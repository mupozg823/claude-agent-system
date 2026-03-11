#!/usr/bin/env node
/**
 * gateway.js - OpenClaw-grade Control Plane Gateway
 *
 * Always-running WebSocket daemon that owns all session state,
 * queue management, channel routing, and execution control.
 *
 * Architecture:
 *   WebSocket Server (localhost:18790) ── JSON frame protocol
 *   In-process Promise Queue ── replaces file-based locking
 *   Channel Adapters ── Supabase, CLI hooks, future channels
 *   Inbound Guard ── dedup + debounce
 *   Session Store ── in-memory + disk persistence
 *   Steer Mode ── mid-execution direction change at tool boundaries
 *
 * CLI:
 *   node gateway.js                  Start gateway daemon
 *   node gateway.js --port 18790    Custom port
 *   node gateway.js --status        Check if running
 *   node gateway.js --stop          Stop running gateway
 *
 * Frame Protocol (JSON over WebSocket):
 *   Request:  { type:"req",  id, method, params }
 *   Response: { type:"res",  id, ok, payload|error }
 *   Event:    { type:"event", event, payload }
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { execSync, spawn } = require('child_process');
const WebSocket = require('ws');
const { CLAUDE_DIR, HOOKS_DIR, AUDIT_DIR, LOGS_DIR, ORCH_DIR } = require('../hooks/lib/paths');
const { localDate, auditFilePath } = require('../hooks/lib/utils');

const ENGINE = path.join(HOOKS_DIR, 'agent-engine.js');
const ORCHESTRATOR = path.join(HOOKS_DIR, 'orchestrator.js');
const GATEWAY_PID = path.join(CLAUDE_DIR, 'gateway.pid');
const GATEWAY_LOG = path.join(LOGS_DIR, 'gateway.jsonl');
const CONFIG_FILE = path.join(CLAUDE_DIR, '.supabase-config.json');
const CRON_FILE = path.join(CLAUDE_DIR, 'CRON.md');
const BINDING_RULES_FILE = path.join(HOOKS_DIR, 'binding-rules.json');
const SKILL_ROUTER_FILE = path.join(HOOKS_DIR, 'skill-router.js');
const DEFAULT_PORT = 18790;

fs.mkdirSync(LOGS_DIR, { recursive: true });

// ══════════════════════════════════════════════════════
// ── LOGGING ──
// ══════════════════════════════════════════════════════

function log(level, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  const prefix = { info: '[INF]', warn: '[WRN]', error: '[ERR]' };
  console.log(`${ts} ${prefix[level] || '[???]'} ${msg}`);
  try {
    fs.appendFileSync(GATEWAY_LOG, JSON.stringify({
      ts: new Date().toISOString(), level, msg,
    }) + '\n');
  } catch {}
}

// localDate() imported from lib/utils

// ══════════════════════════════════════════════════════
// ── BINDING RULE ENGINE (OpenClaw pattern) ──
// ══════════════════════════════════════════════════════

class BindingRuleEngine {
  constructor() {
    this.rules = [];
    this.rateLimits = {};
    this._reload();
    // Hot-reload every 60s
    this._reloadTimer = setInterval(() => this._reload(), 60_000);
  }

  _reload() {
    try {
      if (fs.existsSync(BINDING_RULES_FILE)) {
        const data = JSON.parse(fs.readFileSync(BINDING_RULES_FILE, 'utf8'));
        this.rules = (data.rules || []).sort((a, b) => (b.priority || 0) - (a.priority || 0));
        this.rateLimits = data.rateLimits || {};
      }
    } catch (e) {
      log('warn', `Binding rules reload failed: ${e.message}`);
    }
  }

  match(msg, source) {
    for (const rule of this.rules) {
      const m = rule.match;
      if (!m) continue;

      // Source filter
      if (m.source && m.source !== source) continue;

      // Event filter
      if (m.event && m.event !== (msg.event || msg.type || 'command')) continue;

      // Pattern filter (regex on command string)
      if (m.pattern) {
        const command = msg.command || msg.message || '';
        try {
          if (!new RegExp(m.pattern, 'i').test(command)) continue;
        } catch { continue; }
      }

      return { rule, handler: rule.handler, id: rule.id };
    }
    return null;
  }

  destroy() {
    if (this._reloadTimer) clearInterval(this._reloadTimer);
  }
}

// ══════════════════════════════════════════════════════
// ── RATE LIMITER (Token Bucket per channel) ──
// ══════════════════════════════════════════════════════

class RateLimiter {
  constructor(config = {}) {
    this.buckets = new Map(); // key → { tokens, lastRefill, interval, burst }
    this.config = config; // { channelName: { interval, burst } }
    // Cleanup old buckets every 5 min
    this._cleanupTimer = setInterval(() => this._cleanup(), 300_000);
  }

  configure(config) {
    this.config = { ...this.config, ...config };
  }

  // Returns true if allowed, false if rate-limited
  allow(key) {
    const cfg = this.config[key] || this.config.default || { interval: 30, burst: 3 };
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = {
        tokens: cfg.burst,
        lastRefill: Date.now(),
        interval: cfg.interval * 1000,
        burst: cfg.burst,
      };
      this.buckets.set(key, bucket);
    }

    // Refill tokens based on elapsed time
    const now = Date.now();
    const elapsed = now - bucket.lastRefill;
    const refill = Math.floor(elapsed / bucket.interval);
    if (refill > 0) {
      bucket.tokens = Math.min(bucket.burst, bucket.tokens + refill);
      bucket.lastRefill = now;
    }

    // Consume a token
    if (bucket.tokens > 0) {
      bucket.tokens--;
      return true;
    }

    return false;
  }

  // Get time until next token available (ms)
  retryAfter(key) {
    const bucket = this.buckets.get(key);
    if (!bucket) return 0;
    const elapsed = Date.now() - bucket.lastRefill;
    return Math.max(0, bucket.interval - elapsed);
  }

  _cleanup() {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill > bucket.interval * bucket.burst * 2) {
        this.buckets.delete(key);
      }
    }
  }

  destroy() {
    if (this._cleanupTimer) clearInterval(this._cleanupTimer);
  }
}

// ══════════════════════════════════════════════════════
// ── WEBHOOK HMAC-SHA256 VERIFICATION ──
// ══════════════════════════════════════════════════════

function verifyWebhookSignature(body, signature, secret) {
  if (!signature || !secret) return false;
  try {
    // Support both "sha256=<hex>" and raw "<hex>" formats
    const sigHex = signature.startsWith('sha256=') ? signature.slice(7) : signature;
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
    return crypto.timingSafeEqual(
      Buffer.from(sigHex, 'hex'),
      Buffer.from(expected, 'hex')
    );
  } catch {
    return false;
  }
}

function loadWebhookSecret() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      return config.webhookSecret || null;
    }
  } catch {}
  return process.env.GATEWAY_WEBHOOK_SECRET || null;
}

// ══════════════════════════════════════════════════════
// ── INBOUND GUARD (Dedup + Debounce) ──
// ══════════════════════════════════════════════════════

class InboundGuard {
  constructor(opts = {}) {
    this.dedupeCache = new Map();
    this.dedupeTTL = opts.dedupeTTL || 60_000; // 1 min TTL
    this.debounceTimers = new Map();
    this.debounceMs = opts.debounceMs || 300;

    // Periodic cache cleanup
    this._cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, ts] of this.dedupeCache) {
        if (now - ts > this.dedupeTTL) this.dedupeCache.delete(key);
      }
    }, 30_000);
  }

  isDuplicate(msg) {
    const key = `${msg.channel || ''}:${msg.sender || ''}:${msg.id || ''}:${msg.command || ''}`;
    if (this.dedupeCache.has(key)) return true;
    this.dedupeCache.set(key, Date.now());
    return false;
  }

  debounce(sessionId, msg, callback) {
    const existing = this.debounceTimers.get(sessionId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.messages.push(msg);
    } else {
      this.debounceTimers.set(sessionId, { messages: [msg], timer: null });
    }

    const entry = this.debounceTimers.get(sessionId);
    entry.timer = setTimeout(() => {
      const messages = entry.messages;
      this.debounceTimers.delete(sessionId);
      // Merge debounced messages into single batch
      callback(messages);
    }, this.debounceMs);
  }

  destroy() {
    clearInterval(this._cleanupTimer);
    for (const entry of this.debounceTimers.values()) {
      clearTimeout(entry.timer);
    }
  }
}

// ══════════════════════════════════════════════════════
// ── SESSION STORE (In-memory + Disk) ──
// ══════════════════════════════════════════════════════

class SessionStore {
  constructor() {
    this.sessions = new Map();
    this.file = path.join(CLAUDE_DIR, 'gateway-sessions.json');
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        for (const [id, session] of Object.entries(data)) {
          this.sessions.set(id, session);
        }
        log('info', `Loaded ${this.sessions.size} sessions`);
      }
    } catch {}
  }

  _save() {
    try {
      const data = {};
      for (const [id, session] of this.sessions) {
        data[id] = session;
      }
      fs.writeFileSync(this.file, JSON.stringify(data, null, 2));
    } catch {}
  }

  get(id) {
    return this.sessions.get(id);
  }

  upsert(id, data) {
    const existing = this.sessions.get(id) || {};
    this.sessions.set(id, {
      ...existing,
      ...data,
      id,
      updatedAt: new Date().toISOString(),
    });
    this._save();
    return this.sessions.get(id);
  }

  list() {
    return [...this.sessions.values()];
  }
}

// ══════════════════════════════════════════════════════
// ── PROMISE QUEUE (replaces file-based locking) ──
// ══════════════════════════════════════════════════════

class PromiseQueue {
  constructor() {
    this.lanes = new Map(); // sessionId → { queue, running, steerMsg, steerHistory }
  }

  _getLane(sessionId) {
    if (!this.lanes.has(sessionId)) {
      this.lanes.set(sessionId, {
        queue: [],
        running: false,
        current: null,
        steerMsg: null,
        steerHistory: [],
      });
    }
    return this.lanes.get(sessionId);
  }

  async enqueue(sessionId, task) {
    const lane = this._getLane(sessionId);
    return new Promise((resolve, reject) => {
      lane.queue.push({ task, resolve, reject, id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 5)}` });
      this._drain(sessionId);
    });
  }

  async _drain(sessionId) {
    const lane = this._getLane(sessionId);
    if (lane.running || lane.queue.length === 0) return;

    lane.running = true;
    const item = lane.queue.shift();
    const { task, resolve, reject, id, steerData } = item;
    lane.current = id;

    try {
      // If this queue item is a followup steer entry (no task), execute the steer command
      if (steerData && !task) {
        resolve({ success: true, output: `Followup steer: ${steerData.message}`, exitCode: 0, steered: true, steerData });
      } else {
        const result = await task();
        resolve(result);
      }
    } catch (e) {
      reject(e);
    } finally {
      lane.running = false;
      lane.current = null;
      // Process next in queue
      setImmediate(() => this._drain(sessionId));
    }
  }

  // Steer: inject direction change with mode support
  // modes: 'steer' (inject at tool boundary), 'followup' (after current), 'replace' (clear queue + steer)
  steer(sessionId, message, opts = {}) {
    const lane = this._getLane(sessionId);
    const steerEntry = {
      message,
      mode: opts.mode || 'steer',     // steer | followup | replace
      priority: opts.priority || 'high',
      ts: new Date().toISOString(),
      id: `steer-${Date.now()}`,
    };

    if (steerEntry.mode === 'replace') {
      // Clear queue and set steer
      lane.queue = [];
      lane.steerMsg = steerEntry;
    } else if (steerEntry.mode === 'followup') {
      // Add to front of queue (after current)
      lane.queue.unshift({ task: null, resolve: () => {}, reject: () => {}, id: steerEntry.id, steerData: steerEntry });
      lane.steerMsg = null;
      // Kick drain in case nothing is running
      setImmediate(() => this._drain(sessionId));
    } else {
      // Default steer: inject at tool boundary
      lane.steerMsg = steerEntry;
    }

    if (!lane.steerHistory) lane.steerHistory = [];
    lane.steerHistory.push(steerEntry);

    return { steered: true, sessionId, mode: steerEntry.mode, queueLength: lane.queue.length };
  }

  // Returns the full steer entry (not just message string)
  checkSteer(sessionId) {
    const lane = this._getLane(sessionId);
    if (lane.steerMsg) {
      const entry = lane.steerMsg;
      lane.steerMsg = null;
      return entry;
    }
    return null;
  }

  stats(sessionId) {
    if (sessionId) {
      const lane = this._getLane(sessionId);
      return {
        sessionId,
        pending: lane.queue.length,
        running: lane.running,
        current: lane.current,
        hasSteer: !!lane.steerMsg,
        steerHistoryCount: (lane.steerHistory || []).length,
      };
    }
    const stats = {};
    for (const [id, lane] of this.lanes) {
      stats[id] = {
        pending: lane.queue.length,
        running: lane.running,
        hasSteer: !!lane.steerMsg,
        steerHistoryCount: (lane.steerHistory || []).length,
      };
    }
    return stats;
  }
}

// ══════════════════════════════════════════════════════
// ── AUDIT TAILER ──
// ══════════════════════════════════════════════════════

class AuditTailer {
  constructor(auditDir) {
    this.auditDir = auditDir;
    this.offset = 0;
    this.currentFile = null;
    this.watcher = null;
    this._pollInterval = null;
    this.onEntry = null;
  }

  getCurrentFile() {
    return path.join(this.auditDir, `audit-${localDate()}.jsonl`);
  }

  startWatching(callback) {
    this.onEntry = callback;
    const file = this.getCurrentFile();
    this.currentFile = file;
    if (fs.existsSync(file)) {
      this.offset = fs.readFileSync(file, 'utf8').length;
    }

    fs.mkdirSync(this.auditDir, { recursive: true });

    try {
      this.watcher = fs.watch(this.auditDir, { persistent: true }, (_, filename) => {
        if (!filename || !filename.startsWith('audit-')) return;
        this._flush();
      });
    } catch {}

    this._pollInterval = setInterval(() => this._flush(), 1500);
    log('info', `Audit tailer started: ${this.auditDir}`);
  }

  _flush() {
    const file = this.getCurrentFile();
    if (file !== this.currentFile) {
      this.currentFile = file;
      this.offset = 0;
    }
    if (!fs.existsSync(file)) return;

    try {
      const content = fs.readFileSync(file, 'utf8');
      if (content.length <= this.offset) return;

      const newContent = content.slice(this.offset);
      this.offset = content.length;

      const entries = newContent.trim().split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);

      for (const entry of entries) {
        if (this.onEntry) this.onEntry(entry);
      }
    } catch {}
  }

  stop() {
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
    if (this._pollInterval) { clearInterval(this._pollInterval); }
  }
}

// ══════════════════════════════════════════════════════
// ── CHANNEL ADAPTER: SUPABASE ──
// ══════════════════════════════════════════════════════

class SupabaseAdapter {
  constructor(gateway) {
    this.gateway = gateway;
    this.channel = null;
    this.client = null;
    this.config = null;
    this.connected = false;
  }

  async connect() {
    if (!fs.existsSync(CONFIG_FILE)) {
      log('warn', 'Supabase adapter: no config file, skipping');
      return false;
    }

    try {
      this.config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (!this.config.url || !this.config.anonKey) return false;

      const { createClient } = require('@supabase/supabase-js');
      this.client = createClient(this.config.url, this.config.anonKey, {
        realtime: { params: { eventsPerSecond: 10 } },
      });

      const channelName = `claude:${this.config.sessionId}`;
      this.channel = this.client.channel(channelName, {
        config: { broadcast: { ack: true, self: false } },
      });

      // Subscribe to inbound commands from mobile/web
      this.channel.on('broadcast', { event: 'command' }, ({ payload }) => {
        this.gateway.handleInbound('supabase', payload);
      });

      this.channel.on('broadcast', { event: 'status-request' }, () => {
        this.gateway.handleStatusRequest('supabase');
      });

      this.channel.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          this.connected = true;
          await this.channel.track({
            role: 'gateway',
            sessionId: this.config.sessionId,
            online_at: new Date().toISOString(),
            hostname: require('os').hostname(),
          });
          log('info', `Supabase adapter connected: ${channelName}`);
        }
      });

      return true;
    } catch (e) {
      log('error', `Supabase adapter failed: ${e.message}`);
      return false;
    }
  }

  async broadcast(event, payload) {
    if (!this.connected || !this.channel) return;
    try {
      await this.channel.send({
        type: 'broadcast',
        event,
        payload: { ...payload, _ts: new Date().toISOString() },
      });
    } catch {}
  }

  async disconnect() {
    if (this.channel) {
      await this.channel.unsubscribe();
      this.connected = false;
    }
  }
}

// ══════════════════════════════════════════════════════
// ── COMMAND EXECUTOR ──
// ══════════════════════════════════════════════════════

class CommandExecutor {
  constructor(gateway) {
    this.gateway = gateway;
    this._skillRouter = null;
  }

  _getSkillRouter() {
    if (this._skillRouter) return this._skillRouter;
    try {
      if (fs.existsSync(SKILL_ROUTER_FILE)) {
        this._skillRouter = require(SKILL_ROUTER_FILE);
        return this._skillRouter;
      }
    } catch (e) {
      log('warn', `Skill router load failed: ${e.message}`);
    }
    return null;
  }

  async execute(command, sessionId, opts = {}) {
    // Orchestrate commands
    if (command.startsWith('/orchestrate ') || command.startsWith('orchestrate ')) {
      return this._orchestrate(command.replace(/^\/?orchestrate\s+/, ''));
    }

    // Skill-routed commands (when handler is 'skill-router' from binding engine)
    if (opts.handler === 'skill-router') {
      return this._skillExecute(command, sessionId);
    }

    // Auto-detect slash commands for skill routing
    if (command.match(/^\/[a-z][\w-]*/i)) {
      const router = this._getSkillRouter();
      if (router) {
        const match = router.matchSkill(command);
        if (match && match.confidence >= 0.7) {
          return this._skillExecute(command, sessionId);
        }
      }
    }

    // Shell commands
    return this._shell(command, sessionId);
  }

  async _skillExecute(command, sessionId) {
    const router = this._getSkillRouter();
    if (!router) {
      log('warn', 'Skill router unavailable, falling back to shell');
      return this._shell(command, sessionId);
    }

    const routed = router.routeSkillCommand(command, { maxTurns: 20, includeContext: true });
    log('info', `Skill routed: ${routed.skill || 'generic'} (${routed.confidence.toFixed(2)})`);

    // Log skill routing to audit
    try {
      const auditFile = path.join(AUDIT_DIR, `audit-${localDate()}.jsonl`);
      fs.appendFileSync(auditFile, JSON.stringify({
        ts: new Date().toISOString(),
        type: 'skill-route',
        tool: 'gateway',
        skill_routed: routed.skill,
        confidence: routed.confidence,
        matchType: routed.matchType,
        original: command,
      }) + '\n');
    } catch {}

    // Execute the routed claude -p command
    const result = await this._shell(routed.command, sessionId);
    return {
      ...result,
      skillRouted: true,
      skill: routed.skill,
      category: routed.category,
    };
  }

  async _shell(command, sessionId) {
    return new Promise((resolve) => {
      try {
        const result = execSync(command, {
          encoding: 'utf8',
          timeout: 30_000,
          cwd: HOME,
          env: { ...process.env, GATEWAY_EXEC: '1' },
          maxBuffer: 1024 * 1024 * 5,
        });
        resolve({ success: true, output: result.trim().slice(0, 2000), exitCode: 0 });
      } catch (e) {
        const errMsg = (e.stderr || e.message || 'unknown error').slice(0, 1000);
        resolve({ success: false, output: errMsg, exitCode: e.status || 1 });
      }
    });
  }

  _orchestrate(goal) {
    return new Promise((resolve) => {
      const orchLog = path.join(CLAUDE_DIR, 'logs', 'orch-latest.log');
      const out = fs.openSync(orchLog, 'a');
      const child = spawn('node', [ORCHESTRATOR, goal, HOME], {
        detached: true,
        stdio: ['ignore', out, out],
        cwd: HOME,
      });
      child.unref();
      log('info', `Orchestrator spawned (PID: ${child.pid}): ${goal}`);
      resolve({ success: true, output: `Orchestrator started (PID: ${child.pid})`, exitCode: 0 });
    });
  }
}

