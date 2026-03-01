// ── state.js ── Central shared mutable state + constants
// All modules import S from here; no circular dependencies.

// ── Shared mutable state ──
export const S = {
  // Supabase
  sbClient: null, channel: null,
  // Display
  P: window.innerWidth <= 600 ? 3 : 5,
  // Data
  entries: [], fr: 0, connected: false, lastET: 0,
  serverMetrics: null, timeline: [], prevTotal: 0,
  // PixiJS / Canvas
  pixiApp: null, pixiReady: false,
  buf: null, cx: null, bg: null, bgW: 0, bgH: 0, dpr: 1,
  L: { bg: null, weather: null, desks: null, agents: null, particles: null, hud: null, effects: null },
  bgSprite: null, agentSprites: [], deskSprites: [],
  hudCanvas: null, hudCx: null, hudSprite: null,
  agentCanvases: [], deskCanvases: [],
  texCache: new Map(), TEX_CACHE_MAX: 400,
  pixiPtexCache: new Map(),
  // Combo / XP
  combo: 0, maxCombo: 0, comboTimer: null, totalXP: 0,
  achievements: [], prevLevel: 1,
  // Game calendar
  SESSION_START: Date.now(), currentSeason: '',
  // RP
  totalRP: 0, rpPerMin: 0, rpHistory: [], lastRPCheck: Date.now(),
  // Reputation
  reputation: 3.0, reputationHistory: [],
  // Events
  activeEvent: null, eventTimer: 0, lastEventCheck: 0,
  eventPopup: null, eventLog: [],
  eventXPMultiplier: 1, eventRPMultiplier: 1,
  // Floors
  currentFloor: 0, viewMode: 'floor',
  floorBgCache: [null, null, null],
  floorAnim: 0, floorAnimDir: 0,
  elevatorPackets: [],
  buildingFloorHits: [],
  swipeStartY: 0, swipeStartTime: 0, swipeActive: false,
  // Tick / Lane
  lastTick: 0, relayUptime: 0, lastLaneStats: null, lastLaneStatsTime: 0,
  // Particles
  pts: [], floatingTexts: [], weatherParticles: [],
  thunderFlash: 0, dayOverlay: null,
  // Shake
  shakeFrames: 0, shakeIntensity: 0,
  // Render
  lastRender: 0, hudPrev: 0, hudWait: 30, hudShow: 0,
  // Narration
  nFull: '', nIdx: 0, nTxt: '', nTm: null,
  // Sparkline / Heatmap
  sparkData: { ops: [], errs: [], lat: [] },
  heatmap: Array.from({ length: 7 }, () => new Float32Array(24)),
  groupStats: {},
  skillUsage: {},
  // Activity
  activityHistory: [], lastActivityPush: 0, lastToolStart: 0,
  // UI
  uiD: false, uiT: null, panelOpen: false, currentPanel: 'log', newLogCount: 0,
  // Connection
  reconnectAttempts: 0, reconnectTimer: null, agentOnline: false,
  connParams: null, orchRun: null,
  // SSE
  sseActive: false, sseSource: null, ssePort: 0, sseToken: '', sseMetricsTimer: null,
  // Commands
  cmdHistory: [],
  // Building view
  buildingCanvas: null, buildingCx2: null,
  // Sheet
  sheetStartY: 0,
  // Facility combos
  activeComboNames: [], facilityComboXP: 0, comboCheckTimer: null,
  // MCP tracking
  mcpServerData: {}, skillRouteData: {},
  mcpTotalCalls: 0, skillTotalRouted: 0,
};

// Init group stats
const _groups = ['shell', 'file-io', 'edit', 'search', 'external', 'agent', 'other'];
_groups.forEach(g => { S.groupStats[g] = { total: 0, errors: 0 }; });

