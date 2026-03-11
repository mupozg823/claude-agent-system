#!/usr/bin/env node
/**
 * run-all.js - Test runner for Claude Agent System
 * No dependencies required - uses Node.js built-in assert.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const HOOKS = path.join(ROOT, 'hooks');
let passed = 0, failed = 0, skipped = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}: ${e.message}`);
  }
}

function skip(name) {
  skipped++;
  console.log(`  ○ ${name} (skipped)`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', timeout: 10000, cwd: ROOT, ...opts }).trim();
}

// ══════════════════════════════════════
console.log('\n=== lib/paths.js ===');
// ══════════════════════════════════════

test('exports all path constants', () => {
  const p = require(path.join(HOOKS, 'lib', 'paths.js'));
  const keys = Object.keys(p);
  assert(keys.includes('HOME'), 'missing HOME');
  assert(keys.includes('CLAUDE_DIR'), 'missing CLAUDE_DIR');
  assert(keys.includes('HOOKS_DIR'), 'missing HOOKS_DIR');
  assert(keys.includes('LOGS_DIR'), 'missing LOGS_DIR');
  assert(keys.includes('AUDIT_DIR'), 'missing AUDIT_DIR');
  assert(keys.includes('CHECKPOINT_DIR'), 'missing CHECKPOINT_DIR');
  assert(keys.includes('QUEUE_DIR'), 'missing QUEUE_DIR');
  assert(keys.length >= 8, `expected >=8 exports, got ${keys.length}`);
});

test('paths are absolute', () => {
  const p = require(path.join(HOOKS, 'lib', 'paths.js'));
  assert(path.isAbsolute(p.CLAUDE_DIR), 'CLAUDE_DIR not absolute');
  assert(path.isAbsolute(p.AUDIT_DIR), 'AUDIT_DIR not absolute');
});

// ══════════════════════════════════════
console.log('\n=== lib/utils.js ===');
// ══════════════════════════════════════

test('localDate returns YYYY-MM-DD', () => {
  const { localDate } = require(path.join(HOOKS, 'lib', 'utils.js'));
  const d = localDate();
  assert(/^\d{4}-\d{2}-\d{2}$/.test(d), `bad format: ${d}`);
});

test('auditFilePath returns correct path', () => {
  const { auditFilePath } = require(path.join(HOOKS, 'lib', 'utils.js'));
  const fp = auditFilePath('2026-01-15');
  assert(fp.endsWith('audit-2026-01-15.jsonl'), `bad path: ${fp}`);
});

test('readJsonl parses valid JSONL', () => {
  const { readJsonl } = require(path.join(HOOKS, 'lib', 'utils.js'));
  const tmp = '/tmp/test-readjsonl.jsonl';
  fs.writeFileSync(tmp, '{"a":1}\n{"b":2}\n');
  const result = readJsonl(tmp);
  assertEqual(result.length, 2);
  assertEqual(result[0].a, 1);
  fs.unlinkSync(tmp);
});

test('readJsonl handles missing file', () => {
  const { readJsonl } = require(path.join(HOOKS, 'lib', 'utils.js'));
  const result = readJsonl('/tmp/nonexistent-file-xyz.jsonl');
  assertEqual(result.length, 0);
});

test('appendJsonl creates and appends', () => {
  const { appendJsonl, readJsonl } = require(path.join(HOOKS, 'lib', 'utils.js'));
  const tmp = '/tmp/test-appendjsonl.jsonl';
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  appendJsonl(tmp, { x: 1 });
  appendJsonl(tmp, { x: 2 });
  const result = readJsonl(tmp);
  assertEqual(result.length, 2);
  fs.unlinkSync(tmp);
});

// ══════════════════════════════════════
console.log('\n=== agent-engine.js ===');
// ══════════════════════════════════════

test('exports expected functions', () => {
  const ae = require(path.join(HOOKS, 'agent-engine.js'));
  const fns = ['writeCheckpoint', 'getLatestCheckpoint', 'getStatus', 'getMetrics',
    'queueAdd', 'queueList', 'laneAdd', 'laneNext', 'laneComplete', 'laneFail', 'laneStats'];
  for (const fn of fns) {
    assertEqual(typeof ae[fn], 'function', `${fn} not a function`);
  }
});

test('getStatus returns object with expected keys', () => {
  const ae = require(path.join(HOOKS, 'agent-engine.js'));
  const status = ae.getStatus();
  assert(typeof status === 'object', 'not an object');
  assert('system' in status || 'ts' in status, 'missing expected keys (system or ts)');
});

test('laneStats returns counts', () => {
  const ae = require(path.join(HOOKS, 'agent-engine.js'));
  const stats = ae.laneStats('test-session');
  assert(typeof stats.pending === 'number', 'pending not number');
  assert(typeof stats.completed === 'number', 'completed not number');
});

// ══════════════════════════════════════
console.log('\n=== Hook scripts (stdin/stdout) ===');
// ══════════════════════════════════════

test('session-init.js returns JSON', () => {
  const out = run('echo "{}" | node hooks/session-init.js');
  // Should return valid JSON or empty
  if (out) JSON.parse(out);
});

test('skill-suggest.js returns JSON', () => {
  const out = run('echo \'{"user_prompt":"코드 리뷰해줘"}\' | node hooks/skill-suggest.js');
  if (out) JSON.parse(out);
});

// bootstrap.js tests
test('bootstrap.js returns valid JSON', () => {
  const out = run('echo "{}" | node hooks/bootstrap.js');
  if (out) JSON.parse(out);
});

test('bootstrap.js is idempotent (runs twice without error)', () => {
  run('echo "{}" | node hooks/bootstrap.js');
  const out = run('echo "{}" | node hooks/bootstrap.js');
  if (out) JSON.parse(out);
});

test('audit-log.js returns {}', () => {
  const out = run('echo \'{"tool_name":"Read","tool_input":{"file_path":"/tmp/x"},"tool_response":{}}\' | node hooks/audit-log.js');
  assertEqual(out, '{}');
});

test('stop-check.js allows when stop_hook_active', () => {
  const out = run('echo \'{"stop_hook_active":true}\' | node hooks/stop-check.js');
  assertEqual(out, '{}');
});

// ══════════════════════════════════════
console.log('\n=== telegram-adapter.js ===');
// ══════════════════════════════════════

test('module exports TelegramBot and SessionStore', () => {
  const t = require(path.join(HOOKS, 'telegram-adapter.js'));
  assertEqual(typeof t.TelegramBot, 'function');
  assertEqual(typeof t.SessionStore, 'function');
  assertEqual(typeof t.ClaudeIntegration, 'function');
});

// SessionStore tests require better-sqlite3
(() => {
  let hasSqlite = false;
  try { require('better-sqlite3'); hasSqlite = true; } catch {}

  if (hasSqlite) {
    test('SessionStore CRUD works in memory', () => {
      const { SessionStore } = require(path.join(HOOKS, 'telegram-adapter.js'));
      const store = new SessionStore(':memory:');
      store.init();
      store.saveSession(111, 'sess-1', '/', 'hello');
      const s = store.getSession(111, '/');
      assert(s !== null, 'session not found');
      assertEqual(s.session_id, 'sess-1');
      assertEqual(s.message_count, 1);
      store.saveSession(111, 'sess-1', '/', 'world');
      assertEqual(store.getSession(111, '/').message_count, 2);
      store.clearSession(111, '/');
      assertEqual(store.getSession(111, '/'), null);
      store.close();
    });

    test('SessionStore listSessions returns array', () => {
      const { SessionStore } = require(path.join(HOOKS, 'telegram-adapter.js'));
      const store = new SessionStore(':memory:');
      store.init();
      store.saveSession(222, 'a', '/proj1', 'p1');
      store.saveSession(222, 'b', '/proj2', 'p2');
      const list = store.listSessions(222);
      assertEqual(list.length, 2);
      store.close();
    });
  } else {
    skip('SessionStore CRUD works in memory (better-sqlite3 not installed)');
    skip('SessionStore listSessions returns array (better-sqlite3 not installed)');
  }
})();

// ══════════════════════════════════════
console.log('\n=== Module loading ===');
// ══════════════════════════════════════

const moduleTests = [
  ['orchestrator.js', 'orchestrator'],
  ['skill-router.js', 'skill-router'],
  ['supabase-auto-setup.js', 'supabase-auto-setup'],
];

for (const [file, name] of moduleTests) {
  test(`${name} loads without error`, () => {
    require(path.join(HOOKS, file));
  });
}

// gateway.js requires 'ws' module
(() => {
  let hasWs = false;
  try { require('ws'); hasWs = true; } catch {}
  if (hasWs) {
    test('gateway loads without error', () => {
      require(path.join(HOOKS, 'gateway.js'));
    });
  } else {
    skip('gateway loads without error (ws not installed)');
  }
})();

// ══════════════════════════════════════
console.log('\n=== lib/errors.js ===');
// ══════════════════════════════════════

test('logError writes to stderr without throwing', () => {
  const { logError } = require(path.join(HOOKS, 'lib', 'errors.js'));
  // Should not throw
  logError('test-module', 'test-action', new Error('test error'));
});

test('logError handles string errors', () => {
  const { logError } = require(path.join(HOOKS, 'lib', 'errors.js'));
  logError('test-module', 'test-action', 'string error');
});

test('ERROR_LOG path is absolute', () => {
  const { ERROR_LOG } = require(path.join(HOOKS, 'lib', 'errors.js'));
  assert(path.isAbsolute(ERROR_LOG), `ERROR_LOG not absolute: ${ERROR_LOG}`);
});

// ══════════════════════════════════════
console.log('\n=== Services import paths ===');
// ══════════════════════════════════════

const serviceTests = [
  'orchestrator.js', 'heartbeat.js', 'telegram-adapter.js',
];
for (const svc of serviceTests) {
  test(`services/${svc} resolves imports`, () => {
    // Verify the file can be required (imports resolve)
    require(path.join(ROOT, 'services', svc));
  });
}

// ══════════════════════════════════════
console.log('\n=== Cross-platform bootstrap ===');
// ══════════════════════════════════════

test('bootstrap detects environment', () => {
  // Just verify the module loads and env detection function works
  const out = run('echo "{}" | node hooks/bootstrap.js 2>/dev/null');
  if (out) {
    const parsed = JSON.parse(out);
    // Should have hookSpecificOutput or be empty
    assert(parsed.hookSpecificOutput || Object.keys(parsed).length === 0, 'unexpected output shape');
  }
});

test('deployed hooks match repo hooks', () => {
  const deployed = path.join(process.env.HOME || '/root', '.claude', 'hooks');
  if (fs.existsSync(deployed)) {
    const repoFiles = fs.readdirSync(HOOKS).filter(f => f.endsWith('.js')).sort();
    const deployedFiles = fs.readdirSync(deployed).filter(f => f.endsWith('.js')).sort();
    assertEqual(repoFiles.length, deployedFiles.length,
      `file count mismatch: repo=${repoFiles.length}, deployed=${deployedFiles.length}`);
  }
});

// ══════════════════════════════════════
console.log('\n=== Skills 2.0 ===');
// ══════════════════════════════════════

test('all skills have valid SKILL.md frontmatter', () => {
  const skillsDir = path.join(ROOT, 'skills');
  const dirs = fs.readdirSync(skillsDir).filter(d =>
    fs.statSync(path.join(skillsDir, d)).isDirectory()
  );
  assert(dirs.length >= 48, `expected >=48 skills, got ${dirs.length}`);

  for (const dir of dirs) {
    const skillFile = path.join(skillsDir, dir, 'SKILL.md');
    assert(fs.existsSync(skillFile), `${dir}/SKILL.md missing`);

    const content = fs.readFileSync(skillFile, 'utf8');
    assert(content.startsWith('---'), `${dir}: no frontmatter`);
    assert(content.includes('name:'), `${dir}: no name field`);
    assert(content.includes('description:'), `${dir}: no description field`);
  }
});

test('SKILL.md files are under 100 lines', () => {
  const skillsDir = path.join(ROOT, 'skills');
  const dirs = fs.readdirSync(skillsDir).filter(d =>
    fs.statSync(path.join(skillsDir, d)).isDirectory()
  );
  for (const dir of dirs) {
    const content = fs.readFileSync(path.join(skillsDir, dir, 'SKILL.md'), 'utf8');
    const lines = content.split('\n').length;
    assert(lines <= 100, `${dir}/SKILL.md has ${lines} lines (max 100)`);
  }
});

// ══════════════════════════════════════
// Results
// ══════════════════════════════════════

console.log(`\n${'═'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
console.log(`${'═'.repeat(40)}\n`);

process.exit(failed > 0 ? 1 : 0);
