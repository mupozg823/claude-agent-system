#!/usr/bin/env node
/**
 * agent-engine.js - Autonomous Agent Core Engine
 *
 * OpenClaw-level features:
 *   1) Checkpoint system (crash-safe JSONL)
 *   2) Command queue processor
 *   3) Session state persistence
 *   4) Auto-recovery from interruptions
 *
 * Used by: stop-check.js, session-init.js, /context-save, /context-restore
 * CLI: node agent-engine.js <command> [args]
 *   - checkpoint <summary> [tasks...]  → Write checkpoint
 *   - queue-add <command> [priority]   → Add to command queue
 *   - queue-list                       → List pending commands
 *   - queue-complete <id>              → Mark command complete
 *   - status                           → System status report
 *   - cleanup                          → Clean old files
 */

const fs = require('fs');
const path = require('path');
const { LOGS_DIR, AUDIT_DIR, CHECKPOINT_DIR, CONTEXTS_DIR, QUEUE_DIR, ORCH_DIR } = require('./lib/paths');
const { localDate, writeCheckpoint: _writeCheckpoint, readJsonl, safeRead } = require('./lib/utils');

const DIRS = {
  logs: LOGS_DIR,
  audit: AUDIT_DIR,
  checkpoints: CHECKPOINT_DIR,
  contexts: CONTEXTS_DIR,
  queue: QUEUE_DIR,
};

// Ensure all dirs exist
for (const d of Object.values(DIRS)) {
  fs.mkdirSync(d, { recursive: true });
}

// ── Checkpoint System ──
function writeCheckpoint(summary, pendingTasks = []) {
  const entry = _writeCheckpoint(summary, pendingTasks);
  entry.sessionId = process.env.SESSION_ID || 'unknown';
  return entry;
}

function getLatestCheckpoint() {
  const files = fs.readdirSync(DIRS.checkpoints)
    .filter(f => f.startsWith('checkpoint-') && f.endsWith('.jsonl'))
    .sort().reverse();

  for (const f of files) {
    const content = fs.readFileSync(path.join(DIRS.checkpoints, f), 'utf8').trim();
    const lines = content.split('\n').filter(Boolean);
    if (lines.length > 0) {
      try { return JSON.parse(lines[lines.length - 1]); } catch (e) { process.stderr.write('[agent-engine] checkpoint parse: ' + e.message + '\n'); }
    }
  }
  return null;
}

// ── Command Queue ──
function queueAdd(command, priority = 'normal', metadata = {}) {
  const file = path.join(DIRS.queue, 'commands.jsonl');
  const entry = {
    id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    ts: new Date().toISOString(),
    command,
    priority,
    status: 'pending',
    ...metadata,
  };
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  return entry;
}