// ── Tool name translations ──
export const TK = {
  Bash: '터미널', Read: '파일읽기', Write: '파일쓰기', Edit: '코드편집',
  Grep: '패턴검색', Glob: '파일찾기', WebSearch: '웹검색', WebFetch: '웹수집',
  Task: '서브에이전트', Skill: '스킬', NotebookEdit: '노트북',
  TaskCreate: '태스크생성', TaskUpdate: '태스크갱신', TaskList: '태스크목록',
  TaskGet: '태스크조회', TaskOutput: '결과확인', TaskStop: '태스크중단',
  ToolSearch: '도구탐색', AskUserQuestion: '질의',
};

// ── Character definitions ──
export const C = {
  bash:   { h: '#6644CC', s: '#4834D4', p: '#2A1B6A', l: 'Shell',  r: '명령실행', e: '$_', emoji: '🖥' },
  reader: { h: '#4488CC', s: '#0984E3', p: '#06527A', l: 'Reader', r: '파일분석', e: '{}', emoji: '📖' },
  writer: { h: '#FF6699', s: '#D63031', p: '#8B1A1A', l: 'Editor', r: '코드편집', e: '<>', emoji: '✏' },
  finder: { h: '#44AA88', s: '#00796B', p: '#004040', l: 'Search', r: '패턴검색', e: '??', emoji: '🔍' },
  mcp:    { h: '#44DDAA', s: '#00B894', p: '#006644', l: 'MCP',    r: '서버연동', e: '::', emoji: '🔌' },
  agent:  { h: '#AA88FF', s: '#6C5CE7', p: '#3D2B8A', l: 'Agent',  r: '오케스트라', e: '>>', emoji: '🎯' },
  web:    { h: '#FF88AA', s: '#E84393', p: '#8B2252', l: 'Web',    r: '웹리서치', e: '@',  emoji: '🌐' },
  serena: { h: '#FFCC44', s: '#B8860B', p: '#6B4E00', l: 'Serena', r: '심볼분석', e: 'fn', emoji: '🌿' },
};

// ── Floor definitions ──
export const FLOORS = [
  { id: 0, name: '1F Coding Lab', nameKo: '1F 코딩 연구실',
    colors: { wall: ['#F0F8E8', '#E4F0D8', '#C0D8A0'], floor: ['#5A9E50', '#4D8A44', '#3D7A35'], accent: '#44DD66' } },
  { id: 1, name: '2F Analysis Center', nameKo: '2F 분석 센터',
    colors: { wall: ['#F0E8FF', '#E4D8F8', '#C0A8E0'], floor: ['#7A6AAA', '#6A5A9A', '#5A4A8A'], accent: '#8866CC' } },
  { id: 2, name: '3F Operations Hub', nameKo: '3F 운영 허브',
    colors: { wall: ['#FFF0E0', '#F8E0C8', '#E0C0A0'], floor: ['#AA7744', '#996633', '#886622'], accent: '#FF8844' } },
];

export const AGENT_FLOOR = { bash: 0, writer: 0, reader: 1, finder: 1, serena: 1, mcp: 2, agent: 2, web: 2 };
export const AT = ['bash', 'reader', 'writer', 'finder', 'mcp', 'agent', 'web', 'serena'];

export const DESKS = [
  { x: .35, label: 'Shell', act: false, floor: 0 }, { x: .19, label: 'Reader', act: false, floor: 1 },
  { x: .65, label: 'Editor', act: false, floor: 0 }, { x: .43, label: 'Search', act: false, floor: 1 },
  { x: .22, label: 'MCP', act: false, floor: 2 },    { x: .50, label: 'Agent', act: false, floor: 2 },
  { x: .78, label: 'Web', act: false, floor: 2 },    { x: .78, label: 'Serena', act: false, floor: 1 },
];

// ── Tool particle colors ──
export const TOOL_COLORS = {
  Bash: ['#44DD66', '#22CC44', '#66FF88'],
  Read: ['#4488FF', '#6699FF', '#88BBFF'],
  Write: ['#FF6699', '#FF88AA', '#FF44CC'],
  Edit: ['#FFAA22', '#FFCC44', '#FF8800'],
  Grep: ['#44DDAA', '#66FFCC', '#22BB88'],
  Glob: ['#44DDAA', '#22BB88', '#88FFDD'],
  WebSearch: ['#AA88FF', '#CC99FF', '#8866DD'],
  WebFetch: ['#AA88FF', '#8866DD', '#CCAAFF'],
  Task: ['#FFDD44', '#FFE866', '#FFCC00'],
  ToolSearch: ['#88CCDD', '#66BBCC', '#AADDEE'],
};

