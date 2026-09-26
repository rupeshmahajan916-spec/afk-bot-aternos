const mineflayer = require('mineflayer');
const { Movements, pathfinder, goals } = require('mineflayer-pathfinder');
const { GoalBlock } = goals;
const config = require('./settings.json');
const express = require('express');
const http = require('http');

// ============================================================
// EXPRESS SERVER - Keep Render/Aternos alive
// ============================================================
const app = express();
const PORT = process.env.PORT || 5000;

let botState = {
  connected: false,
  lastActivity: Date.now(),
  reconnectAttempts: 0,
  startTime: Date.now(),
  errors: []
};

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>${config.name} Status</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; overflow: hidden; }
        .container { background: #1e293b; padding: 40px; border-radius: 20px; box-shadow: 0 0 50px rgba(45, 212, 191, 0.2); text-align: center; width: 400px; border: 1px solid #334155; }
        h1 { margin-bottom: 30px; font-size: 24px; color: #ccfbf1; }
        .stat-card { background: #0f172a; padding: 15px; margin: 15px 0; border-radius: 12px; border-left: 5px solid #2dd4bf; text-align: left; }
        .label { font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px; }
        .value { font-size: 18px; font-weight: bold; color: #2dd4bf; margin-top: 5px; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>${config.name}</h1>
        <div class="stat-card">
          <div class="label">Status</div>
          <div class="value" id="status-text">Connecting...</div>
        </div>
        <div class="stat-card">
          <div class="label">Server</div>
          <div class="value">${config.server.ip}</div>
        </div>
      </div>
      <script>
        setInterval(async () => {
          try {
            const res = await fetch('/health');
            const data = await res.json();
            document.getElementById('status-text').innerText = data.status === 'connected' ? 'Online & Running' : 'Reconnecting...';
          } catch(e) {}
        }, 2000);
      </script>
    </body>
    </html>
  `);
});

app.get('/health', (req, res) => {
  res.json({
    status: botState.connected ? 'connected' : 'disconnected',
    uptime: Math.floor((Date.now() - botState.startTime) / 1000),
    coords: (bot && bot.entity) ? bot.entity.position : null,
    lastActivity: botState.lastActivity,
    reconnectAttempts: botState.reconnectAttempts,
    memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024
  });
});

app.get('/ping', (req, res) => res.send('pong'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] HTTP server started on port ${PORT}`);
});

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h${m}s`;
}

// ============================================================
// SELF-PING & MEMORY
// ============================================================
const SELF_PING_INTERVAL = 10 * 60 * 1000;
const https = require('https');

function startSelfPing() {
  setInterval(() => {
    const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(`${url}/ping`, () => {}).on('error', (err) => {
      console.log(`[KeepAlive] Self-ping failed: ${err.message}`);
    });
  }, SELF_PING_INTERVAL);
}
startSelfPing();

// ============================================================
// BOT CORE LOGIC
// ============================================================
let bot = null;
let activeIntervals = [];
let reconnectTimeout = null;
let isReconnecting = false;

function clearAllIntervals() {
  activeIntervals.forEach(id => clearInterval(id));
  activeIntervals = [];
}

function addInterval(callback, delay) {
  const id = setInterval(callback, delay);
  activeIntervals.push(id);
  return id;
}

function getReconnectDelay() {
  const baseDelay = config.utils['auto-reconnect-delay'] || 2000;
  const maxDelay = config.utils['max-reconnect-delay'] || 15000;
  return Math.min(baseDelay + (botState.reconnectAttempts * 1000), maxDelay);
}

function createBot() {
  if (isReconnecting) return;

  if (bot) {
    clearAllIntervals();
    try {
      bot.removeAllListeners();
      bot.end();
    } catch (e) {
      console.log('[Cleanup] Error ending previous bot:', e.message);
    }
    bot = null;
  }

  console.log(`[Bot] Connecting to ${config.server.ip}:${config.server.port}`);

  try {
    bot = mineflayer.createBot({
      username: config['bot-account'].username,
      password: config['bot-account'].password || undefined,
      auth: config['bot-account'].type,
      host: config.server.ip,
      port: config.server.port,
      version: config.server.version,
      hideErrors: false,
      checkTimeoutInterval: 120000
    });

    bot.loadPlugin(pathfinder);

    const connectionTimeout = setTimeout(() => {
      if (!botState.connected) {
        console.log('[Bot] Connection timeout - no spawn received');
        scheduleReconnect();
      }
    }, 60000);

    bot.once('spawn', () => {
      clearTimeout(connectionTimeout);
      botState.connected = true;
      botState.lastActivity = Date.now();
      botState.reconnectAttempts = 0;
      isReconnecting = false;
      console.log(`[Bot] [+] Successfully spawned on server!`);

      // Auth & Server Switch Handler
      bot.on('messagestr', (msg) => {
        const message = msg.toLowerCase();

        // Login Handler
        if (message.includes('login')) {
          bot.chat('/login botpranavne');
          console.log('[Auth] Login command sent');
        }

        // Register Handler
        if (message.includes('register')) {
          bot.chat('/register botpranavne botpranavne');
          console.log('[Auth] Register command sent');
        }

        // Dynamic Server Switch via chat/whisper
        const validServers = ['hub', 'pvp', 'lifesteal', 'survival'];
        for (const srv of validServers) {
          if (message.includes(srv)) {
            console.log(`[Switch] Switching to ${srv} server...`);
            bot.chat(`/server ${srv}`);
            break;
          }
        }
      });

      if (config.discord && config.discord.events.connect) {
        sendDiscordWebhook(`[+] **Connected** to \`${config.server.ip}\``, 0x4ade80);
      }

      const mcData = require('minecraft-data')(config.server.version);
      const defaultMove = new Movements(bot, mcData);
      initializeModules(bot, mcData, defaultMove);
      setupLeaveRejoin(bot, createBot);
    });

    bot.on('end', (reason) => {
      console.log(`[Bot] Disconnected: ${reason || 'Unknown reason'}`);
      botState.connected = false;
      clearAllIntervals();

      if (config.discord && config.discord.events.disconnect && reason !== 'Periodic Rejoin') {
        sendDiscordWebhook(`[-] **Disconnected**: ${reason || 'Unknown'}`, 0xf87171);
      }

      if (config.utils['auto-reconnect']) {
        scheduleReconnect();
      }
    });

    bot.on('kicked', (reason) => {
      console.log('[KICK]', typeof reason === 'string' ? reason : JSON.stringify(reason, null, 2));
    });

    bot.on('error', (err) => {
      console.log(`[Bot] Error: ${err.message}`);
      botState.errors.push({ type: 'error', message: err.message, time: Date.now() });
    });

  } catch (err) {
    console.log(`[Bot] Failed to create bot: ${err.message}`);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  if (isReconnecting) return;

  isReconnecting = true;
  botState.reconnectAttempts++;
  const delay = getReconnectDelay();
  console.log(`[Bot] Reconnecting in ${delay / 1000}s (attempt #${botState.reconnectAttempts})`);

  reconnectTimeout = setTimeout(() => {
    isReconnecting = false;
    createBot();
  }, delay);
}

