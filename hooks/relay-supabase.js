#!/usr/bin/env node
/**
 * relay-supabase.js - Supabase Realtime Relay Daemon
 *
 * CLI 측 릴레이: 감사 로그를 Supabase로 브로드캐스트하고,
 * 모바일/웹에서 보낸 명령을 수신하여 큐에 추가합니다.
 *
 * Usage:
 *   node relay-supabase.js --setup          # Interactive setup (creates Supabase project + config)
 *   node relay-supabase.js --setup <token>  # Non-interactive setup with access token
 *   node relay-supabase.js                  # Start relay (config required)
 *   node relay-supabase.js --session my-session
 *
 * Events (broadcast):
 *   audit           Agent→Mobile   감사 로그 항목
 *   status          Agent→Mobile   시스템 상태
 *   metrics         Agent→Mobile   메트릭
 *   command-ack     Agent→Mobile   명령 수신 확인
 *   command-result  Agent→Mobile   명령 실행 결과
 *   lane-executing  Agent→Mobile   명령 실행 시작 알림
 *
 * Events (subscribe):
 *   command         Mobile→Agent   명령 전송
 *   status-request  Mobile→Agent   상태 요청
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createClient } = require('@supabase/supabase-js');

const {
  HOME, CLAUDE_DIR, HOOKS_DIR, DIRS, ENGINE,
  localDate: _localDate, AuditTailer, runEngine: _runEngine,
} = require('./lib/utils');

const AUDIT_DIR = DIRS.audit;
const CONFIG_FILE = path.join(CLAUDE_DIR, '.supabase-config.json');

// ── Config ──
function loadConfig() {
  const config = {};

  // Environment variables take precedence
  if (process.env.SUPABASE_URL) config.url = process.env.SUPABASE_URL;
  if (process.env.SUPABASE_KEY) config.anonKey = process.env.SUPABASE_KEY;

  // Then config file
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (!config.url) config.url = file.url;
      if (!config.anonKey) config.anonKey = file.anonKey;
      if (!config.sessionId) config.sessionId = file.sessionId;
    } catch (e) {
      log('warn', `Config parse error: ${e.message}`);
    }
  }

  // CLI args
  const args = process.argv.slice(2);
  const sessionIdx = args.indexOf('--session');
  if (sessionIdx !== -1 && args[sessionIdx + 1]) {
    config.sessionId = args[sessionIdx + 1];
  }

  // Generate session ID if needed
  if (!config.sessionId || config.sessionId === 'auto') {
    config.sessionId = `agent-${Date.now().toString(36)}`;
  }

  return config;
}

// ── Setup Mode ──
const SUPABASE_API = 'https://api.supabase.com';

async function httpJson(url, opts = {}) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const reqOpts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...opts.headers,
      },
    };
    const req = https.request(reqOpts, (res) => {
      let body = '';
      res.on('data', (d) => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

function prompt(question) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

async function setup() {
  console.log('\n\x1b[36m=== Supabase Relay Setup ===\x1b[0m\n');

  // Step 1: Get access token
  const args = process.argv.slice(2);
  const setupIdx = args.indexOf('--setup');
  let token = args[setupIdx + 1] && !args[setupIdx + 1].startsWith('--') ? args[setupIdx + 1] : null;

  if (!token) {
    token = process.env.SUPABASE_ACCESS_TOKEN || '';
  }

  if (!token) {
    console.log('  Supabase Access Token이 필요합니다.');
    console.log('  아래 URL에서 토큰을 생성하세요:\n');
    console.log('  \x1b[33mhttps://supabase.com/dashboard/account/tokens\x1b[0m\n');

    // Open browser
    try {
      const { exec } = require('child_process');
      const openCmd = process.platform === 'win32' ? 'start ""' :
                      process.platform === 'darwin' ? 'open' : 'xdg-open';
      exec(`${openCmd} "https://supabase.com/dashboard/account/tokens"`);
      console.log('  (브라우저가 열렸습니다)\n');
    } catch {}

    token = await prompt('  Access Token 입력: ');
    if (!token) { console.error('  토큰이 필요합니다.'); process.exit(1); }
  }

  console.log('\n  토큰 확인 중...');

  // Step 2: Validate token & list projects
  const authHeaders = { Authorization: `Bearer ${token}` };
  const { status: pStatus, data: projects } = await httpJson(`${SUPABASE_API}/v1/projects`, { headers: authHeaders });

  if (pStatus !== 200) {
    console.error(`\n  \x1b[31m토큰 인증 실패 (HTTP ${pStatus})\x1b[0m`);
    console.error('  올바른 Access Token인지 확인하세요.');
    process.exit(1);
  }

  console.log(`  인증 성공! 기존 프로젝트: ${projects.length}개\n`);

  // Step 3: Select or create project
  let project = null;

  // Look for existing claude-relay project
  const existing = projects.filter(p => p.status === 'ACTIVE_HEALTHY');
  const claudeProject = existing.find(p => p.name && p.name.includes('claude'));

  if (claudeProject) {
    console.log(`  기존 Claude 프로젝트 발견: \x1b[36m${claudeProject.name}\x1b[0m (${claudeProject.region})`);
    const use = await prompt('  이 프로젝트를 사용할까요? (Y/n): ');
    if (use.toLowerCase() !== 'n') {
      project = claudeProject;
    }
  }

  if (!project && existing.length > 0) {
    console.log('\n  사용 가능한 프로젝트:');
    existing.forEach((p, i) => {
      console.log(`    ${i + 1}. ${p.name} (${p.region}) - ${p.id}`);
    });
    const choice = await prompt(`\n  프로젝트 번호 (또는 'new'로 새로 생성): `);
    if (choice !== 'new') {
      const idx = parseInt(choice) - 1;
      if (idx >= 0 && idx < existing.length) {
        project = existing[idx];
      }
    }
  }

  if (!project) {
    console.log('\n  새 프로젝트 생성 중...');

    // Get available organizations
    const { data: orgs } = await httpJson(`${SUPABASE_API}/v1/organizations`, { headers: authHeaders });
    if (!orgs || orgs.length === 0) {
      console.error('  \x1b[31m조직(Organization)이 없습니다. Supabase 대시보드에서 먼저 생성하세요.\x1b[0m');
      process.exit(1);
    }

    const orgId = orgs[0].id;
    const projectName = `claude-relay-${Date.now().toString(36)}`;
    const dbPass = require('crypto').randomBytes(16).toString('hex');

    const { status: cStatus, data: newProject } = await httpJson(`${SUPABASE_API}/v1/projects`, {
      method: 'POST',
      headers: authHeaders,
      body: {
        organization_id: orgId,
        name: projectName,
        db_pass: dbPass,
        region: 'ap-northeast-1', // Tokyo (closest to Korea)
        plan: 'free',
      },
    });

    if (cStatus !== 201 && cStatus !== 200) {
      console.error(`\n  \x1b[31m프로젝트 생성 실패 (HTTP ${cStatus})\x1b[0m`);
      console.error('  ', JSON.stringify(newProject));
      process.exit(1);
    }

    project = newProject;
    console.log(`  프로젝트 생성됨: \x1b[36m${project.name}\x1b[0m`);

    // Wait for project to be ready
    console.log('  프로젝트 초기화 대기 중 (최대 60초)...');
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const { data: check } = await httpJson(`${SUPABASE_API}/v1/projects/${project.id}`, { headers: authHeaders });
      if (check && check.status === 'ACTIVE_HEALTHY') {
        console.log('  프로젝트 준비 완료!');
        project = check;
        break;
      }
      process.stdout.write('.');
    }
  }

  // Step 4: Get API keys
  console.log('\n  API 키 가져오는 중...');
  const { status: kStatus, data: keys } = await httpJson(`${SUPABASE_API}/v1/projects/${project.id}/api-keys`, { headers: authHeaders });

  if (kStatus !== 200 || !keys || keys.length === 0) {
    console.error(`\n  \x1b[31mAPI 키 조회 실패 (HTTP ${kStatus})\x1b[0m`);
    process.exit(1);
  }

  const anonKey = keys.find(k => k.name === 'anon');
  if (!anonKey) {
    console.error('  \x1b[31manon key를 찾을 수 없습니다.\x1b[0m');
    process.exit(1);
  }

  const projectUrl = `https://${project.id}.supabase.co`;
  const sessionId = `agent-${Date.now().toString(36)}`;

  // Step 5: Save config
  const config = {
    url: projectUrl,
    anonKey: anonKey.api_key,
    sessionId,
    projectName: project.name,
    region: project.region,
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');

  console.log('\n  \x1b[32m=== Setup Complete! ===\x1b[0m\n');
  console.log(`  Config saved: ${CONFIG_FILE}`);
  console.log(`  Project URL:  ${projectUrl}`);
  console.log(`  Session ID:   ${sessionId}`);
  console.log(`  Region:       ${project.region}\n`);
  console.log('  Relay 시작:');
  console.log(`    node relay-supabase.js\n`);
  console.log('  Dashboard 열기:');
  console.log(`    dashboard-remote.html?session=${sessionId}&url=${encodeURIComponent(projectUrl)}&key=${encodeURIComponent(anonKey.api_key)}\n`);

  // Ask to start relay
  const startNow = await prompt('  지금 Relay를 시작할까요? (Y/n): ');
  if (startNow.toLowerCase() !== 'n') {
    return main();
  }
}

function localDate() { return _localDate(); }

function log(level, msg) {
  const { log: utilLog } = require('./lib/utils');
  utilLog(level, msg);
}

// ── Exponential Backoff Reconnect ──
class BackoffReconnect {
  constructor(opts = {}) {
    this.attempts = 0;
    this.base = opts.base || 1000;      // 1 second
    this.max = opts.max || 60000;        // 60 seconds
    this.jitter = opts.jitter !== false;  // Add random jitter by default
    this._timer = null;
    this._onReconnect = null;
    this._destroyed = false;
  }

  getDelay() {
    const exp = Math.min(this.base * Math.pow(2, this.attempts), this.max);
    const jitter = this.jitter ? Math.random() * exp * 0.1 : 0;
    return Math.floor(exp + jitter);
  }

  reset() {
    this.attempts = 0;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  schedule(callback) {
    if (this._destroyed) return;
    this.attempts++;
    const delay = this.getDelay();
    log('info', `Reconnect attempt #${this.attempts} in ${delay}ms`);
    this._timer = setTimeout(() => {
      if (!this._destroyed) callback();
    }, delay);
  }

  destroy() {
    this._destroyed = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}

// AuditTailer imported from lib/utils.js
// runEngine imported as _runEngine from lib/utils.js
function runEngine(command, ...args) { return _runEngine(command, ...args); }

// ── Command Allowlist ──
const ALLOWED_COMMANDS = [
  /^\/\w/,                              // Slash commands
  /^node\s+.*agent-engine\.js\s/,       // Agent engine commands
  /^node\s+.*heartbeat\.js/,            // Heartbeat
  /^claude\s/,                          // Claude CLI
];

const BLOCKED_PATTERNS = [
  /rm\s+-rf/i, /--force/i, /--hard/i,
  /drop\s+(database|table)/i,
  /curl.*\|\s*(sh|bash)/i,
  /shutdown/i, /reboot/i,
  /npm\s+publish/i,
];

function isCommandAllowed(command) {
  if (!command || typeof command !== 'string') return false;
  const trimmed = command.trim();
  if (BLOCKED_PATTERNS.some(p => p.test(trimmed))) return false;
  if (ALLOWED_COMMANDS.some(p => p.test(trimmed))) return true;
  // Default: REJECT unknown commands (defense-in-depth)
  log('warn', `Command rejected (not in allowlist): ${trimmed.slice(0, 80)}`);
  return false;
}

// ── Main Relay ──
async function main() {
  const config = loadConfig();

  if (!config.url || config.url.includes('YOUR_PROJECT') || !config.anonKey || config.anonKey.includes('YOUR_')) {
    console.error('\n  Config이 올바르지 않습니다. --setup을 실행하세요.');
    console.error('    node relay-supabase.js --setup\n');
    process.exit(1);
  }

  log('info', '=== Supabase Realtime Relay ===');
  log('info', `Session: ${config.sessionId}`);
  log('info', `Supabase: ${config.url}`);

  // Create Supabase client
  const supabase = createClient(config.url, config.anonKey, {
    realtime: { params: { eventsPerSecond: 10 } },
  });

  const channelName = `claude:${config.sessionId}`;
  const channel = supabase.channel(channelName, {
    config: { broadcast: { ack: true, self: false } },
  });

  // Broadcast helper with error handling
  async function broadcast(event, payload) {
    try {
      await channel.send({
        type: 'broadcast',
        event,
        payload: { ...payload, _ts: new Date().toISOString() },
      });
    } catch (e) {
      log('warn', `Broadcast ${event} failed: ${e.message}`);
    }
  }

  // ── Event Handlers ──

  // Handle command from mobile
  channel.on('broadcast', { event: 'command' }, async ({ payload }) => {
    const { id, command, priority } = payload || {};
    log('info', `Command received: ${command} (priority: ${priority || 'normal'})`);

    // ── Orchestrate Command Handler ──
    if (command && (command.startsWith('/orchestrate ') || command.startsWith('orchestrate '))) {
      const goal = command.replace(/^\/?orchestrate\s+/, '');
      const ORCHESTRATOR = path.join(path.dirname(__filename), 'orchestrator.js');
      log('info', `Orchestrate: "${goal}"`);
      await broadcast('command-ack', { id, status: 'orchestrating', goal });

      // Spawn orchestrator as detached background process
      const { spawn: sp } = require('child_process');
      const orchLog = path.join(HOME, '.claude', 'logs', 'orch-latest.log');
      const out = fs.openSync(orchLog, 'a');
      const child = sp('node', [ORCHESTRATOR, goal, HOME], {
        detached: true,
        stdio: ['ignore', out, out],
        cwd: HOME,
      });
      child.unref();
      // Close fd to avoid leak (child inherits it)
      try { fs.closeSync(out); } catch {}
      log('info', `Orchestrator spawned (PID: ${child.pid})`);
      await broadcast('command-result', {
        id, command, result: `Orchestrator started (PID: ${child.pid}): ${goal}`, exitCode: 0,
      });
      return;
    }

    if (!isCommandAllowed(command)) {
      log('warn', `Command blocked: ${command}`);
      await broadcast('command-ack', { id, status: 'rejected', reason: 'blocked by security policy' });
      return;
    }

    // Use Lane Queue for session-scoped serial execution
    const result = runEngine('lane-add', config.sessionId, command, priority || 'normal');
    if (result) {
      log('info', `Lane queued: ${result.id || 'ok'}`);
      await broadcast('command-ack', { id, status: 'queued', queueId: result.id, lane: config.sessionId });
      // Trigger immediate execution instead of waiting for poll
      triggerWorker();
    } else {
      // Fallback to legacy queue
      const legacyResult = runEngine('queue-add', command, priority || 'normal');
      if (legacyResult) {
        await broadcast('command-ack', { id, status: 'queued', queueId: legacyResult.id });
        // Trigger immediate execution instead of waiting for poll
        triggerWorker();
      } else {
        await broadcast('command-ack', { id, status: 'rejected', reason: 'queue failed' });
      }
    }
  });

  // Handle status request from mobile
  channel.on('broadcast', { event: 'status-request' }, async () => {
    log('info', 'Status request received');
    const status = runEngine('status');
    if (status) await broadcast('status', status);
  });

  // ── Subscribe & Presence (with exponential backoff reconnect) ──
  const reconnect = new BackoffReconnect({ base: 1000, max: 60000 });

  function subscribeWithReconnect() {
    channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        reconnect.reset(); // Reset backoff on successful connection
        log('info', `Channel subscribed: ${channelName}`);

        // Track presence
        await channel.track({
          role: 'agent',
          sessionId: config.sessionId,
          online_at: new Date().toISOString(),
          hostname: require('os').hostname(),
          platform: process.platform,
        });

        log('info', 'Presence tracked: agent online');

        // Send initial status
        const initialStatus = runEngine('status');
        if (initialStatus) await broadcast('status', initialStatus);

        const initialMetrics = runEngine('metrics');
        if (initialMetrics) await broadcast('metrics', initialMetrics);
      } else if (status === 'CHANNEL_ERROR') {
        log('error', `Channel error on ${channelName}`);
        reconnect.schedule(async () => {
          log('info', 'Attempting reconnect...');
          try {
            await channel.unsubscribe();
          } catch {}
          subscribeWithReconnect();
        });
      } else if (status === 'TIMED_OUT') {
        log('error', 'Channel subscription timed out');
        reconnect.schedule(async () => {
          log('info', 'Attempting reconnect after timeout...');
          try {
            await channel.unsubscribe();
          } catch {}
          subscribeWithReconnect();
        });
      }
    });
  }

  subscribeWithReconnect();

  // ── Audit Log Tailing ──
  const tailer = new AuditTailer(AUDIT_DIR);
  let auditBatchBuffer = [];
  let batchTimer = null;

  function flushAuditBatch() {
    if (auditBatchBuffer.length === 0) return;
    const batch = auditBatchBuffer.splice(0, auditBatchBuffer.length);
    // Send individually for simpler client handling
    for (const entry of batch) {
      broadcast('audit', entry);
    }
  }

  tailer.startWatching((entry) => {
    auditBatchBuffer.push(entry);
    // Debounce: flush after 500ms of quiet or max 10 items
    if (auditBatchBuffer.length >= 10) {
      flushAuditBatch();
    } else {
      clearTimeout(batchTimer);
      batchTimer = setTimeout(flushAuditBatch, 500);
    }
  });

  // ── Tick Liveness (OpenClaw pattern: 60s heartbeat) ──
  const TICK_INTERVAL = 60_000;
  let tickCount = 0;
  const tickTimer = setInterval(async () => {
    tickCount++;
    await broadcast('tick', {
      seq: tickCount,
      uptime: Math.floor(process.uptime()),
      memMB: Math.round(process.memoryUsage().heapUsed / 1048576),
      entries: auditBatchBuffer.length,
    });
  }, TICK_INTERVAL);

  // ── Periodic Status/Metrics Push ──
  const STATUS_INTERVAL = 30_000;
  const statusTimer = setInterval(async () => {
    const status = runEngine('status');
    if (status) await broadcast('status', status);

    const metrics = runEngine('metrics');
    if (metrics) await broadcast('metrics', metrics);

    // Lane queue stats
    const laneStats = runEngine('lane-stats', config.sessionId);
    if (laneStats) await broadcast('lane-stats', laneStats);
  }, STATUS_INTERVAL);

  // ── Worker Loop (Event-driven with fallback poll) ──
  let workerBusy = false;

  async function runWorker() {
    if (workerBusy) return;
    workerBusy = true;

    try {
      // Process all pending items (drain loop)
      let hasMore = true;
      while (hasMore) {
        const next = runEngine('lane-next', config.sessionId);
        if (!next || next.empty || next.locked) {
          hasMore = false;
          break;
        }

        const item = next.item;
        if (!item || !item.command) {
          hasMore = false;
          break;
        }

        log('info', `Worker executing: ${item.command}`);
        await broadcast('lane-executing', { id: item.id, command: item.command });

        // Re-validate before execution (defense-in-depth)
        if (!isCommandAllowed(item.command)) {
          runEngine('lane-fail', config.sessionId, item.id, 'blocked by allowlist');
          log('warn', `Worker blocked: ${item.command}`);
          await broadcast('command-result', {
            id: item.id, command: item.command,
            result: 'Command blocked by security policy', exitCode: 127,
          });
          continue;
        }

        try {
          const result = execSync(item.command, {
            encoding: 'utf8',
            timeout: 30000,
            cwd: HOME,
            env: { ...process.env, RELAY_EXEC: '1' },
          });

          runEngine('lane-complete', config.sessionId, item.id, 'ok');
          log('info', `Worker completed: ${item.id}`);
          await broadcast('command-result', {
            id: item.id,
            command: item.command,
            result: result.trim().slice(0, 2000),
            exitCode: 0,
          });
        } catch (execErr) {
          const errMsg = (execErr.stderr || execErr.message || 'unknown error').slice(0, 1000);
          runEngine('lane-fail', config.sessionId, item.id, errMsg);
          log('warn', `Worker failed: ${item.id} - ${errMsg.slice(0, 100)}`);
          await broadcast('command-result', {
            id: item.id,
            command: item.command,
            result: errMsg,
            exitCode: execErr.status || 1,
          });
        }

        // Broadcast updated lane stats after each execution
        const laneStats = runEngine('lane-stats', config.sessionId);
        if (laneStats) await broadcast('lane-stats', laneStats);
      }
    } catch (e) {
      log('warn', `Worker loop error: ${e.message}`);
    }

    workerBusy = false;
  }

  // Fallback poll every 30s (catch any missed events)
  const WORKER_FALLBACK_INTERVAL = 30_000;
  const workerTimer = setInterval(() => runWorker(), WORKER_FALLBACK_INTERVAL);

  // Immediate trigger function (called when command is queued)
  function triggerWorker() {
    // Use setImmediate to run after current event loop iteration
    setImmediate(() => runWorker());
  }

  log('info', 'Worker loop started (event-driven + 30s fallback)');

  // ── Orchestrator Outbox Relay (forward orch events to dashboard) ──
  const ORCH_OUTBOX = path.join(HOME, '.claude', 'orchestrator', 'outbox.jsonl');
  let orchOutboxOffset = 0;

  // Initialize offset to end of file if exists
  try {
    if (fs.existsSync(ORCH_OUTBOX)) {
      orchOutboxOffset = fs.readFileSync(ORCH_OUTBOX, 'utf8').split('\n').filter(Boolean).length;
    }
  } catch {}

  const orchTimer = setInterval(async () => {
    try {
      if (!fs.existsSync(ORCH_OUTBOX)) return;
      const lines = fs.readFileSync(ORCH_OUTBOX, 'utf8').split('\n').filter(Boolean);
      if (lines.length <= orchOutboxOffset) return;

      const newLines = lines.slice(orchOutboxOffset);
      orchOutboxOffset = lines.length;

      for (const line of newLines) {
        try {
          const msg = JSON.parse(line);
          if (msg.event && msg.payload) {
            await broadcast(msg.event, msg.payload);
          }
        } catch (parseErr) {
          log('warn', `Outbox JSON parse error: ${(parseErr.message || '').slice(0, 60)}`);
        }
      }
    } catch {}
  }, 3_000); // 3s poll

  // ── Graceful Shutdown ──
  async function shutdown(signal) {
    log('info', `Shutting down (${signal})...`);

    reconnect.destroy();
    clearInterval(orchTimer);
    clearInterval(workerTimer);
    clearInterval(statusTimer);
    clearInterval(tickTimer);
    clearTimeout(batchTimer);
    flushAuditBatch();
    tailer.stop();

    try {
      await channel.untrack();
      await supabase.removeChannel(channel);
    } catch {}

    log('info', 'Relay stopped.');
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (e) => {
    log('error', `Uncaught: ${e.message}`);
  });

  // Print connection info
  console.log('\n  ┌─────────────────────────────────────┐');
  console.log('  │   Supabase Realtime Relay Running    │');
  console.log('  ├─────────────────────────────────────┤');
  console.log(`  │  Session: ${config.sessionId.padEnd(25)}│`);
  console.log(`  │  Channel: ${channelName.padEnd(25)}│`);
  console.log('  │                                     │');
  console.log('  │  Open dashboard-remote.html with:   │');
  console.log(`  │  ?session=${config.sessionId.padEnd(21)}│`);
  console.log('  └─────────────────────────────────────┘\n');

  log('info', 'Relay ready. Waiting for events...');
}

// ── Entrypoint ──
const isSetup = process.argv.includes('--setup');

if (isSetup) {
  setup().catch((e) => {
    console.error(`\n  \x1b[31mSetup failed: ${e.message}\x1b[0m`);
    process.exit(1);
  });
} else {
  // Auto-setup if config is missing/invalid
  const cfg = loadConfig();
  if (!cfg.url || cfg.url.includes('YOUR_PROJECT') || !cfg.anonKey || cfg.anonKey.includes('YOUR_')) {
    console.log('\n  Config이 없습니다. 자동 셋업을 시작합니다...\n');
    setup().catch((e) => {
      console.error(`\n  \x1b[31mSetup failed: ${e.message}\x1b[0m`);
      process.exit(1);
    });
  } else {
    main().catch((e) => {
      log('error', `Fatal: ${e.message}`);
      process.exit(1);
    });
  }
}