// ══════════════════════════════════════════════════════
// ── CRON SCHEDULER ──
// ══════════════════════════════════════════════════════

class CronScheduler {
  constructor(gateway) {
    this.gateway = gateway;
    this.jobs = [];
    this.timer = null;
    this._reloadTimer = null;
    this.lastRun = new Map(); // job.id -> lastRunTs
  }

  start() {
    this._loadJobs();
    // Check every 60 seconds
    this.timer = setInterval(() => this._tick(), 60_000);
    // Also reload jobs every 5 minutes
    this._reloadTimer = setInterval(() => this._loadJobs(), 300_000);
    log('info', `Cron scheduler started (${this.jobs.length} jobs)`);
  }

  _loadJobs() {
    if (!fs.existsSync(CRON_FILE)) {
      this.jobs = [];
      return;
    }
    try {
      const content = fs.readFileSync(CRON_FILE, 'utf8');
      const jobs = [];
      const lines = content.split('\n');
      for (const line of lines) {
        // Match: - `*/5 * * * *` node heartbeat.js
        const match = line.match(/^[-*]\s*`([^`]+)`\s+(.+)$/);
        if (match) {
          const [, schedule, command] = match;
          const parts = schedule.trim().split(/\s+/);
          if (parts.length >= 5) {
            jobs.push({
              id: `cron-${jobs.length}`,
              schedule: parts.slice(0, 5).join(' '),
              command: command.trim(),
              enabled: !line.includes('[disabled]'),
            });
          }
        }
        // Also match table format: | */30 * * * * | command | desc |
        const tableMatch = line.match(/^\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/);
        if (tableMatch && !tableMatch[1].includes('cron') && !tableMatch[1].includes('---')) {
          const schedule = tableMatch[1].trim();
          const command = tableMatch[2].trim();
          const parts = schedule.split(/\s+/);
          if (parts.length >= 5 && /\d|\*/.test(parts[0])) {
            jobs.push({
              id: `cron-${jobs.length}`,
              schedule: parts.slice(0, 5).join(' '),
              command,
              enabled: !line.includes('[disabled]'),
            });
          }
        }
      }
      this.jobs = jobs.filter(j => j.enabled);
      if (jobs.length > 0) log('info', `Loaded ${jobs.length} cron jobs (${this.jobs.length} enabled)`);
    } catch (e) {
      log('warn', `Cron load failed: ${e.message}`);
    }
  }

  _tick() {
    const now = new Date();
    for (const job of this.jobs) {
      if (this._matches(job.schedule, now)) {
        const lastRun = this.lastRun.get(job.id) || 0;
        // Prevent running more than once per minute
        if (Date.now() - lastRun < 55_000) continue;

        this.lastRun.set(job.id, Date.now());
        log('info', `Cron firing: ${job.command}`);
        this.gateway._broadcastAll('cron-fire', { job: job.id, command: job.command });

        const sessionId = this.gateway._getDefaultSessionId();
        this.gateway._processCommand(sessionId, {
          id: `cron-${Date.now()}`,
          command: job.command,
          priority: 'low',
        }, 'cron');
      }
    }
  }

  _matches(schedule, date) {
    const [min, hour, dom, mon, dow] = schedule.split(/\s+/);
    return this._fieldMatch(min, date.getMinutes()) &&
           this._fieldMatch(hour, date.getHours()) &&
           this._fieldMatch(dom, date.getDate()) &&
           this._fieldMatch(mon, date.getMonth() + 1) &&
           this._fieldMatch(dow, date.getDay());
  }

  _fieldMatch(field, value) {
    if (field === '*') return true;
    // */N pattern
    const stepMatch = field.match(/^\*\/(\d+)$/);
    if (stepMatch) return value % parseInt(stepMatch[1]) === 0;
    // Range: N-M
    const rangeMatch = field.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const low = parseInt(rangeMatch[1]);
      const high = parseInt(rangeMatch[2]);
      return value >= low && value <= high;
    }
    // Comma-separated values
    const values = field.split(',').map(v => parseInt(v));
    return values.includes(value);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this._reloadTimer) clearInterval(this._reloadTimer);
  }
}

// ══════════════════════════════════════════════════════
// ── GATEWAY (Main Control Plane) ──
// ══════════════════════════════════════════════════════

class Gateway extends EventEmitter {
  constructor(port = DEFAULT_PORT) {
    super();
    this.port = port;
    this.sessions = new SessionStore();
    this.queue = new PromiseQueue();
    this.guard = new InboundGuard();
    this.executor = new CommandExecutor(this);
    this.tailer = new AuditTailer(AUDIT_DIR);
    this.adapters = new Map();
    this.wsClients = new Set();
    this.server = null;
    this.wss = null;
    this.bindingEngine = new BindingRuleEngine();
    this.rateLimiter = new RateLimiter();
    this.webhookSecret = loadWebhookSecret();
    this.startTime = Date.now();
    this.stats = { commands: 0, events: 0, errors: 0, rateLimited: 0, webhooksVerified: 0 };

    // Configure rate limiter from binding rules
    if (this.bindingEngine.rateLimits) {
      this.rateLimiter.configure(this.bindingEngine.rateLimits);
    }
  }

  async start() {
    log('info', '=== Gateway Control Plane ===');
    log('info', `Port: ${this.port}`);

    // HTTP + WebSocket server
    this.server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.getStatus()));
      } else if (req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.getDetailedStatus()));
      } else if (req.method === 'POST' && req.url.startsWith('/webhook/')) {
        const event = req.url.split('/')[2];
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          // HMAC-SHA256 signature verification
          if (this.webhookSecret) {
            const signature = req.headers['x-signature'] || req.headers['x-hub-signature-256'] || '';
            if (!verifyWebhookSignature(body, signature, this.webhookSecret)) {
              this.stats.errors++;
              log('warn', `Webhook HMAC verification failed for /${event}`);
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid signature' }));
              return;
            }
            this.stats.webhooksVerified++;
          }

          // Rate limiting
          const rateKey = event === 'command' ? 'default' : event;
          if (!this.rateLimiter.allow(rateKey)) {
            this.stats.rateLimited++;
            const retryAfter = Math.ceil(this.rateLimiter.retryAfter(rateKey) / 1000);
            log('warn', `Rate limited: webhook/${event} (retry after ${retryAfter}s)`);
            res.writeHead(429, {
              'Content-Type': 'application/json',
              'Retry-After': String(retryAfter),
            });
            res.end(JSON.stringify({ error: 'Rate limited', retryAfter }));
            return;
          }

          try {
            const payload = JSON.parse(body || '{}');
            this._handleWebhook(event, payload, res);
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    this.wss = new WebSocket.Server({ server: this.server });

    this.wss.on('connection', (ws, req) => {
      const clientId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
      ws._clientId = clientId;
      this.wsClients.add(ws);
      log('info', `WS client connected: ${clientId}`);

      ws.on('message', (data) => {
        try {
          const frame = JSON.parse(data.toString());
          this._handleFrame(ws, frame);
        } catch (e) {
          this._sendFrame(ws, { type: 'res', id: null, ok: false, error: 'Invalid JSON' });
        }
      });

      ws.on('close', () => {
        this.wsClients.delete(ws);
        log('info', `WS client disconnected: ${clientId}`);
      });

      // Send welcome frame
      this._sendFrame(ws, {
        type: 'event',
        event: 'connected',
        payload: { clientId, uptime: this.uptime(), sessions: this.sessions.list().length },
      });
    });

    this.server.listen(this.port, '127.0.0.1', () => {
      log('info', `Gateway listening on ws://127.0.0.1:${this.port}`);
    });

