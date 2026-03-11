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
  try { return fs.readFileSync(fp, 'utf8'); } catch { /* silent */ return ''; }
}

/** JSONL 파일에서 파싱된 객체 배열 반환 */
function readJsonl(fp) {
  const content = safeRead(fp).trim();
  if (!content) return [];
  return content.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { /* silent */ return null; }
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
  } catch { /* silent */ return null; }
}

/** Atomic file write (temp + rename to prevent corruption) */
function atomicWrite(filePath, content) {
  const tmp = filePath + '.tmp';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

/** Safe JSON parse with fallback */
function safeJsonParse(str, fallback = null) {
  try { return JSON.parse(str); } catch { /* silent */ return fallback; }
}

/** Clean old files in directory by extension and max age */
function compressOldFiles(dir, ext, maxAgeDays) {
  const now = Date.now();
  const maxMs = maxAgeDays * 86400000;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(ext)) continue;
      const fp = path.join(dir, f);
      if (now - fs.statSync(fp).mtimeMs > maxMs) fs.unlinkSync(fp);
    }
  } catch { /* silent */ }
}

// ── Async variants for performance-critical paths ──

const fsp = require('fs').promises;

/** Async safe file read */
async function safeReadAsync(fp) {
  try { return await fsp.readFile(fp, 'utf8'); } catch { /* silent */ return ''; }
}

/** Async JSONL read with streaming (memory efficient for large files) */
async function readJsonlStream(fp) {
  const content = await safeReadAsync(fp);
  if (!content.trim()) return [];
  return content.trim().split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { /* silent */ return null; }
  }).filter(Boolean);
}

/** Async latest file finder with result caching */
const _latestFileCache = new Map(); // dir+ext → { result, ts }
const LATEST_FILE_TTL = 5000; // 5 second cache
const LATEST_FILE_MAX = 20; // max cache entries

async function latestFileAsync(dir, ext) {
  const key = `${dir}:${ext}`;
  const cached = _latestFileCache.get(key);
  if (cached && Date.now() - cached.ts < LATEST_FILE_TTL) return cached.result;

  // Evict oldest if at capacity
  if (_latestFileCache.size >= LATEST_FILE_MAX && !_latestFileCache.has(key)) {
    const oldest = _latestFileCache.keys().next().value;
    _latestFileCache.delete(oldest);
  }

  try {
    const files = await fsp.readdir(dir);
    const matching = files.filter(f => f.endsWith(ext));
    if (matching.length === 0) {
      _latestFileCache.set(key, { result: null, ts: Date.now() });
      return null;
    }

    const withStats = await Promise.all(
      matching.map(async f => {
        const fp = path.join(dir, f);
        const stat = await fsp.stat(fp);
        return { name: f, mtime: stat.mtimeMs };
      })
    );

    withStats.sort((a, b) => b.mtime - a.mtime);
    const result = path.join(dir, withStats[0].name);
    _latestFileCache.set(key, { result, ts: Date.now() });
    return result;
  } catch { /* silent */
    _latestFileCache.set(key, { result: null, ts: Date.now() });
    return null;
  }
}

/** Async append JSONL */
async function appendJsonlAsync(fp, obj) {
  await fsp.mkdir(path.dirname(fp), { recursive: true });
  await fsp.appendFile(fp, JSON.stringify(obj) + '\n');
}

module.exports = {
  localDate,
  auditFilePath,
  safeRead,
  readJsonl,
  appendJsonl,
  writeCheckpoint,
  latestFile,
  atomicWrite,
  safeJsonParse,
  compressOldFiles,
  // Async variants
  safeReadAsync,
  readJsonlStream,
  latestFileAsync,
  appendJsonlAsync,
};
