require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Events } = require('discord.js');
const express = require('express');

const token = process.env.DISCORD_BOT_TOKEN;
const port = Number(process.env.BOT_HTTP_PORT || 3000);
const minecraftChannelId = process.env.MINECRAFT_DISCORD_CHANNEL_ID;

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
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  if (message.content === '!ping') {
    await message.reply('Pong!');
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
  const { player, message } = req.body || {};

  if (!minecraftChannelId) {
    console.warn('MINECRAFT_DISCORD_CHANNEL_ID is not set; cannot relay messages.');
    return res.status(500).json({ ok: false, error: 'Channel ID not configured' });
  }

  if (!player || !message) {
    return res.status(400).json({ ok: false, error: 'Missing player or message' });
  }

  try {
    const channel = await client.channels.fetch(minecraftChannelId);
    if (!channel || !channel.isTextBased()) {
      return res.status(500).json({ ok: false, error: 'Configured channel is not text-based or not found' });
    }

    await channel.send(`📜 **[MC] ${player}**: ${message}`);
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

