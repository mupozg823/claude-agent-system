#!/usr/bin/env node
/**
 * token-budget.js - Adaptive Token Budget System
 *
 * Monitors token consumption and provides adaptive compaction timing.
 * Integrates with StatusLine hook for real-time display.
 *
 * Key features:
 *   - Burn rate tracking (tokens/min)
 *   - Adaptive compaction trigger (70-90% based on burn rate)
 *   - Skill token cost profiling
 *   - Estimated remaining turns
 *
 * Expected: 30-40% token savings, 1.5x effective session length
 */

const fs = require('fs');
const path = require('path');
const { AUDIT_DIR, TEMP_DIR } = require('./lib/paths');
const { safeRead, localDate, readJsonl } = require('./lib/utils');
const { fileCache } = require('./lib/cache');

// Claude Code context window — supports 1M (Opus 4.6 beta) via env flag
const MAX_CONTEXT_TOKENS = process.env.CLAUDE_CONTEXT_1M === '1'
  ? 1000000   // Opus 4.6 1M beta
  : 200000;   // Standard
// Average tokens per audit entry (empirical estimate)
const TOKENS_PER_TURN = 4000;
// System prompt overhead (tools + CLAUDE.md)
const SYSTEM_OVERHEAD = 20000;

const STATE_FILE = path.join(TEMP_DIR, 'token-budget.json');

// ── State management ──

let _state = null;

function loadState() {
  if (_state) return _state;
  try {
    _state = JSON.parse(safeRead(STATE_FILE));
    if (!_state || !_state.sessionStart) throw new Error('invalid');
  } catch { /* silent */
    _state = {
      sessionStart: Date.now(),
      turnCount: 0,
      tokenEstimate: SYSTEM_OVERHEAD,
      burnSamples: [],  // { ts, tokens }
      lastCompaction: null,
    };
  }
  return _state;
}

function saveState() {
  if (!_state) return;
  try {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(_state));
  } catch { /* silent */ }
}

// ── Token estimation ──

/**
 * Estimate current token usage based on audit log entry count.
 * More accurate than guessing since we count actual interactions.
 */
function estimateTokenUsage() {
  const state = loadState();

  // Count today's audit entries as proxy for turns
  const auditFile = path.join(AUDIT_DIR, `audit-${localDate()}.jsonl`);
  const cacheKey = `audit-count-${localDate()}`;
  let entryCount = fileCache.get(cacheKey);

  if (entryCount === undefined) {
    try {
      const content = safeRead(auditFile);
      entryCount = content ? content.split('\n').filter(Boolean).length : 0;
      fileCache.set(cacheKey, entryCount);
    } catch { /* silent */
      entryCount = 0;
    }
  }

  state.turnCount = entryCount;
  state.tokenEstimate = SYSTEM_OVERHEAD + (entryCount * TOKENS_PER_TURN);

  return state.tokenEstimate;
}

/**
 * Calculate burn rate (tokens per minute)
 */
function calculateBurnRate() {
  const state = loadState();
  const elapsed = (Date.now() - state.sessionStart) / 60000; // minutes
  if (elapsed < 1) return 0;

  const currentTokens = estimateTokenUsage();
  return Math.round(currentTokens / elapsed);
}

/**
 * Get token budget status
 */
