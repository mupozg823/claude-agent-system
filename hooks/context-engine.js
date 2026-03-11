#!/usr/bin/env node
/**
 * context-engine.js - Context Persistence Engine
 *
 * Solves lossy compaction problem by creating structured snapshots.
 * Integrates session-init (restore) and pre-compact (save) flows.
 *
 * Two modes:
 *   1. save   - Called by pre-compact hook before compaction
 *   2. restore - Called by session-init hook at session start
 *
 * Snapshot format: JSON with git state, decisions, tasks, and architecture notes.
 * Expected: context loss -80%, defensive prompting eliminated.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { CHECKPOINT_DIR, AUDIT_DIR, CONTEXTS_DIR, QUEUE_DIR, LOGS_DIR } = require('./lib/paths');
const { safeRead, localDate, readJsonl, atomicWrite, latestFile, appendJsonl, auditFilePath } = require('./lib/utils');
const { checkpointCache } = require('./lib/cache');

const SNAPSHOT_DIR = path.join(CHECKPOINT_DIR, 'snapshots');

// ── Git helpers ──

function gitExec(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); } catch { /* silent */ return null; }
}

function getGitState() {
  const branch = gitExec('git rev-parse --abbrev-ref HEAD');
  const lastCommit = gitExec('git log -1 --format="%h %s"');
  const dirtyRaw = gitExec('git diff --name-only');
  const stagedRaw = gitExec('git diff --cached --name-only');
  const dirtyFiles = dirtyRaw ? dirtyRaw.split('\n').filter(Boolean) : [];
  const stagedFiles = stagedRaw ? stagedRaw.split('\n').filter(Boolean) : [];
  return { branch, lastCommit, dirtyFiles, stagedFiles };
}

// ── Decision extraction ──

/**
 * Extract decisions from recent audit log entries.
 * Looks for [DECISION] markers in tool summaries.
 */
function extractDecisions(auditEntries) {
  const decisions = [];
  for (const entry of auditEntries) {
    const summary = entry.summary || '';
    // Look for explicit decision markers
    if (summary.includes('[DECISION]') || summary.includes('[결정]')) {
      decisions.push(summary.replace(/\[DECISION\]|\[결정\]/g, '').trim());
    }
  }
  return decisions;
}

/**
 * Extract architecture notes from audit entries.
 * Files frequently read/edited suggest architectural understanding.
 */
function extractArchitecture(auditEntries) {
  const fileAccess = new Map(); // file → { reads, edits }
  for (const entry of auditEntries) {
    const summary = entry.summary || '';
    let file = null;
    if (summary.startsWith('read →') || summary.startsWith('edit →') || summary.startsWith('write →')) {
      file = summary.split('→')[1]?.trim().split(' ')[0];
    }
    if (file) {
      const stats = fileAccess.get(file) || { reads: 0, edits: 0 };
      if (summary.startsWith('read')) stats.reads++;
      else stats.edits++;
      fileAccess.set(file, stats);
    }
  }

  // Files with multiple accesses indicate architectural significance
  const significant = [];
  for (const [file, stats] of fileAccess) {
    if (stats.reads + stats.edits >= 3) {
      significant.push(`${file} (r:${stats.reads} e:${stats.edits})`);
    }
  }
  return significant.slice(0, 10); // top 10
}

/**
 * Extract pending tasks from queue
 */
function getPendingTasks() {
  try {
    const qFile = path.join(QUEUE_DIR, 'commands.jsonl');
    if (!fs.existsSync(qFile)) return { completed: [], pending: [], blocked: [] };
    const lines = safeRead(qFile).trim().split('\n').filter(Boolean);
    const result = { completed: [], pending: [], blocked: [] };
    for (const line of lines) {
      try {
        const cmd = JSON.parse(line);
        const desc = cmd.command || cmd.description || 'unknown';
        if (cmd.status === 'completed') result.completed.push(desc);
        else if (cmd.status === 'blocked') result.blocked.push(desc);
        else result.pending.push(desc);
      } catch { /* silent */ }
    }
    return result;
  } catch { /* silent */ return { completed: [], pending: [], blocked: [] }; }
}

// ── Save: Create structured snapshot ──