    // Start Supabase adapter
    const supabase = new SupabaseAdapter(this);
    this.adapters.set('supabase', supabase);
    await supabase.connect();

    // Start audit tailer
    this.tailer.startWatching((entry) => {
      this.stats.events++;
      this._broadcastAll('audit', entry);
    });

    // Periodic status push (30s)
    this._statusTimer = setInterval(() => {
      const status = this.getStatus();
      this._broadcastAll('status', status);
      const metrics = this._getMetrics();
      if (metrics) this._broadcastAll('metrics', metrics);
    }, 30_000);

    // Start cron scheduler
    this.cron = new CronScheduler(this);
    this.cron.start();

    // Orchestrator outbox relay (3s)
    this._orchOutboxOffset = 0;
    const outboxFile = path.join(CLAUDE_DIR, 'orchestrator', 'outbox.jsonl');
    try {
      if (fs.existsSync(outboxFile)) {
        this._orchOutboxOffset = fs.readFileSync(outboxFile, 'utf8').split('\n').filter(Boolean).length;
      }
    } catch {}

    this._orchTimer = setInterval(() => {
      try {
        if (!fs.existsSync(outboxFile)) return;
        const lines = fs.readFileSync(outboxFile, 'utf8').split('\n').filter(Boolean);
        if (lines.length <= this._orchOutboxOffset) return;

        const newLines = lines.slice(this._orchOutboxOffset);
        this._orchOutboxOffset = lines.length;

        for (const line of newLines) {
          try {
            const msg = JSON.parse(line);
            if (msg.event && msg.payload) this._broadcastAll(msg.event, msg.payload);
          } catch {}
        }
      } catch {}
    }, 3_000);

