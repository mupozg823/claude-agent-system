#!/usr/bin/env node
/**
 * heartbeat.js - Autonomous Heartbeat Daemon
 *
 * OpenClaw-style heartbeat: HEARTBEAT.md를 읽고 "지금 행동 필요?" 판단
 * Windows Task Scheduler에서 주기적으로 호출
 *
 * Usage:
 *   node heartbeat.js              → Check & execute enabled tasks
 *   node heartbeat.js --install    → Install Windows Task Scheduler job
 *   node heartbeat.js --uninstall  → Remove scheduled job
 *   node heartbeat.js --status     → Show heartbeat status
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { DIRS, CLAUDE_DIR, ENGINE } = require('./lib/utils');

const HEARTBEAT_MD = path.join(CLAUDE_DIR, 'HEARTBEAT.md');
const HEARTBEAT_LOG = path.join(DIRS.logs, 'heartbeat.jsonl');

function log(action, result) {
  try {
    fs.mkdirSync(path.dirname(HEARTBEAT_LOG), { recursive: true });
    fs.appendFileSync(HEARTBEAT_LOG, JSON.stringify({
      ts: new Date().toISOString(),
      action,
      result,
    }) + '\n');
  } catch {}
}

function parseHeartbeat() {
  if (!fs.existsSync(HEARTBEAT_MD)) return [];
  const content = fs.readFileSync(HEARTBEAT_MD, 'utf8');
  const tasks = [];
  const blocks = content.split(/###\s+\d+\.\s+/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;

    const name = lines[0].trim();
    const props = {};
    for (const line of lines) {
      const m = line.replace(/\r$/, '').match(/^-\s+(\w+):\s+(.+)$/);
      if (m) props[m[1]] = m[2].trim();
    }

    if (props.enabled === 'true') {
      tasks.push({ name, ...props });
    }
  }
  return tasks;
}

function executeTask(task) {
  switch (task.action) {
    case 'cleanup old audit logs (30 days), checkpoints (14 days), markers (7 days)':
      try {
        const result = execSync(`node "${ENGINE}" cleanup`, { encoding: 'utf8', timeout: 10000 });
        log('cleanup', result.trim());
        return { success: true, result: result.trim() };
      } catch (e) {
        log('cleanup', `error: ${e.message}`);
        return { success: false, error: e.message };
      }

    case 'check ~/.claude/queue/commands.jsonl for pending items':
      try {
        const result = execSync(`node "${ENGINE}" queue-list`, { encoding: 'utf8', timeout: 5000 });
        const items = JSON.parse(result);
        log('queue-check', `${items.length} pending`);
        return { success: true, pending: items.length };
      } catch (e) {
        return { success: false, error: e.message };
      }

    case 'disk space, node version, git status of active projects':
      try {
        const nodeVer = execSync('node --version', { encoding: 'utf8', timeout: 5000 }).trim();
        log('status-check', `node: ${nodeVer}`);
        return { success: true, nodeVersion: nodeVer };
      } catch (e) {
        return { success: false, error: e.message };
      }

    case 'check relay-supabase.js process alive, restart if crashed':
      try {
        const relayScript = path.join(path.dirname(__filename), 'relay-supabase.js');
        const configFile = path.join(path.dirname(__filename), '..', '.supabase-config.json');
        if (!fs.existsSync(configFile)) {
          log('relay-check', 'no config - skipped');
          return { skipped: true, reason: 'no .supabase-config.json' };
        }
        // Check if relay process is running (look for node relay-supabase in process list)
        try {
          const ps = execSync('tasklist /FI "IMAGENAME eq node.exe" /FO CSV', { encoding: 'utf8', timeout: 5000 });
          // Simple heuristic: if relay was started, there should be a relay log
          const relayLog = '/tmp/relay-remote.log';
          if (fs.existsSync(relayLog)) {
            const stat = fs.statSync(relayLog);
            const age = Date.now() - stat.mtimeMs;
            if (age < 120000) { // Updated within 2 minutes
              log('relay-check', 'relay alive (log fresh)');
              return { success: true, status: 'running' };
            }
          }
          // Relay seems dead, restart it
          const { spawn } = require('child_process');
          const child = spawn('node', [relayScript], {
            detached: true, stdio: ['ignore', fs.openSync(relayLog, 'a'), fs.openSync(relayLog, 'a')]
          });
          child.unref();
          log('relay-check', `restarted relay (PID: ${child.pid})`);
          return { success: true, status: 'restarted', pid: child.pid };
        } catch (e2) {
          log('relay-check', `process check failed: ${e2.message}`);
          return { success: false, error: e2.message };
        }
      } catch (e) {
        return { success: false, error: e.message };
      }

    default:
      log('unknown-action', task.action);
      return { skipped: true, reason: 'unknown action' };
  }
}

function installScheduler() {
  const scriptPath = path.resolve(__filename).replace(/\//g, '\\');
  const taskName = 'ClaudeCodeHeartbeat';

  try {
    // Windows Task Scheduler: 매 30분마다 실행
    const cmd = `schtasks /create /tn "${taskName}" /tr "node \\"${scriptPath}\\"" /sc MINUTE /mo 30 /f`;
    execSync(cmd, { encoding: 'utf8', stdio: 'pipe' });
    console.log(`[OK] Task "${taskName}" installed (every 30 minutes)`);
    log('install', 'scheduler installed');
  } catch (e) {
    console.error(`[FAIL] ${e.message}`);
    console.log('Run as Administrator to install scheduler');
  }
}

function uninstallScheduler() {
  try {
    execSync('schtasks /delete /tn "ClaudeCodeHeartbeat" /f', { encoding: 'utf8', stdio: 'pipe' });
    console.log('[OK] Task removed');
    log('uninstall', 'scheduler removed');
  } catch (e) {
    console.error(`[FAIL] ${e.message}`);
  }
}

function showStatus() {
  try {
    const result = execSync('schtasks /query /tn "ClaudeCodeHeartbeat" /fo LIST', { encoding: 'utf8', stdio: 'pipe' });
    console.log(result);
  } catch {
    console.log('[INFO] Heartbeat scheduler not installed');
  }

  // 최근 heartbeat 로그
  if (fs.existsSync(HEARTBEAT_LOG)) {
    const lines = fs.readFileSync(HEARTBEAT_LOG, 'utf8').trim().split('\n').filter(Boolean);
    const recent = lines.slice(-5);
    console.log('\n--- Recent heartbeat logs ---');
    for (const l of recent) {
      try { const e = JSON.parse(l); console.log(`${e.ts} | ${e.action}: ${JSON.stringify(e.result)}`); } catch {}
    }
  }
}

// ── Main ──
const arg = process.argv[2];

switch (arg) {
  case '--install':
    installScheduler();
    break;
  case '--uninstall':
    uninstallScheduler();
    break;
  case '--status':
    showStatus();
    break;
  default: {
    // Default: execute heartbeat check
    const tasks = parseHeartbeat();
    const results = [];
    for (const task of tasks) {
      const r = executeTask(task);
      results.push({ task: task.name, ...r });
    }
    log('heartbeat', { tasksChecked: tasks.length, results });
    if (results.length > 0) {
      console.log(JSON.stringify({ heartbeat: results }, null, 2));
    }
    break;
  }
}
