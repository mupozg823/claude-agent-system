#!/usr/bin/env node
/**
 * telemetry.js - Performance Telemetry Module
 *
 * Collects and reports session-level performance metrics.
 * Integrates with all hooks via shared telemetry API.
 *
 * Usage:
 *   - As library: require('./telemetry') → recordHookLatency(), flush()
 *   - As CLI: node telemetry.js benchmark-hooks | weekly-report | quality-stats
 */

const fs = require('fs');
const path = require('path');
const { LOGS_DIR, AUDIT_DIR } = require('./lib/paths');

const TELEMETRY_DIR = path.join(LOGS_DIR, 'telemetry');
const { localDate, readJsonl, appendJsonl, safeRead } = require('./lib/utils');

// ── In-memory metrics buffer (bounded to prevent memory leaks) ──
const MAX_HOOK_LATENCIES = 1000;
const MAX_FILES_TRACKED = 500;

const _metrics = {
  hookLatencies: [],    // { hook, ms, ts } — max MAX_HOOK_LATENCIES
  toolCalls: 0,
  filesChanged: new Set(),  // max MAX_FILES_TRACKED
  reworkFiles: new Map(), // file → edit count — max MAX_FILES_TRACKED
  sessionStart: Date.now(),
  compactions: 0,
  contextRestores: 0,
  qualityGate: { errors: 0, warnings: 0 },
};

/**
 * Record hook execution latency
 * @param {string} hookName
 * @param {number} elapsedMs
 */
function recordHookLatency(hookName, elapsedMs) {
  if (_metrics.hookLatencies.length >= MAX_HOOK_LATENCIES) {
    _metrics.hookLatencies.shift();
  }
  _metrics.hookLatencies.push({
    hook: hookName,
    ms: Math.round(elapsedMs * 100) / 100,
    ts: Date.now(),
  });
}

/**
 * Record a file change (for rework detection)
 * @param {string} filePath
 */
function recordFileChange(filePath) {
  if (_metrics.filesChanged.size < MAX_FILES_TRACKED) {
    _metrics.filesChanged.add(filePath);
  }
  if (_metrics.reworkFiles.size >= MAX_FILES_TRACKED && !_metrics.reworkFiles.has(filePath)) {
    // Evict oldest entry
    const oldest = _metrics.reworkFiles.keys().next().value;
    _metrics.reworkFiles.delete(oldest);
  }
  const count = _metrics.reworkFiles.get(filePath) || 0;
  _metrics.reworkFiles.set(filePath, count + 1);
}

/** Record compaction event */
function recordCompaction() { _metrics.compactions++; }

/** Record context restore event */
function recordContextRestore() { _metrics.contextRestores++; }

/** Record quality gate results */
function recordQualityGate(errors, warnings) {
  _metrics.qualityGate.errors += errors;
  _metrics.qualityGate.warnings += warnings;
}

/** Increment tool call counter */
function recordToolCall() { _metrics.toolCalls++; }

/**
 * Compute latency statistics from array of numbers
 */