    // Write PID file
    fs.writeFileSync(GATEWAY_PID, String(process.pid));
    log('info', `PID: ${process.pid}`);

    // Graceful shutdown
    const shutdown = async (signal) => {
      log('info', `Shutting down (${signal})...`);
      clearInterval(this._statusTimer);
      clearInterval(this._orchTimer);
      if (this.cron) this.cron.stop();
      this.tailer.stop();
      this.guard.destroy();
      this.bindingEngine.destroy();
      this.rateLimiter.destroy();

      for (const adapter of this.adapters.values()) {
        await adapter.disconnect?.();
      }

      for (const ws of this.wsClients) {
        ws.close(1001, 'Gateway shutting down');
      }

      this.wss.close();
      this.server.close();

      try { fs.unlinkSync(GATEWAY_PID); } catch {}
      log('info', 'Gateway stopped');
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('uncaughtException', (e) => {
      log('error', `Uncaught: ${e.message}`);
    });
  }

  // ── Frame Protocol Handler ──
  async _handleFrame(ws, frame) {
    if (frame.type === 'req') {
      const { id, method, params } = frame;
      try {
        const result = await this._handleRequest(method, params || {}, ws);
        this._sendFrame(ws, { type: 'res', id, ok: true, payload: result });
      } catch (e) {
        this._sendFrame(ws, { type: 'res', id, ok: false, error: e.message });
      }
    } else if (frame.type === 'event') {
      this.handleInbound('ws', { ...frame.payload, _wsClientId: ws._clientId });
    }
  }

