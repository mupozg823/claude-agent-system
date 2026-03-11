#!/usr/bin/env node
/**
 * session-init.js - SessionStart hook (replaces session-init.sh)
 *
 * 3-tier context loading:
 *   1) Latest checkpoint (checkpoints/*.jsonl → last entry)
 *   2) Latest context-save (contexts/*.json)
 *   3) Latest session log (logs/*.md → "다음에 이어서 할 작업")
 *   4) Command queue pending items (queue/commands.jsonl)
 *
 * stdout: { hookSpecificOutput: { hookEventName, additionalContext } }
 */

const fs = require('fs');
const path = require('path');
const { LOGS_DIR, AUDIT_DIR, CHECKPOINT_DIR, CONTEXTS_DIR, QUEUE_DIR } = require('./lib/paths');
const { safeRead, latestFile } = require('./lib/utils');

// v4: Context engine integration for structured snapshot restore
let contextEngine = null;
try { contextEngine = require('./context-engine'); } catch { /* silent */ }
let telemetry = null;
try { telemetry = require('./telemetry'); } catch { /* silent */ }

const DIRS = {
  logs: LOGS_DIR,
  audit: AUDIT_DIR,
  checkpoints: CHECKPOINT_DIR,
  contexts: CONTEXTS_DIR,
  queue: QUEUE_DIR,
};

function out(s) { process.stdout.write(s); }

// safeRead, latestFile → lib/utils.js에서 import

function getCheckpointContext() {
  // 1) Check compact checkpoints (.md) first — created by pre-compact.js
  const compactCp = latestFile(DIRS.checkpoints, '.md');
  if (compactCp) {
    const content = safeRead(compactCp);
    if (content) {
      const age = Date.now() - fs.statSync(compactCp).mtimeMs;
      if (age < 24 * 60 * 60 * 1000) {
        return `[컴팩트 체크포인트 ${path.basename(compactCp)}] ${content.slice(0, 500)}`;
      }
    }
  }

  // 2) Regular JSONL checkpoints
  const cp = latestFile(DIRS.checkpoints, '.jsonl');
  if (!cp) return null;
  const lines = safeRead(cp).trim().split('\n').filter(Boolean);
  if (lines.length === 0) return null;
  try {
    const last = JSON.parse(lines[lines.length - 1]);
    const tasks = last.pendingTasks || [];
    const summary = last.summary || '';
    if (tasks.length === 0 && !summary) return null;
    const age = Date.now() - new Date(last.ts).getTime();
    if (age > 24 * 60 * 60 * 1000) return null; // 24h 이상 지난 건 무시
    return `[체크포인트 ${last.ts}] ${summary}${tasks.length > 0 ? ` | 미완료: ${tasks.join(', ')}` : ''}`;
  } catch { /* silent */ return null; }
}

function getContextSave() {
  const ctx = latestFile(DIRS.contexts, '.json');
  if (!ctx) return null;
  try {
    const data = JSON.parse(safeRead(ctx));
    const age = Date.now() - new Date(data.savedAt).getTime();
    if (age > 48 * 60 * 60 * 1000) return null; // 48h 이상 지난 건 무시
    return `[컨텍스트 ${path.basename(ctx)}] ${data.description || data.task || ''}`.trim();
  } catch { /* silent */ return null; }
}

function getLogContext() {
  const log = latestFile(DIRS.logs, '.md');
  if (!log) return null;
  const content = safeRead(log);
  if (!content) return null;

  // "다음에 이어서 할 작업" 섹션 추출
  const patterns = ['다음에 이어서 할 작업', '## Next', '## TODO', '## Remaining'];
  for (const p of patterns) {
    const idx = content.indexOf(p);
    if (idx !== -1) {
      const section = content.slice(idx, idx + 500).split(/\n## /)[0].trim();
      return `[이전 세션 ${path.basename(log)}] ${section.slice(0, 300)}`;
    }
  }
  // 없으면 첫 5줄
  const lines = content.split('\n').slice(0, 5).join(' ').trim();
  return lines ? `[이전 세션 ${path.basename(log)}] ${lines.slice(0, 200)}` : null;
}

function getQueueContext() {
  const queueFile = path.join(DIRS.queue, 'commands.jsonl');
  if (!fs.existsSync(queueFile)) return null;
  const lines = safeRead(queueFile).trim().split('\n').filter(Boolean);
  const pending = [];
  for (const line of lines) {
    try {
      const cmd = JSON.parse(line);
      if (cmd.status === 'pending') pending.push(cmd.command || cmd.description);
    } catch { /* silent */ }
  }
  if (pending.length === 0) return null;
  return `[대기 명령 ${pending.length}개] ${pending.slice(0, 3).join(' | ')}`;
}

function main() {
  // Skip context loading for orchestrator decompose calls
  if (process.env.ORCH_DECOMPOSE === '1') {
    out('{}');
    return;
  }

  // v4: Try structured snapshot first (faster, more compact ~500 tokens)
  if (contextEngine) {
    try {
      const snapshot = contextEngine.restoreSnapshot();
      if (snapshot) {
        const snapshotContext = contextEngine.formatSnapshotContext(snapshot);
        if (snapshotContext) {
          if (telemetry) telemetry.recordContextRestore();
          const result = {
            hookSpecificOutput: {
              hookEventName: 'SessionStart',
              additionalContext: snapshotContext
            }
          };
          out(JSON.stringify(result));
          return;
        }
      }
    } catch (e) { process.stderr.write('[session-init] snapshot restore: ' + e.message + '\n'); }
  }

  // Fallback: original 3-tier context loading
  const parts = [
    getCheckpointContext(),
    getContextSave(),
    getLogContext(),
    getQueueContext(),
  ].filter(Boolean);

  if (parts.length === 0) {
    out('{}');
    return;
  }

  const context = parts.join('\n');
  const result = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context
    }
  };
  out(JSON.stringify(result));
}

try { main(); } catch { /* silent */ out('{}'); }
