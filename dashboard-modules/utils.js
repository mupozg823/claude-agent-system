// ── utils.js ── Pure utility functions
import { S, TK, SEASONS, SEASON_COLORS, AGENT_TRAITS } from './state.js';

export function tk(t) {
  if (!t) return '대기';
  if (TK[t]) return TK[t];
  if (t.startsWith('mcp__serena__')) return 'Serena';
  if (t.startsWith('mcp__memory__')) return '메모리';
  if (t.startsWith('mcp__context7')) return '문서조회';
  if (t.startsWith('mcp__filesystem')) return '파일시스템';
  if (t.startsWith('mcp__grep')) return '코드검색';
  if (t.startsWith('mcp__seq')) return '추론';
  if (t.startsWith('mcp__')) return 'MCP';
  return t;
}

// Tool → Agent index mapping
export function t2a(t) {
  if (!t) return 5;
  if (t === 'Bash') return 0;
  if (t === 'Read') return 1;
  if (['Write', 'Edit', 'NotebookEdit'].includes(t)) return 2;
  if (t === 'Grep' || t === 'Glob') return 3;
  if (t === 'WebSearch' || t === 'WebFetch') return 6;
  if (['Task', 'Skill', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskStop', 'TaskOutput', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'].includes(t)) return 5;
  if (t === 'ToolSearch') return 3;
  if (t.startsWith('mcp__serena')) return 7;
  if (t.startsWith('mcp__grep')) return 3;
  if (t.startsWith('mcp__context7')) return 6;
  if (t.startsWith('mcp__filesystem')) return 1;
  if (t.startsWith('mcp__memory')) return 5;
  if (t.startsWith('mcp__seq')) return 5;
  if (t.startsWith('mcp__claude_ai_Notion')) return 6;
  if (t.startsWith('mcp__')) return 4;
  return 5;
}

export function desc(e) {
  const t = e.tool || '', s = e.summary || e.cmd || '';
  if (t === 'Bash') { const c = e.cmd || s; if (c.includes('git')) return 'Git'; if (c.includes('npm') || c.includes('node')) return 'Node'; if (c.includes('curl') || c.includes('wget')) return '네트워크'; if (c.includes('docker')) return 'Docker'; if (c.includes('test') || c.includes('jest')) return '테스트'; return '명령실행'; }
  if (t === 'Read') { const f = (e.path || s).split(/[/\\]/).pop(); return f ? f.slice(0, 14) : '파일읽기'; }
  if (t === 'Write') { const f = (e.path || s).split(/[/\\]/).pop(); return f ? '생성:' + f.slice(0, 10) : '파일생성'; }
  if (t === 'Edit') { const f = (e.path || s).split(/[/\\]/).pop(); return f ? '수정:' + f.slice(0, 10) : '코드수정'; }
  if (t === 'NotebookEdit') return '노트북편집';
  if (t === 'Grep') return '코드검색'; if (t === 'Glob') return '파일탐색';
  if (t === 'WebSearch') return '웹검색'; if (t === 'WebFetch') return '페이지수집';
  if (t === 'Task') return '서브에이전트'; if (t === 'Skill') return '스킬실행';
  if (t === 'ToolSearch') return '도구탐색'; if (t === 'AskUserQuestion') return '사용자질의';
  if (t === 'EnterPlanMode') return '계획수립'; if (t === 'ExitPlanMode') return '계획완료';
  if (['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'].includes(t)) return '태스크관리';
  if (t.startsWith('mcp__serena')) return 'Serena:' + t.split('__').pop().slice(0, 10);
  if (t.startsWith('mcp__grep')) return '코드검색(외부)';
  if (t.startsWith('mcp__context7')) return '문서조회';
  if (t.startsWith('mcp__filesystem')) return '파일시스템';
  if (t.startsWith('mcp__memory')) return '지식그래프';
  if (t.startsWith('mcp__seq')) return '추론체인';
  if (t.startsWith('mcp__claude_ai_Notion')) return 'Notion';
  if (t.startsWith('mcp__')) return 'MCP:' + t.split('__')[1];
  return tk(t);
}

// ── Agent traits lookup (shared by agents.js and ui.js) ──
export function getAgentTraits(type, lv) {
  const traits = AGENT_TRAITS[type] || [];
  return traits.filter(t => lv >= t.lv);
}

export function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
export function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

export function toolGroup(t) {
  if (!t) return 'other';
  if (t === 'Bash') return 'shell';
  if (['Read', 'Write', 'Glob'].includes(t)) return 'file-io';
  if (['Edit', 'NotebookEdit'].includes(t)) return 'edit';
  if (['Grep', 'WebSearch', 'WebFetch'].includes(t)) return 'search';
  if (t.startsWith('mcp__')) return 'external';
  if (['Task', 'Skill'].includes(t)) return 'agent';
  return 'other';
}

// Cached: recalculates only when game-time bucket changes (every 2 real seconds)
let _calCache = null, _calBucket = -1;
export function getGameCalendar() {
  const elapsed = (Date.now() - S.SESSION_START) / 1000;
  const gameMins = Math.floor(elapsed / 2);
  if (gameMins === _calBucket && _calCache) return _calCache;
  _calBucket = gameMins;
  const gameDay = Math.floor(gameMins / 24) % 30 + 1;
  const gameMonth = Math.floor(gameMins / 24 / 30) % 12 + 1;
  const gameYear = Math.floor(gameMins / 24 / 30 / 12) + 1;
  const seasonIdx = Math.floor((gameMonth - 1) / 3);
  _calCache = {
    year: gameYear, month: gameMonth, day: gameDay,
    season: SEASONS[seasonIdx], seasonColor: SEASON_COLORS[seasonIdx],
    label: `Y${gameYear} ${SEASONS[seasonIdx]} ${gameMonth}월 ${gameDay}일`,
  };
  return _calCache;
}

export function getDayPhase() {
  const h = new Date().getHours();
  if (h >= 6 && h < 10) return 'morning';
  if (h >= 10 && h < 17) return 'day';
  if (h >= 17 && h < 20) return 'evening';
  return 'night';
}

// Cached: recalculates at most once per second
let _weatherCache = 'sunny', _weatherTs = 0;
export function getWeather() {
  const now = Date.now();
  if (now - _weatherTs < 1000) return _weatherCache;
  _weatherTs = now;
  if (S.entries.length < 5) { _weatherCache = 'sunny'; return _weatherCache; }
  const recent = S.entries.slice(-20);
  const errRate = recent.filter(e => e.err || e.decision === 'deny').length / recent.length;
  const intensity = getActivityIntensity();
  if (errRate > .3) _weatherCache = 'rain';
  else if (errRate > .15) _weatherCache = 'cloudy';
  else if (intensity > .6) _weatherCache = 'active';
  else _weatherCache = 'sunny';
  return _weatherCache;
}

export function trackActivity() {
  const now = Date.now();
  S.activityHistory.push(now);
  S.activityHistory = S.activityHistory.filter(t => now - t < 60000);
}

export function getActivityIntensity() {
  return Math.min(S.activityHistory.length / 30, 1);
}

export function addSpark(key, val) {
  const a = S.sparkData[key]; a.push(val); if (a.length > 30) a.shift();
}

export function recordHeat(ts) {
  const d = new Date(ts || Date.now());
  S.heatmap[d.getDay()][d.getHours()]++;
}