function getTokenBudget() {
  const state = loadState();
  const used = estimateTokenUsage();
  const remaining = Math.max(0, MAX_CONTEXT_TOKENS - used);
  const burnRate = calculateBurnRate();
  const usedPct = Math.round((used / MAX_CONTEXT_TOKENS) * 100);

  // Estimated remaining turns
  const estimatedTurns = burnRate > 0
    ? Math.floor(remaining / TOKENS_PER_TURN)
    : 999;

  // Adaptive compaction decision
  let action = 'normal';
  if (MAX_CONTEXT_TOKENS >= 1000000) {
    // 1M mode: compact much later
    if (burnRate > 5000) {
      if (usedPct >= 90) action = 'compact-now';
      else if (usedPct >= 85) action = 'compact-soon';
    } else if (burnRate > 2000) {
      if (usedPct >= 95) action = 'compact-now';
      else if (usedPct >= 90) action = 'compact-soon';
    } else {
      if (usedPct >= 97) action = 'compact-now';
      else if (usedPct >= 93) action = 'compact-soon';
    }
  } else if (burnRate > 5000) {
    // 200K: High burn rate → compact earlier
    if (usedPct >= 70) action = 'compact-now';
    else if (usedPct >= 60) action = 'compact-soon';
  } else if (burnRate > 2000) {
    // 200K: Medium burn rate → standard thresholds
    if (usedPct >= 85) action = 'compact-now';
    else if (usedPct >= 75) action = 'compact-soon';
  } else {
    // 200K: Low burn rate → can wait longer
    if (usedPct >= 90) action = 'compact-now';
    else if (usedPct >= 85) action = 'compact-soon';
  }

  return {
    used,
    remaining,
    usedPct,
    burnRate,
    estimatedTurns,
    action,
    turnCount: state.turnCount,
  };
}

/**
 * Record a new turn (called from audit-log hook)
 */
function recordTurn() {
  const state = loadState();
  state.turnCount++;
  state.tokenEstimate += TOKENS_PER_TURN;
  state.burnSamples.push({ ts: Date.now(), tokens: state.tokenEstimate });
  // Keep last 50 samples
  if (state.burnSamples.length > 50) state.burnSamples = state.burnSamples.slice(-50);
  saveState();
}

/**
 * Record compaction event (resets token estimate)
 */
function recordCompaction() {
  const state = loadState();
  state.lastCompaction = Date.now();
  // After compaction, estimate drops significantly
  state.tokenEstimate = Math.floor(state.tokenEstimate * 0.3);
  state.burnSamples = [];
  saveState();
}

/**
 * Format token budget for StatusLine display
 */
function formatStatusLine() {
  const budget = getTokenBudget();
  const pct = Math.max(0, Math.min(100, budget.usedPct));
  const filled = Math.floor(pct / 10);
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  const icon = budget.action === 'compact-now' ? '🔴' :
               budget.action === 'compact-soon' ? '🟡' : '🟢';

  return `${icon} [${bar}] ${budget.usedPct}% | ~${budget.estimatedTurns}턴 | ${Math.round(budget.burnRate)}t/m`;
}

/**
 * Get skill token cost profile
 */
function getSkillTokenCost(skillName) {
  // Pre-measured token costs per skill (approximate)
  const costs = {
    'reviewing-code': { skill: 800, reference: 4200, total: 5000 },
    'debugging-errors': { skill: 600, reference: 0, total: 600 },
    'developing-features': { skill: 1200, reference: 0, total: 1200 },
    'scanning-security': { skill: 3000, reference: 8000, total: 11000 },
    'generating-docs': { skill: 800, reference: 3000, total: 3800 },
    'checking-status': { skill: 400, reference: 0, total: 400 },
    'logging-session': { skill: 300, reference: 0, total: 300 },
    'default': { skill: 500, reference: 0, total: 500 },
  };
  return costs[skillName] || costs['default'];
}

/**
 * Check if budget allows a skill invocation
 */
function canAffordSkill(skillName) {
  const budget = getTokenBudget();
  const cost = getSkillTokenCost(skillName);
  return budget.remaining > cost.total * 2; // 2x safety margin
}

// ── CLI / Integration mode ──

if (require.main === module) {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'status':
      console.log(JSON.stringify(getTokenBudget(), null, 2));
      break;
    case 'statusline':
      console.log(formatStatusLine());
      break;
    case 'reset':
      _state = null;
      try { fs.unlinkSync(STATE_FILE); } catch { /* silent */ }
      console.log('Token budget state reset.');
      break;
    default:
      console.log(formatStatusLine());
  }
}

module.exports = {
  getTokenBudget,
  recordTurn,
  recordCompaction,
  formatStatusLine,
  getSkillTokenCost,
  canAffordSkill,
  estimateTokenUsage,
  calculateBurnRate,
  STATE_FILE,
};
