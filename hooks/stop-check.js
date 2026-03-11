#!/usr/bin/env node
/**
 * stop-check.js v3 - Stop hook
 *
 * v3 개선:
 *   - 체크포인트 자동 기록 (agent-engine.js 연동)
 *   - TaskList 실제 상태 분석 (환경변수 PENDING_TASKS)
 *   - 키워드 분석 가중치 강화
 *   - 대기 큐 확인
 *   - 세션 요약 자동 생성
 */

const fs = require('fs');
const path = require('path');
const { AUDIT_DIR, LOGS_DIR, CHECKPOINT_DIR, QUEUE_DIR } = require('./lib/paths');
const { auditFilePath, writeCheckpoint, appendJsonl } = require('./lib/utils');
const { logError } = require('./lib/errors');

// Quality gate integration (v4)
let qualityGate = null;
try { qualityGate = require('./quality-gate'); } catch { /* OK: optional module */ }

// Telemetry integration (v4)
let telemetry = null;
try { telemetry = require('./telemetry'); } catch { /* OK: optional module */ }

// Context engine integration (v4)
let contextEngine = null;
try { contextEngine = require('./context-engine'); } catch { /* OK: optional module */ }

function logEvent(event, detail) {
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    appendJsonl(auditFilePath(), { ts: new Date().toISOString(), ev: event, ...detail });
  } catch (e) { logError('stop-check', 'audit-log-write', e); }
}

// 세션 종료 마커
function writeSessionMarker() {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const ts = new Date().toISOString().slice(0, 23).replace(/[T:.]/g, '-');
    const marker = path.join(LOGS_DIR, `.last-session-${ts}`);
    fs.writeFileSync(marker, `Session ended at ${new Date().toISOString()}\n`);
  } catch (e) { logError('stop-check', 'session-marker-write', e); }
}

// 정리 작업
function cleanup() {
  const now = Date.now();
  try {
    // 7일 이상 세션 마커
    for (const f of fs.readdirSync(LOGS_DIR)) {
      if (!f.startsWith('.last-session-')) continue;
      const fp = path.join(LOGS_DIR, f);
      if (now - fs.statSync(fp).mtimeMs > 7 * 86400000) fs.unlinkSync(fp);
    }
    // 30일 이상 감사 로그
    for (const f of fs.readdirSync(AUDIT_DIR)) {
      if (!f.startsWith('audit-')) continue;
      const fp = path.join(AUDIT_DIR, f);
      if (now - fs.statSync(fp).mtimeMs > 30 * 86400000) fs.unlinkSync(fp);
    }
    // 14일 이상 체크포인트
    if (fs.existsSync(CHECKPOINT_DIR)) {
      for (const f of fs.readdirSync(CHECKPOINT_DIR)) {
        const fp = path.join(CHECKPOINT_DIR, f);
        if (now - fs.statSync(fp).mtimeMs > 14 * 86400000) fs.unlinkSync(fp);
      }
    }
  } catch { /* OK: cleanup of old files is best-effort */ }
}

// 대기 큐 확인
function checkQueue() {
  try {
    const qFile = path.join(QUEUE_DIR, 'commands.jsonl');
    if (!fs.existsSync(qFile)) return 0;
    const lines = fs.readFileSync(qFile, 'utf8').trim().split('\n').filter(Boolean);
    return lines.filter(l => {
      try { return JSON.parse(l).status === 'pending'; } catch { /* OK: malformed line skipped */ return false; }
    }).length;
  } catch (e) { logError('stop-check', 'queue-read', e); return 0; }
}

