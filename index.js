require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Events } = require('discord.js');
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const token = process.env.DISCORD_BOT_TOKEN;
const port = Number(process.env.BOT_HTTP_PORT || 3000);
const minecraftChannelId = process.env.MINECRAFT_DISCORD_CHANNEL_ID;
const minecraftRoleId = process.env.MINECRAFT_DISCORD_ROLE_ID;
const minecraftAdminRoleId = process.env.MINECRAFT_DISCORD_ADMINROLE_ID;
const pterodactylPanelUrl = (process.env.PTERODACTYL_PANEL_URL || '').replace(/\/+$/, '');
const pterodactylServerId = process.env.PTERODACTYL_SERVER_ID;
const pterodactylClientApiKey = process.env.PTERODACTYL_CLIENT_API_KEY;
const restartCooldownMs = Number(process.env.RESTART_COOLDOWN_MS || 60000);
const discordLinkSharedSecret = (process.env.DISCORDLINK_SHARED_SECRET || '').trim();
const pterodactylStartupPingEnabled = (process.env.PTERODACTYL_STARTUP_PING_ENABLED || 'false').toLowerCase() !== 'false';
const pterodactylStatePollMsRaw = Number(process.env.PTERODACTYL_STATE_POLL_MS || 15000);
const pterodactylStatePollMs = Number.isFinite(pterodactylStatePollMsRaw) && pterodactylStatePollMsRaw >= 5000
  ? pterodactylStatePollMsRaw
  : 15000;
const weaknessRevealSecret = (process.env.TOURNAMENT_WEAKNESS_SECRET || '').trim();

const DATA_DIR = path.join(__dirname, 'data');
const TOURNAMENT_DIR = path.join(DATA_DIR, 'tournaments');
const POKEAPI_CACHE_DIR = path.join(DATA_DIR, 'pokeapi-cache');
const memoryPokeApiCache = new Map();
let moveNameIndex = null;
let abilityNameIndex = null;

const TYPE_COLORS = {
  normal: '#a8a878',
  fire: '#f08030',
  water: '#6890f0',
  electric: '#f8d030',
  grass: '#78c850',
  ice: '#98d8d8',
  fighting: '#c03028',
  poison: '#a040a0',
  ground: '#e0c068',
  flying: '#a890f0',
  psychic: '#f85888',
  bug: '#a8b820',
  rock: '#b8a038',
  ghost: '#705898',
  dragon: '#7038f8',
  dark: '#705848',
  steel: '#b8b8d0',
  fairy: '#ee99ac',
};

const SHOWDOWN_TRAINER_SPRITES = [
  'ace-trainer', 'ace-trainerf', 'beauty', 'blackbelt', 'bugcatcher', 'champion',
  'dragon-tamer', 'engineer', 'fisherman', 'gentleman', 'hiker', 'lass',
  'leader-brock', 'leader-misty', 'leader-surge', 'leader-erika', 'leader-koga', 'leader-sabrina',
  'leader-blaine', 'leader-giovanni', 'pokemaniac', 'psychic', 'ranger', 'scientist',
  'swimmer', 'swimmerf', 'youngster', 'worker', 'hex-maniac', 'artist',
  'battlegirl', 'cyclist', 'ninja-boy', 'veteran', 'veteranf', 'breeder',
  'pokemon-breeder', 'pokefan', 'pokefanf', 'supernerd', 'doctor', 'nurse'
];

let restartInFlight = false;
let lastRestartAtMs = 0;
let lastKnownPterodactylState = null;
let pterodactylMonitorTimer = null;

ensureDir(DATA_DIR);
ensureDir(TOURNAMENT_DIR);
ensureDir(POKEAPI_CACHE_DIR);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function hasPterodactylConfig() {
  return !!(pterodactylPanelUrl && pterodactylServerId && pterodactylClientApiKey);
}

function hasBridgeSecretConfigured() {
  return discordLinkSharedSecret.length > 0;
}

function isBridgeSecretValid(request) {
  const provided = request.get('X-DiscordLink-Secret') || '';
  const providedBuffer = Buffer.from(provided, 'utf8');
  const expectedBuffer = Buffer.from(discordLinkSharedSecret, 'utf8');

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

function slugifyTournamentName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'tournament';
}

function normalizePokemonName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[.']/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function normalizeMoveName(name) {
  return normalizePokemonName(name);
}

function normalizeAbilityName(name) {
  return normalizePokemonName(name);
}

function normalizeItemName(name) {
  return normalizePokemonName(name);
}

function compactPokeApiKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isPokeApiNotFoundError(err) {
  return /PokeAPI request failed \(404\)/i.test(String(err?.message || err || ''));
}

function pickTrainerSprite(playerUuid, playerName) {
  const seed = `${playerUuid || ''}:${playerName || ''}`;
  const digest = crypto.createHash('sha256').update(seed).digest();
  const idx = digest.readUInt32BE(0) % SHOWDOWN_TRAINER_SPRITES.length;
  const key = SHOWDOWN_TRAINER_SPRITES[idx];
  return `https://play.pokemonshowdown.com/sprites/trainers/${key}.png`;
}

function getTournamentPathBySlug(slug) {
  return path.join(TOURNAMENT_DIR, `${slug}.json`);
}