function queueList(statusFilter = 'pending') {
  const file = path.join(DIRS.queue, 'commands.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { /* silent */ return null; } })
    .filter(e => e && (statusFilter === 'all' || e.status === statusFilter));
}

function queueComplete(id) {
  const file = path.join(DIRS.queue, 'commands.jsonl');
  if (!fs.existsSync(file)) return false;
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  const updated = lines.map(l => {
    try {
      const e = JSON.parse(l);
      if (e.id === id) {
        e.status = 'completed';
        e.completedAt = new Date().toISOString();
        return JSON.stringify(e);
      }
      return l;
    } catch { /* silent */ return l; }
  });
  fs.writeFileSync(file, updated.join('\n') + '\n');
  return true;
}

// ── Status Report ──
function getStatus() {
  const status = { ts: new Date().toISOString(), system: {} };

  // Audit log stats
  try {
    const auditFiles = fs.readdirSync(DIRS.audit).filter(f => f.startsWith('audit-'));
    const today = localDate();
    const todayFile = path.join(DIRS.audit, `audit-${today}.jsonl`);
    status.system.auditFiles = auditFiles.length;
    if (fs.existsSync(todayFile)) {
      const lines = fs.readFileSync(todayFile, 'utf8').trim().split('\n').filter(Boolean);
      status.system.todayActions = lines.length;
      // Count by tool
      const toolCounts = {};
      for (const l of lines) {
        try { const e = JSON.parse(l); toolCounts[e.tool] = (toolCounts[e.tool] || 0) + 1; } catch { /* silent */ }
      }
      status.system.toolUsage = toolCounts;
    }
  } catch { /* silent */ }

  // Checkpoint
  const cp = getLatestCheckpoint();
  status.lastCheckpoint = cp ? { ts: cp.ts, summary: cp.summary, pending: cp.pendingTasks } : null;

  // Queue
  const pending = queueList('pending');
  status.queue = { pending: pending.length, items: pending.slice(0, 5) };

  // Context saves
  try {
    const ctxFiles = fs.readdirSync(DIRS.contexts).filter(f => f.endsWith('.json'));
    status.savedContexts = ctxFiles.length;
  } catch { /* silent */ status.savedContexts = 0; }

  // Session markers
  try {
    const markers = fs.readdirSync(DIRS.logs).filter(f => f.startsWith('.last-session-'));
    status.recentSessions = markers.length;
  } catch { /* silent */ }

  return status;
}

// ── Cleanup ──
function cleanup() {
  const results = { deleted: 0, errors: 0 };
  const now = Date.now();

  // 30-day audit logs
  try {
    for (const f of fs.readdirSync(DIRS.audit)) {
      const fp = path.join(DIRS.audit, f);
      if (now - fs.statSync(fp).mtimeMs > 30 * 86400000) {
        fs.unlinkSync(fp); results.deleted++;
      }
    }
  } catch { /* silent */ results.errors++; }

  // 14-day checkpoints
  try {
    for (const f of fs.readdirSync(DIRS.checkpoints)) {
      const fp = path.join(DIRS.checkpoints, f);
      if (now - fs.statSync(fp).mtimeMs > 14 * 86400000) {
        fs.unlinkSync(fp); results.deleted++;
      }
    }
  } catch { /* silent */ results.errors++; }

  // 7-day session markers
  try {
    for (const f of fs.readdirSync(DIRS.logs)) {
      if (!f.startsWith('.last-session-')) continue;
      const fp = path.join(DIRS.logs, f);
      if (now - fs.statSync(fp).mtimeMs > 7 * 86400000) {
        fs.unlinkSync(fp); results.deleted++;
      }
    }
  } catch { /* silent */ results.errors++; }

  // Completed queue items older than 7 days
  const queueFile = path.join(DIRS.queue, 'commands.jsonl');
  if (fs.existsSync(queueFile)) {
    try {
      const lines = fs.readFileSync(queueFile, 'utf8').trim().split('\n').filter(Boolean);
      const kept = lines.filter(l => {
        try {
          const e = JSON.parse(l);
          if (e.status === 'completed' && now - new Date(e.ts).getTime() > 7 * 86400000) {
            results.deleted++; return false;
          }
          return true;
        } catch { /* silent */ return true; }
      });
      fs.writeFileSync(queueFile, kept.join('\n') + '\n');
    } catch { /* silent */ results.errors++; }
  }

  return results;
}

// ── Lane Queue (OpenClaw-style session-scoped serial queue) ──
const LANES_DIR = path.join(DIRS.queue, 'lanes');
fs.mkdirSync(LANES_DIR, { recursive: true });

// ── Global Concurrency Control ──
const GLOBAL_LOCK_FILE = path.join(LANES_DIR, '.global-state.json');
const DEFAULT_MAX_CONCURRENT = 3; // Max simultaneous executions across all sessions

function loadGlobalState() {
  try {
    if (fs.existsSync(GLOBAL_LOCK_FILE)) {
      const data = JSON.parse(fs.readFileSync(GLOBAL_LOCK_FILE, 'utf8'));
      // Clean stale entries (older than 5 min)
      const now = Date.now();
      data.running = (data.running || []).filter(r => now - new Date(r.ts).getTime() < 300_000);
      return data;
    }
  } catch { /* silent */ }
  return { maxConcurrent: DEFAULT_MAX_CONCURRENT, running: [], totalCompleted: 0, totalFailed: 0 };
}

function saveGlobalState(state) {
  try {
    fs.writeFileSync(GLOBAL_LOCK_FILE, JSON.stringify(state, null, 2));
  } catch { /* silent */ }
}

function laneFile(sessionId) {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(LANES_DIR, `lane-${safe}.jsonl`);
}

function lockFile(sessionId) {
  return laneFile(sessionId) + '.lock';
}

function laneAdd(sessionId, command, priority = 'normal', metadata = {}) {
  const file = laneFile(sessionId);
  const entry = {
    id: `ln-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    ts: new Date().toISOString(),
    sessionId,
    command,
    priority,
    status: 'pending',
    ...metadata,
  };
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  return entry;
}

function laneList(sessionId, statusFilter = 'all') {
  const file = laneFile(sessionId);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { /* silent */ return null; } })
    .filter(e => e && (statusFilter === 'all' || e.status === statusFilter));
}

function laneNext(sessionId) {
  // Global concurrency check
  const globalState = loadGlobalState();
  const maxConcurrent = globalState.maxConcurrent || DEFAULT_MAX_CONCURRENT;
  if (globalState.running.length >= maxConcurrent) {
    return {
      globalLimited: true,
      running: globalState.running.length,
      max: maxConcurrent,
      sessions: globalState.running.map(r => r.sessionId)
    };
  }

  // Check lock - serial execution
  const lock = lockFile(sessionId);
  if (fs.existsSync(lock)) {
    try {
      const lockData = JSON.parse(fs.readFileSync(lock, 'utf8'));
      // Stale lock check (5 min timeout)
      if (Date.now() - new Date(lockData.ts).getTime() < 300000) {
        return { locked: true, lockedBy: lockData.id, lockedAt: lockData.ts };
      }
      // Stale lock - remove it
      fs.unlinkSync(lock);
    } catch { /* silent */ fs.unlinkSync(lock); }
  }

  // Get next pending (priority: urgent > high > normal > low)
  const pending = laneList(sessionId, 'pending');
  if (pending.length === 0) return { empty: true };

  const priorityOrder = { urgent: 0, high: 1, normal: 2, low: 3 };
  pending.sort((a, b) => (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2));

  const next = pending[0];

  // Acquire lock
  fs.writeFileSync(lock, JSON.stringify({ id: next.id, ts: new Date().toISOString() }));

  // Register in global running list
  globalState.running.push({
    sessionId,
    id: next.id,
    command: next.command?.slice(0, 100),
    ts: new Date().toISOString()
  });
  saveGlobalState(globalState);

  // Update status to 'running'
  laneUpdateStatus(sessionId, next.id, 'running');

  return { item: next };
}

function laneComplete(sessionId, id, result = null) {
  laneUpdateStatus(sessionId, id, 'completed', result);
  // Release lock
  const lock = lockFile(sessionId);
  if (fs.existsSync(lock)) {
    try {
      const lockData = JSON.parse(fs.readFileSync(lock, 'utf8'));
      if (lockData.id === id) fs.unlinkSync(lock);
    } catch { /* silent */ fs.unlinkSync(lock); }
  }
  // Update global state
  const globalState = loadGlobalState();
  globalState.running = globalState.running.filter(r => !(r.sessionId === sessionId && r.id === id));
  globalState.totalCompleted = (globalState.totalCompleted || 0) + 1;
  saveGlobalState(globalState);
  return { success: true, id };
}

function laneFail(sessionId, id, error = null) {
  laneUpdateStatus(sessionId, id, 'failed', null, error);
  // Release lock
  const lock = lockFile(sessionId);
  if (fs.existsSync(lock)) fs.unlinkSync(lock);
  // Update global state
  const globalState = loadGlobalState();
  globalState.running = globalState.running.filter(r => !(r.sessionId === sessionId && r.id === id));
  globalState.totalFailed = (globalState.totalFailed || 0) + 1;
  saveGlobalState(globalState);
  return { success: true, id, status: 'failed' };
}

function laneUpdateStatus(sessionId, id, newStatus, result = null, error = null) {
  const file = laneFile(sessionId);
  if (!fs.existsSync(file)) return false;
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  const updated = lines.map(l => {
    try {
      const e = JSON.parse(l);
      if (e.id === id) {
        e.status = newStatus;
        if (result !== null) e.result = result;
        if (error !== null) e.error = error;
        if (newStatus === 'completed' || newStatus === 'failed') e.completedAt = new Date().toISOString();
        return JSON.stringify(e);
      }
      return l;
    } catch { /* silent */ return l; }
  });
  fs.writeFileSync(file, updated.join('\n') + '\n');
  return true;
}

function laneStats(sessionId) {
  const items = laneList(sessionId, 'all');
  const pending = items.filter(i => i.status === 'pending').length;
  const running = items.filter(i => i.status === 'running').length;
  const completed = items.filter(i => i.status === 'completed').length;
  const failed = items.filter(i => i.status === 'failed').length;
  const lock = lockFile(sessionId);
  const locked = fs.existsSync(lock);
  return { total: items.length, pending, running, completed, failed, locked };
}

// ── Global Lane Stats ──
function globalStats() {
  const state = loadGlobalState();
  // Also collect per-session stats
  const sessionStats = {};
  try {
    const laneFiles = fs.readdirSync(LANES_DIR).filter(f => f.startsWith('lane-') && f.endsWith('.jsonl'));
    for (const f of laneFiles) {
      const sessionId = f.replace('lane-', '').replace('.jsonl', '');
      sessionStats[sessionId] = laneStats(sessionId);
    }
  } catch { /* silent */ }

  return {
    maxConcurrent: state.maxConcurrent || DEFAULT_MAX_CONCURRENT,
    currentRunning: state.running.length,
    running: state.running,
    totalCompleted: state.totalCompleted || 0,
    totalFailed: state.totalFailed || 0,
    sessions: sessionStats,
  };
}

function setMaxConcurrent(n) {
  const state = loadGlobalState();
  state.maxConcurrent = Math.max(1, Math.min(parseInt(n) || DEFAULT_MAX_CONCURRENT, 10));
  saveGlobalState(state);
  return { maxConcurrent: state.maxConcurrent };
}

// ── Metrics (computed from audit log) ──
function getMetrics() {
  const today = localDate();
  const file = path.join(DIRS.audit, `audit-${today}.jsonl`);
  if (!fs.existsSync(file)) return { total: 0, message: 'No audit log for today' };

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  const entries = lines.map(l => { try { return JSON.parse(l); } catch { /* silent */ return null; } }).filter(Boolean);

  let ok = 0, errors = 0, blocked = 0;
  const tools = {}, groups = {};
  const sessions = new Set();

  entries.forEach(e => {
    if (e.ok !== false) ok++;
    else errors++;
    if (e.decision === 'deny') blocked++;
    if (e.tool) tools[e.tool] = (tools[e.tool] || 0) + 1;
    const g = e.group || 'other';
    groups[g] = (groups[g] || 0) + 1;
    if (e.sid) sessions.add(e.sid);
  });

  const firstTs = entries[0] && entries[0].ts ? new Date(entries[0].ts).getTime() : Date.now();
  const lastTs = entries[entries.length - 1] && entries[entries.length - 1].ts ? new Date(entries[entries.length - 1].ts).getTime() : Date.now();
  const durationMin = Math.max((lastTs - firstTs) / 60000, 1);

  return {
    date: today,
    total: entries.length,
    ok,
    errors,
    blocked,
    successRate: `${Math.round((ok / entries.length) * 100)}%`,
    blockRate: `${Math.round((blocked / Math.max(entries.length, 1)) * 100)}%`,
    opsPerMin: Math.round((entries.length / durationMin) * 10) / 10,
    durationMin: Math.round(durationMin),
    sessions: sessions.size,
    topTools: Object.entries(tools).sort((a, b) => b[1] - a[1]).slice(0, 10),
    groups,
  };
}

// ── DAG Orchestration Support ──
// ORCH_DIR is imported from lib/paths
fs.mkdirSync(ORCH_DIR, { recursive: true });

function dagSave(runId, dagData) {
  const file = path.join(ORCH_DIR, `${runId}.json`);
  fs.writeFileSync(file, JSON.stringify(dagData, null, 2));
  return { success: true, runId, file };
}

function dagLoad(runId) {
  const file = path.join(ORCH_DIR, `${runId}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { process.stderr.write('[agent-engine] dag parse: ' + e.message + '\n'); return null; }
}

function dagList(limit = 10) {
  try {
    return fs.readdirSync(ORCH_DIR)
      .filter(f => f.startsWith('run-') && f.endsWith('.json'))
      .sort().reverse()
      .slice(0, limit)
      .map(f => {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(ORCH_DIR, f), 'utf8'));
          return { runId: d.runId, goal: (d.goal || '').slice(0, 60), state: d.state, steps: d.dag?.length || 0 };
        } catch { /* silent */ return { file: f }; }
      });
  } catch { /* silent */ return []; }
}

