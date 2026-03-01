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
const { execSync } = require('child_process');
const { DIRS, auditFile, appendJsonl, writeCheckpoint: _writeCheckpoint, isTokenOverflowText } = require('./lib/utils');

const AUDIT_DIR = DIRS.audit;
const LOGS_DIR = DIRS.logs;
const CHECKPOINT_DIR = DIRS.checkpoints;
const QUEUE_DIR = DIRS.queue;

function logEvent(event, detail) {
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    appendJsonl(auditFile(), { ts: new Date().toISOString(), ev: event, ...detail });
  } catch {}
}

function writeCheckpoint(summary, pendingTasks = [], meta = {}) {
  try {
    const { ts: _, summary: _s, pendingTasks: _p, ...safeMeta } = meta;
    _writeCheckpoint(summary, pendingTasks, { type: 'stop', ...safeMeta });
  } catch {}
}

// 세션 종료 마커
function writeSessionMarker() {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const ts = new Date().toISOString().slice(0, 23).replace(/[T:.]/g, '-');
    const marker = path.join(LOGS_DIR, `.last-session-${ts}`);
    fs.writeFileSync(marker, `Session ended at ${new Date().toISOString()}\n`);
  } catch {}
}

// 정리 작업 - agent-engine.js cleanup에 위임
function cleanup() {
  try {
    const { runEngine } = require('./lib/utils');
    runEngine('cleanup');
  } catch {}
}

// 대기 큐 확인
function checkQueue() {
  try {
    const { parseJsonl } = require('./lib/utils');
    const entries = parseJsonl(path.join(QUEUE_DIR, 'commands.jsonl'));
    return entries.filter(e => e.status === 'pending').length;
  } catch { return 0; }
}

async function main() {
  let raw = '';
  for await (const c of process.stdin) raw += c;

  let data;
  try { data = JSON.parse(raw); } catch { data = {}; }

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
    // Note: token overflow는 별도 isTokenOverflow 로직에서 처리 (오탐 방지)
    { pattern: 'break your work into smaller', weight: 4 },
  ];

  const compPatterns = [
    { pattern: '모든 작업 완료', weight: 5 },
    { pattern: '완료했습니다', weight: 4 },
    { pattern: '수정 완료', weight: 4 },
    { pattern: '작업 완료', weight: 4 },
    { pattern: '모두 통과', weight: 3 },
    { pattern: '마무리', weight: 3 },
    { pattern: '끝났', weight: 3 },
    { pattern: '정리하면', weight: 2 },
    { pattern: '요약하면', weight: 2 },
    { pattern: '수정 요약', weight: 3 },
    { pattern: '스킵한 항목', weight: 2 },
    { pattern: 'all tasks completed', weight: 5 },
    { pattern: 'all done', weight: 4 },
    { pattern: 'completed', weight: 3 },
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

  // 토큰 초과 감지 (특별 처리) - lib/utils.js 공유 패턴 사용
  // 실제 초과 vs 기능 설명 구분: 완료 신호가 충분하면 설명 컨텍스트로 판단
  const hasTokenOverflow = isTokenOverflowText(msg) && compScore < 3;

  if (hasTokenOverflow) {
    writeCheckpoint(
      `토큰 초과로 중단 - 파일 분할 필요`,
      [...incHits, 'TOKEN_OVERFLOW'],
      { type: 'token_overflow', guidance: '큰 파일은 300줄 이하로 분할. Agent 도구 사용 시 출력 크기 제한 필요.' }
    );
    logEvent('stop', { decision: 'block', reason: 'token_overflow', incScore, compScore });
    return out(JSON.stringify({
      decision: 'block',
      reason: '토큰 초과 감지! 작업을 더 작은 단위로 분할하세요.'
    }));
  }

  // 결정: 미완료 가중치가 완료 가중치보다 높으면 차단
  const shouldBlock = incScore >= 4 && compScore < incScore;

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

  // 허용 + 체크포인트 + 정리
  writeCheckpoint('세션 정상 종료', []);
  logEvent('stop', { decision: 'allow', incScore, compScore });
  writeSessionMarker();
  cleanup();
  out('{}');
}

function out(s) { process.stdout.write(s); }
main().catch(() => out('{}'));
