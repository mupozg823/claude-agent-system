/**
 * cache.js - In-memory cache layer for hook performance optimization
 *
 * Provides:
 *   - TTL-based cache for skill-rules.json (60s)
 *   - Pre-compiled regex cache for skill patterns
 *   - LRU cache for checkpoint data (max 5)
 *   - In-memory sequence counter (batch flush)
 *
 * Expected improvement: hook latency 50-200ms → 3-8ms
 */

const fs = require('fs');
const path = require('path');

// ── TTL Cache ──

class TTLCache {
  constructor(ttlMs = 60000) {
    this._data = new Map();
    this._ttl = ttlMs;
  }

  get(key) {
    const entry = this._data.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > this._ttl) {
      this._data.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value) {
    this._data.set(key, { value, ts: Date.now() });
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  invalidate(key) {
    this._data.delete(key);
  }

  clear() {
    this._data.clear();
  }
}

// ── LRU Cache ──

class LRUCache {
  constructor(maxSize = 5) {
    this._map = new Map();
    this._max = maxSize;
  }

  get(key) {
    if (!this._map.has(key)) return undefined;
    const value = this._map.get(key);
    // Move to end (most recent)
    this._map.delete(key);
    this._map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this._map.has(key)) this._map.delete(key);
    this._map.set(key, value);
    // Evict oldest if over limit
    if (this._map.size > this._max) {
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
    }
  }

  has(key) {
    return this._map.has(key);
  }

  get size() {
    return this._map.size;
  }
}

// ── Skill Rules Cache (singleton) ──

let _skillRulesCache = null;
let _skillRulesMtime = 0;
let _compiledPatterns = null; // Map<skillName, RegExp[]>

/**
 * Load skill-rules.json with file-mtime based invalidation
 * @param {string} rulesPath - path to skill-rules.json
 * @returns {object|null} parsed rules
 */
function getSkillRules(rulesPath) {
  try {
    const stat = fs.statSync(rulesPath);
    if (_skillRulesCache && stat.mtimeMs === _skillRulesMtime) {
      return _skillRulesCache;
    }
    _skillRulesCache = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    _skillRulesMtime = stat.mtimeMs;
    _compiledPatterns = null; // invalidate compiled patterns
    return _skillRulesCache;
  } catch {
    return null;
  }
}

/**
 * Get pre-compiled RegExp patterns for skill matching
 * @param {string} rulesPath - path to skill-rules.json
 * @returns {Map<string, RegExp[]>} compiled patterns per skill
 */
function getCompiledPatterns(rulesPath) {
  if (_compiledPatterns) return _compiledPatterns;

  const rules = getSkillRules(rulesPath);
  if (!rules || !rules.skills) return new Map();

  _compiledPatterns = new Map();
  for (const skill of rules.skills) {
    const regexps = [];
    for (const pat of (skill.patterns || [])) {
      try {
        regexps.push(new RegExp(pat, 'i'));
      } catch {
        // skip invalid regex
      }
    }
    _compiledPatterns.set(skill.name, regexps);
  }
  return _compiledPatterns;
}

// ── Sequence Counter (in-memory) ──

const _seqCounters = new Map(); // key → number

/**
 * Get next sequence number (in-memory, no disk I/O)
 * @param {string} key - counter key (e.g. 'audit')
 * @returns {number} next sequence number
 */
function nextSeq(key = 'default') {
  const current = _seqCounters.get(key) || 0;
  const next = current + 1;
  _seqCounters.set(key, next);
  return next;
}

/**
 * Initialize sequence counter from disk value
 * @param {string} key
 * @param {string} filePath - path to .seq file
 */
function initSeqFromDisk(key, filePath) {
  try {
    const val = parseInt(fs.readFileSync(filePath, 'utf8').trim()) || 0;
    _seqCounters.set(key, val);
  } catch {
    _seqCounters.set(key, 0);
  }
}

/**
 * Flush sequence counter to disk
 * @param {string} key
 * @param {string} filePath
 */
function flushSeqToDisk(key, filePath) {
  const val = _seqCounters.get(key) || 0;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, String(val));
  } catch {}
}

// ── Checkpoint LRU ──

const checkpointCache = new LRUCache(5);

// ── Shared caches ──

const fileCache = new TTLCache(60000);     // 60s TTL for file reads
const configCache = new TTLCache(300000);  // 5min TTL for config files

module.exports = {
  TTLCache,
  LRUCache,
  getSkillRules,
  getCompiledPatterns,
  nextSeq,
  initSeqFromDisk,
  flushSeqToDisk,
  checkpointCache,
  fileCache,
  configCache,
};