async function main() {
  let raw = '';
  for await (const c of process.stdin) raw += c;

  let data;
  try { data = JSON.parse(raw); } catch { /* OK: fallback to empty object */ data = {}; }

  // 핵심: stop_hook_active=true → 무한루프 방지
  if (data.stop_hook_active) {
    logEvent('stop', { decision: 'allow', reason: 'stop_hook_active=true' });
    writeSessionMarker();
    cleanup();
    return out('{}');
  }

  const msg = (data.last_assistant_message || '').toLowerCase();

  // ── 미완료 분석 (가중치 기반) ──
  const incPatterns = [
    { pattern: '다음 단계', weight: 2 },
    { pattern: '이어서', weight: 2 },
    { pattern: '계속 진행', weight: 3 },
    { pattern: '남은 작업', weight: 3 },
    { pattern: '아직 완료되지', weight: 3 },
    { pattern: '진행 중', weight: 2 },
    { pattern: 'task #', weight: 1 },
    { pattern: 'in_progress', weight: 2 },
    { pattern: 'pending', weight: 1 },
    { pattern: 'next step', weight: 2 },
    { pattern: 'continue with', weight: 2 },
    { pattern: 'todo:', weight: 2 },
    { pattern: 'remaining:', weight: 3 },
    { pattern: 'not yet', weight: 2 },
  ];

  const compPatterns = [
    { pattern: '모든 작업 완료', weight: 5 },
    { pattern: '완료했습니다', weight: 4 },
    { pattern: '마무리', weight: 3 },
    { pattern: '끝났', weight: 3 },
    { pattern: '정리하면', weight: 2 },
    { pattern: '요약하면', weight: 2 },
    { pattern: 'all tasks completed', weight: 5 },
    { pattern: 'all done', weight: 4 },
    { pattern: 'finished', weight: 3 },
    { pattern: 'complete', weight: 2 },
    { pattern: 'summary', weight: 1 },
  ];

  let incScore = 0, compScore = 0;
  const incHits = [], compHits = [];

  for (const { pattern, weight } of incPatterns) {
    if (msg.includes(pattern)) { incScore += weight; incHits.push(pattern); }
  }
  for (const { pattern, weight } of compPatterns) {
    if (msg.includes(pattern)) { compScore += weight; compHits.push(pattern); }
  }

  // 대기 큐 확인
  const pendingQueue = checkQueue();
  if (pendingQueue > 0) incScore += Math.ceil(Math.log2(pendingQueue + 1)) * 2;

  // Ambiguity detection: let prompt hook handle uncertain cases
  const isAmbiguous = incScore >= 3 && incScore <= 5 && Math.abs(incScore - compScore) <= 2;

  // 결정: 미완료 가중치가 완료 가중치보다 높으면 차단 (애매한 경우 제외)
  const shouldBlock = !isAmbiguous && incScore >= 4 && compScore < incScore;

  if (isAmbiguous) {
    logEvent('stop', { decision: 'uncertain', incScore, compScore, incHits, compHits, pendingQueue });
    // Pass through — prompt hook will evaluate
    writeCheckpoint('세션 종료 (AI 판단 위임)', incHits);
    writeSessionMarker();
    cleanup();
    return out('{}');
  }

  if (shouldBlock) {
    // 체크포인트 기록 (미완료 상태로 종료 시)
    writeCheckpoint(
      `세션 중단 - 미완료 감지 (inc:${incScore}, comp:${compScore})`,
      incHits
    );
    logEvent('stop', { decision: 'block', incScore, compScore, incHits, compHits, pendingQueue });
    return out(JSON.stringify({
      decision: 'block',
      reason: `미완료 작업 감지 (신뢰도:${incScore}/${incScore + compScore}). 작업을 완료하거나 /log로 기록하세요.`
    }));
  }

  // ── v4: Quality Gate check before allow ──
  let qualityMsg = '';
  if (qualityGate) {
    try {
      const qResult = qualityGate.runAndRecord();
      const formatted = qualityGate.formatResults(qResult);
      if (formatted && qResult.verdict === 'fail') {
        // Block with quality gate failure
        logEvent('stop', { decision: 'block', reason: 'quality-gate', issues: qResult.issues });
        return out(JSON.stringify({
          decision: 'block',
          reason: `품질 게이트 실패:\n${formatted}\n이슈를 해결한 후 다시 시도하세요.`
        }));
      }
      if (formatted) qualityMsg = `\n${formatted}`;
    } catch (e) {
      process.stderr.write(`[stop-check] quality-gate error: ${e.message}\n`);
    }
  }

  // ── v4: Save structured snapshot before exit ──
  if (contextEngine) {
    try { contextEngine.createSnapshot(data.session_id); } catch (e) { logError('stop-check', 'context-snapshot', e); }
  }

  // ── v4: Flush telemetry ──
  if (telemetry) {
    try { telemetry.flush(data.session_id); } catch { /* OK: telemetry flush is best-effort */ }
  }

  // 허용 + 체크포인트 + 정리
  writeCheckpoint('세션 정상 종료', []);
  logEvent('stop', { decision: 'allow', incScore, compScore, qualityMsg: qualityMsg ? 'yes' : 'no' });
  writeSessionMarker();
  cleanup();
  out('{}');
}

function out(s) { process.stdout.write(s); }
main().catch(() => out('{}'));