// ── Tool group classification ──
export const GROUPS = {
  shell: '#44AA44', 'file-io': '#4488CC', edit: '#CC8800',
  search: '#44AAAA', external: '#AA44CC', agent: '#CCAA22', other: '#888888',
};

// ── Seasons ──
export const SEASONS = ['봄', '여름', '가을', '겨울'];
export const SEASON_COLORS = ['#6B9A8E', '#D4523C', '#D4A032', '#6666CC'];
export const SEASON_BG = {
  '봄':  { wall: ['#FFF5E8', '#F0E8D8', '#E0D0B8'], floor: ['#5AAE55', '#4D9A48', '#3D8A38'], sky: ['#88DDFF', '#BBEEFF', '#E0F8FF'], accent: '#FF88AA' },
  '여름': { wall: ['#FFF8E0', '#F5EED0', '#E8D8B0'], floor: ['#3D8A35', '#307828', '#256820'], sky: ['#55AAFF', '#88CCFF', '#BBDDFF'], accent: '#FF6633' },
  '가을': { wall: ['#FFF0D0', '#F0E0C0', '#DCC8A0'], floor: ['#8A7A35', '#7A6A2D', '#6A5A25'], sky: ['#AACCEE', '#CCDDEE', '#E8E8F0'], accent: '#DD8822' },
  '겨울': { wall: ['#F0F0FA', '#E8E8F2', '#D8D8E8'], floor: ['#88AAAA', '#779999', '#668888'], sky: ['#99AACC', '#BBCCDD', '#D0D8E8'], accent: '#6688CC' },
};

// ── Achievements ──
export const ACHIEVEMENTS = [
  { id: 'first', name: '첫 번째 작업', desc: '첫 도구 실행', cond: () => S.entries.length >= 1 },
  { id: 'combo5', name: '콤보 5!', desc: '5연속 성공', cond: () => S.maxCombo >= 5 },
  { id: 'combo10', name: '콤보 마스터', desc: '10연속 성공', cond: () => S.maxCombo >= 10 },
  { id: 'ops50', name: '50작업 돌파', desc: '총 50회 도구 실행', cond: () => S.entries.length >= 50 },
  { id: 'ops100', name: '백전노장', desc: '총 100회 도구 실행', cond: () => S.entries.length >= 100 },
  { id: 'deny0', name: '무결점', desc: '차단 0으로 50작업', cond: () => S.entries.length >= 50 && S.entries.filter(e => e.decision === 'deny').length === 0 },
  { id: 'alltools', name: '만능 도구', desc: '5종류 이상 도구 사용', cond: () => new Set(S.entries.map(e => e.tool).filter(Boolean)).size >= 5 },
  { id: 'night', name: '야간 근무', desc: '밤 10시 이후 작업', cond: () => new Date().getHours() >= 22 },
];

// ── Facility combos ──
export const FACILITY_COMBOS = [
  { agents: ['bash', 'writer'], name: 'CI/CD 파이프라인', bonus: 1.2, color: '#FF6644' },
  { agents: ['reader', 'finder', 'serena'], name: '코드 분석팀', bonus: 1.5, color: '#4488FF' },
  { agents: ['mcp', 'web'], name: '외부 연동', bonus: 1.3, color: '#44DDAA' },
  { agents: ['agent', 'bash'], name: '자동화 부서', bonus: 1.4, color: '#AA88FF' },
  { agents: ['writer', 'reader'], name: '코드 리뷰', bonus: 1.2, color: '#FF88AA' },
  { agents: ['serena', 'finder', 'reader'], name: '아키텍처 분석', bonus: 1.6, color: '#FFCC44' },
];

