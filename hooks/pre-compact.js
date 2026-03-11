#!/usr/bin/env node
/**
 * pre-compact.js - PreCompact hook
 *
 * Saves working state before context compaction:
 *   1) Git branch + diff stat
 *   2) Last 20 audit log entries
 *   3) Latest checkpoint summary
 *   4) Structured markdown → checkpoints/compact-{ts}.md
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { CHECKPOINT_DIR, AUDIT_DIR } = require('./lib/paths');
const { safeRead, localDate, latestFile, atomicWrite, readJsonl } = require('./lib/utils');

// v4.1: Context engine for structured snapshots + telemetry
let contextEngine = null;
try { contextEngine = require('./context-engine'); } catch { /* silent */ }
let telemetry = null;
try { telemetry = require('./telemetry'); } catch { /* silent */ }
let tokenBudget = null;
try { tokenBudget = require('./token-budget'); } catch { /* silent */ }

function out(s) { process.stdout.write(s); }

function gitExec(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', timeout: 3000 }).trim(); } catch { /* silent */ return null; }
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => raw += c);
  process.stdin.on('end', () => {
    const sections = [];
    const ts = new Date().toISOString();

    sections.push(`# Pre-Compact Checkpoint ${ts}`);

    // 1) Git state
    const branch = gitExec('git rev-parse --abbrev-ref HEAD');
    const diffStat = gitExec('git diff --stat HEAD');
    if (branch || diffStat) {
      sections.push('## Git State');
      if (branch) sections.push(`- Branch: ${branch}`);
      if (diffStat) sections.push(`- Diff:\n\`\`\`\n${diffStat.slice(0, 2000)}\n\`\`\``);
    }

    // 2) Recent audit entries (last 20)
    const auditFile = path.join(AUDIT_DIR, `audit-${localDate()}.jsonl`);
    const entries = readJsonl(auditFile);
    if (entries.length > 0) {
      const recent = entries.slice(-20);
      sections.push('## Recent Actions');
      for (const e of recent) {
        sections.push(`- [${e.ts || '?'}] ${e.ev || 'unknown'}: ${e.tool || e.detail || JSON.stringify(e).slice(0, 100)}`);
      }
    }

    // 3) Latest checkpoint
    const cp = latestFile(CHECKPOINT_DIR, '.jsonl');
    if (cp) {
      const lines = safeRead(cp).trim().split('\n').filter(Boolean);
      if (lines.length > 0) {
        try {
          const last = JSON.parse(lines[lines.length - 1]);
          sections.push('## Previous Checkpoint');
          sections.push(`- ${last.ts}: ${last.summary || 'no summary'}`);
          if (last.pendingTasks && last.pendingTasks.length > 0) {
            sections.push(`- Pending: ${last.pendingTasks.join(', ')}`);
          }
        } catch { /* silent */ }
      }
    }

    // 4) Pending tasks from env
    if (process.env.PENDING_TASKS) {
      sections.push('## Working Context');
      sections.push(`- Tasks: ${process.env.PENDING_TASKS}`);
    }

    // Write compact checkpoint (legacy markdown format)
    const content = sections.join('\n\n') + '\n';
    const fileName = `compact-${ts.replace(/[:.]/g, '-')}.md`;
    const filePath = path.join(CHECKPOINT_DIR, fileName);

    try {
      atomicWrite(filePath, content);
    } catch (e) {
      process.stderr.write(`pre-compact error: ${e.message}\n`);
    }

    // v4.1: Also create structured JSON snapshot (for context-engine restore)
    if (contextEngine) {
      try { contextEngine.createSnapshot(); } catch { /* silent */ }
    }

    // v4.1: Record compaction event in telemetry + token budget
    if (telemetry) {
      try { telemetry.recordCompaction(); } catch { /* silent */ }
    }
    if (tokenBudget) {
      try { tokenBudget.recordCompaction(); } catch { /* silent */ }
    }

    out('{}');
  });
}

main();
