#!/usr/bin/env node
/**
 * telegram-adapter.js - Telegram Bot Adapter for Claude Agent System
 *
 * Connects a Telegram Bot to the local agent-engine, allowing remote
 * control of the Claude Agent System from Telegram.
 *
 * Features:
 *   - /status  → System status report
 *   - /metrics → Audit log metrics
 *   - /queue   → View lane queue
 *   - /run <command> → Execute command via lane queue
 *   - /checkpoint [summary] → Write checkpoint
 *   - /logs [n] → Last n audit entries
 *   - /orchestrate <goal> → Run orchestrator
 *   - /help → Command list
 *   - Real-time audit notifications (opt-in)
 *
 * Setup:
 *   1. Create bot via @BotFather → get token
 *   2. node telegram-adapter.js --setup <BOT_TOKEN>
 *   3. Send /start to your bot → auto-registers chat ID
 *   4. node telegram-adapter.js  (or --daemon for background)
 *
 * Config: ~/.claude/.telegram-config.json
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync, spawn } = require('child_process');
const { CLAUDE_DIR, HOOKS_DIR, AUDIT_DIR, LOGS_DIR } = require('./lib/paths');
const { readJsonl, localDate } = require('./lib/utils');

const CONFIG_FILE = path.join(CLAUDE_DIR, '.telegram-config.json');
const PID_FILE = path.join(CLAUDE_DIR, 'telegram-adapter.pid');
const SESSION_ID = 'telegram';

// ── Telegram Bot API ──
class TelegramBot {
  constructor(token) {
    this.token = token;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.offset = 0;
    this.polling = false;
  }

  async api(method, body = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.baseUrl}/${method}`);
      const opts = {
        hostname: url.hostname,
        path: url.pathname,
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : {},
      };
      const req = https.request(opts, (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.ok) resolve(parsed.result);
            else reject(new Error(parsed.description || 'Telegram API error'));
          } catch { reject(new Error('Invalid JSON response')); }
        });
      });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async getMe() {
    return this.api('getMe');
  }

  async sendMessage(chatId, text, opts = {}) {
    const body = {
      chat_id: chatId,
      text: text.slice(0, 4096), // Telegram limit
      parse_mode: opts.parseMode || 'Markdown',
      ...opts,
    };
    try {
      return await this.api('sendMessage', body);
    } catch (e) {
      // Retry without markdown if parse fails
      if (e.message && e.message.includes("can't parse")) {
        body.parse_mode = undefined;
        return this.api('sendMessage', body);
      }
      throw e;
    }
  }

  async getUpdates(timeout = 30) {
    return this.api('getUpdates', {
      offset: this.offset,
      timeout,
      allowed_updates: ['message'],
    });
  }

  async poll(handler) {
    this.polling = true;
    while (this.polling) {
      try {
        const updates = await this.getUpdates(30);
        for (const update of updates) {
          this.offset = update.update_id + 1;
          if (update.message && update.message.text) {
            await handler(update.message);
          }
        }
      } catch (e) {
        log('warn', `Poll error: ${e.message}`);
        await sleep(5000);
      }
    }
  }

  stop() {
    this.polling = false;
  }
}

// ── Config ──
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
}

// ── Agent Engine (direct require) ──
let engine;
try {
  engine = require('./agent-engine.js');
} catch (e) {
  log('warn', `agent-engine require failed: ${e.message}`);
  engine = null;
}

// ── Security ──
const BLOCKED = [
  /rm\s+-rf/i, /--force/i, /--hard/i,
  /drop\s+(database|table)/i, /curl.*\|\s*(sh|bash)/i,
  /shutdown/i, /reboot/i, /npm\s+publish/i,
];

function isAllowed(cmd) {
  if (!cmd || typeof cmd !== 'string') return false;
  return !BLOCKED.some(p => p.test(cmd.trim()));
}

// ── Helpers ──
function log(level, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  const prefix = { info: '[INFO]', warn: '[WARN]', error: '[ERR]' };
  console.log(`${ts} ${prefix[level] || '[???]'} ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function escMd(s) {
  // Escape Markdown special chars for Telegram
  return String(s).replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

// ── Command Handlers ──
async function handleMessage(bot, config, message) {
  const chatId = message.chat.id;
  const text = (message.text || '').trim();
  const userId = message.from.id;

  // Auth check: only allowed chat IDs
  if (config.allowedChatIds && config.allowedChatIds.length > 0) {
    if (!config.allowedChatIds.includes(chatId)) {
      log('warn', `Unauthorized chat: ${chatId} (user: ${userId})`);
      return;
    }
  }

  // Auto-register on /start
  if (text === '/start') {
    if (!config.allowedChatIds) config.allowedChatIds = [];
    if (!config.allowedChatIds.includes(chatId)) {
      config.allowedChatIds.push(chatId);
      saveConfig(config);
      log('info', `Registered chat: ${chatId}`);
    }
    await bot.sendMessage(chatId,
      `*Claude Agent System* connected\\!\n\n` +
      `Chat ID: \`${chatId}\`\n` +
      `Type /help for commands\\.`,
      { parseMode: 'MarkdownV2' }
    );
    return;
  }

  // Parse command
  const [cmd, ...args] = text.split(/\s+/);
  const argStr = args.join(' ');

  switch (cmd.toLowerCase().replace(/@\w+$/, '')) {
    case '/help':
      await cmdHelp(bot, chatId);
      break;
    case '/status':
      await cmdStatus(bot, chatId);
      break;
    case '/metrics':
      await cmdMetrics(bot, chatId);
      break;
    case '/queue':
      await cmdQueue(bot, chatId);
      break;
    case '/run':
      await cmdRun(bot, chatId, argStr);
      break;
    case '/checkpoint':
      await cmdCheckpoint(bot, chatId, argStr);
      break;
    case '/logs':
      await cmdLogs(bot, chatId, parseInt(args[0]) || 10);
      break;
    case '/orchestrate':
      await cmdOrchestrate(bot, chatId, argStr);
      break;
    case '/notify':
      await cmdNotify(bot, chatId, config, args[0]);
      break;
    default:
      if (text.startsWith('/')) {
        await bot.sendMessage(chatId, `Unknown command: ${cmd}\nType /help for available commands.`, { parseMode: undefined });
      }
  }
}

async function cmdHelp(bot, chatId) {
  await bot.sendMessage(chatId,
    `*Claude Agent System - Commands*\n\n` +
    `/status - System status\n` +
    `/metrics - Today's metrics\n` +
    `/queue - Lane queue status\n` +
    `/run <cmd> - Execute command\n` +
    `/checkpoint [msg] - Write checkpoint\n` +
    `/logs [n] - Last n audit entries\n` +
    `/orchestrate <goal> - Run orchestrator\n` +
    `/notify on|off - Toggle notifications\n` +
    `/help - This message`
  );
}

async function cmdStatus(bot, chatId) {
  if (!engine) {
    await bot.sendMessage(chatId, 'agent-engine not available', { parseMode: undefined });
    return;
  }
  const status = engine.getStatus();
  const lines = [
    `*System Status*`,
    ``,
    `Actions today: ${status.todayActions || 0}`,
    `Rate: ${status.opsPerMin || 0} ops/min`,
    `Checkpoints: ${status.checkpoints || 0}`,
    `Queue pending: ${status.queuePending || 0}`,
    `Uptime: ${Math.floor(process.uptime())}s`,
  ];
  await bot.sendMessage(chatId, lines.join('\n'));
}

async function cmdMetrics(bot, chatId) {
  if (!engine) {
    await bot.sendMessage(chatId, 'agent-engine not available', { parseMode: undefined });
    return;
  }
  const metrics = engine.getMetrics();
  const lines = [
    `*Metrics*`,
    ``,
    `Total entries: ${metrics.total || 0}`,
    `Errors: ${metrics.errors || 0}`,
    `Tools used: ${Object.keys(metrics.toolCounts || {}).length}`,
  ];
  if (metrics.toolCounts) {
    const top5 = Object.entries(metrics.toolCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    lines.push('', '*Top tools:*');
    for (const [tool, count] of top5) {
      lines.push(`  ${tool}: ${count}`);
    }
  }
  await bot.sendMessage(chatId, lines.join('\n'));
}

async function cmdQueue(bot, chatId) {
  if (!engine) {
    await bot.sendMessage(chatId, 'agent-engine not available', { parseMode: undefined });
    return;
  }
  const stats = engine.laneStats(SESSION_ID);
  const lines = [
    `*Lane Queue (${SESSION_ID})*`,
    ``,
    `Pending: ${stats.pending}`,
    `Running: ${stats.running}`,
    `Completed: ${stats.completed}`,
    `Failed: ${stats.failed}`,
    `Locked: ${stats.locked ? 'Yes' : 'No'}`,
  ];
  await bot.sendMessage(chatId, lines.join('\n'));
}

async function cmdRun(bot, chatId, command) {
  if (!command) {
    await bot.sendMessage(chatId, 'Usage: /run <command>', { parseMode: undefined });
    return;
  }
  if (!isAllowed(command)) {
    await bot.sendMessage(chatId, 'Command blocked by security policy.', { parseMode: undefined });
    return;
  }
  if (!engine) {
    await bot.sendMessage(chatId, 'agent-engine not available', { parseMode: undefined });
    return;
  }

  const result = engine.laneAdd(SESSION_ID, command, 'normal');
  await bot.sendMessage(chatId, `Queued: \`${command}\`\nID: ${result.id}`, { parseMode: 'Markdown' });

  // Execute immediately in background
  setImmediate(async () => {
    const next = engine.laneNext(SESSION_ID);
    if (!next || next.empty || next.locked) return;

    const item = next.item;
    if (!item) return;

    try {
      const output = execSync(item.command, {
        encoding: 'utf8',
        timeout: 30000,
        cwd: process.env.HOME,
      });
      engine.laneComplete(SESSION_ID, item.id, 'ok');
      const trimmed = output.trim().slice(0, 3000);
      await bot.sendMessage(chatId,
        `*Done:* \`${item.command}\`\n\`\`\`\n${trimmed || '(no output)'}\n\`\`\``,
      );
    } catch (e) {
      const errMsg = (e.stderr || e.message || 'error').slice(0, 1000);
      engine.laneFail(SESSION_ID, item.id, errMsg);
      await bot.sendMessage(chatId,
        `*Failed:* \`${item.command}\`\n\`\`\`\n${errMsg}\n\`\`\``,
      );
    }
  });
}

async function cmdCheckpoint(bot, chatId, summary) {
  if (!engine) {
    await bot.sendMessage(chatId, 'agent-engine not available', { parseMode: undefined });
    return;
  }
  const msg = summary || `Telegram checkpoint at ${new Date().toISOString()}`;
  engine.writeCheckpoint(msg, []);
  await bot.sendMessage(chatId, `Checkpoint saved: ${msg}`, { parseMode: undefined });
}

async function cmdLogs(bot, chatId, count) {
  const auditFile = path.join(AUDIT_DIR, `audit-${localDate()}.jsonl`);
  const entries = readJsonl(auditFile);
  const recent = entries.slice(-count);

  if (recent.length === 0) {
    await bot.sendMessage(chatId, 'No audit entries today.', { parseMode: undefined });
    return;
  }

  const lines = [`*Last ${recent.length} audit entries:*`, ''];
  for (const e of recent) {
    const time = (e.ts || '').slice(11, 19);
    const ok = e.ok ? '✓' : '✗';
    lines.push(`${time} ${ok} ${e.tool || '?'}: ${(e.summary || '').slice(0, 60)}`);
  }
  await bot.sendMessage(chatId, lines.join('\n'));
}

async function cmdOrchestrate(bot, chatId, goal) {
  if (!goal) {
    await bot.sendMessage(chatId, 'Usage: /orchestrate <goal>', { parseMode: undefined });
    return;
  }

  const orchScript = path.join(HOOKS_DIR, 'orchestrator.js');
  if (!fs.existsSync(orchScript)) {
    await bot.sendMessage(chatId, 'orchestrator.js not found', { parseMode: undefined });
    return;
  }

  await bot.sendMessage(chatId, `Orchestrating: ${goal}`, { parseMode: undefined });

  try {
    const logFile = path.join(LOGS_DIR, 'orch-latest.log');
    const out = fs.openSync(logFile, 'a');
    const child = spawn('node', [orchScript, goal, process.env.HOME || '/root'], {
      detached: true,
      stdio: ['ignore', out, out],
    });
    child.unref();
    await bot.sendMessage(chatId, `Orchestrator started (PID: ${child.pid})`, { parseMode: undefined });
  } catch (e) {
    await bot.sendMessage(chatId, `Orchestrator failed: ${e.message}`, { parseMode: undefined });
  }
}

async function cmdNotify(bot, chatId, config, toggle) {
  if (toggle === 'on') {
    config.notifyChat = chatId;
    saveConfig(config);
    await bot.sendMessage(chatId, 'Audit notifications enabled for this chat.', { parseMode: undefined });
  } else if (toggle === 'off') {
    delete config.notifyChat;
    saveConfig(config);
    await bot.sendMessage(chatId, 'Audit notifications disabled.', { parseMode: undefined });
  } else {
    const status = config.notifyChat === chatId ? 'ON' : 'OFF';
    await bot.sendMessage(chatId, `Notifications: ${status}\nUsage: /notify on|off`, { parseMode: undefined });
  }
}

// ── Audit Notification Watcher ──
function startAuditWatcher(bot, config) {
  let lastSize = 0;
  const auditFile = () => path.join(AUDIT_DIR, `audit-${localDate()}.jsonl`);

  // Initialize offset
  try {
    const content = fs.readFileSync(auditFile(), 'utf8');
    lastSize = content.length;
  } catch {}

  setInterval(() => {
    if (!config.notifyChat) return;
    const file = auditFile();
    if (!fs.existsSync(file)) return;

    try {
      const content = fs.readFileSync(file, 'utf8');
      if (content.length <= lastSize) return;

      const newPart = content.slice(lastSize);
      lastSize = content.length;

      const entries = newPart.trim().split('\n').filter(Boolean).map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);

      // Only notify errors and warnings
      const notable = entries.filter(e => !e.ok || e.level === 'warn');
      if (notable.length === 0) return;

      const lines = notable.map(e => {
        const ok = e.ok ? '✓' : '✗';
        return `${ok} ${e.tool}: ${(e.summary || '').slice(0, 80)}`;
      });

      bot.sendMessage(config.notifyChat,
        `*Agent Alert* (${notable.length} events)\n\`\`\`\n${lines.join('\n')}\n\`\`\``,
      ).catch(() => {});
    } catch {}
  }, 5000);
}

// ── CLI ──
async function main() {
  const args = process.argv.slice(2);

  // --setup <token>
  if (args[0] === '--setup') {
    const token = args[1];
    if (!token) {
      console.error('Usage: node telegram-adapter.js --setup <BOT_TOKEN>');
      console.error('  Get token from @BotFather on Telegram');
      process.exit(1);
    }

    const bot = new TelegramBot(token);
    try {
      const me = await bot.getMe();
      console.log(`Bot verified: @${me.username} (${me.first_name})`);
    } catch (e) {
      console.error(`Invalid token: ${e.message}`);
      process.exit(1);
    }

    const config = { botToken: token, allowedChatIds: [], createdAt: new Date().toISOString() };
    saveConfig(config);
    console.log(`Config saved: ${CONFIG_FILE}`);
    console.log('\nNext steps:');
    console.log('  1. Send /start to your bot in Telegram');
    console.log('  2. Run: node telegram-adapter.js');
    return;
  }

  // --status
  if (args[0] === '--status') {
    if (fs.existsSync(PID_FILE)) {
      const pid = fs.readFileSync(PID_FILE, 'utf8').trim();
      try {
        process.kill(parseInt(pid), 0);
        console.log(`Telegram adapter running (PID: ${pid})`);
      } catch {
        console.log('Telegram adapter not running (stale PID file)');
        fs.unlinkSync(PID_FILE);
      }
    } else {
      console.log('Telegram adapter not running');
    }
    const config = loadConfig();
    console.log(`Config: ${config.botToken ? 'configured' : 'NOT configured'}`);
    console.log(`Allowed chats: ${(config.allowedChatIds || []).length}`);
    return;
  }

  // --stop
  if (args[0] === '--stop') {
    if (fs.existsSync(PID_FILE)) {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim());
      try {
        process.kill(pid, 'SIGTERM');
        console.log(`Stopped (PID: ${pid})`);
      } catch {
        console.log('Process not found');
      }
      fs.unlinkSync(PID_FILE);
    } else {
      console.log('Not running');
    }
    return;
  }

  // --daemon
  if (args[0] === '--daemon') {
    const logFile = path.join(LOGS_DIR, 'telegram-adapter.log');
    const out = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, [__filename], {
      detached: true,
      stdio: ['ignore', out, out],
    });
    child.unref();
    fs.writeFileSync(PID_FILE, String(child.pid));
    console.log(`Telegram adapter started in background (PID: ${child.pid})`);
    console.log(`Log: ${logFile}`);
    return;
  }

  // Normal start
  const config = loadConfig();
  if (!config.botToken) {
    console.error('Not configured. Run: node telegram-adapter.js --setup <BOT_TOKEN>');
    process.exit(1);
  }

  const bot = new TelegramBot(config.botToken);

  // Verify bot
  try {
    const me = await bot.getMe();
    log('info', `Bot: @${me.username}`);
  } catch (e) {
    log('error', `Bot verification failed: ${e.message}`);
    process.exit(1);
  }

  // Write PID
  fs.writeFileSync(PID_FILE, String(process.pid));

  log('info', '=== Telegram Adapter Started ===');
  log('info', `Allowed chats: ${(config.allowedChatIds || []).join(', ') || '(none - send /start to register)'}`);

  // Start audit watcher
  startAuditWatcher(bot, config);

  // Start polling
  process.on('SIGINT', () => {
    log('info', 'Shutting down...');
    bot.stop();
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    bot.stop();
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
    process.exit(0);
  });

  await bot.poll((message) => handleMessage(bot, config, message));
}

// Only run when executed directly
if (require.main === module) {
  main().catch(e => {
    log('error', `Fatal: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { TelegramBot, handleMessage };