  // ── Request Router ──
  async _handleRequest(method, params) {
    switch (method) {
      case 'status':
        return this.getDetailedStatus();

      case 'queue-stats':
        return this.queue.stats(params.sessionId);

      case 'sessions':
        return this.sessions.list();

      case 'execute': {
        const sessionId = params.sessionId || 'default';
        return this.queue.enqueue(sessionId, () =>
          this.executor.execute(params.command, sessionId)
        );
      }

      case 'steer':
        return this.queue.steer(params.sessionId || 'default', params.message, {
          mode: params.mode,
          priority: params.priority,
        });

      case 'orchestrate':
        return this.executor._orchestrate(params.goal);

      case 'engine': {
        const result = this._runEngine(params.command, ...(params.args || []));
        return result || { error: 'engine command failed' };
      }

      case 'cron-list':
        return this.cron ? this.cron.jobs : [];

      case 'cron-reload':
        if (this.cron) this.cron._loadJobs();
        return { reloaded: true, count: this.cron?.jobs.length || 0 };

      case 'skill-execute': {
        const sessionId = params.sessionId || 'default';
        return this.queue.enqueue(sessionId, () =>
          this.executor.execute(params.command, sessionId, { handler: 'skill-router' })
        );
      }

      case 'skill-match': {
        const router = this.executor._getSkillRouter();
        if (!router) return { error: 'Skill router not available' };
        const match = router.matchSkill(params.command);
        return match || { skill: null, confidence: 0 };
      }

      case 'skill-list': {
        const router = this.executor._getSkillRouter();
        if (!router) return { error: 'Skill router not available' };
        return router.listSkills();
      }

      case 'mcp-stats': {
        const router = this.executor._getSkillRouter();
        if (!router) return { error: 'Skill router not available' };
        return router.getMcpStats();
      }

      case 'skill-stats': {
        const router = this.executor._getSkillRouter();
        if (!router) return { error: 'Skill router not available' };
        return router.getSkillStats();
      }

      case 'binding-rules':
        return { rules: this.bindingEngine.rules, rateLimits: this.bindingEngine.rateLimits };

      case 'rate-limit-status':
        return Object.fromEntries(this.rateLimiter.buckets);

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  // ── Inbound Message Handler ──
  handleInbound(channel, payload) {
    const { id, command, priority } = payload || {};
    if (!command) return;

    // Dedup check
    if (this.guard.isDuplicate(payload)) {
      log('warn', `Dedup: ${command.slice(0, 40)}`);
      return;
    }

    // Rate limiting for inbound messages
    const rateKey = command.match(/^\/?(orchestrate)\b/) ? 'orchestrate' :
                    command.match(/^\/?(status)\b/) ? 'status-check' : 'default';
    if (!this.rateLimiter.allow(`inbound:${channel}:${rateKey}`)) {
      this.stats.rateLimited++;
      log('warn', `Rate limited inbound [${channel}]: ${command.slice(0, 40)}`);
      this._broadcastAll('command-ack', { id, status: 'rate-limited', retryAfter: this.rateLimiter.retryAfter(`inbound:${channel}:${rateKey}`) });
      return;
    }

    const sessionId = payload.sessionId || this._getDefaultSessionId();
    this.stats.commands++;

    // Binding rule engine: determine handler
    const binding = this.bindingEngine.match(payload, channel);
    const handler = binding ? binding.handler : 'lane-queue';

    log('info', `Inbound [${channel}] → ${handler}: ${command.slice(0, 60)}`);

    // Debounce text commands
    this.guard.debounce(sessionId, { ...payload, _handler: handler }, (messages) => {
      // Merge debounced messages
      const merged = messages.length === 1
        ? messages[0]
        : { ...messages[0], command: messages.map(m => m.command).join(' && ') };

      this._processCommand(sessionId, merged, channel);
    });
  }

  async _processCommand(sessionId, payload, channel) {
    const { id, command, priority, _handler } = payload;

    // ACK immediately
    this._broadcastAll('command-ack', { id, status: 'queued', sessionId, handler: _handler || 'lane-queue' });

    try {
      // Enqueue for serial execution via Promise queue
      const result = await this.queue.enqueue(sessionId, async () => {
        this._broadcastAll('lane-executing', { id, command, handler: _handler });

        // Check steer before execution (now returns full steer entry)
        const steerMsg = this.queue.checkSteer(sessionId);
        if (steerMsg) {
          log('info', `Steer applied [${steerMsg.mode}]: ${steerMsg.message.slice(0, 40)}`);
          this._broadcastAll('steer-applied', { sessionId, steer: steerMsg });

          if (steerMsg.mode === 'replace') {
            return { success: true, output: `Replaced with: ${steerMsg.message}`, exitCode: 0, steered: true };
          }
          // For 'steer' mode: execute the steered command instead
          return this.executor.execute(steerMsg.message, sessionId);
        }

        return this.executor.execute(command, sessionId, { handler: _handler || 'default' });
      });

      this._broadcastAll('command-result', {
        id,
        command,
        result: result.output,
        exitCode: result.exitCode,
        steered: result.steered || false,
      });

      // Broadcast queue stats
      this._broadcastAll('lane-stats', this.queue.stats(sessionId));

    } catch (e) {
      this.stats.errors++;
      this._broadcastAll('command-result', {
        id, command,
        result: e.message,
        exitCode: 1,
      });
    }
  }

  handleStatusRequest(channel) {
    const status = this.getStatus();
    this._broadcastAll('status', status);
    const metrics = this._getMetrics();
    if (metrics) this._broadcastAll('metrics', metrics);
  }

  // ── Webhook Handler ──
  async _handleWebhook(event, payload, res) {
    log('info', `Webhook [${event}]: ${JSON.stringify(payload).slice(0, 100)}`);
    this.stats.webhooks = (this.stats.webhooks || 0) + 1;

    const sessionId = payload.sessionId || this._getDefaultSessionId();

    switch (event) {
      case 'command':
        // Execute a command via webhook
        if (payload.command) {
          this._processCommand(sessionId, payload, 'webhook');
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accepted: true, sessionId }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'missing command' }));
        }
        break;