function writeTournamentSnapshot(snapshot) {
  const slug = slugifyTournamentName(snapshot?.tournamentName || snapshot?.slug || 'tournament');
  const finalData = {
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    ...snapshot,
    slug,
  };

  const filePath = getTournamentPathBySlug(slug);
  fs.writeFileSync(filePath, JSON.stringify(finalData, null, 2), 'utf8');
  return { slug, filePath, snapshot: finalData };
}

function readTournamentSnapshot(slug) {
  const filePath = getTournamentPathBySlug(slug);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function getPokeApiCachePath(url) {
  const key = crypto.createHash('sha256').update(url).digest('hex');
  return path.join(POKEAPI_CACHE_DIR, `${key}.json`);
}

async function getCachedJson(url) {
  if (memoryPokeApiCache.has(url)) {
    return memoryPokeApiCache.get(url);
  }

  const diskPath = getPokeApiCachePath(url);
  if (fs.existsSync(diskPath)) {
    const parsed = JSON.parse(fs.readFileSync(diskPath, 'utf8'));
    memoryPokeApiCache.set(url, parsed.payload);
    return parsed.payload;
  }

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'discordlink-bot/1.1.0',
    },
  });

  if (!response.ok) {
    throw new Error(`PokeAPI request failed (${response.status}) for ${url}`);
  }

  const payload = await response.json();
  const wrapped = {
    fetchedAt: new Date().toISOString(),
    url,
    payload,
  };

  fs.writeFileSync(diskPath, JSON.stringify(wrapped, null, 2), 'utf8');
  memoryPokeApiCache.set(url, payload);
  return payload;
}

async function getPokeApiPokemon(speciesName) {
  const normalized = normalizePokemonName(speciesName);
  const speciesAliases = {
    nidoranmale: 'nidoran-m',
    nidoranfemale: 'nidoran-f',
    'mr-mime': 'mr-mime',
    'mime-jr': 'mime-jr',
    farfetchd: 'farfetchd',
  };

  const resolved = speciesAliases[normalized] || normalized;
  const url = `https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(resolved)}`;
  return getCachedJson(url);
}

async function getPokeApiMove(moveName) {
  const normalized = normalizeMoveName(moveName);
  const primaryUrl = `https://pokeapi.co/api/v2/move/${encodeURIComponent(normalized)}`;

  try {
    return await getCachedJson(primaryUrl);
  } catch (err) {
    if (!isPokeApiNotFoundError(err)) {
      throw err;
    }
  }

  const fallbackName = await resolvePokeApiResourceNameByCompactKey('move', normalized);
  if (!fallbackName || fallbackName === normalized) {
    throw new Error(`PokeAPI move not found for ${moveName}`);
  }

  const fallbackUrl = `https://pokeapi.co/api/v2/move/${encodeURIComponent(fallbackName)}`;
  return getCachedJson(fallbackUrl);
}

async function getPokeApiAbility(abilityName) {
  const normalized = normalizeAbilityName(abilityName);
  const primaryUrl = `https://pokeapi.co/api/v2/ability/${encodeURIComponent(normalized)}`;

  try {
    return await getCachedJson(primaryUrl);
  } catch (err) {
    if (!isPokeApiNotFoundError(err)) {
      throw err;
    }
  }

  const fallbackName = await resolvePokeApiResourceNameByCompactKey('ability', normalized);
  if (!fallbackName || fallbackName === normalized) {
    throw new Error(`PokeAPI ability not found for ${abilityName}`);
  }

  const fallbackUrl = `https://pokeapi.co/api/v2/ability/${encodeURIComponent(fallbackName)}`;
  return getCachedJson(fallbackUrl);
}

async function getPokeApiItem(itemName) {
  const normalized = normalizeItemName(itemName);
  if (!normalized || normalized === 'none' || normalized === 'no-item') {
    return null;
  }
  const url = `https://pokeapi.co/api/v2/item/${encodeURIComponent(normalized)}`;
  return getCachedJson(url);
}

async function getTypeData(typeName) {
  const url = `https://pokeapi.co/api/v2/type/${encodeURIComponent(typeName)}`;
  return getCachedJson(url);
}

async function getPokeApiNameIndex(resourceType) {
  if (resourceType === 'move' && moveNameIndex) {
    return moveNameIndex;
  }
  if (resourceType === 'ability' && abilityNameIndex) {
    return abilityNameIndex;
  }

  const limit = resourceType === 'move' ? 2000 : 600;
  const url = `https://pokeapi.co/api/v2/${resourceType}?limit=${limit}`;
  const payload = await getCachedJson(url);
  const index = new Map();

  for (const entry of (payload.results || [])) {
    const canonical = String(entry?.name || '').trim().toLowerCase();
    if (!canonical) continue;
    index.set(canonical, canonical);

    const compact = compactPokeApiKey(canonical);
    if (compact && !index.has(compact)) {
      index.set(compact, canonical);
    }
  }

  if (resourceType === 'move') {
    moveNameIndex = index;
  } else if (resourceType === 'ability') {
    abilityNameIndex = index;
  }

  return index;
}

async function resolvePokeApiResourceNameByCompactKey(resourceType, normalizedName) {
  const input = String(normalizedName || '').trim().toLowerCase();
  if (!input) return null;

  const index = await getPokeApiNameIndex(resourceType);
  if (index.has(input)) {
    return index.get(input);
  }

  const compact = compactPokeApiKey(input);
  if (!compact) return null;
  return index.get(compact) || null;
}