function dagStatus(runId) {
  const data = dagLoad(runId);
  if (!data) return { error: 'not found' };
  return {
    runId: data.runId,
    state: data.state,
    goal: data.goal,
    total: data.dag?.length || 0,
    completed: data.completed?.length || 0,
    errors: data.errors?.length || 0,
    updatedAt: data.updatedAt,
  };
}

// ── CLI ──
const [,, cmd, ...args] = process.argv;

switch (cmd) {
  case 'checkpoint':
    console.log(JSON.stringify(writeCheckpoint(args[0] || '', args.slice(1))));
    break;
  case 'queue-add':
    console.log(JSON.stringify(queueAdd(args[0], args[1] || 'normal')));
    break;
  case 'queue-list':
    console.log(JSON.stringify(queueList(args[0] || 'pending'), null, 2));
    break;
  case 'queue-complete':
    console.log(JSON.stringify({ success: queueComplete(args[0]) }));
    break;
  case 'status': {
    const st = getStatus();
    // Include orchestration info
    st.orchestration = dagList(3);
    console.log(JSON.stringify(st, null, 2));
    break;
  }
  case 'metrics':
    console.log(JSON.stringify(getMetrics(), null, 2));
    break;
  case 'cleanup':
    console.log(JSON.stringify(cleanup()));
    break;
  // ── Lane Queue Commands ──
  case 'lane-add':
    console.log(JSON.stringify(laneAdd(args[0], args[1], args[2] || 'normal')));
    break;
  case 'lane-list':
    console.log(JSON.stringify(laneList(args[0], args[1] || 'all'), null, 2));
    break;
  case 'lane-next':
    console.log(JSON.stringify(laneNext(args[0])));
    break;
  case 'lane-complete':
    console.log(JSON.stringify(laneComplete(args[0], args[1], args[2] || null)));
    break;
  case 'lane-fail':
    console.log(JSON.stringify(laneFail(args[0], args[1], args[2] || null)));
    break;
  case 'lane-stats':
    console.log(JSON.stringify(laneStats(args[0]), null, 2));
    break;
  // ── DAG Orchestration Commands ──
  case 'dag-save':
    try {
      const dagData = JSON.parse(args[1] || '{}');
      console.log(JSON.stringify(dagSave(args[0], dagData)));
    } catch (e) { console.log(JSON.stringify({ error: e.message })); }
    break;
  case 'dag-load':
    console.log(JSON.stringify(dagLoad(args[0]) || { error: 'not found' }, null, 2));
    break;
  case 'dag-list':
    console.log(JSON.stringify(dagList(parseInt(args[0]) || 10), null, 2));
    break;
  case 'dag-status':
    console.log(JSON.stringify(dagStatus(args[0]), null, 2));
    break;
  // ── Global Concurrency Commands ──
  case 'global-stats':
    console.log(JSON.stringify(globalStats(), null, 2));
    break;
  case 'global-set-max':
    console.log(JSON.stringify(setMaxConcurrent(args[0])));
    break;
  case 'global-running':
    console.log(JSON.stringify(loadGlobalState().running, null, 2));
    break;
  default:
    console.log('Usage: node agent-engine.js <command> [args]');
    console.log('  checkpoint, queue-add, queue-list, queue-complete, status, metrics, cleanup');
    console.log('  lane-add <session> <cmd> [priority], lane-list <session>, lane-next <session>');
    console.log('  lane-complete <session> <id>, lane-fail <session> <id>, lane-stats <session>');
    console.log('  dag-save <runId> <json>, dag-load <runId>, dag-list [limit], dag-status <runId>');
    console.log('  global-stats, global-set-max <n>, global-running');
}

// ── Module Exports (for direct require instead of execSync) ──
if (typeof module !== 'undefined') {
  module.exports = {
    writeCheckpoint,
    getLatestCheckpoint,
    queueAdd,
    queueList,
    queueComplete,
    getStatus,
    getMetrics,
    cleanup,
    laneAdd,
    laneNext,
    laneComplete,
    laneFail,
    laneStats,
  };
}