function latencyStats(values) {
  if (values.length === 0) return { avg: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const avg = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const max = sorted[sorted.length - 1];
  return {
    avg: Math.round(avg * 100) / 100,
    p50: Math.round(p50 * 100) / 100,
    p95: Math.round(p95 * 100) / 100,
    max: Math.round(max * 100) / 100,
  };
}

/**
 * Compute rework count (files edited more than once)
 */
function reworkCount() {
  let count = 0;
  for (const [, edits] of _metrics.reworkFiles) {
    if (edits > 1) count += edits - 1;
  }
  return count;
}

/**
 * Flush current session metrics to disk
 */
function flush(sessionId) {
  fs.mkdirSync(TELEMETRY_DIR, { recursive: true });

  const latencies = _metrics.hookLatencies.map(h => h.ms);
  const durationMin = (Date.now() - _metrics.sessionStart) / 60000;

  const entry = {
    ts: new Date().toISOString(),
    session_id: sessionId || 'unknown',
    duration_min: Math.round(durationMin * 10) / 10,
    tools_used: _metrics.toolCalls,
    files_changed: _metrics.filesChanged.size,
    compactions: _metrics.compactions,
    context_restores: _metrics.contextRestores,
    quality_gate: { ..._metrics.qualityGate },
    hook_latency_ms: latencyStats(latencies),
    hook_samples: _metrics.hookLatencies.length,
    rework_count: reworkCount(),
  };

  const file = path.join(TELEMETRY_DIR, `metrics-${localDate()}.jsonl`);
  appendJsonl(file, entry);
  return entry;
}

/**
 * Read all telemetry entries for a date range
 */
function readMetrics(days = 7) {
  const entries = [];
  const now = Date.now();
  try {
    const files = fs.readdirSync(TELEMETRY_DIR)
      .filter(f => f.startsWith('metrics-') && f.endsWith('.jsonl'))
      .filter(f => {
        const fp = path.join(TELEMETRY_DIR, f);
        return now - fs.statSync(fp).mtimeMs < days * 86400000;
      });
    for (const f of files) {
      entries.push(...readJsonl(path.join(TELEMETRY_DIR, f)));
    }
  } catch { /* silent */ }
  return entries;
}

/**
 * Generate weekly performance report
 */
function weeklyReport() {
  const entries = readMetrics(7);
  if (entries.length === 0) {
    return '텔레메트리 데이터 없음. 최소 1세션 후 다시 확인하세요.';
  }

  const totalSessions = entries.length;
  const avgDuration = entries.reduce((s, e) => s + (e.duration_min || 0), 0) / totalSessions;
  const avgTools = entries.reduce((s, e) => s + (e.tools_used || 0), 0) / totalSessions;
  const avgFiles = entries.reduce((s, e) => s + (e.files_changed || 0), 0) / totalSessions;
  const totalRework = entries.reduce((s, e) => s + (e.rework_count || 0), 0);
  const totalCompactions = entries.reduce((s, e) => s + (e.compactions || 0), 0);

  // Aggregate hook latencies
  const allLatencies = entries
    .map(e => e.hook_latency_ms || {})
    .filter(h => h.avg > 0);
  const avgHookLatency = allLatencies.length > 0
    ? allLatencies.reduce((s, h) => s + h.avg, 0) / allLatencies.length
    : 0;
  const maxP95 = allLatencies.length > 0
    ? Math.max(...allLatencies.map(h => h.p95))
    : 0;

  // Quality gate stats
  const totalErrors = entries.reduce((s, e) => s + ((e.quality_gate || {}).errors || 0), 0);
  const totalWarnings = entries.reduce((s, e) => s + ((e.quality_gate || {}).warnings || 0), 0);
  const gateRuns = entries.filter(e => e.quality_gate && (e.quality_gate.errors > 0 || e.quality_gate.warnings > 0)).length;

  const lines = [
    '┌─────────────────────────────────────────┐',
    '│ 주간 성능 리포트                        │',
    '├─────────────────────────────────────────┤',
    `│ 세션 수:          ${String(totalSessions).padStart(4)}                  │`,
    `│ 평균 세션 길이:    ${String(Math.round(avgDuration)).padStart(4)}분               │`,
    `│ 평균 도구 호출:    ${String(Math.round(avgTools)).padStart(4)}회               │`,
    `│ 평균 파일 변경:    ${String(Math.round(avgFiles)).padStart(4)}개               │`,
    `│ 훅 평균 지연:      ${String(Math.round(avgHookLatency * 10) / 10).padStart(6)}ms            │`,
    `│ 훅 P95 지연:       ${String(Math.round(maxP95 * 10) / 10).padStart(6)}ms            │`,
    `│ 컴팩션 횟수:       ${String(totalCompactions).padStart(4)}                  │`,
    `│ 재작업 횟수:       ${String(totalRework).padStart(4)}                  │`,
    `│ 품질 에러:         ${String(totalErrors).padStart(4)}                  │`,
    `│ 품질 경고:         ${String(totalWarnings).padStart(4)}                  │`,
    '└─────────────────────────────────────────┘',
  ];

  return lines.join('\n');
}

/**
 * Benchmark all hooks by measuring file I/O operations
 */
function benchmarkHooks() {
  const results = [];

  // Benchmark safeRead
  const testFile = path.join(TELEMETRY_DIR, '.benchmark-test');
  fs.mkdirSync(TELEMETRY_DIR, { recursive: true });
  fs.writeFileSync(testFile, '{"test": true}\n'.repeat(100));

  const ops = [
    { name: 'safeRead (100 lines)', fn: () => safeRead(testFile) },
    { name: 'readJsonl (100 entries)', fn: () => readJsonl(testFile) },
    { name: 'appendJsonl (1 entry)', fn: () => appendJsonl(testFile, { ts: Date.now(), test: true }) },
    { name: 'localDate()', fn: () => localDate() },
  ];

  for (const op of ops) {
    const start = process.hrtime.bigint();
    const iterations = 100;
    for (let i = 0; i < iterations; i++) op.fn();
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    results.push({
      name: op.name,
      avg_ms: Math.round(elapsed / iterations * 100) / 100,
      total_ms: Math.round(elapsed * 100) / 100,
    });
  }

  // Cleanup
  try { fs.unlinkSync(testFile); } catch { /* silent */ }

  console.log('Hook I/O Benchmark Results:');
  console.log('─'.repeat(50));
  for (const r of results) {
    console.log(`  ${r.name.padEnd(30)} avg: ${String(r.avg_ms).padStart(8)}ms`);
  }
  return results;
}

// ── CLI mode ──
if (require.main === module) {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'weekly-report':
      console.log(weeklyReport());
      break;
    case 'benchmark-hooks':
      benchmarkHooks();
      break;
    case 'quality-stats': {
      const entries = readMetrics(30);
      const withGate = entries.filter(e => e.quality_gate);
      console.log(`총 세션: ${entries.length}`);
      console.log(`품질 게이트 실행: ${withGate.length}`);
      const totalErr = withGate.reduce((s, e) => s + (e.quality_gate.errors || 0), 0);
      const totalWarn = withGate.reduce((s, e) => s + (e.quality_gate.warnings || 0), 0);
      console.log(`총 에러: ${totalErr}, 총 경고: ${totalWarn}`);
      break;
    }
    default:
      console.log('Usage: node telemetry.js <weekly-report|benchmark-hooks|quality-stats>');
  }
}

module.exports = {
  recordHookLatency,
  recordFileChange,
  recordCompaction,
  recordContextRestore,
  recordQualityGate,
  recordToolCall,
  flush,
  readMetrics,
  weeklyReport,
  latencyStats,
  TELEMETRY_DIR,
};