function parseWeaknessMultiplierByType(primaryType, secondaryType, primaryTypeData, secondaryTypeData) {
  const allTypes = Object.keys(TYPE_COLORS);
  const multipliers = {};
  for (const t of allTypes) {
    multipliers[t] = 1;
  }

  const applyTypeData = (typeData) => {
    if (!typeData?.damage_relations) {
      return;
    }
    for (const t of typeData.damage_relations.double_damage_from || []) {
      multipliers[t.name] = (multipliers[t.name] || 1) * 2;
    }
    for (const t of typeData.damage_relations.half_damage_from || []) {
      multipliers[t.name] = (multipliers[t.name] || 1) * 0.5;
    }
    for (const t of typeData.damage_relations.no_damage_from || []) {
      multipliers[t.name] = 0;
    }
  };

  if (primaryType) {
    applyTypeData(primaryTypeData);
  }
  if (secondaryType) {
    applyTypeData(secondaryTypeData);
  }

  return Object.entries(multipliers)
    .map(([type, multiplier]) => ({ type, multiplier }))
    .sort((a, b) => b.multiplier - a.multiplier || a.type.localeCompare(b.type));
}

function parseStatSpreadString(raw) {
  const input = String(raw || '').trim();
  const out = { hp: null, atk: null, def: null, spa: null, spd: null, spe: null, raw: input };

  if (!input || input === 'unknown') {
    return out;
  }

  const pairs = input.split(';');
  for (const pair of pairs) {
    const [k, v] = pair.split('=');
    if (!k || v == null) continue;
    const key = k.trim().toLowerCase();
    const value = Number(v.trim());
    if (!Number.isFinite(value)) continue;
    if (key in out) {
      out[key] = value;
    }
  }

  return out;
}

