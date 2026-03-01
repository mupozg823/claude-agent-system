#!/usr/bin/env node
/**
 * lib/utils.js - Shared utilities for Claude Agent System hooks
 *
 * Consolidates duplicated code across 14 hook files:
 *   - localDate()          (was duplicated 6x)
 *   - DIRS constants       (was duplicated 12x)
 *   - AuditTailer class    (was duplicated 2x: gateway.js, relay-supabase.js)
 *   - runEngine()          (was duplicated 3x: gateway.js, relay-supabase.js, heartbeat.js)
 *   - log()                (was duplicated with variations)
 *   - writeCheckpoint()    (was duplicated 2x: agent-engine.js, stop-check.js)
 *   - parseJsonl()         (inline pattern repeated ~10x)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── Constants ──

const HOME = process.env.HOME || process.env.USERPROFILE;
const CLAUDE_DIR = path.join(HOME, '.claude');
const HOOKS_DIR = path.join(CLAUDE_DIR, 'hooks');

const DIRS = {
  claude: CLAUDE_DIR,
  hooks: HOOKS_DIR,
  logs: path.join(CLAUDE_DIR, 'logs'),
  audit: path.join(CLAUDE_DIR, 'logs', 'audit'),
  checkpoints: path.join(CLAUDE_DIR, 'logs', 'checkpoints'),
  contexts: path.join(CLAUDE_DIR, 'contexts'),
  queue: path.join(CLAUDE_DIR, 'queue'),
  orchestrator: path.join(CLAUDE_DIR, 'orchestrator'),
};

const ENGINE = path.join(HOOKS_DIR, 'agent-engine.js');

// ── Date Utility ──

function localDate(date) {
  const d = date || new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Audit File Path ──

function auditFile(date) {
  return path.join(DIRS.audit, `audit-${localDate(date)}.jsonl`);
}

// ── Logging ──

const LOG_COLORS = {
  info: '\x1b[36m[INFO]\x1b[0m',
  warn: '\x1b[33m[WARN]\x1b[0m',
  error: '\x1b[31m[ERR]\x1b[0m',
  debug: '\x1b[90m[DBG]\x1b[0m',
};

function log(level, msg, opts = {}) {
  const ts = new Date().toISOString().slice(11, 19);
  const prefix = LOG_COLORS[level] || '[???]';
  console.log(`${ts} ${prefix} ${msg}`);

  if (opts.file) {
    try {
      fs.appendFileSync(opts.file, JSON.stringify({
        ts: new Date().toISOString(), level, msg,
      }) + '\n');
    } catch {}
  }
}

// ── JSONL Parser ──

function parseJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    return fs.readFileSync(filePath, 'utf8').trim().split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function appendJsonl(filePath, entry) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
}

// ── Ensure Directories ──

function ensureDirs(...dirs) {
  for (const d of dirs) {
    fs.mkdirSync(d, { recursive: true });
  }
}

// ── Agent Engine Runner ──

function runEngine(command, ...args) {
  try {
    const { execFileSync } = require('child_process');
    // Use execFileSync with args array to avoid shell injection
    const result = execFileSync('node', [ENGINE, command, ...args.map(String)], {
      encoding: 'utf8',
      timeout: 10000,
    });
    try { return JSON.parse(result.trim()); } catch { return result.trim(); }
  } catch (e) {
    return null;
  }
}

// ── Checkpoint ──

function writeCheckpoint(summary, pendingTasks = [], extra = {}) {
  ensureDirs(DIRS.checkpoints);
  const file = path.join(DIRS.checkpoints, `checkpoint-${localDate()}.jsonl`);
  const entry = {
    ts: new Date().toISOString(),
    summary,
    pendingTasks,
    sessionId: process.env.SESSION_ID || 'unknown',
    ...extra,
  };
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  return entry;
}

function getLatestCheckpoint() {
  if (!fs.existsSync(DIRS.checkpoints)) return null;
  const files = fs.readdirSync(DIRS.checkpoints)
    .filter(f => f.startsWith('checkpoint-') && f.endsWith('.jsonl'))
    .sort().reverse();

  for (const f of files) {
    const content = fs.readFileSync(path.join(DIRS.checkpoints, f), 'utf8').trim();
    const lines = content.split('\n').filter(Boolean);
    if (lines.length > 0) {
      try { return JSON.parse(lines[lines.length - 1]); } catch {}
    }
  }
  return null;
}

// ── AuditTailer ──
// Unified from gateway.js and relay-supabase.js implementations

class AuditTailer {
  constructor(auditDir) {
    this.auditDir = auditDir || DIRS.audit;
    this.offset = 0;
    this.currentFile = null;
    this.watcher = null;
    this._pollInterval = null;
    this.onEntry = null;
  }

  getCurrentFile() {
    return path.join(this.auditDir, `audit-${localDate()}.jsonl`);
  }

  init() {
    const file = this.getCurrentFile();
    this.currentFile = file;
    if (fs.existsSync(file)) {
      this.offset = fs.readFileSync(file, 'utf8').length;
    }
  }

  readNewEntries() {
    const file = this.getCurrentFile();
    if (file !== this.currentFile) {
      this.currentFile = file;
      this.offset = 0;
    }
    if (!fs.existsSync(file)) return [];

    try {
      const content = fs.readFileSync(file, 'utf8');
      if (content.length <= this.offset) return [];

      const newContent = content.slice(this.offset);
      this.offset = content.length;

      return newContent.trim().split('\n')
        .filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  startWatching(callback) {
    this.onEntry = callback;
    this.init();

    fs.mkdirSync(this.auditDir, { recursive: true });

    // fs.watch + polling hybrid (Windows fs.watch is unreliable for content changes)
    try {
      this.watcher = fs.watch(this.auditDir, { persistent: true }, (_, filename) => {
        if (!filename || !filename.startsWith('audit-')) return;
        this._flush();
      });
    } catch {}

    // Primary: 1.5s polling (works reliably on Windows)
    this._pollInterval = setInterval(() => this._flush(), 1500);
  }

  _flush() {
    const entries = this.readNewEntries();
    for (const entry of entries) {
      if (this.onEntry) this.onEntry(entry);
    }
    return entries;
  }

  stop() {
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
    if (this._pollInterval) { clearInterval(this._pollInterval); this._pollInterval = null; }
  }
}

// ── Token Overflow Detection ──
// Shared between audit-log.js and stop-check.js

const TOKEN_OVERFLOW_PATTERNS = [
  /output token (limit|maximum)/i,
  /exceeded.*\d+.*token/i,
  /response.*cut off/i,
  /token_limit_exceeded/i,
  /토큰\s?초과/,
];

function isTokenOverflow(val) {
  if (!val) return false;
  if (typeof val === 'string') return TOKEN_OVERFLOW_PATTERNS.some(p => p.test(val));
  for (const k of ['error', 'message', 'stderr', 'result']) {
    if (typeof val[k] === 'string' && TOKEN_OVERFLOW_PATTERNS.some(p => p.test(val[k]))) return true;
  }
  return false;
}

function isTokenOverflowText(text) {
  if (!text) return false;
  return TOKEN_OVERFLOW_PATTERNS.some(p => p.test(text));
}

// ── Exports ──

module.exports = {
  HOME,
  CLAUDE_DIR,
  HOOKS_DIR,
  DIRS,
  ENGINE,
  localDate,
  auditFile,
  log,
  LOG_COLORS,
  parseJsonl,
  appendJsonl,
  ensureDirs,
  runEngine,
  writeCheckpoint,
  getLatestCheckpoint,
  AuditTailer,
  TOKEN_OVERFLOW_PATTERNS,
  isTokenOverflow,
  isTokenOverflowText,
};
