require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Events } = require('discord.js');
const express = require('express');
const crypto = require('crypto');

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
const pterodactylStartupPingEnabled = (process.env.PTERODACTYL_STARTUP_PING_ENABLED || 'true').toLowerCase() !== 'false';
const pterodactylStatePollMsRaw = Number(process.env.PTERODACTYL_STATE_POLL_MS || 15000);
const pterodactylStatePollMs = Number.isFinite(pterodactylStatePollMsRaw) && pterodactylStatePollMsRaw >= 5000
  ? pterodactylStatePollMsRaw
  : 15000;

let restartInFlight = false;
let lastRestartAtMs = 0;
let lastKnownPterodactylState = null;
let pterodactylMonitorTimer = null;

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

async function getPterodactylErrorReason(response) {
  const fallback = `HTTP ${response.status}`;
  const raw = await response.text();

  if (!raw) {
    return fallback;
  }

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

// Simple HTTP server for Minecraft to call
const app = express();
app.use(express.json());

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

app.get('/health', (_req, res) => {
  const ready = !!client.user;
  res.json({
    ok: ready,
    status: ready ? 'ready' : 'starting',
  });
});

app.listen(port, () => {
  console.log(`Bot HTTP server listening on http://localhost:${port}`);
});

client.login(token);