      case 'steer':
        if (payload.message) {
          const result = this.queue.steer(sessionId, payload.message, payload);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'missing message' }));
        }
        break;

      case 'notify':
        // Broadcast a notification to all channels
        this._broadcastAll('webhook-notify', { ...payload, _source: 'webhook' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ notified: true }));
        break;

      case 'skill': {
        // Route through skill router
        if (payload.command) {
          const sessionId = payload.sessionId || this._getDefaultSessionId();
          this._processCommand(sessionId, { ...payload, _handler: 'skill-router' }, 'webhook');
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accepted: true, handler: 'skill-router', sessionId }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'missing command' }));
        }
        break;
      }

      default:
        // Generic event broadcast
        this._broadcastAll(`webhook-${event}`, payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ event, received: true }));
    }
  }

  // ── Broadcast to all channels ──
  _broadcastAll(event, payload) {
    // WebSocket clients
    const frame = JSON.stringify({ type: 'event', event, payload });
    for (const ws of this.wsClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(frame);
      }
    }

    // Supabase adapter
    const supabase = this.adapters.get('supabase');
    if (supabase) supabase.broadcast(event, payload);
  }

  _sendFrame(ws, frame) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
    }
  }

  // ── Engine Helper ──
  _runEngine(command, ...args) {
    try {
      const cmd = `node "${ENGINE}" ${command} ${args.map(a => `"${a}"`).join(' ')}`;
      const result = execSync(cmd, { encoding: 'utf8', timeout: 10000 });
      try { return JSON.parse(result.trim()); } catch { return result.trim(); }
    } catch {
      return null;
    }
  }

  _getMetrics() {
    return this._runEngine('metrics');
  }

  _getDefaultSessionId() {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      return config.sessionId || 'default';
    } catch { return 'default'; }
  }

  // ── Status ──
  uptime() { return Math.floor((Date.now() - this.startTime) / 1000); }

  getStatus() {
    return {
      gateway: true,
      uptime: this.uptime(),
      pid: process.pid,
      port: this.port,
      wsClients: this.wsClients.size,
      adapters: [...this.adapters.keys()].map(k => ({
        name: k,
        connected: this.adapters.get(k).connected || false,
      })),
      stats: this.stats,
      bindingRules: this.bindingEngine.rules.length,
      rateLimiter: { buckets: this.rateLimiter.buckets.size },
      hmacEnabled: !!this.webhookSecret,
      skillRouter: !!this.executor._getSkillRouter(),
      memMB: Math.round(process.memoryUsage().heapUsed / 1048576),
    };
  }

  getDetailedStatus() {
    const router = this.executor._getSkillRouter();
    return {
      ...this.getStatus(),
      sessions: this.sessions.list(),
      queue: this.queue.stats(),
      cron: this.cron ? { jobs: this.cron.jobs.length, lastRuns: Object.fromEntries(this.cron.lastRun) } : null,
      system: this._runEngine('status'),
      mcpStats: router ? router.getMcpStats() : null,
      skillStats: router ? router.getSkillStats() : null,
      bindingRulesDetail: this.bindingEngine.rules,
    };
  }
}

