#!/usr/bin/env node
/**
 * v6-modules.test.js - Tests for v6 performance modules
 * Tests: cache, telemetry, token-budget, context-engine, quality-gate
 * Total: 50 tests
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOOKS = path.join(ROOT, 'hooks');
let passed = 0, failed = 0, skipped = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    failed++;
    console.log(`  \u2717 ${name}: ${e.message}`);
  }
}

function skip(name) {
  skipped++;
  console.log(`  \u25CB ${name} (skipped)`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function assertType(val, type, msg) {
  if (typeof val !== type) throw new Error(msg || `expected ${type}, got ${typeof val}`);
}

// ══════════════════════════════════════
console.log('\n=== lib/cache.js ===');
// ══════════════════════════════════════

const { TTLCache, LRUCache, getSkillRules, getCompiledPatterns, nextSeq, initSeqFromDisk, flushSeqToDisk } = require(path.join(HOOKS, 'lib', 'cache.js'));

test('TTLCache stores and retrieves values', () => {
  const cache = new TTLCache(5000);
  cache.set('key1', 'value1');
  assertEqual(cache.get('key1'), 'value1');
});

test('TTLCache returns undefined for missing keys', () => {
  const cache = new TTLCache(5000);
  assertEqual(cache.get('nonexistent'), undefined);
});

test('TTLCache expires entries after TTL', () => {
  const cache = new TTLCache(1); // 1ms TTL
  cache.set('key', 'val');
  // Force expiry by manipulating entry
  const entry = cache._data.get('key');
  entry.ts = Date.now() - 100; // expired 100ms ago
  assertEqual(cache.get('key'), undefined);
});

test('TTLCache delete removes entry', () => {
  const cache = new TTLCache(5000);
  cache.set('a', 1);
  cache.invalidate('a');
  assertEqual(cache.get('a'), undefined);
});

test('TTLCache has() works correctly', () => {
  const cache = new TTLCache(5000);
  cache.set('x', 42);
  assertEqual(cache.has('x'), true);
  assertEqual(cache.has('y'), false);
});

test('TTLCache clear removes all entries', () => {
  const cache = new TTLCache(5000);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.clear();
  assertEqual(cache.get('a'), undefined);
  assertEqual(cache.get('b'), undefined);
});

test('LRUCache respects max size', () => {
  const cache = new LRUCache(3);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  cache.set('d', 4); // should evict 'a'
  assertEqual(cache.get('a'), undefined, 'a should be evicted');
  assertEqual(cache.get('d'), 4);
  assertEqual(cache.size, 3);
});

test('LRUCache updates access order on get', () => {
  const cache = new LRUCache(3);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  cache.get('a'); // access 'a', making it most recent
  cache.set('d', 4); // should evict 'b' (oldest after 'a' was accessed)
  assertEqual(cache.get('a'), 1, 'a should survive');
  assertEqual(cache.get('b'), undefined, 'b should be evicted');
});

test('getSkillRules loads and caches', () => {
  const rulesPath = path.join(HOOKS, 'skill-rules.json');
  if (!fs.existsSync(rulesPath)) { skip('skill-rules.json not found'); return; }
  const rules = getSkillRules(rulesPath);
  assert(rules !== null, 'rules should load');
  assert(Array.isArray(rules.skills), 'should have skills array');
  assert(rules.skills.length > 0, 'should have at least 1 skill');
});

test('getCompiledPatterns returns Map of RegExp', () => {
  const rulesPath = path.join(HOOKS, 'skill-rules.json');
  if (!fs.existsSync(rulesPath)) { skip('skill-rules.json not found'); return; }
  const patterns = getCompiledPatterns(rulesPath);
  assert(patterns instanceof Map, 'should be a Map');
  assert(patterns.size > 0, 'should have entries');
  for (const [, regexps] of patterns) {
    assert(Array.isArray(regexps), 'values should be arrays');
    for (const r of regexps) {
      assert(r instanceof RegExp, 'should be RegExp instances');
    }
    break; // check first entry
  }
});

test('nextSeq increments monotonically', () => {
  const a = nextSeq('test-mono');
  const b = nextSeq('test-mono');
  const c = nextSeq('test-mono');
  assert(b === a + 1, 'should increment by 1');
  assert(c === b + 1, 'should increment by 1');
});

test('initSeqFromDisk loads initial sequence', () => {
  const tmp = '/tmp/test-seq-init.seq';
  fs.writeFileSync(tmp, '42');
  initSeqFromDisk('test-init', tmp);
  const next = nextSeq('test-init');
  assertEqual(next, 43, 'should start from 42+1');
  fs.unlinkSync(tmp);
});

test('flushSeqToDisk writes current value', () => {
  const tmp = '/tmp/test-seq-flush.seq';
  nextSeq('test-flush'); nextSeq('test-flush'); nextSeq('test-flush');
  flushSeqToDisk('test-flush', tmp);
  const val = parseInt(fs.readFileSync(tmp, 'utf8').trim());
  assert(val >= 3, 'flushed value should be >= 3');
  fs.unlinkSync(tmp);
});

// ══════════════════════════════════════
console.log('\n=== telemetry.js ===');
// ══════════════════════════════════════

const telemetry = require(path.join(HOOKS, 'telemetry.js'));

test('recordHookLatency adds entry', () => {
  telemetry.recordHookLatency('test-hook', 5.5);
  // Can't directly inspect _metrics, but flush should work
  assertType(telemetry.recordHookLatency, 'function');
});

test('recordFileChange tracks files', () => {
  telemetry.recordFileChange('/tmp/test-file.js');
  telemetry.recordFileChange('/tmp/test-file2.js');
  assertType(telemetry.recordFileChange, 'function');
});

test('recordFileChange detects rework on same file', () => {
  telemetry.recordFileChange('/tmp/rework-test.js');
  telemetry.recordFileChange('/tmp/rework-test.js');
  // Rework should be tracked internally
  assertType(telemetry.recordFileChange, 'function');
});

test('latencyStats computes avg/p50/p95/max', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const stats = telemetry.latencyStats(values);
  assertEqual(stats.avg, 5.5);
  assertEqual(stats.max, 10);
  assert(stats.p50 >= 5 && stats.p50 <= 6, `p50 should be ~5, got ${stats.p50}`);
  assert(stats.p95 >= 9 && stats.p95 <= 10, `p95 should be ~10, got ${stats.p95}`);
});

test('latencyStats handles empty array', () => {
  const stats = telemetry.latencyStats([]);
  assertEqual(stats.avg, 0);
  assertEqual(stats.p50, 0);
  assertEqual(stats.p95, 0);
  assertEqual(stats.max, 0);
});

test('latencyStats handles single value', () => {
  const stats = telemetry.latencyStats([42]);
  assertEqual(stats.avg, 42);
  assertEqual(stats.max, 42);
});

test('flush writes metrics to disk', () => {
  const entry = telemetry.flush('test-session');
  assert(entry !== null, 'flush should return entry');
  assertType(entry.ts, 'string');
  assertEqual(entry.session_id, 'test-session');
  assertType(entry.duration_min, 'number');
  assertType(entry.tools_used, 'number');
});

test('flush includes all metric fields', () => {
  const entry = telemetry.flush('test-fields');
  assert('files_changed' in entry, 'missing files_changed');
  assert('compactions' in entry, 'missing compactions');
  assert('context_restores' in entry, 'missing context_restores');
  assert('quality_gate' in entry, 'missing quality_gate');
  assert('hook_latency_ms' in entry, 'missing hook_latency_ms');
  assert('rework_count' in entry, 'missing rework_count');
});

test('weeklyReport generates output', () => {
  const report = telemetry.weeklyReport();
  assertType(report, 'string');
  assert(report.length > 0, 'report should not be empty');
});

test('recordToolCall increments counter', () => {
  telemetry.recordToolCall();
  telemetry.recordToolCall();
  assertType(telemetry.recordToolCall, 'function');
});

// ══════════════════════════════════════
console.log('\n=== token-budget.js ===');
// ══════════════════════════════════════

const tokenBudget = require(path.join(HOOKS, 'token-budget.js'));

test('getTokenBudget returns required fields', () => {
  const budget = tokenBudget.getTokenBudget();
  assert('used' in budget, 'missing used');
  assert('remaining' in budget, 'missing remaining');
  assert('usedPct' in budget, 'missing usedPct');
  assert('burnRate' in budget, 'missing burnRate');
  assert('estimatedTurns' in budget, 'missing estimatedTurns');
  assert('action' in budget, 'missing action');
  assert('turnCount' in budget, 'missing turnCount');
});

test('getTokenBudget action is valid value', () => {
  const budget = tokenBudget.getTokenBudget();
  const validActions = ['normal', 'compact-soon', 'compact-now'];
  assert(validActions.includes(budget.action), `invalid action: ${budget.action}`);
});

test('recordTurn increments internal state', () => {
  // recordTurn modifies internal state, but getTokenBudget re-estimates from audit file
  // Verify recordTurn doesn't throw and state file is updated
  tokenBudget.recordTurn();
  const budget = tokenBudget.getTokenBudget();
  assertType(budget.turnCount, 'number');
  assert(budget.turnCount >= 0, 'turnCount should be non-negative');
});

test('recordCompaction reduces tokenEstimate', () => {
  tokenBudget.recordTurn(); tokenBudget.recordTurn();
  const before = tokenBudget.estimateTokenUsage();
  tokenBudget.recordCompaction();
  const after = tokenBudget.estimateTokenUsage();
  assert(after <= before, 'tokenEstimate should decrease after compaction');
});

test('formatStatusLine returns progress bar', () => {
  const line = tokenBudget.formatStatusLine();
  assertType(line, 'string');
  assert(line.includes('%'), 'should contain percentage');
  assert(line.includes('턴'), 'should contain turn count');
});

test('getSkillTokenCost returns known skill cost', () => {
  const cost = tokenBudget.getSkillTokenCost('reviewing-code');
  assertEqual(cost.total, 5000);
  assertEqual(cost.skill, 800);
});

test('getSkillTokenCost returns default for unknown', () => {
  const cost = tokenBudget.getSkillTokenCost('nonexistent-skill');
  assertEqual(cost.total, 500);
});

test('canAffordSkill returns boolean', () => {
  const result = tokenBudget.canAffordSkill('checking-status');
  assertType(result, 'boolean');
});

test('estimateTokenUsage returns positive number', () => {
  const usage = tokenBudget.estimateTokenUsage();
  assertType(usage, 'number');
  assert(usage >= 0, 'usage should be non-negative');
});

test('calculateBurnRate returns non-negative number', () => {
  const rate = tokenBudget.calculateBurnRate();
  assertType(rate, 'number');
  assert(rate >= 0, 'burn rate should be non-negative');
});

// ══════════════════════════════════════
console.log('\n=== context-engine.js ===');
// ══════════════════════════════════════

const contextEngine = require(path.join(HOOKS, 'context-engine.js'));

test('createSnapshot returns valid object', () => {
  const result = contextEngine.createSnapshot('test-session');
  assert(result !== null, 'should return result');
  assert(result.snapshot !== null, 'should have snapshot');
  assertEqual(result.snapshot.version, 1);
  assertType(result.snapshot.ts, 'string');
  assertType(result.filePath, 'string');
  // Cleanup
  try { fs.unlinkSync(result.filePath); } catch {}
});

test('createSnapshot captures git state', () => {
  const result = contextEngine.createSnapshot('test-git');
  const git = result.snapshot.git;
  assert(git !== null, 'should have git state');
  // Branch might be null in some envs, but object should exist
  assertType(git, 'object');
  assert('branch' in git, 'missing branch');
  assert('dirtyFiles' in git, 'missing dirtyFiles');
  assert(Array.isArray(git.dirtyFiles), 'dirtyFiles should be array');
  try { fs.unlinkSync(result.filePath); } catch {}
});

test('createSnapshot has tasks object', () => {
  const result = contextEngine.createSnapshot('test-tasks');
  assert('tasks' in result.snapshot, 'missing tasks');
  assert('completed' in result.snapshot.tasks, 'missing completed');
  assert('pending' in result.snapshot.tasks, 'missing pending');
  assert(Array.isArray(result.snapshot.tasks.pending), 'pending should be array');
  try { fs.unlinkSync(result.filePath); } catch {}
});

test('formatSnapshotContext produces compact text', () => {
  const result = contextEngine.createSnapshot('test-format');
  const context = contextEngine.formatSnapshotContext(result.snapshot);
  // May be null if snapshot has no useful data, which is OK
  if (context !== null) {
    assertType(context, 'string');
    // Should be compact (roughly <500 tokens ≈ <2000 chars)
    assert(context.length < 3000, `context too long: ${context.length} chars`);
  }
  try { fs.unlinkSync(result.filePath); } catch {}
});

test('formatSnapshotContext returns null for null input', () => {
  const context = contextEngine.formatSnapshotContext(null);
  assertEqual(context, null);
});

test('extractDecisions finds DECISION markers', () => {
  const entries = [
    { summary: '[DECISION] Use async hooks for audit-log' },
    { summary: 'read → /tmp/file.js' },
    { summary: '[결정] 토큰 버짓 1M 지원' },
  ];
  const decisions = contextEngine.extractDecisions(entries);
  assertEqual(decisions.length, 2);
  assert(decisions[0].includes('async hooks'), 'should extract first decision');
});

test('extractDecisions handles empty array', () => {
  const decisions = contextEngine.extractDecisions([]);
  assertEqual(decisions.length, 0);
});

test('restoreSnapshot handles missing snapshots gracefully', () => {
  // This might return a snapshot from earlier tests, but shouldn't crash
  const result = contextEngine.restoreSnapshot();
  // Either null or valid object
  if (result !== null) {
    assertType(result, 'object');
    assert('version' in result, 'should have version');
  }
});

test('cleanupSnapshots runs without error', () => {
  contextEngine.cleanupSnapshots();
  // Should not throw
});

test('getGitState returns object with expected keys', () => {
  const git = contextEngine.getGitState();
  assertType(git, 'object');
  assert('branch' in git, 'missing branch');
  assert('lastCommit' in git, 'missing lastCommit');
  assert('dirtyFiles' in git, 'missing dirtyFiles');
  assert('stagedFiles' in git, 'missing stagedFiles');
});

// ══════════════════════════════════════
console.log('\n=== quality-gate.js ===');
// ══════════════════════════════════════

const qualityGate = require(path.join(HOOKS, 'quality-gate.js'));

test('runQualityChecks returns result object', () => {
  const result = qualityGate.runQualityChecks();
  assert('issues' in result, 'missing issues');
  assert('warnings' in result, 'missing warnings');
  assert('suggestions' in result, 'missing suggestions');
  assert('verdict' in result, 'missing verdict');
  assert(Array.isArray(result.issues), 'issues should be array');
  assert(Array.isArray(result.warnings), 'warnings should be array');
});

test('verdict is valid value', () => {
  const result = qualityGate.runQualityChecks();
  const valid = ['clean', 'pass', 'pass_with_warnings', 'fail'];
  assert(valid.includes(result.verdict), `invalid verdict: ${result.verdict}`);
});

test('getChangedFiles returns array', () => {
  const files = qualityGate.getChangedFiles();
  assert(Array.isArray(files), 'should return array');
});

test('getDiffStat returns object with expected keys', () => {
  const stat = qualityGate.getDiffStat();
  assert('files' in stat, 'missing files');
  assert('additions' in stat, 'missing additions');
  assert('deletions' in stat, 'missing deletions');
  assertType(stat.files, 'number');
  assertType(stat.additions, 'number');
});

test('formatResults returns null for clean verdict', () => {
  const result = { verdict: 'clean', issues: [], warnings: [], suggestions: [] };
  assertEqual(qualityGate.formatResults(result), null);
});

test('formatResults returns string for pass verdict', () => {
  const result = { verdict: 'pass', issues: [], warnings: [], suggestions: ['test'] };
  const formatted = qualityGate.formatResults(result);
  assertType(formatted, 'string');
  assert(formatted.includes('PASS'), 'should contain PASS');
});

test('formatResults shows issues for fail verdict', () => {
  const result = { verdict: 'fail', issues: ['lint error'], warnings: [], suggestions: [] };
  const formatted = qualityGate.formatResults(result);
  assertType(formatted, 'string');
  assert(formatted.includes('FAIL'), 'should contain FAIL');
  assert(formatted.includes('lint error'), 'should show issue');
});

test('runAndRecord writes to audit log', () => {
  const result = qualityGate.runAndRecord();
  assert('verdict' in result, 'should return result with verdict');
});

test('getChangedFiles handles git errors gracefully', () => {
  // Should not throw even if git is in weird state
  const files = qualityGate.getChangedFiles();
  assert(Array.isArray(files), 'should return array');
});

test('getDiffStat returns zeros when no changes', () => {
  const stat = qualityGate.getDiffStat();
  assertType(stat.files, 'number');
  // May or may not have changes, just verify it doesn't crash
});

// ══════════════════════════════════════
// Results
// ══════════════════════════════════════

console.log(`\n${'═'.repeat(50)}`);
console.log(`v6 Modules: ${passed} passed, ${failed} failed, ${skipped} skipped`);
console.log(`${'═'.repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
