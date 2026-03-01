#!/usr/bin/env node
/**
 * session-init.js - SessionStart hook (replaces session-init.sh)
 *
 * 3-tier context loading + OpenClaw-style context compaction:
 *   1) Latest checkpoint (checkpoints/*.jsonl → last entry)
 *   2) Latest context-save (contexts/*.json)
 *   3) Latest session log (logs/*.md → "다음에 이어서 할 작업")
 *   4) Command queue pending items (queue/commands.jsonl)
 *   5) Context compaction: auto-truncate if total context exceeds MAX_CONTEXT_CHARS
 *
 * stdout: { hookSpecificOutput: { hookEventName, additionalContext } }
 */

const fs = require('fs');
const path = require('path');
const { DIRS } = require('./lib/utils');

function out(s) { process.stdout.write(s); }

function safeRead(fp) {
  try { return fs.readFileSync(fp, 'utf8'); } catch { return ''; }
}

function latestFile(dir, ext) {
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith(ext))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return files.length > 0 ? path.join(dir, files[0].name) : null;
  } catch { return null; }
}

function getCheckpointContext() {
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
  } catch { return null; }
}

function getContextSave() {
  const ctx = latestFile(DIRS.contexts, '.json');
  if (!ctx) return null;
  try {
    const data = JSON.parse(safeRead(ctx));
    const age = Date.now() - new Date(data.savedAt).getTime();
    if (age > 48 * 60 * 60 * 1000) return null; // 48h 이상 지난 건 무시
    return `[컨텍스트 ${path.basename(ctx)}] ${data.description || data.task || ''}`.trim();
  } catch { return null; }
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
    } catch {}
  }
  if (pending.length === 0) return null;
  return `[대기 명령 ${pending.length}개] ${pending.slice(0, 3).join(' | ')}`;
}

// OpenClaw-style context compaction: prevent context overflow
const MAX_CONTEXT_CHARS = 3000;

function compactContext(parts) {
  let context = parts.join('\n');
  if (context.length <= MAX_CONTEXT_CHARS) return context;

  // Priority: checkpoint > context-save > queue > log
  // Truncate least important parts first (log context)
  const truncated = [];
  let remaining = MAX_CONTEXT_CHARS;
  for (const part of parts) {
    if (remaining <= 0) {
      truncated.push(`[truncated: ${part.slice(0, 50)}...]`);
      continue;
    }
    if (part.length <= remaining) {
      truncated.push(part);
      remaining -= part.length;
    } else {
      truncated.push(part.slice(0, remaining) + '...[compacted]');
      remaining = 0;
    }
  }
  return truncated.join('\n');
}

function main() {
  // Skip context loading for orchestrator decompose calls
  if (process.env.ORCH_DECOMPOSE === '1') {
    out('{}');
    return;
  }

  const parts = [
    getCheckpointContext(),
    getContextSave(),
    getQueueContext(),
    getLogContext(),  // lowest priority - compacted first
  ].filter(Boolean);

  if (parts.length === 0) {
    out('{}');
    return;
  }

  const context = compactContext(parts);
  const result = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context
    }
  };
  out(JSON.stringify(result));
}

try { main(); } catch { out('{}'); }
