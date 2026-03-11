#!/usr/bin/env node
/**
 * telegram-adapter.js v2 - Telegram Bot + Claude Agent SDK + SQLite Session
 *
 * Architecture (claude-code-telegram pattern):
 *   [Telegram] ←→ [Bot Polling] ←→ [Claude Agent SDK query()] ←→ [Local Tools]
 *                                         ↕
 *                                   [SQLite Session DB]
 *
 * Features:
 *   - Claude Agent SDK 직접 연동 (세션 유지 + 스트리밍)
 *   - SQLite 세션 영속화 (채팅별 자동 resume)
 *   - SDK 실패 시 CLI 폴백 (claude -p --resume)
 *   - /status, /metrics, /logs 등 시스템 명령 유지
 *   - 실시간 감사 로그 알림 (opt-in)
 *   - --daemon 백그라운드 모드
 *
 * Setup:
 *   1. Create bot via @BotFather → get token
 *   2. node telegram-adapter.js --setup <BOT_TOKEN>
 *   3. Send /start to your bot → auto-registers chat ID
 *   4. node telegram-adapter.js  (or --daemon for background)
 *
 * Config: ~/.claude/.telegram-config.json
 * DB:     ~/.claude/telegram-sessions.db
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync, execFileSync, spawn } = require('child_process');
const { CLAUDE_DIR, HOOKS_DIR, AUDIT_DIR, LOGS_DIR } = require('./lib/paths');
const { readJsonl, localDate } = require('./lib/utils');

const CONFIG_FILE = path.join(CLAUDE_DIR, '.telegram-config.json');
const DB_FILE = path.join(CLAUDE_DIR, 'telegram-sessions.db');
const PID_FILE = path.join(CLAUDE_DIR, 'telegram-adapter.pid');

// ── Lazy imports (may not be installed) ──
let query, Database;

function loadSDK() {
  if (!query) {
    try {
      ({ query } = require('@anthropic-ai/claude-agent-sdk'));
    } catch {
      log('warn', 'Claude Agent SDK not installed. Using CLI fallback.');
    }
  }
  return !!query;
}

function loadSQLite() {
  if (!Database) {
    try {
      Database = require('better-sqlite3');
    } catch {
      log('warn', 'better-sqlite3 not installed. Sessions will not persist.');
    }
  }
  return !!Database;
}

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

  async getMe() { return this.api('getMe'); }

  async sendMessage(chatId, text, opts = {}) {
    const body = { chat_id: chatId, text: text.slice(0, 4096), parse_mode: opts.parseMode || 'Markdown', ...opts };
    try {
      return await this.api('sendMessage', body);
    } catch (e) {
      if (e.message && e.message.includes("can't parse")) {
        body.parse_mode = undefined;
        return this.api('sendMessage', body);
      }
      throw e;
    }
  }

  async editMessage(chatId, messageId, text, opts = {}) {
    return this.api('editMessageText', {
      chat_id: chatId, message_id: messageId,
      text: text.slice(0, 4096), parse_mode: opts.parseMode || 'Markdown', ...opts,
    }).catch(() => {});
  }

  async sendChatAction(chatId, action = 'typing') {
    return this.api('sendChatAction', { chat_id: chatId, action }).catch(() => {});
  }

  async getUpdates(timeout = 30) {
    return this.api('getUpdates', { offset: this.offset, timeout, allowed_updates: ['message'] });
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

  stop() { this.polling = false; }
}

// ── SQLite Session Store ──
class SessionStore {
  constructor(dbPath) {
    this.db = null;
    this.dbPath = dbPath;
  }

  init() {
    if (!loadSQLite()) return false;
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        chat_id INTEGER NOT NULL,
        cwd TEXT NOT NULL DEFAULT '/',
        session_id TEXT,
        last_prompt TEXT,
        updated_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        message_count INTEGER DEFAULT 0,
        PRIMARY KEY (chat_id, cwd)
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
    `);
    return true;
  }

  getSession(chatId, cwd = '/') {
    if (!this.db) return null;
    return this.db.prepare(
      'SELECT * FROM sessions WHERE chat_id = ? AND cwd = ?'
    ).get(chatId, cwd) || null;
  }

  saveSession(chatId, sessionId, cwd = '/', lastPrompt = '') {
    if (!this.db) return;
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO sessions (chat_id, cwd, session_id, last_prompt, updated_at, created_at, message_count)
      VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(chat_id, cwd) DO UPDATE SET
        session_id = excluded.session_id,
        last_prompt = excluded.last_prompt,
        updated_at = excluded.updated_at,
        message_count = message_count + 1
    `).run(chatId, cwd, sessionId, lastPrompt.slice(0, 500), now, now);
  }

  clearSession(chatId, cwd = '/') {
    if (!this.db) return;
    this.db.prepare('DELETE FROM sessions WHERE chat_id = ? AND cwd = ?').run(chatId, cwd);
  }

  listSessions(chatId) {
    if (!this.db) return [];
    return this.db.prepare(
      'SELECT * FROM sessions WHERE chat_id = ? ORDER BY updated_at DESC LIMIT 10'
    ).all(chatId);
  }

  close() {
    if (this.db) { this.db.close(); this.db = null; }
  }
}

// ── Claude Integration (SDK primary, CLI fallback) ──
class ClaudeIntegration {
  constructor(sessionStore) {
    this.store = sessionStore;
    this.activeSessions = new Map(); // chatId → AbortController (for /stop)
    this.sdkAvailable = loadSDK();
  }

  async runQuery(chatId, prompt, bot, cwd = '/') {
    // Check for active session
    if (this.activeSessions.has(chatId)) {
      await bot.sendMessage(chatId, 'Already processing a request. Use /stop to cancel.', { parseMode: undefined });
      return;
    }

    // Get existing session for resume
    const existing = this.store.getSession(chatId, cwd);
    const resumeId = existing ? existing.session_id : undefined;

    // Send typing indicator
    await bot.sendChatAction(chatId);

    if (this.sdkAvailable) {
      await this._runSDK(chatId, prompt, bot, cwd, resumeId);
    } else {
      await this._runCLI(chatId, prompt, bot, cwd, resumeId);
    }
  }

  async _runSDK(chatId, prompt, bot, cwd, resumeId) {
    const statusMsg = await bot.sendMessage(chatId, '_Processing..._');
    const statusMsgId = statusMsg ? statusMsg.message_id : null;

    let resultText = '';
    let newSessionId = null;
    let lastUpdate = 0;
    const UPDATE_INTERVAL = 2000; // Update message every 2s max

    try {
      const opts = {
        allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
        maxTurns: 30,
        permissionMode: 'bypassPermissions',
        systemPrompt: { type: 'preset', preset: 'claude_code' },
      };

      if (resumeId) opts.resume = resumeId;

      const stream = query({ prompt, options: opts });
      this.activeSessions.set(chatId, stream);

      for await (const message of stream) {
        // Capture session ID early
        if (message.session_id && !newSessionId) {
          newSessionId = message.session_id;
        }

        // System init
        if (message.type === 'system' && message.session_id) {
          newSessionId = message.session_id;
        }

        // Collect assistant text
        if (message.type === 'assistant' && message.message) {
          const content = message.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text') resultText += block.text;
            }
          }
        }

        // Result message
        if (message.type === 'result') {
          if (message.session_id) newSessionId = message.session_id;
          if (message.subtype === 'success' && message.result) {
            resultText = message.result;
          } else if (message.subtype === 'error_max_turns') {
            resultText += '\n\n(Max turns reached)';
          }
        }

        // Periodic status update
        const now = Date.now();
        if (statusMsgId && resultText && now - lastUpdate > UPDATE_INTERVAL) {
          lastUpdate = now;
          const preview = resultText.slice(-3500);
          await bot.editMessage(chatId, statusMsgId, preview.length < resultText.length
            ? `...${preview}` : preview);
          await bot.sendChatAction(chatId);
        }
      }
    } catch (e) {
      log('error', `SDK error: ${e.message}`);
      // Fallback to CLI
      if (resultText.length === 0) {
        log('info', 'SDK failed, falling back to CLI');
        this.activeSessions.delete(chatId);
        if (statusMsgId) await bot.editMessage(chatId, statusMsgId, '_SDK failed, using CLI..._');
        return this._runCLI(chatId, prompt, bot, cwd, resumeId);
      }
    } finally {
      this.activeSessions.delete(chatId);
    }

    // Save session
    if (newSessionId) {
      this.store.saveSession(chatId, newSessionId, cwd, prompt);
      log('info', `Session saved: chat=${chatId} session=${newSessionId.slice(0, 12)}...`);
    }

    // Send final result
    if (resultText) {
      // Delete status message and send final
      if (statusMsgId) await bot.editMessage(chatId, statusMsgId, resultText.slice(0, 4096));
      // Send remaining chunks if long
      if (resultText.length > 4096) {
        const chunks = splitMessage(resultText);
        for (let i = 1; i < chunks.length; i++) {
          await bot.sendMessage(chatId, chunks[i]);
        }
      }
    } else {
      if (statusMsgId) await bot.editMessage(chatId, statusMsgId, '(No response)');
    }
  }

  async _runCLI(chatId, prompt, bot, cwd, resumeId) {
    try {
      const args = ['-p', prompt, '--output-format', 'text'];
      if (resumeId) args.push('--resume', resumeId);

      const result = execFileSync('claude', args, {
        encoding: 'utf8',
        timeout: 120000,
        cwd: cwd === '/' ? process.env.HOME : cwd,
        env: { ...process.env, CLAUDE_AGENT_SDK_FALLBACK: '1' },
      });

      // Try to extract session ID from CLI output
      const sidMatch = result.match(/session[_-]?id[:\s]+([a-f0-9-]+)/i);
      if (sidMatch) {
        this.store.saveSession(chatId, sidMatch[1], cwd, prompt);
      }

      const trimmed = result.trim().slice(0, 4096);
      await bot.sendMessage(chatId, trimmed || '(No output)', { parseMode: undefined });
    } catch (e) {
      const errMsg = (e.stderr || e.message || 'error').slice(0, 1000);
      await bot.sendMessage(chatId, `Error: ${errMsg}`, { parseMode: undefined });
    }
  }

  stopQuery(chatId) {
    const stream = this.activeSessions.get(chatId);
    if (stream && typeof stream.close === 'function') {
      stream.close();
      this.activeSessions.delete(chatId);
      return true;
    }
    return false;
  }
}

// ── Config ──
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
}

// ── Agent Engine ──
let engine;
try { engine = require('./agent-engine.js'); } catch { engine = null; }

// ── Security ──
const BLOCKED = [
  /rm\s+-rf/i, /--force/i, /--hard/i,
  /drop\s+(database|table)/i, /curl.*\|\s*(sh|bash)/i,
  /shutdown/i, /reboot/i, /npm\s+publish/i,
  /base64.*\|\s*(sh|bash)/i, /\beval\b/i, /\bexec\b/i,
  /python.*-c/i, /node.*-e/i, /perl.*-e/i,
  /\bdd\b.*of=/i, /mkfs/i, /format\b/i,
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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function splitMessage(text, maxLen = 4096) {
  const chunks = [];
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen));
  }
  return chunks;
}

// ── Message Handler ──
async function handleMessage(bot, config, claude, message) {
  const chatId = message.chat.id;
  const text = (message.text || '').trim();

  // Auth check
  if (config.allowedChatIds && config.allowedChatIds.length > 0) {
    if (!config.allowedChatIds.includes(chatId)) {
      log('warn', `Unauthorized chat: ${chatId}`);
      return;
    }
  }

  // /start - register
  if (text === '/start') {
    if (!config.allowedChatIds) config.allowedChatIds = [];
    if (!config.allowedChatIds.includes(chatId)) {
      config.allowedChatIds.push(chatId);
      saveConfig(config);
      log('info', `Registered chat: ${chatId}`);
    }
    await bot.sendMessage(chatId,
      `*Claude Agent System v2* connected!\n\nChat ID: \`${chatId}\`\nSDK: ${claude.sdkAvailable ? 'Active' : 'CLI fallback'}\nType /help for commands.`
    );
    return;
  }

  // Parse command
  const [cmd, ...args] = text.split(/\s+/);
  const argStr = args.join(' ');
  const command = cmd.toLowerCase().replace(/@\w+$/, '');

  // System commands (no SDK needed)
  switch (command) {
    case '/help':    return cmdHelp(bot, chatId, claude.sdkAvailable);
    case '/status':  return cmdStatus(bot, chatId);
    case '/metrics': return cmdMetrics(bot, chatId);
    case '/logs':    return cmdLogs(bot, chatId, parseInt(args[0]) || 10);
    case '/queue':   return cmdQueue(bot, chatId);
    case '/notify':  return cmdNotify(bot, chatId, config, args[0]);
    case '/stop':    return cmdStop(bot, chatId, claude);
    case '/new':     return cmdNew(bot, chatId, claude);
    case '/sessions': return cmdSessions(bot, chatId, claude);
    case '/run':     return cmdRun(bot, chatId, argStr);
    case '/checkpoint': return cmdCheckpoint(bot, chatId, argStr);
    case '/orchestrate': return cmdOrchestrate(bot, chatId, argStr);
  }

  // Non-command text → send to Claude as conversation
  if (!text.startsWith('/')) {
    await claude.runQuery(chatId, text, bot);
    return;
  }

  await bot.sendMessage(chatId, `Unknown: ${cmd}. /help for commands.`, { parseMode: undefined });
}

// ── Command Handlers ──
async function cmdHelp(bot, chatId, sdkActive) {
  await bot.sendMessage(chatId,
    `*Commands*\n\n` +
    `*Conversation (SDK ${sdkActive ? '✓' : '✗'}):*\n` +
    `Just type naturally - Claude responds with full context\n` +
    `/stop - Cancel current query\n` +
    `/new - Start fresh session\n` +
    `/sessions - List saved sessions\n\n` +
    `*System:*\n` +
    `/status - System status\n` +
    `/metrics - Today's metrics\n` +
    `/logs [n] - Last n audit entries\n` +
    `/queue - Lane queue\n` +
    `/run <cmd> - Execute shell command\n` +
    `/checkpoint [msg] - Write checkpoint\n` +
    `/orchestrate <goal> - Run orchestrator\n` +
    `/notify on|off - Alert toggle\n` +
    `/help - This message`
  );
}

async function cmdStop(bot, chatId, claude) {
  if (claude.stopQuery(chatId)) {
    await bot.sendMessage(chatId, 'Query cancelled.', { parseMode: undefined });
  } else {
    await bot.sendMessage(chatId, 'No active query.', { parseMode: undefined });
  }
}

async function cmdNew(bot, chatId, claude) {
  claude.store.clearSession(chatId);
  await bot.sendMessage(chatId, 'Session cleared. Next message starts a fresh conversation.', { parseMode: undefined });
}

async function cmdSessions(bot, chatId, claude) {
  const sessions = claude.store.listSessions(chatId);
  if (sessions.length === 0) {
    await bot.sendMessage(chatId, 'No saved sessions.', { parseMode: undefined });
    return;
  }
  const lines = ['*Saved Sessions:*', ''];
  for (const s of sessions) {
    const sid = s.session_id ? s.session_id.slice(0, 12) + '...' : 'none';
    const time = s.updated_at ? s.updated_at.slice(0, 16) : '?';
    lines.push(`\`${sid}\` (${s.message_count} msgs) ${time}`);
    if (s.last_prompt) lines.push(`  _${s.last_prompt.slice(0, 60)}_`);
  }
  await bot.sendMessage(chatId, lines.join('\n'));
}

async function cmdStatus(bot, chatId) {
  if (!engine) return bot.sendMessage(chatId, 'agent-engine not available', { parseMode: undefined });
  const status = engine.getStatus();
  await bot.sendMessage(chatId, [
    '*System Status*', '',
    `Actions today: ${status.todayActions || 0}`,
    `Rate: ${status.opsPerMin || 0} ops/min`,
    `Checkpoints: ${status.checkpoints || 0}`,
    `Queue pending: ${status.queuePending || 0}`,
    `Uptime: ${Math.floor(process.uptime())}s`,
  ].join('\n'));
}

async function cmdMetrics(bot, chatId) {
  if (!engine) return bot.sendMessage(chatId, 'agent-engine not available', { parseMode: undefined });
  const m = engine.getMetrics();
  const lines = ['*Metrics*', '', `Total: ${m.total || 0}`, `Errors: ${m.errors || 0}`];
  if (m.toolCounts) {
    const top5 = Object.entries(m.toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    lines.push('', '*Top tools:*');
    for (const [t, c] of top5) lines.push(`  ${t}: ${c}`);
  }
  await bot.sendMessage(chatId, lines.join('\n'));
}

async function cmdLogs(bot, chatId, count) {
  const entries = readJsonl(path.join(AUDIT_DIR, `audit-${localDate()}.jsonl`));
  const recent = entries.slice(-count);
  if (!recent.length) return bot.sendMessage(chatId, 'No audit entries today.', { parseMode: undefined });
  const lines = [`*Last ${recent.length} entries:*`, ''];
  for (const e of recent) {
    lines.push(`${(e.ts || '').slice(11, 19)} ${e.ok ? '✓' : '✗'} ${e.tool || '?'}: ${(e.summary || '').slice(0, 60)}`);
  }
  await bot.sendMessage(chatId, lines.join('\n'));
}

async function cmdQueue(bot, chatId) {
  if (!engine) return bot.sendMessage(chatId, 'agent-engine not available', { parseMode: undefined });
  const s = engine.laneStats('telegram');
  await bot.sendMessage(chatId, [
    '*Lane Queue*', '',
    `Pending: ${s.pending}`, `Running: ${s.running}`,
    `Completed: ${s.completed}`, `Failed: ${s.failed}`,
  ].join('\n'));
}

async function cmdRun(bot, chatId, command) {
  if (!command) return bot.sendMessage(chatId, 'Usage: /run <command>', { parseMode: undefined });
  if (!isAllowed(command)) return bot.sendMessage(chatId, 'Blocked by security policy.', { parseMode: undefined });
  // Sanitize: reject shell metacharacters to prevent injection
  if (/[`$\\|;&<>(){}!\n\r\x00]/.test(command)) {
    return bot.sendMessage(chatId, 'Blocked: shell metacharacters not allowed.', { parseMode: undefined });
  }
  try {
    // Split command into args and use execFileSync (no shell interpretation)
    const parts = command.trim().split(/\s+/);
    const output = execFileSync(parts[0], parts.slice(1), {
      encoding: 'utf8', timeout: 30000, cwd: process.env.HOME,
    });
    await bot.sendMessage(chatId, `\`\`\`\n${(output.trim() || '(empty)').slice(0, 3800)}\n\`\`\``);
  } catch (e) {
    await bot.sendMessage(chatId, `Error:\n\`\`\`\n${(e.stderr || e.message || 'error').slice(0, 1000)}\n\`\`\``);
  }
}

async function cmdCheckpoint(bot, chatId, summary) {
  if (!engine) return bot.sendMessage(chatId, 'agent-engine not available', { parseMode: undefined });
  engine.writeCheckpoint(summary || `Telegram checkpoint`, []);
  await bot.sendMessage(chatId, 'Checkpoint saved.', { parseMode: undefined });
}

async function cmdOrchestrate(bot, chatId, goal) {
  if (!goal) return bot.sendMessage(chatId, 'Usage: /orchestrate <goal>', { parseMode: undefined });
  const script = path.join(HOOKS_DIR, 'orchestrator.js');
  if (!fs.existsSync(script)) return bot.sendMessage(chatId, 'orchestrator.js not found', { parseMode: undefined });
  try {
    const logFile = path.join(LOGS_DIR, 'orch-latest.log');
    const out = fs.openSync(logFile, 'a');
    const child = spawn('node', [script, goal, process.env.HOME || '/root'], {
      detached: true, stdio: ['ignore', out, out],
    });
    child.unref();
    await bot.sendMessage(chatId, `Orchestrator started (PID: ${child.pid})`, { parseMode: undefined });
  } catch (e) {
    await bot.sendMessage(chatId, `Failed: ${e.message}`, { parseMode: undefined });
  }
}

async function cmdNotify(bot, chatId, config, toggle) {
  if (toggle === 'on') {
    config.notifyChat = chatId; saveConfig(config);
    await bot.sendMessage(chatId, 'Notifications ON.', { parseMode: undefined });
  } else if (toggle === 'off') {
    delete config.notifyChat; saveConfig(config);
    await bot.sendMessage(chatId, 'Notifications OFF.', { parseMode: undefined });
  } else {
    await bot.sendMessage(chatId, `Notifications: ${config.notifyChat === chatId ? 'ON' : 'OFF'}\n/notify on|off`, { parseMode: undefined });
  }
}

// ── Audit Watcher ──
function startAuditWatcher(bot, config) {
  let lastSize = 0;
  const auditFile = () => path.join(AUDIT_DIR, `audit-${localDate()}.jsonl`);
  try { lastSize = fs.readFileSync(auditFile(), 'utf8').length; } catch {}

  setInterval(() => {
    if (!config.notifyChat) return;
    try {
      const file = auditFile();
      if (!fs.existsSync(file)) return;
      const content = fs.readFileSync(file, 'utf8');
      if (content.length <= lastSize) return;
      const entries = content.slice(lastSize).trim().split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      lastSize = content.length;
      const notable = entries.filter(e => !e.ok || e.level === 'warn');
      if (!notable.length) return;
      const lines = notable.map(e => `${e.ok ? '✓' : '✗'} ${e.tool}: ${(e.summary || '').slice(0, 80)}`);
      bot.sendMessage(config.notifyChat, `*Alert* (${notable.length})\n\`\`\`\n${lines.join('\n')}\n\`\`\``).catch(() => {});
    } catch {}
  }, 5000);
}

// ── CLI Entrypoint ──
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
    saveConfig({ botToken: token, allowedChatIds: [], createdAt: new Date().toISOString() });
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
      try { process.kill(parseInt(pid), 0); console.log(`Running (PID: ${pid})`); }
      catch { console.log('Not running (stale PID)'); fs.unlinkSync(PID_FILE); }
    } else { console.log('Not running'); }
    const c = loadConfig();
    console.log(`Config: ${c.botToken ? 'OK' : 'NOT SET'}`);
    console.log(`Chats: ${(c.allowedChatIds || []).length}`);
    console.log(`SDK: ${loadSDK() ? 'available' : 'not installed'}`);
    console.log(`SQLite: ${loadSQLite() ? 'available' : 'not installed'}`);
    return;
  }

  // --stop
  if (args[0] === '--stop') {
    if (fs.existsSync(PID_FILE)) {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim());
      try { process.kill(pid, 'SIGTERM'); console.log(`Stopped (PID: ${pid})`); } catch { console.log('Not found'); }
      fs.unlinkSync(PID_FILE);
    } else { console.log('Not running'); }
    return;
  }

  // --daemon
  if (args[0] === '--daemon') {
    const logFile = path.join(LOGS_DIR, 'telegram-adapter.log');
    const out = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, [__filename], { detached: true, stdio: ['ignore', out, out] });
    child.unref();
    fs.writeFileSync(PID_FILE, String(child.pid));
    console.log(`Daemon started (PID: ${child.pid})`);
    console.log(`Log: ${logFile}`);
    return;
  }

  // ── Normal start ──
  const config = loadConfig();
  if (!config.botToken) {
    console.error('Not configured. Run: node telegram-adapter.js --setup <BOT_TOKEN>');
    process.exit(1);
  }

  // Init components
  const bot = new TelegramBot(config.botToken);
  const store = new SessionStore(DB_FILE);
  store.init();
  const claude = new ClaudeIntegration(store);

  // Verify bot
  try {
    const me = await bot.getMe();
    log('info', `Bot: @${me.username}`);
  } catch (e) {
    log('error', `Bot verification failed: ${e.message}`);
    process.exit(1);
  }

  fs.writeFileSync(PID_FILE, String(process.pid));

  log('info', '=== Telegram Adapter v2 ===');
  log('info', `SDK: ${claude.sdkAvailable ? 'Active' : 'CLI fallback'}`);
  log('info', `SQLite: ${store.db ? 'Active' : 'Disabled'}`);
  log('info', `Chats: ${(config.allowedChatIds || []).join(', ') || '(send /start to register)'}`);

  startAuditWatcher(bot, config);

  // Graceful shutdown
  const shutdown = () => {
    log('info', 'Shutting down...');
    bot.stop();
    store.close();
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await bot.poll((message) => handleMessage(bot, config, claude, message));
}

if (require.main === module) {
  main().catch(e => { log('error', `Fatal: ${e.message}`); process.exit(1); });
}

module.exports = { TelegramBot, SessionStore, ClaudeIntegration };