function createSnapshot(sessionId) {
  const ts = new Date().toISOString();
  const git = getGitState();
  const tasks = getPendingTasks();

  // Read recent audit entries
  const auditFile = path.join(AUDIT_DIR, `audit-${localDate()}.jsonl`);
  const auditEntries = readJsonl(auditFile);
  const recentEntries = auditEntries.slice(-50); // last 50 actions

  const decisions = extractDecisions(recentEntries);
  const architecture = extractArchitecture(recentEntries);

  // Files touched in this session
  const filesTouched = new Set();
  for (const entry of recentEntries) {
    const summary = entry.summary || '';
    const match = summary.match(/→\s*([^\s(]+)/);
    if (match) filesTouched.add(match[1]);
  }

  // Next steps from latest checkpoint
  const nextSteps = [];
  const cp = latestFile(CHECKPOINT_DIR, '.jsonl');
  if (cp) {
    const lines = safeRead(cp).trim().split('\n').filter(Boolean);
    if (lines.length > 0) {
      try {
        const last = JSON.parse(lines[lines.length - 1]);
        if (last.pendingTasks) nextSteps.push(...last.pendingTasks);
      } catch { /* silent */ }
    }
  }

  const snapshot = {
    version: 1,
    session_id: sessionId || 'unknown',
    ts,
    git,
    tasks: {
      completed: tasks.completed.slice(-10),
      pending: tasks.pending.slice(0, 10),
      blocked: tasks.blocked,
    },
    decisions: decisions.slice(0, 10),
    architecture: architecture.slice(0, 10),
    files_touched: [...filesTouched].slice(0, 20),
    next_steps: nextSteps.slice(0, 5),
    recent_actions: recentEntries.slice(-10).map(e => ({
      ts: e.ts,
      tool: e.tool,
      summary: (e.summary || '').slice(0, 100),
      ok: e.ok,
    })),
  };

  // Write snapshot
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const fileName = `snapshot-${ts.replace(/[:.]/g, '-')}.json`;
  const filePath = path.join(SNAPSHOT_DIR, fileName);
  atomicWrite(filePath, JSON.stringify(snapshot, null, 2));

  return { snapshot, filePath };
}

// ── Restore: Load latest snapshot ──

function restoreSnapshot() {
  const cached = checkpointCache.get('latest-snapshot');
  if (cached) return cached;

  const snapshotFile = latestFile(SNAPSHOT_DIR, '.json');
  if (!snapshotFile) return null;

  try {
    const snapshot = JSON.parse(safeRead(snapshotFile));
    // Skip if older than 24h
    const age = Date.now() - new Date(snapshot.ts).getTime();
    if (age > 24 * 60 * 60 * 1000) return null;

    checkpointCache.set('latest-snapshot', snapshot);
    return snapshot;
  } catch (e) { process.stderr.write('[context-engine] restore: ' + e.message + '\n'); return null; }
}

/**
 * Format snapshot as compact context string for session-init injection.
 * Target: ~500 tokens (vs previous ~2000 tokens).
 */
function formatSnapshotContext(snapshot) {
  if (!snapshot) return null;

  const parts = [];

  // Git state (most important for orientation)
  if (snapshot.git?.branch) {
    parts.push(`[Git] ${snapshot.git.branch} @ ${snapshot.git.lastCommit || '?'}`);
    if (snapshot.git.dirtyFiles.length > 0) {
      parts.push(`  변경: ${snapshot.git.dirtyFiles.slice(0, 5).join(', ')}`);
    }
  }

  // Decisions (critical for continuity)
  if (snapshot.decisions?.length > 0) {
    parts.push(`[결정] ${snapshot.decisions.slice(0, 3).join(' | ')}`);
  }

  // Pending tasks
  if (snapshot.tasks?.pending?.length > 0) {
    parts.push(`[미완료] ${snapshot.tasks.pending.slice(0, 3).join(', ')}`);
  }

  // Architecture notes
  if (snapshot.architecture?.length > 0) {
    parts.push(`[핵심 파일] ${snapshot.architecture.slice(0, 5).join(', ')}`);
  }

  // Next steps
  if (snapshot.next_steps?.length > 0) {
    parts.push(`[다음] ${snapshot.next_steps.slice(0, 3).join(', ')}`);
  }

  if (parts.length === 0) return null;
  return parts.join('\n');
}

// ── Cleanup old snapshots (keep last 10) ──

function cleanupSnapshots() {
  try {
    const files = fs.readdirSync(SNAPSHOT_DIR)
      .filter(f => f.startsWith('snapshot-') && f.endsWith('.json'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(SNAPSHOT_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    for (const f of files.slice(10)) {
      fs.unlinkSync(path.join(SNAPSHOT_DIR, f.name));
    }
  } catch { /* silent */ }
}

// ── CLI / Hook mode ──

if (require.main === module) {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'save': {
      const sessionId = process.argv[3] || process.env.SESSION_ID;
      const result = createSnapshot(sessionId);
      console.log(`Snapshot saved: ${result.filePath}`);
      cleanupSnapshots();
      break;
    }
    case 'restore': {
      const snapshot = restoreSnapshot();
      if (snapshot) {
        const context = formatSnapshotContext(snapshot);
        console.log(context || 'No relevant context.');
      } else {
        console.log('No recent snapshot found.');
      }
      break;
    }
    case 'show': {
      const snapshot = restoreSnapshot();
      console.log(JSON.stringify(snapshot, null, 2));
      break;
    }
    default:
      console.log('Usage: node context-engine.js <save|restore|show> [session_id]');
  }
}

module.exports = {
  createSnapshot,
  restoreSnapshot,
  formatSnapshotContext,
  cleanupSnapshots,
  getGitState,
  extractDecisions,
  SNAPSHOT_DIR,
};