// ══════════════════════════════════════════════════════
// ── CLI ──
// ══════════════════════════════════════════════════════

function isRunning() {
  if (!fs.existsSync(GATEWAY_PID)) return false;
  try {
    const pid = parseInt(fs.readFileSync(GATEWAY_PID, 'utf8').trim());
    process.kill(pid, 0); // Signal 0 = check existence
    return pid;
  } catch {
    try { fs.unlinkSync(GATEWAY_PID); } catch {}
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === '--status') {
    const pid = isRunning();
    if (pid) {
      console.log(`Gateway running (PID: ${pid})`);
      // HTTP health check
      try {
        const port = parseInt(args[1]) || DEFAULT_PORT;
        const res = execSync(`curl -s http://127.0.0.1:${port}/status`, { encoding: 'utf8', timeout: 3000 });
        console.log(res);
      } catch {
        console.log('(HTTP health check failed)');
      }
    } else {
      console.log('Gateway not running');
    }
    return;
  }

  if (args[0] === '--stop') {
    const pid = isRunning();
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
        console.log(`Stopped gateway (PID: ${pid})`);
      } catch (e) {
        console.error(`Failed to stop: ${e.message}`);
      }
    } else {
      console.log('Gateway not running');
    }
    return;
  }

  if (args[0] === '--help') {
    console.log(`Usage:
  node gateway.js                  Start gateway daemon
  node gateway.js --port 18790    Custom port
  node gateway.js --status        Check if running
  node gateway.js --stop          Stop running gateway
  node gateway.js --daemon        Start in background`);
    return;
  }

  // Check if already running
  const existing = isRunning();
  if (existing) {
    console.error(`Gateway already running (PID: ${existing}). Use --stop first.`);
    process.exit(1);
  }

  // Daemon mode
  if (args[0] === '--daemon') {
    const out = fs.openSync(path.join(CLAUDE_DIR, 'logs', 'gateway-daemon.log'), 'a');
    const child = spawn('node', [__filename, '--port', String(args[1] || DEFAULT_PORT)], {
      detached: true,
      stdio: ['ignore', out, out],
    });
    child.unref();
    console.log(`Gateway daemon started (PID: ${child.pid})`);
    return;
  }

  const port = parseInt(args.find((_, i) => args[i - 1] === '--port') || DEFAULT_PORT);
  const gateway = new Gateway(port);
  await gateway.start();
}

module.exports = { Gateway, PromiseQueue, InboundGuard, SessionStore, CronScheduler, BindingRuleEngine, RateLimiter, verifyWebhookSignature };

if (require.main === module) {
  main().catch(e => {
    log('error', `Fatal: ${e.message}`);
    process.exit(1);
  });
}