// ── Kairo events ──
export const KAIRO_EVENTS = [
  { id: 'bug_outbreak', name: '버그 대발생!', desc: '에러율 증가! 빠른 수정 필요', icon: 'B', color: '#FF4444', duration: 120, effect: 'error' },
  { id: 'code_review', name: '코드 리뷰 데이', desc: 'XP 획득량 2배!', icon: 'R', color: '#4488FF', duration: 180, effect: 'xp_boost' },
  { id: 'hackathon', name: '해커톤 개최!', desc: '속도 스탯 대폭 상승', icon: 'H', color: '#FF8844', duration: 150, effect: 'speed_boost' },
  { id: 'research_grant', name: '연구 지원금!', desc: 'RP 획득량 3배', icon: 'G', color: '#44CC88', duration: 120, effect: 'rp_boost' },
  { id: 'team_dinner', name: '팀 회식!', desc: '전원 사기 상승, 파워 회복', icon: 'D', color: '#FFAA44', duration: 60, effect: 'morale' },
  { id: 'investor_visit', name: '투자자 방문!', desc: '평판 보너스 발동', icon: 'I', color: '#FFD080', duration: 90, effect: 'reputation' },
];

// ── Agent traits ──
export const AGENT_TRAITS = {
  bash:   [{ lv: 5, name: '스크립터', icon: 'S', color: '#FF8844', bonus: 'code+10%' }, { lv: 10, name: '데브옵스 마스터', icon: 'M', color: '#FF4422', bonus: 'speed+20%' }],
  reader: [{ lv: 5, name: '분석가', icon: 'A', color: '#4488FF', bonus: 'research+10%' }, { lv: 10, name: '아키텍트', icon: 'M', color: '#2266DD', bonus: 'research+20%' }],
  writer: [{ lv: 5, name: '리팩터러', icon: 'R', color: '#44CC88', bonus: 'code+10%' }, { lv: 10, name: '클린코더', icon: 'M', color: '#22AA66', bonus: 'code+20%' }],
  finder: [{ lv: 5, name: '탐색자', icon: 'F', color: '#CCAA44', bonus: 'speed+10%' }, { lv: 10, name: '인덱서', icon: 'M', color: '#DDBB22', bonus: 'speed+20%' }],
  mcp:    [{ lv: 5, name: '커넥터', icon: 'C', color: '#AA66FF', bonus: 'network+10%' }, { lv: 10, name: '통합자', icon: 'M', color: '#8844DD', bonus: 'network+20%' }],
  agent:  [{ lv: 5, name: '코디네이터', icon: 'C', color: '#FF66AA', bonus: 'speed+10%' }, { lv: 10, name: '오케스트레이터', icon: 'M', color: '#DD4488', bonus: 'all+10%' }],
  web:    [{ lv: 5, name: '크롤러', icon: 'W', color: '#44DDCC', bonus: 'network+10%' }, { lv: 10, name: '풀스택', icon: 'M', color: '#22BBAA', bonus: 'all+10%' }],
  serena: [{ lv: 5, name: '심볼리스트', icon: 'S', color: '#FFCC44', bonus: 'research+10%' }, { lv: 10, name: '코드 위스퍼러', icon: 'M', color: '#DDAA22', bonus: 'all+15%' }],
};