// ============================================================
// MODULE INITIALIZATION
// ============================================================
function initializeModules(bot, mcData, defaultMove) {
  let authDone = false;
  bot.on('messagestr', (msg) => {
    const message = msg.toLowerCase();
    if (authDone) return;
    if (message.includes('/register') || message.includes('register')) {
      authDone = true;
      bot.chat('/register botpranavne botpranavne');
      return;
    }
    if (message.includes('/login') || message.includes('login')) {
      authDone = true;
      bot.chat('/login botpranavne');
      return;
    }
  });

  if (config.position.enabled) {
    bot.pathfinder.setMovements(defaultMove);
    bot.pathfinder.setGoal(new GoalBlock(config.position.x, config.position.y, config.position.z));
  }

  if (config.utils['anti-afk'].enabled) {
    addInterval(() => {
      if (bot && botState.connected) {
        bot.setControlState('jump', true);
        setTimeout(() => {
          if (bot) bot.setControlState('jump', false);
        }, 100);
        botState.lastActivity = Date.now();
      }
    }, 30000);

    if (config.utils['anti-afk'].sneak) {
      bot.setControlState('sneak', true);
    }
  }

  if (config.modules.avoidMobs) avoidMobs(bot);
  if (config.modules.combat) combatModule(bot, mcData);
  if (config.modules.beds) bedModule(bot, mcData);
  if (config.modules.chat) chatModule(bot);
}

