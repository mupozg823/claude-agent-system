/**
 * utils.js - Shared utility functions for Claude Agent System
 */
const fs = require('fs');
const path = require('path');
const { AUDIT_DIR, CHECKPOINT_DIR } = require('./paths');

/** YYYY-MM-DD 형식의 로컬 날짜 */
function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 오늘 감사 로그 파일 경로 */
function auditFilePath(date) {
  return path.join(AUDIT_DIR, `audit-${date || localDate()}.jsonl`);
}

/** 안전한 파일 읽기 (실패 시 빈 문자열) */
function safeRead(fp) {
  try { return fs.readFileSync(fp, 'utf8'); } catch { return ''; }
}

/** JSONL 파일에서 파싱된 객체 배열 반환 */
function readJsonl(fp) {
  const content = safeRead(fp).trim();
  if (!content) return [];
  return content.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

/** JSONL 파일에 한 줄 추가 */
function appendJsonl(fp, obj) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.appendFileSync(fp, JSON.stringify(obj) + '\n');
}

/** 체크포인트 기록 */
function writeCheckpoint(summary, pendingTasks = []) {
  fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
  const entry = {
    ts: new Date().toISOString(),
    summary,
    pendingTasks,
  };
  const file = path.join(CHECKPOINT_DIR, `checkpoint-${localDate()}.jsonl`);
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  return entry;
}

/** 디렉토리 내 최신 파일 경로 반환 */
function latestFile(dir, ext) {
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith(ext))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return files.length > 0 ? path.join(dir, files[0].name) : null;
  } catch { return null; }
}

module.exports = {
  localDate,
  auditFilePath,
  safeRead,
  readJsonl,
  appendJsonl,
  writeCheckpoint,
  latestFile,
};