// ── Narration templates ──
export const NR = {
  Bash: ['Shell: 터미널 명령 실행 중...', 'Shell: 시스템 호출 처리 중', 'Shell: 프로세스 실행 대기', 'Shell: 명령 결과 수집 중', 'Shell: 파이프라인 구성 중'],
  Read: ['Reader: 소스코드 분석 시작', 'Reader: 파일 내용 스캔 중', 'Reader: 구조 파악 중...', 'Reader: 의존성 추적 중', 'Reader: 모듈 분석 완료'],
  Write: ['Editor: 새 파일 생성 중', 'Editor: 코드 작성 시작', 'Editor: 보일러플레이트 생성', 'Editor: 파일 구조 설계 중'],
  Edit: ['Editor: 코드 패치 적용 중', 'Editor: 리팩토링 수행', 'Editor: 심볼 교체 중', 'Editor: diff 계산 중', 'Editor: 인라인 수정 반영'],
  Grep: ['Search: 정규식 패턴 매칭 중', 'Search: 코드베이스 스캔 중', 'Search: 일치 결과 수집 중', 'Search: 심층 검색 진행 중'],
  Glob: ['Search: 파일 시스템 탐색 중', 'Search: 패턴 매칭 파일 검색', 'Search: 디렉토리 트리 순회 중'],
  WebSearch: ['Web: 검색 엔진 쿼리 실행', 'Web: 최신 정보 수집 중', 'Web: 검색 결과 분석 중', 'Web: 글로벌 지식 탐색 중'],
  WebFetch: ['Web: 웹 페이지 다운로드 중', 'Web: HTML 파싱 처리 중', 'Web: 콘텐츠 추출 중', 'Web: API 응답 처리 중'],
  Task: ['Agent: 서브에이전트 디스패치!', 'Agent: 병렬 작업 분배 중', 'Agent: 에이전트 태스크 할당', 'Agent: 오케스트레이션 실행 중'],
  TaskCreate: ['Agent: 새 태스크 생성!', 'Agent: 작업 계획 수립 중'],
  TaskUpdate: ['Agent: 태스크 상태 업데이트', 'Agent: 진행 상황 기록 중'],
  ToolSearch: ['MCP: 도구 검색 실행 중', 'MCP: 확장 도구 탐색 중'],
  Skill: ['Skill: 스킬 실행 중!', 'Skill: 자동화 워크플로우 시작'],
  EnterPlanMode: ['Plan: 설계 모드 진입!', 'Plan: 아키텍처 분석 시작'],
  ExitPlanMode: ['Plan: 설계 완료, 실행 준비!'],
  deny: ['⚠ 차단: 위험 명령 감지됨!', '⚠ 차단: 정책 위반 감지', '⚠ 차단: 접근 거부됨'],
  idle: ['시스템 모니터링 대기 중...', '모든 에이전트 대기 상태', '다음 작업 대기 중...', '시스템 정상 운영 중'],
};

// ── MCP server list ──
export const MCP_SERVERS = [
  { id: 'serena', label: 'Serena', desc: '코드 심볼 탐색/수정', icon: '🔍' },
  { id: 'grep-app', label: 'grep.app', desc: '공개 저장소 검색', icon: '🌐' },
  { id: 'context7', label: 'Context7', desc: '라이브러리 문서', icon: '📚' },
  { id: 'filesystem', label: 'Filesystem', desc: '파일 시스템', icon: '📁' },
  { id: 'memory', label: 'Memory', desc: '지식 그래프', icon: '🧠' },
  { id: 'sequential-thinking', label: 'Thinking', desc: '복잡 추론', icon: '💭' },
  { id: 'claude_ai_Notion', label: 'Notion', desc: '노션 연동', icon: '📝' },
];

// ── Skill categories ──
export const SKILL_CATEGORIES = [
  { id: 'session', label: '세션', color: '#6B9A8E' },
  { id: 'quality', label: '품질', color: '#D4523C' },
  { id: 'debug', label: '디버그', color: '#CC3300' },
  { id: 'security', label: '보안', color: '#8B6F47' },
  { id: 'workflow', label: '워크플로', color: '#6666CC' },
  { id: 'devops', label: 'DevOps', color: '#44AA44' },
  { id: 'project', label: '프로젝트', color: '#CC6600' },
  { id: 'deps', label: '의존성', color: '#CCAA22' },
  { id: 'docs', label: '문서', color: '#4488AA' },
  { id: 'planning', label: '기획', color: '#AA88FF' },
  { id: 'research', label: '리서치', color: '#888888' },
  { id: 'system', label: '시스템', color: '#44CC44' },
  { id: 'report', label: '보고', color: '#BB6688' },
];

// ── SSE Ports ──
export const SSE_PORTS = [17891, 17892];