const setupLeaveRejoin = require('./leaveRejoin');

function avoidMobs(bot) {
  const safeDistance = 5;
  addInterval(() => {
    if (!bot || !botState.connected) return;
    try {
      const entities = Object.values(bot.entities).filter(e => e.type === 'mob');
      for (const e of entities) {
        if (!e.position) continue;
        if (bot.entity.position.distanceTo(e.position) < safeDistance) {
          bot.setControlState('back', true);
          setTimeout(() => {
            if (bot) bot.setControlState('back', false);
          }, 500);
          break;
        }
      }
    } catch (e) {}
  }, 2000);
}

function combatModule(bot, mcData) {
  addInterval(() => {
    if (!bot || !botState.connected) return;
    try {
      if (config.combat['attack-mobs']) {
        const mobs = Object.values(bot.entities).filter(e => e.type === 'mob' && e.position && bot.entity.position.distanceTo(e.position) < 4);
        if (mobs.length > 0) bot.attack(mobs[0]);
      }
    } catch (e) {}
  }, 1500);

  bot.on('health', () => {
    if (!config.combat['auto-eat']) return;
    try {
      if (bot.food < 14) {
        const food = bot.inventory.items().find(i => mcData.itemsByName[i.name]?.food);
        if (food) bot.equip(food, 'hand').then(() => bot.consume()).catch(() => {});
      }
    } catch (e) {}
  });
}

function bedModule(bot, mcData) {
  addInterval(async () => {
    if (!bot || !botState.connected) return;
    try {
      const isNight = bot.time.timeOfDay >= 12500 && bot.time.timeOfDay <= 23500;
      if (config.beds['place-night'] && isNight && !bot.isSleeping) {
        const bedBlock = bot.findBlock({ matching: block => block.name.includes('bed'), maxDistance: 8 });
        if (bedBlock) await bot.sleep(bedBlock);
      }
    } catch (e) {}
  }, 10000);
}

function chatModule(bot) {
  bot.on('chat', (username, message) => {
    if (!bot || username === bot.username) return;
    if (config.chat.respond) {
      const lowerMsg = message.toLowerCase();
      if (lowerMsg.includes('hello') || lowerMsg.includes('hi')) bot.chat(`Hello, ${username}!`);
    }
  });
}

// ============================================================
// DISCORD WEBHOOK
// ============================================================
function sendDiscordWebhook(content, color = 0x0099ff) {
  if (!config.discord || !config.discord.enabled || !config.discord.webhookUrl || config.discord.webhookUrl.includes('YOUR_DISCORD')) return;
  const protocol = config.discord.webhookUrl.startsWith('https') ? https : http;
  const urlParts = new URL(config.discord.webhookUrl);
  const payload = JSON.stringify({
    username: config.name,
    embeds: [{ description: content, color: color, timestamp: new Date().toISOString() }]
  });
  const req = protocol.request({
    hostname: urlParts.hostname,
    port: 443,
    path: urlParts.pathname + urlParts.search,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length }
  });
  req.on('error', () => {});
  req.write(payload);
  req.end();
}

// ============================================================
// CRASH RECOVERY
// ============================================================
process.on('uncaughtException', (err) => {
  console.log(`[FATAL] Uncaught Exception: ${err.message}`);
  botState.errors.push({ type: 'uncaught', message: err.message, time: Date.now() });
  if (config.utils['auto-reconnect']) {
    clearAllIntervals();
    setTimeout(() => { scheduleReconnect(); }, 1000);
  }
});

process.on('unhandledRejection', (reason) => {
  console.log(`[FATAL] Unhandled Rejection: ${reason}`);
  botState.errors.push({ type: 'rejection', message: String(reason), time: Date.now() });
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

// ============================================================
// START THE BOT
// ============================================================
console.log('='.repeat(50));
console.log(' Minecraft AFK Bot v2.3 - Bug Fix Edition');
console.log('='.repeat(50));
createBot();
      