function normalizeNatureName(raw) {
  const input = String(raw || '').trim();
  if (!input) return 'Unknown';

  // Accept both namespaced and bare values from different mod versions.
  let value = input;
  const lower = value.toLowerCase();
  if (lower.startsWith('cobblemon.nature.')) {
    value = value.slice('cobblemon.nature.'.length);
  }

  const token = value.split(/[.:/\\]/).filter(Boolean).pop() || value;
  if (!token) return 'Unknown';
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

async function enrichPokemon(pokemon, includeWeakness) {
  const enriched = {
    ...pokemon,
    nature: normalizeNatureName(pokemon.nature),
    pokeApi: null,
    moveInfo: [],
    abilityInfo: null,
    itemInfo: null,
    weakness: null,
    parse: {
      ivs: parseStatSpreadString(pokemon.ivSpread),
      evs: parseStatSpreadString(pokemon.evSpread),
    },
  };

  try {
    const pokeApi = await getPokeApiPokemon(pokemon.species || pokemon.displayName);
    enriched.pokeApi = {
      id: pokeApi.id,
      name: pokeApi.name,
      sprite: pokeApi.sprites?.front_default || null,
      artwork: pokeApi.sprites?.other?.['official-artwork']?.front_default || pokeApi.sprites?.front_default || null,
      types: (pokeApi.types || []).map((entry) => entry.type.name),
      stats: pokeApi.stats || [],
    };

    if (includeWeakness && enriched.pokeApi.types.length > 0) {
      const [primaryType, secondaryType] = enriched.pokeApi.types;
      const primaryTypeData = await getTypeData(primaryType);
      const secondaryTypeData = secondaryType ? await getTypeData(secondaryType) : null;
      enriched.weakness = parseWeaknessMultiplierByType(primaryType, secondaryType, primaryTypeData, secondaryTypeData);
    }
  } catch (err) {
    enriched.pokeApiError = err.message;
  }

  try {
    if (pokemon.ability && pokemon.ability.toLowerCase() !== 'unknown') {
      const ability = await getPokeApiAbility(pokemon.ability);
      const englishEffect = (ability.effect_entries || []).find((entry) => entry.language?.name === 'en');
      enriched.abilityInfo = {
        name: ability.name,
        shortEffect: englishEffect?.short_effect || null,
      };
    }
  } catch (err) {
    enriched.abilityError = err.message;
  }

  try {
    const item = await getPokeApiItem(pokemon.heldItem);
    if (item) {
      const englishEffect = (item.effect_entries || []).find((entry) => entry.language?.name === 'en');
      enriched.itemInfo = {
        name: item.name,
        sprite: item.sprites?.default || null,
        shortEffect: englishEffect?.short_effect || null,
      };
    }
  } catch (err) {
    enriched.itemError = err.message;
  }

  const moveNames = Array.isArray(pokemon.moves) ? pokemon.moves : [];
  for (const moveName of moveNames) {
    try {
      const move = await getPokeApiMove(moveName);
      enriched.moveInfo.push({
        sourceName: moveName,
        name: move.name,
        type: move.type?.name || null,
        power: move.power,
        accuracy: move.accuracy,
        pp: move.pp,
        damageClass: move.damage_class?.name || null,
      });
    } catch (err) {
      enriched.moveInfo.push({
        sourceName: moveName,
        error: err.message,
      });
    }
  }

  return enriched;
}

async function buildTournamentViewData(snapshot, includeWeakness) {
  const players = [];
  const sourcePlayers = Array.isArray(snapshot.players) ? snapshot.players : [];

  for (const player of sourcePlayers) {
    const team = Array.isArray(player.team) ? player.team : [];
    const enrichedTeam = [];
    for (const pokemon of team) {
      enrichedTeam.push(await enrichPokemon(pokemon, includeWeakness));
    }

    players.push({
      ...player,
      trainerSprite: pickTrainerSprite(player.playerUuid, player.playerName),
      team: enrichedTeam,
    });
  }

  return {
    ...snapshot,
    players,
    revealWeakness: includeWeakness,
    generatedAt: new Date().toISOString(),
  };
}

function weaknessSecretValid(req) {
  if (!weaknessRevealSecret) {
    return false;
  }

  const queryToken = String(req.query.w || req.query.weak || '').trim();
  const pathToken = String(req.params.weaknessToken || '').trim();
  const provided = queryToken || pathToken;
  if (!provided) {
    return false;
  }

  const providedBuffer = Buffer.from(provided, 'utf8');
  const expectedBuffer = Buffer.from(weaknessRevealSecret, 'utf8');
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

function getPterodactylErrorReason(response) {
  const fallback = `HTTP ${response.status}`;
  return response.text().then((raw) => {
    if (!raw) return fallback;

    try {
      const payload = JSON.parse(raw);
      const detail = payload?.errors?.[0]?.detail;
      if (detail) {
        return detail;
      }
    } catch (_err) {
      // Keep fallback formatting if body is not JSON.
    }

    return `${fallback}: ${raw.slice(0, 300)}`;
  });
}

async function sendToMinecraftChannel(payload) {
  if (!minecraftChannelId) {
    throw new Error('MINECRAFT_DISCORD_CHANNEL_ID is not set.');
  }

  const channel = await client.channels.fetch(minecraftChannelId);
  if (!channel || !channel.isTextBased()) {
    throw new Error('Configured channel is not text-based or not found.');
  }

  await channel.send(payload);
}

async function sendMinecraftRelay(player, message) {
  await sendToMinecraftChannel(formatMinecraftRelay(player, message));
}

function getRestartConfigErrors() {
  const errors = [];

  if (!minecraftAdminRoleId) errors.push('MINECRAFT_DISCORD_ADMINROLE_ID');
  if (!pterodactylPanelUrl) errors.push('PTERODACTYL_PANEL_URL');
  if (!pterodactylServerId) errors.push('PTERODACTYL_SERVER_ID');
  if (!pterodactylClientApiKey) errors.push('PTERODACTYL_CLIENT_API_KEY');

  return errors;
}

async function requestPterodactylRestart() {
  const response = await fetch(`${pterodactylPanelUrl}/api/client/servers/${pterodactylServerId}/power`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${pterodactylClientApiKey}`,
      Accept: 'Application/vnd.pterodactyl.v1+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ signal: 'restart' }),
  });

  if (response.status === 204) {
    return;
  }

  throw new Error(await getPterodactylErrorReason(response));
}

async function getPterodactylServerState() {
  const response = await fetch(`${pterodactylPanelUrl}/api/client/servers/${pterodactylServerId}/resources`, {
    headers: {
      Authorization: `Bearer ${pterodactylClientApiKey}`,
      Accept: 'Application/vnd.pterodactyl.v1+json',
    },
  });

  if (!response.ok) {
    throw new Error(await getPterodactylErrorReason(response));
  }

  const payload = await response.json();
  const state = payload?.attributes?.current_state;

  if (typeof state !== 'string') {
    throw new Error('Pterodactyl response did not include attributes.current_state.');
  }

  return state.toLowerCase();
}

async function pollPterodactylState() {
  try {
    const currentState = await getPterodactylServerState();
    const previousState = lastKnownPterodactylState;
    lastKnownPterodactylState = currentState;

    if (previousState === null) {
      console.log(`Pterodactyl initial server state: ${currentState}`);
      return;
    }

    if (previousState !== 'running' && currentState === 'running') {
      await sendMinecraftRelay('SERVER', '@minecraft Server has started.');
      console.log('Pterodactyl state transition detected: running. Startup notice sent to Discord.');
    }
  } catch (err) {
    console.warn(`Failed to poll Pterodactyl server state: ${err.message}`);
  }
}

async function startPterodactylMonitor() {
  if (pterodactylMonitorTimer) {
    return;
  }

  if (!pterodactylStartupPingEnabled) {
    console.log('Pterodactyl monitor disabled by PTERODACTYL_STARTUP_PING_ENABLED=false.');
    return;
  }

  if (!hasPterodactylConfig()) {
    console.warn('Pterodactyl monitor disabled: missing Pterodactyl API configuration.');
    return;
  }

  if (!minecraftChannelId) {
    console.warn('Pterodactyl monitor disabled: MINECRAFT_DISCORD_CHANNEL_ID is not set.');
    return;
  }

  await pollPterodactylState();
  pterodactylMonitorTimer = setInterval(() => {
    pollPterodactylState();
  }, pterodactylStatePollMs);
  console.log(`Pterodactyl monitor enabled (poll interval: ${pterodactylStatePollMs}ms).`);
}

async function handleRestartCommand(message) {
  if (!message.inGuild()) {
    await message.reply('This command can only be used in a server channel.');
    return;
  }

  const missingConfig = getRestartConfigErrors();
  if (missingConfig.length > 0) {
    await message.reply(`Restart is not configured. Missing: ${missingConfig.join(', ')}`);
    return;
  }

  if (!message.member?.roles?.cache?.has(minecraftAdminRoleId)) {
    await message.reply('You do not have permission to restart the server.');
    return;
  }

  if (restartInFlight) {
    await message.reply('A restart request is already in progress. Please wait.');
    return;
  }

  const cooldownLeftMs = lastRestartAtMs + restartCooldownMs - Date.now();
  if (cooldownLeftMs > 0) {
    await message.reply(`Restart is on cooldown. Try again in ${Math.ceil(cooldownLeftMs / 1000)}s.`);
    return;
  }

  restartInFlight = true;

  try {
    await message.reply('Restart request accepted. Sending restart signal to Pterodactyl...');
    await requestPterodactylRestart();
    lastRestartAtMs = Date.now();
    await message.channel.send('Restart signal sent. The Minecraft server should restart shortly.');
  } catch (err) {
    console.error('Failed to restart server via Pterodactyl:', err);
    await message.channel.send(`Failed to restart server: ${err.message}`);
  } finally {
    restartInFlight = false;
  }
}

function hasAdminRole(message) {
  return !!message.member?.roles?.cache?.has(minecraftAdminRoleId);
}

async function handleStartupTestCommand(message) {
  if (!message.inGuild()) {
    await message.reply('This command can only be used in a server channel.');
    return;
  }

  const missingConfig = getRestartConfigErrors();
  if (missingConfig.length > 0) {
    await message.reply(`Startup test is not configured. Missing: ${missingConfig.join(', ')}`);
    return;
  }

  if (!hasAdminRole(message)) {
    await message.reply('You do not have permission to run startup ping tests.');
    return;
  }

  try {
    const state = await getPterodactylServerState();
    await sendMinecraftRelay('SERVER', '@minecraft Server has started.');
    await message.reply(`Startup ping test sent successfully (current Pterodactyl state: ${state}).`);
  } catch (err) {
    console.error('Failed to run startup ping test:', err);
    await message.reply(`Startup ping test failed: ${err.message}`);
  }
}

async function handleMonitorStateCommand(message) {
  if (!message.inGuild()) {
    await message.reply('This command can only be used in a server channel.');
    return;
  }

  const missingConfig = getRestartConfigErrors();
  if (missingConfig.length > 0) {
    await message.reply(`Monitor state check is not configured. Missing: ${missingConfig.join(', ')}`);
    return;
  }

  if (!hasAdminRole(message)) {
    await message.reply('You do not have permission to view monitor state.');
    return;
  }

  try {
    const currentState = await getPterodactylServerState();
    const lastKnown = lastKnownPterodactylState ?? 'null';
    await message.reply(`Monitor state: lastKnown=${lastKnown}, current=${currentState}, pollMs=${pterodactylStatePollMs}.`);
  } catch (err) {
    console.error('Failed to check monitor state:', err);
    await message.reply(`Monitor state check failed: ${err.message}`);
  }
}

function formatMinecraftRelay(player, message) {
  const isStartupMessage = player === 'SERVER' && (message === '@minecraft Server has started.' || message === 'Server has started.');

  if (isStartupMessage && minecraftRoleId) {
    return {
      content: `📜 **[MC] ${player}**: <@&${minecraftRoleId}> Server has started.`,
      allowedMentions: { roles: [minecraftRoleId] },
    };
  }

  return {
    content: `📜 **[MC] ${player}**: ${message}`,
  };
}

function renderTournamentHtml(tournamentSlug) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DiscordLink Tournament - ${tournamentSlug}</title>
  <style>
    :root {
      --bg: #0f1419;
      --bg-2: #1a1f2e;
      --ink: #e0e6ed;
      --sub: #a0aab8;
      --card: #16192b;
      --card-hover: #1e2235;
      --line: #2a2f3f;
      --accent: #10b981;
      --accent-2: #3b82f6;
      --danger: #ef4444;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Trebuchet MS", "Segoe UI", sans-serif;
      color: var(--ink);
      background: linear-gradient(135deg, #0a0e14 0%, #16192b 50%, #0f1419 100%);
      min-height: 100vh;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
    }
    .hero {
      border: 1px solid var(--line);
      border-radius: 16px;
      background: var(--card);
      padding: 24px;
      margin-bottom: 24px;
    }
    .hero h1 { margin: 0 0 8px; font-size: 2rem; }
    .muted { color: var(--sub); }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 16px 0;
    }
    .toolbar input {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 10px 12px;
      min-width: 240px;
      background: var(--bg-2);
      color: var(--ink);
    }
    .toolbar input::placeholder { color: var(--sub); }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 16px;
    }
    .player-card {
      border: 1px solid var(--line);
      border-radius: 14px;
      background: var(--card);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
      overflow: hidden;
      transition: all 0.2s ease;
      cursor: pointer;
    }
    .player-card:hover {
      border-color: var(--accent);
      background: var(--card-hover);
    }
    .player-head {
      display: flex;
      gap: 12px;
      padding: 12px;
      align-items: center;
      user-select: none;
    }
    .trainer {
      width: 64px;
      height: 64px;
      border-radius: 10px;
      object-fit: contain;
      background: var(--bg-2);
      border: 1px solid var(--line);
      flex-shrink: 0;
    }
    .player-meta {
      flex: 1;
      min-width: 0;
    }
    .player-meta h3 { margin: 0 0 4px; font-size: 1.1rem; }
    .player-meta .muted { font-size: 0.85rem; }
    .team-summary {
      margin-top: 8px;
      font-size: 0.9rem;
      color: var(--sub);
    }
    .chip {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid var(--line);
      font-size: 11px;
      margin-right: 4px;
      margin-top: 4px;
      background: var(--bg-2);
      color: var(--sub);
    }
    .team {
      display: none;
      padding: 12px;
      border-top: 1px solid var(--line);
      max-height: 500px;
      overflow-y: auto;
    }
    .team.open {
      display: grid;
      grid-template-columns: 1fr;
      gap: 10px;
    }
    .poke {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 8px;
      background: var(--bg-2);
    }
    .poke-row {
      display: flex;
      gap: 8px;
      align-items: center;
      cursor: pointer;
    }
    .poke-sprite {
      width: 56px;
      height: 56px;
      object-fit: contain;
      border-radius: 8px;
      background: var(--card);
      border: 1px solid var(--line);
      flex-shrink: 0;
    }
    .poke-info {
      flex: 1;
      min-width: 0;
    }
    .poke-name {
      font-weight: bold;
      font-size: 0.95rem;
    }
    .poke-meta {
      font-size: 0.85rem;
      color: var(--sub);
      margin-top: 2px;
    }
    .type-pill {
      display: inline-block;
      font-size: 10px;
      border-radius: 999px;
      padding: 2px 6px;
      color: #fff;
      margin-right: 4px;
      margin-top: 4px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-weight: 600;
    }
    .details {
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px dashed var(--line);
      display: none;
      font-size: 0.85rem;
    }
    .details.open { display: block; }
    .detail-item {
      margin-top: 4px;
      padding: 6px;
      background: var(--card);
      border-radius: 6px;
      border: 1px solid var(--line);
    }
    .detail-label {
      color: var(--sub);
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .detail-value {
      color: var(--ink);
      font-family: monospace;
      font-size: 0.9rem;
      margin-top: 2px;
    }
    .moves { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
    .move {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 6px;
      background: var(--card);
      font-size: 11px;
      color: var(--sub);
    }
    .weak-grid {
      margin-top: 6px;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(80px, 1fr));
      gap: 4px;
    }
    .weak-item {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 3px 4px;
      font-size: 11px;
      background: var(--card);
      text-align: center;
    }
    .footer {
      margin-top: 32px;
      padding-top: 16px;
      border-top: 1px solid var(--line);
      color: var(--sub);
      font-size: 12px;
      text-align: center;
    }
    @media (max-width: 680px) {
      .container { padding: 12px; }
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="hero">
      <h1 id="title">Tournament</h1>
      <div class="muted" id="subtitle">Loading...</div>
      <div class="toolbar">
        <input id="search" placeholder="Search player / pokemon / move" />
      </div>
      <div class="muted" id="weakness-note"></div>
    </div>
    <div id="grid" class="grid"></div>
    <div class="footer">Data source: mod export snapshots + cached PokeAPI resources. Trainer sprites: Pokemon Showdown.</div>
  </div>

  <script>
    const TYPE_COLORS = ${JSON.stringify(TYPE_COLORS)};

    function createTypePill(typeName) {
      const span = document.createElement('span');
      span.className = 'type-pill';
      span.textContent = typeName;
      span.style.background = TYPE_COLORS[typeName] || '#666';
      return span;
    }

    function weaknessLabel(multiplier) {
      if (multiplier === 0) return '0x';
      if (multiplier === 0.25) return '1/4x';
      if (multiplier === 0.5) return '1/2x';
      if (multiplier === 1) return '1x';
      if (multiplier === 2) return '2x';
      if (multiplier === 4) return '4x';
      return multiplier + 'x';
    }

    function renderPokemon(pokemon, revealWeakness) {
      const wrapper = document.createElement('div');
      wrapper.className = 'poke';

      const row = document.createElement('div');
      row.className = 'poke-row';

      const sprite = document.createElement('img');
      sprite.className = 'poke-sprite';
      sprite.src = pokemon.pokeApi?.artwork || pokemon.pokeApi?.sprite || 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/0.png';
      sprite.alt = pokemon.displayName || pokemon.species || 'Pokemon';

      const info = document.createElement('div');
      info.className = 'poke-info';
      
      const name = document.createElement('div');
      name.className = 'poke-name';
      name.textContent = pokemon.displayName || pokemon.species || 'Unknown';
      info.appendChild(name);

      const meta = document.createElement('div');
      meta.className = 'poke-meta';
      meta.innerHTML = (pokemon.nature || 'Unknown') + ' | ' + (pokemon.ability || 'Unknown');
      info.appendChild(meta);

      const typeWrap = document.createElement('div');
      const types = pokemon.pokeApi?.types || [];
      for (const t of types) {
        typeWrap.appendChild(createTypePill(t));
      }
      info.appendChild(typeWrap);

      row.appendChild(sprite);
      row.appendChild(info);
      wrapper.appendChild(row);

      const details = document.createElement('div');
      details.className = 'details';

      const abilityDiv = document.createElement('div');
      abilityDiv.className = 'detail-item';
      abilityDiv.innerHTML = '<div class="detail-label">Ability</div><div class="detail-value">' + (pokemon.ability || 'Unknown') + '</div>';
      details.appendChild(abilityDiv);

      const heldItemDiv = document.createElement('div');
      heldItemDiv.className = 'detail-item';
      heldItemDiv.innerHTML = '<div class="detail-label">Held Item</div><div class="detail-value">' + (pokemon.heldItem || 'None') + '</div>';
      details.appendChild(heldItemDiv);

      const ivsDiv = document.createElement('div');
      ivsDiv.className = 'detail-item';
      ivsDiv.innerHTML = '<div class="detail-label">IVs</div><div class="detail-value">' + (pokemon.ivSpread || 'unknown') + '</div>';
      details.appendChild(ivsDiv);

      const evsDiv = document.createElement('div');
      evsDiv.className = 'detail-item';
      evsDiv.innerHTML = '<div class="detail-label">EVs</div><div class="detail-value">' + (pokemon.evSpread || 'unknown') + '</div>';
      details.appendChild(evsDiv);

      const moveWrap = document.createElement('div');
      moveWrap.className = 'detail-item';
      const moveLabel = document.createElement('div');
      moveLabel.className = 'detail-label';
      moveLabel.textContent = 'Moves';
      moveWrap.appendChild(moveLabel);
      
      const movesContainer = document.createElement('div');
      movesContainer.className = 'moves';
      const moveInfo = Array.isArray(pokemon.moveInfo) ? pokemon.moveInfo : [];
      if (moveInfo.length === 0) {
        const none = document.createElement('span');
        none.className = 'move';
        none.textContent = 'No moves';
        movesContainer.appendChild(none);
      } else {
        for (const move of moveInfo) {
          const m = document.createElement('span');
          m.className = 'move';
          const suffix = move.type ? ' [' + move.type + ']' : '';
          m.textContent = (move.sourceName || move.name || 'unknown') + suffix;
          movesContainer.appendChild(m);
        }
      }
      moveWrap.appendChild(movesContainer);
      details.appendChild(moveWrap);

      if (revealWeakness && Array.isArray(pokemon.weakness)) {
        const weak = document.createElement('div');
        weak.className = 'detail-item';
        const weakLabel = document.createElement('div');
        weakLabel.className = 'detail-label';
        weakLabel.textContent = 'Weaknesses';
        weak.appendChild(weakLabel);
        
        const weakGrid = document.createElement('div');
        weakGrid.className = 'weak-grid';
        for (const entry of pokemon.weakness) {
          if (![0, 0.5, 2, 4].includes(entry.multiplier)) continue;
          const item = document.createElement('div');
          item.className = 'weak-item';
          item.textContent = entry.type + ': ' + weaknessLabel(entry.multiplier);
          weakGrid.appendChild(item);
        }
        weak.appendChild(weakGrid);
        details.appendChild(weak);
      }

      wrapper.appendChild(details);

      row.addEventListener('click', () => {
        details.classList.toggle('open');
      });

      return wrapper;
    }

    function renderPlayer(player, revealWeakness) {
      const card = document.createElement('article');
      card.className = 'player-card';

      const head = document.createElement('div');
      head.className = 'player-head';
      head.style.cursor = 'pointer';
      head.innerHTML = '<img class="trainer" src="' + player.trainerSprite + '" alt="Trainer sprite" />'
        + '<div class="player-meta">'
        + '<h3>' + player.playerName + '</h3>'
        + '<div class="muted">Team: ' + (Array.isArray(player.team) ? player.team.length : 0) + ' Pokémon</div>';
      
      const team = Array.isArray(player.team) ? player.team : [];
      const teamNames = team.slice(0, 3).map(p => p.species || p.displayName || 'Unknown').join(', ');
      head.innerHTML += '<div class="team-summary">' + (teamNames || 'No team') + (team.length > 3 ? '...' : '') + '</div>'
        + '</div>';
      
      card.appendChild(head);

      const teamWrap = document.createElement('div');
      teamWrap.className = 'team';
      for (const pokemon of team) {
        teamWrap.appendChild(renderPokemon(pokemon, revealWeakness));
      }
      card.appendChild(teamWrap);

      head.addEventListener('click', () => {
        teamWrap.classList.toggle('open');
      });

      return card;
    }

    function playerSearchBlob(player) {
      const team = Array.isArray(player.team) ? player.team : [];
      let blob = player.playerName + ' ';
      for (const p of team) {
        blob += (p.species || '') + ' ';
        blob += (p.displayName || '') + ' ';
        blob += (p.moves || []).join(' ') + ' ';
      }
      return blob.toLowerCase();
    }

    async function load() {
      const params = new URLSearchParams(location.search);
      const weak = params.get('w') || params.get('weak') || '';
      const url = '/api/tournament/${tournamentSlug}' + (weak ? ('?w=' + encodeURIComponent(weak)) : '');
      const response = await fetch(url);
      const data = await response.json();

      if (!data.ok) {
        document.getElementById('title').textContent = 'Tournament not found';
        document.getElementById('subtitle').textContent = data.error || 'Unknown error';
        return;
      }

      const t = data.tournament;
      const revealWeakness = !!t.revealWeakness;
      document.getElementById('title').textContent = t.tournamentName + ' (' + t.status + ')';
      document.getElementById('subtitle').textContent = 'Players: ' + t.players.length + ' | Exported: ' + (t.exportedAt || 'Unknown');
      document.getElementById('weakness-note').textContent = revealWeakness
        ? 'Weakness mode enabled.'
        : '';

      const grid = document.getElementById('grid');
      const players = Array.isArray(t.players) ? t.players : [];
      const entries = players.map((player) => ({ player, card: renderPlayer(player, revealWeakness), blob: playerSearchBlob(player) }));
      for (const entry of entries) {
        grid.appendChild(entry.card);
      }

      const searchInput = document.getElementById('search');
      searchInput.addEventListener('input', () => {
        const q = searchInput.value.trim().toLowerCase();
        for (const entry of entries) {
          const visible = !q || entry.blob.includes(q);
          entry.card.style.display = visible ? '' : 'none';
        }
      });
    }

    load().catch((err) => {
      document.getElementById('title').textContent = 'Failed to load tournament';
      document.getElementById('subtitle').textContent = err.message;
    });
  </script>
</body>
</html>`;
}

if (!token) {
  console.error('Missing DISCORD_BOT_TOKEN in .env file.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  startPterodactylMonitor();
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();

  if (content === '!ping') {
    await message.reply('Pong!');
    return;
  }

  if (content === '!restart') {
    await handleRestartCommand(message);
    return;
  }

  if (content === '!startuptest') {
    await handleStartupTestCommand(message);
    return;
  }

  if (content === '!monitorstate') {
    await handleMonitorStateCommand(message);
  }
});

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/mc/chat', (_req, res) => {
  res
    .status(405)
    .json({ ok: false, error: 'Use POST /mc/chat with JSON: { "player": "...", "message": "..." }' });
});

app.post('/mc/chat', async (req, res) => {
  if (!hasBridgeSecretConfigured()) {
    console.warn('DISCORDLINK_SHARED_SECRET is not configured; refusing /mc/chat requests.');
    return res.status(503).json({ ok: false, error: 'Bridge secret not configured' });
  }

  if (!isBridgeSecretValid(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized bridge request' });
  }

  const { player, message } = req.body || {};

  if (!minecraftChannelId) {
    console.warn('MINECRAFT_DISCORD_CHANNEL_ID is not set; cannot relay messages.');
    return res.status(500).json({ ok: false, error: 'Channel ID not configured' });
  }

  if (!player || !message) {
    return res.status(400).json({ ok: false, error: 'Missing player or message' });
  }

  try {
    await sendMinecraftRelay(player, message);
    return res.json({ ok: true });
  } catch (err) {
    console.error('Error relaying MC chat to Discord:', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

app.post('/mc/tournament-export', async (req, res) => {
  if (!hasBridgeSecretConfigured()) {
    console.warn('DISCORDLINK_SHARED_SECRET is not configured; refusing /mc/tournament-export requests.');
    return res.status(503).json({ ok: false, error: 'Bridge secret not configured' });
  }

  if (!isBridgeSecretValid(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized bridge request' });
  }

  const payload = req.body || {};
  if (!payload.tournamentName || !Array.isArray(payload.players)) {
    return res.status(400).json({ ok: false, error: 'Invalid tournament export payload.' });
  }

  try {
    const { slug, snapshot } = writeTournamentSnapshot(payload);
    const publicUrl = `/tournament/${encodeURIComponent(slug)}`;
    return res.json({
      ok: true,
      slug,
      publicUrl,
      weaknessHint: weaknessRevealSecret ? `${publicUrl}?w=<secret>` : null,
      players: snapshot.players.length,
    });
  } catch (err) {
    console.error('Failed to store tournament export:', err);
    return res.status(500).json({ ok: false, error: 'Failed to store export snapshot.' });
  }
});

app.get('/tournament/:slug', async (req, res) => {
  const slug = String(req.params.slug || '').trim();
  const snapshot = readTournamentSnapshot(slug);
  if (!snapshot) {
    return res.status(404).send('Tournament not found.');
  }

  res.type('html').send(renderTournamentHtml(slug));
});

app.get('/tournament/:slug/weak/:weaknessToken', async (req, res) => {
  const slug = String(req.params.slug || '').trim();
  const snapshot = readTournamentSnapshot(slug);
  if (!snapshot) {
    return res.status(404).send('Tournament not found.');
  }

  const redirectUrl = `/tournament/${encodeURIComponent(slug)}?w=${encodeURIComponent(req.params.weaknessToken)}`;
  return res.redirect(302, redirectUrl);
});

app.get('/api/tournament/:slug', async (req, res) => {
  const slug = String(req.params.slug || '').trim();
  const snapshot = readTournamentSnapshot(slug);
  if (!snapshot) {
    return res.status(404).json({ ok: false, error: 'Tournament not found.' });
  }

  const includeWeakness = weaknessSecretValid(req);

  try {
    const view = await buildTournamentViewData(snapshot, includeWeakness);
    return res.json({ ok: true, tournament: view });
  } catch (err) {
    console.error('Failed to build tournament view data:', err);
    return res.status(500).json({ ok: false, error: 'Failed to enrich tournament data.' });
  }
});

app.get('/health', (_req, res) => {
  const ready = !!client.user;
  res.json({
    ok: ready,
    status: ready ? 'ready' : 'starting',
  });
});

app.listen(port, () => {
  console.log(`Bot HTTP server listening on http://localhost:${port}`);
  console.log(`Tournament snapshots dir: ${TOURNAMENT_DIR}`);
  console.log(`PokeAPI cache dir: ${POKEAPI_CACHE_DIR}`);
});

client.login(token);
