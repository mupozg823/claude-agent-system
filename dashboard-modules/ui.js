// ── ui.js ── Toast, narration, panel system, sparkline/heatmap SVG, panel content rendering, throttled UI update
import {
  S, C, FLOORS, AT, DESKS, GROUPS, ACHIEVEMENTS, SEASON_BG,
  AGENT_TRAITS, NR, MCP_SERVERS, SKILL_CATEGORIES,
} from './state.js';
import { tk, desc, esc, pick, getGameCalendar, getActivityIntensity } from './utils.js';

// ── Agent traits (inlined to avoid circular import from agents.js) ──
function getAgentTraits(type, lv) {
  const traits = AGENT_TRAITS[type] || [];
  return traits.filter(t => lv >= t.lv);
}

// ══════════════════════════════════════════════════════
// ── TOAST SYSTEM ──
// ══════════════════════════════════════════════════════
export function toast(msg, type = 'in') {
  const wrap = document.getElementById('toastWrap'); if (!wrap) return;
  const el = document.createElement('div'); el.className = 'toast ' + type; el.textContent = msg;
  wrap.appendChild(el); requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); el.classList.add('hide'); setTimeout(() => el.remove(), 300); }, 2500);
  while (wrap.children.length > 3) wrap.firstChild.remove();
}

// ══════════════════════════════════════════════════════
// ── NARRATION (typewriter) ──
// ══════════════════════════════════════════════════════
export function narr(t, at) {
  document.getElementById('nf').textContent = at ? (C[at]?.l || 'SYS') : 'SYS';
  S.nFull = t; S.nIdx = 0; S.nTxt = ''; clearInterval(S.nTm);
  S.nTm = setInterval(() => {
    if (S.nIdx < S.nFull.length) {
      S.nTxt += S.nFull[S.nIdx++];
      document.getElementById('nt').textContent = S.nTxt;
    } else clearInterval(S.nTm);
  }, 35);
}

// ══════════════════════════════════════════════════════
// ── PANEL SYSTEM ──
// ══════════════════════════════════════════════════════
export function openPanel(name) {
  S.currentPanel = name || 'log'; S.panelOpen = true;
  document.getElementById('panelOverlay').classList.add('open');
  document.getElementById('fabBtn').classList.add('hide');
  switchTab(S.currentPanel); renderPanel();
  document.querySelectorAll('.bnav .nb').forEach(b => {
    b.classList.toggle('active', b.dataset.p === S.currentPanel);
  });
  if (name === 'log') { S.newLogCount = 0; updateBadge('logBadge', 0); }
}

export function closePanel(e) {
  if (e && e.target !== e.currentTarget) return;
  S.panelOpen = false;
  document.getElementById('panelOverlay').classList.remove('open');
  document.getElementById('fabBtn').classList.remove('hide');
}

export function switchTab(name) {
  S.currentPanel = name;
  document.querySelectorAll('.ptab').forEach(t => t.classList.toggle('active', t.dataset.p === name));
  document.querySelectorAll('.bnav .nb').forEach(b => b.classList.toggle('active', b.dataset.p === name));
  renderPanel();
}

export function updateBadge(id, n) {
  const el = document.getElementById(id); if (!el) return;
  el.textContent = n; el.classList.toggle('show', n > 0);
}

// ══════════════════════════════════════════════════════
// ── SPARKLINE / HEATMAP SVG ──
// ══════════════════════════════════════════════════════
export function drawSparkSvg(data, color, w, h) {
  if (data.length < 2) return '';
  const max = Math.max(1, ...data),
    pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - v / max * (h - 2) + 1}`).join(' ');
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5"/></svg>`;
}

export function renderHeatmapSvg() {
  const cW2 = 280, cH2 = 110, padL = 28, padT = 16,
    gw = (cW2 - padL) / 24, gh = (cH2 - padT) / 7;
  const mx = Math.max(1, ...S.heatmap.flat());
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  let s = '<div class="heatmap-wrap"><svg width="' + cW2 + '" height="' + cH2 + '" style="display:block">';
  for (let d = 0; d < 7; d++) {
    s += '<text x="' + (padL - 4) + '" y="' + (padT + d * gh + gh * .7) + '" text-anchor="end" fill="#8B7860" font-size="8" font-family="inherit">' + days[d] + '</text>';
    for (let h = 0; h < 24; h++) {
      const v = S.heatmap[d][h], intensity = v / mx;
      const r = Math.round(68 + intensity * 140), g2 = Math.round(170 - intensity * 80), b = Math.round(68 + intensity * 20);
      const col = v === 0 ? '#3A3A5A' : 'rgb(' + r + ',' + g2 + ',' + b + ')';
      s += '<rect x="' + (padL + h * gw) + '" y="' + (padT + d * gh) + '" width="' + (gw - 1) + '" height="' + (gh - 1) + '" rx="1.5" fill="' + col + '"><title>' + days[d] + ' ' + h + '시: ' + v + '건</title></rect>';
    }
  }
  for (let h = 0; h < 24; h += 3) s += '<text x="' + (padL + h * gw + gw * .5) + '" y="' + (padT - 4) + '" text-anchor="middle" fill="#8B7860" font-size="7" font-family="inherit">' + h + '</text>';
  s += '</svg></div>'; return s;
}

// ══════════════════════════════════════════════════════
// ── PANEL CONTENT RENDERING ──
// ══════════════════════════════════════════════════════
export function renderPanel() {
  const body = document.getElementById('panelBody'); if (!body) return;
  switch (S.currentPanel) {
    case 'log': body.innerHTML = rLogHTML(); break;
    case 'metrics': body.innerHTML = rStatHTML(); break;
    case 'agents': body.innerHTML = rAgHTML(); break;
    case 'cmd':
      body.innerHTML = rCmdHTML();
      const inp = document.getElementById('cmdInput'); if (inp) inp.focus(); break;
    case 'mcp': body.innerHTML = rMcpHTML(); break;
    case 'dag': body.innerHTML = rDagHTML(); break;
    case 'analytics': body.innerHTML = rAnalyticsHTML(); break;
  }
}

// ── Log Panel ──
export function rLogHTML() {
  return S.entries.slice(-40).reverse().map(e => {
    const cl = e.decision === 'deny' ? 'er' : e.err ? 'er' : e.decision === 'allow' ? 'ok' : e.level === 'warn' ? 'wr' : 'in';
    const tm = (e.ts || '').slice(11, 19), tl = tk(e.tool);
    const gBadge = e.group ? `<span style="color:#8B7860;font-size:8px;margin-right:2px">${e.group}</span>` : '';
    let dt = '';
    if (e.err) dt = '\u26a0 ' + e.err.slice(0, 40);
    else if (e.cmd) dt = e.cmd.slice(0, 50);
    else if (e.path) dt = e.path.split(/[/\\]/).slice(-2).join('/');
    else if (e.summary) dt = e.summary.slice(0, 50);
    else dt = desc(e);
    const seqTag = e.seq ? `<span style="color:#AAA;font-size:8px;margin-right:2px">#${e.seq}</span>` : '';
    return `<div class="le ${cl}">${seqTag}<span class="t">${tm}</span><span class="n">${tl}</span>${gBadge}<span class="m">${esc(dt)}</span></div>`;
  }).join('') || '<div style="text-align:center;color:#8B7860;padding:20px">아직 이벤트가 없습니다</div>';
}

// ── Stats / Metrics Panel ──
export function rStatHTML() {
  const d = S.entries, m = S.serverMetrics;
  let successRate = 100, blockRate = 0, opsMin = '0', errs = 0, blocks = 0, total = d.length, sessions = 0, durMin = 0;
  const grp = { 'file-io': 0, shell: 0, search: 0, external: 0, agent: 0, edit: 0 };
  if (m && m.total > 0) {
    successRate = m.successRate || 100; blockRate = m.blockRate || 0;
    opsMin = m.opsPerMin || 0; errs = m.errorCount || 0; blocks = Math.round(m.blockRate * m.total / 100) || 0;
    total = m.total; sessions = m.sessions || 0; durMin = m.durationMin || 0;
    if (m.groups) Object.entries(m.groups).forEach(([k, v]) => { if (grp[k] !== undefined) grp[k] = v.count || v; });
  } else {
    d.forEach(e => {
      if (!e.tool) return;
      if ('Read Write Edit NotebookEdit'.includes(e.tool)) grp['file-io']++;
      else if (e.tool === 'Bash') grp.shell++;
      else if (e.tool === 'Grep' || e.tool === 'Glob') grp.search++;
      else if (e.tool.startsWith('mcp__') || e.tool === 'WebSearch' || e.tool === 'WebFetch') grp.external++;
      else if ('Task Skill TaskCreate TaskUpdate'.includes(e.tool)) grp.agent++;
      if (e.ok === false) errs++; if (e.decision === 'deny') blocks++;
    });
    successRate = total > 0 ? ((total - errs) / total * 100) | 0 : 100;
    blockRate = total > 0 ? (blocks / total * 100) | 0 : 0;
    opsMin = total >= 2 ? (total / Math.max(1, (new Date(d[d.length - 1].ts) - new Date(d[0].ts)) / 6e4)).toFixed(1) : '0';
  }

  let h = '<div style="font-size:12px;color:var(--gold-dd);font-weight:bold;margin:4px 0 8px">시스템 메트릭</div>';
  h += `<div class="sb"><span class="n">성공률</span><div class="b"><div class="f" style="width:${successRate}%;background:${successRate > 90 ? 'var(--ok)' : 'var(--err)'}"></div>${drawSparkSvg(S.sparkData.ops, '#44AA4480', 60, 12)}</div><span class="v">${Math.round(successRate)}%</span></div>`;
  h += `<div class="sb"><span class="n">차단률</span><div class="b"><div class="f" style="width:${Math.min(blockRate * 10, 100)}%;background:var(--err)"></div>${drawSparkSvg(S.sparkData.errs, '#CC330080', 60, 12)}</div><span class="v">${Math.round(blockRate)}%</span></div>`;
  h += `<div class="sb"><span class="n">속도</span><div class="b"><div class="f" style="width:${Math.min(opsMin * 5, 100)}%;background:var(--info)"></div></div><span class="v">${opsMin}/m</span></div>`;
  h += '<div style="font-size:12px;color:var(--gold-dd);font-weight:bold;margin:10px 0 8px">도구 그룹</div>';

  const gMetrics = [
    ['파일I/O', grp['file-io'] + grp.edit, 'var(--ok)'],
    ['셸', grp.shell, '#FF6644'],
    ['검색', grp.search, 'var(--info)'],
    ['외부', grp.external, 'var(--warn)'],
    ['에이전트', grp.agent, '#AA88FF'],
  ];
  const gmx = Math.max(1, ...gMetrics.map(m2 => m2[1]));
  gMetrics.forEach(([n, v, co]) => {
    h += `<div class="sb"><span class="n">${n}</span><div class="b"><div class="f" style="width:${(v / gmx * 100) | 0}%;background:${co}"></div></div><span class="v">${v}</span></div>`;
  });

  h += `<div style="font-size:10px;color:#8B7860;margin-top:8px;padding:6px;background:#FFF8E8;border-radius:6px">총 <b>${total}</b> | 에러 <b>${errs}</b> | 차단 <b>${blocks}</b>${sessions ? ' | ' + sessions + '세션' : ''}${durMin ? ' | ' + durMin + '분' : ''}</div>`;

  // Lane Queue info
  h += '<div style="font-size:12px;color:var(--gold-dd);font-weight:bold;margin:10px 0 6px">Lane Queue</div>';
  const laneAge = S.lastLaneStatsTime ? Math.floor((Date.now() - S.lastLaneStatsTime) / 1000) : 999;
  const laneDefault = S.lastLaneStats
    ? `큐:<b>${S.lastLaneStats.pending || 0}</b> 실행:<b>${S.lastLaneStats.running || 0}</b> 완료:<b>${S.lastLaneStats.completed || 0}</b>${laneAge > 90 ? ' <span style="color:var(--err)">(' + laneAge + '초 전)</span>' : ''}`
    : (S.connected ? '<span style="color:var(--warn)">대기 중... (30초 내 업데이트)</span>' : '<span style="color:var(--err)">릴레이 오프라인</span>');
  h += `<div id="laneInfo" style="font-size:11px;color:#8B7860;padding:6px;background:#FFF8E8;border-radius:6px;border-left:3px solid ${S.lastLaneStats && S.lastLaneStats.running > 0 ? 'var(--accent)' : 'transparent'}">${laneDefault}</div>`;

  // Orchestration
  h += '<div id="orchInfo" style="font-size:11px;color:#8B7860;padding:6px;margin-top:4px;background:#FFF8E8;border-radius:6px;border-left:3px solid var(--info);display:none"></div>';

  // Game calendar & stats
  const cal = getGameCalendar();
  h += '<div style="font-size:12px;color:var(--gold-dd);font-weight:bold;margin:10px 0 6px">게임 통계</div>';
  h += `<div style="padding:6px;background:var(--kairo-panel);border:1px solid var(--kairo-border);border-radius:6px;font-size:11px">`;
  h += `<div style="display:flex;justify-content:space-between;align-items:center"><span style="font-weight:bold;color:${cal.seasonColor}">${cal.label}</span><span style="font-size:9px;color:#888">세션 ${Math.floor((Date.now() - S.SESSION_START) / 60000)}분</span></div>`;
  h += `<div style="margin-top:4px">현재 콤보: <b style="color:${S.combo >= 5 ? 'var(--warm-red)' : 'var(--accent)'}">${S.combo}</b> | 최대: <b>${S.maxCombo}</b></div>`;
  h += `<div>총 XP: <b style="color:var(--info)">${S.totalXP}</b> | Lv.<b>${Math.floor(S.totalXP / 500) + 1}</b></div>`;
  if (S.activeComboNames.length > 0) {
    h += `<div style="margin-top:3px;color:var(--accent-gold);font-weight:bold;font-size:10px">시설 콤보: ${S.activeComboNames.join(', ')}</div>`;
  }
  h += `<div style="margin-top:4px">업적: ${S.achievements.length}/${ACHIEVEMENTS.length}</div>`;
  S.achievements.forEach(id => {
    const a = ACHIEVEMENTS.find(x => x.id === id);
    if (a) h += `<div style="font-size:9px;color:var(--ok);margin-top:2px">\u2713 ${a.name}</div>`;
  });
  h += `</div>`;

  // Relay uptime
  if (S.relayUptime > 0) {
    const um = Math.floor(S.relayUptime / 60), us = S.relayUptime % 60;
    h += `<div style="font-size:10px;color:#8B7860;margin-top:6px">릴레이 업타임: ${um}분 ${us}초</div>`;
  }
  return h;
}

// ── Agents Panel ──
export function rAgHTML() {
  const agents = S.agents;
  if (!agents || !agents.length) return '<div style="text-align:center;color:#8B7860;padding:20px">에이전트 초기화 대기 중...</div>';
  return agents.map(a => {
    const c = C[a.t],
      txt = a.tk || (a.st === 'work' ? '처리 중' : a.st === 'walk' ? '이동' : '대기'),
      act = a.st === 'work' ? ' on' : '',
      st = a.st === 'work' ? 'RUN' : a.st === 'walk' ? 'MOV' : 'IDLE',
      stC = a.st === 'work' ? 'var(--warm-red)' : a.st === 'walk' ? 'var(--accent-gold)' : 'var(--muted-teal)',
      s = a.stats, mx = Math.max(s.code, s.research, s.network, s.speed, 1);
    const _tr = getAgentTraits(a.t, a.lv);
    const _trHTML = _tr.length > 0 ? '<div class="traits">' + _tr.map(t => `<span class="trait-badge" style="background:${t.color}">${t.icon} ${t.name}</span>`).join('') + '</div>' : '';
    const _pwB = Math.min(a.pw, 100), _pwC = _pwB > 60 ? 'var(--ok)' : _pwB > 30 ? 'var(--warn)' : 'var(--err)';
    return `<div class="ac${act}"><div class="fc" style="background:${a.st === 'work' ? c.s : 'var(--cream)'};color:${a.st === 'work' ? '#FFF' : c.s};font-family:monospace;font-weight:bold">${c.e}<span class="lvbadge">${a.lv}</span></div><div class="i"><div class="nm">${c.l} <span class="rl">${c.r} | ${a.tot}ops</span></div><div class="tk"><span style="color:${stC};font-weight:bold;font-size:9px">[${st}]</span> ${txt}</div><div class="stat-grid">` +
      `<div class="stat-bar"><span class="sl">CD</span><div class="sb2"><div class="sf" style="width:${Math.min(s.code / mx * 100, 100) | 0}%;background:var(--warm-red)"></div></div><span class="sv">${s.code}</span></div>` +
      `<div class="stat-bar"><span class="sl">RS</span><div class="sb2"><div class="sf" style="width:${Math.min(s.research / mx * 100, 100) | 0}%;background:var(--info)"></div></div><span class="sv">${s.research}</span></div>` +
      `<div class="stat-bar"><span class="sl">NW</span><div class="sb2"><div class="sf" style="width:${Math.min(s.network / mx * 100, 100) | 0}%;background:var(--muted-teal)"></div></div><span class="sv">${s.network}</span></div>` +
      `<div class="stat-bar"><span class="sl">SP</span><div class="sb2"><div class="sf" style="width:${Math.min(s.speed, 99)}%;background:var(--accent-gold)"></div></div><span class="sv">${s.speed}</span></div>` +
      `</div><div class="pw" style="margin-top:3px"><div class="pf" style="width:${_pwB}%;background:${_pwC}"></div></div>${_trHTML}</div></div>`;
  }).join('');
}

// ── Command Panel ──
export function rCmdHTML() {
  let h = '<div class="cmd-area">';
  h += '<div class="cmd-row"><input id="cmdInput" placeholder="명령 입력..." onkeydown="if(event.key===\'Enter\')sendCmd()"><button onclick="sendCmd()">전송</button></div>';
  h += '<div class="quick-cmds">';
  h += '<button class="qc" onclick="quickCmd(\'/status\')">📋 상태</button>';
  h += '<button class="qc" onclick="quickCmd(\'/log\')">📝 로그</button>';
  h += '<button class="qc" onclick="quickCmd(\'/optimize\')">⚡ 최적화</button>';
  h += '<button class="qc" onclick="quickCmd(\'/continue\')">▶ 이어서</button>';
  h += '<button class="qc" onclick="requestStatus()">🔄 새로고침</button>';
  h += '</div>';
  h += '<div id="cmdHist" class="cmd-hist">';
  h += S.cmdHistory.slice(0, 30).map(c => {
    const stCls = c.status === 'completed' ? 'queued' : c.status === 'queued' ? 'queued' : c.status === 'executing' ? 'executing' : c.status === 'rejected' || c.status === 'failed' ? 'rejected' : 'pending';
    const statusIcon = c.status === 'executing' ? '\u2699\ufe0f ' : c.status === 'completed' ? '\u2705 ' : c.status === 'failed' ? '\u274c ' : c.status === 'queued' ? '\ud83d\udccb ' : '\u23f3 ';
    return `<div class="cmd-entry"><span class="ct">${statusIcon}${esc(c.command)}</span><span class="cs ${stCls}">${c.status}${c.reason ? ' : ' + esc(c.reason) : ''}</span><br><span style="color:#8B7860;font-size:9px">${c.ts.toLocaleTimeString('ko-KR')}</span>${c.result ? '<div style="margin-top:3px;padding:4px 6px;background:var(--panel);border:1px solid #D4B896;border-radius:4px;font-size:10px;max-height:80px;overflow:auto;white-space:pre-wrap">' + esc(String(c.result)) + '</div>' : ''}</div>`;
  }).join('');
  h += '</div></div>';
  return h;
}

// ── MCP / Skill Panel ──
export function rMcpHTML() {
  let h = '';

  // MCP Server Status
  h += '<div style="font-size:12px;color:var(--gold-dd);font-weight:bold;margin:4px 0 8px">MCP 서버 상태</div>';
  const maxCalls = Math.max(1, ...MCP_SERVERS.map(s => (S.mcpServerData[s.id] || {}).calls || 0));

  MCP_SERVERS.forEach(s => {
    const data = S.mcpServerData[s.id] || { calls: 0, tools: {}, lastSeen: null };
    const active = data.calls > 0;
    const lastTime = data.lastSeen ? new Date(data.lastSeen).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '없음';
    const barW = maxCalls > 0 ? Math.max(2, (data.calls / maxCalls * 100) | 0) : 0;
    const topTools = Object.entries(data.tools).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, c]) => `${t}(${c})`).join(', ');

    h += `<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;margin-bottom:3px;background:#FFF8E8;border-radius:6px;border-left:4px solid ${active ? 'var(--ok)' : '#CCC'}">`;
    h += `<span style="font-size:16px;width:24px;text-align:center">${s.icon}</span>`;
    h += `<div style="flex:1;min-width:0">`;
    h += `<div style="font-size:11px;font-weight:bold;color:${active ? 'var(--text)' : '#999'}">${s.label} <span style="font-size:9px;font-weight:normal;color:#8B7860">${s.desc}</span></div>`;
    h += `<div style="display:flex;align-items:center;gap:4px;margin-top:2px">`;
    h += `<div style="flex:1;height:6px;background:#E8DCC8;border-radius:3px;overflow:hidden"><div style="height:100%;width:${barW}%;background:${active ? 'var(--ok)' : '#CCC'};border-radius:3px;transition:width .3s"></div></div>`;
    h += `<span style="font-size:10px;color:var(--accent);font-weight:bold;min-width:24px;text-align:right">${data.calls}</span>`;
    h += `</div>`;
    if (topTools) h += `<div style="font-size:9px;color:#8B7860;margin-top:1px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${topTools}</div>`;
    h += `</div>`;
    h += `<span style="font-size:9px;color:#AAA;white-space:nowrap">${lastTime}</span>`;
    h += `</div>`;
  });

  h += `<div style="font-size:10px;color:#8B7860;padding:4px 8px;text-align:right">총 MCP 호출: <b>${S.mcpTotalCalls}</b></div>`;

  // Skill Router Stats
  h += '<div style="font-size:12px;color:var(--gold-dd);font-weight:bold;margin:12px 0 8px">스킬 라우팅</div>';

  if (S.skillTotalRouted > 0) {
    const sortedSkills = Object.entries(S.skillRouteData).sort((a, b) => b[1] - a[1]);
    const maxSkill = Math.max(1, ...sortedSkills.map(s => s[1]));
    sortedSkills.forEach(([name, count]) => {
      const barW = (count / maxSkill * 100) | 0;
      h += `<div class="sb"><span class="n" style="min-width:80px">/${name}</span><div class="b"><div class="f" style="width:${barW}%;background:var(--info)"></div></div><span class="v">${count}</span></div>`;
    });
    h += `<div style="font-size:10px;color:#8B7860;padding:4px 8px;text-align:right">총 라우팅: <b>${S.skillTotalRouted}</b></div>`;
  } else {
    h += `<div style="padding:12px;text-align:center;color:#8B7860;font-size:11px">스킬 라우팅 기록 없음</div>`;
  }

  // Skill Catalog
  h += '<div style="font-size:12px;color:var(--gold-dd);font-weight:bold;margin:12px 0 8px">스킬 카탈로그 (48)</div>';
  h += '<div style="display:flex;flex-wrap:wrap;gap:4px;padding:4px">';
  SKILL_CATEGORIES.forEach(cat => {
    h += `<span style="display:inline-block;padding:3px 8px;border-radius:10px;font-size:10px;font-weight:bold;background:${cat.color}20;color:${cat.color};border:1px solid ${cat.color}40;cursor:pointer" onclick="quickCmd('/${cat.id === 'session' ? 'status' : cat.id === 'quality' ? 'review' : cat.id === 'debug' ? 't-smart-debug' : 'status'}')">${cat.label}</span>`;
  });
  h += '</div>';

  // Quick skill commands
  h += '<div style="font-size:11px;color:var(--gold-dd);font-weight:bold;margin:10px 0 6px">빠른 스킬 실행</div>';
  h += '<div style="display:flex;flex-wrap:wrap;gap:4px">';
  const quickSkills = [
    { cmd: '/review', label: '리뷰', color: '#D4523C' },
    { cmd: '/fix-all', label: '전체수정', color: '#CC3300' },
    { cmd: '/t-smart-debug', label: '디버그', color: '#CC6600' },
    { cmd: '/t-security-scan', label: '보안스캔', color: '#8B6F47' },
    { cmd: '/t-deps-audit', label: '의존성감사', color: '#CCAA22' },
    { cmd: '/deploy', label: '배포', color: '#44AA44' },
    { cmd: '/orchestrate status', label: '오케스트레이션', color: '#6666CC' },
  ];
  quickSkills.forEach(s => {
    h += `<button style="padding:5px 10px;border:2px solid ${s.color};border-radius:8px;background:${s.color}15;color:${s.color};font-size:10px;font-weight:bold;font-family:inherit;cursor:pointer" onclick="quickCmd('${s.cmd}')">${s.label}</button>`;
  });
  h += '</div>';

  return h;
}

// ── DAG Panel ──
export function rDagHTML() {
  if (!S.orchRun || !S.orchRun.dag) {
    return '<div style="text-align:center;color:#8B7860;padding:20px">오케스트레이션 없음<br><small>/orchestrate 로 시작하세요</small></div>';
  }
  const steps = Array.isArray(S.orchRun.dag) ? S.orchRun.dag : S.orchRun.dag.steps || [];
  if (!steps.length) return '<div style="text-align:center;color:#8B7860">스텝 없음</div>';
  const nW = 100, nH = 28, gX = 20, gY = 45;
  const inD = {}; steps.forEach(s => { inD[s.id] = 0; });
  steps.forEach(s => { (s.dependsOn || []).forEach(d => { if (inD[s.id] !== undefined) inD[s.id]++; }); });
  const layers = [], placed = new Set();
  while (placed.size < steps.length) {
    const layer = steps.filter(s => !placed.has(s.id) && (s.dependsOn || []).every(d => placed.has(d)));
    if (!layer.length) break; layers.push(layer); layer.forEach(s => placed.add(s.id));
  }
  const svgW = Math.max(300, layers.reduce((m, l) => Math.max(m, l.length), 0) * (nW + gX));
  const svgH = layers.length * (nH + gY) + 20; const pos = {};
  let svg = '<div class="dag-wrap"><svg width="' + svgW + '" height="' + svgH + '" viewBox="0 0 ' + svgW + ' ' + svgH + '">';
  layers.forEach((layer, li) => {
    const tw = layer.length * (nW + gX) - gX, sx = (svgW - tw) / 2;
    layer.forEach((s, si) => { pos[s.id] = { x: sx + si * (nW + gX) + nW / 2, y: li * (nH + gY) + nH / 2 + 10 }; });
  });
  steps.forEach(s => {
    (s.dependsOn || []).forEach(d => {
      if (pos[d] && pos[s.id]) {
        const f = pos[d], t2 = pos[s.id];
        svg += '<path d="M' + f.x + ',' + (f.y + nH / 2) + ' C' + f.x + ',' + ((f.y + t2.y) / 2) + ' ' + t2.x + ',' + ((f.y + t2.y) / 2) + ' ' + t2.x + ',' + (t2.y - nH / 2) + '" fill="none" stroke="#666" stroke-width="1.5"/>';
      }
    });
  });
  const sc = { pending: '#555', running: '#4488CC', completed: '#44AA44', failed: '#CC3300', skipped: '#888' };
  steps.forEach(s => {
    const p = pos[s.id]; if (!p) return; const c = sc[s.status || 'pending'] || '#555';
    svg += '<g><rect x="' + (p.x - nW / 2) + '" y="' + (p.y - nH / 2) + '" width="' + nW + '" height="' + nH + '" rx="6" fill="' + c + '" stroke="' + c + '" stroke-width="1.5"' + (s.status === 'running' ? ' opacity=".8"' : '') + '/>' +
      '<text x="' + p.x + '" y="' + p.y + '" text-anchor="middle" dominant-baseline="central" fill="#FFF" font-size="10" font-family="inherit">' + (s.name || s.id).slice(0, 12) + '</text></g>';
  });
  svg += '</svg></div>';
  const done = steps.filter(s => s.status === 'completed').length;
  svg += '<div style="text-align:center;font-size:11px;color:var(--gold-dd);margin-top:4px">진행: ' + done + '/' + steps.length + ' | 상태: ' + (S.orchRun.state || '--') + '</div>';
  return svg;
}

// ── Analytics Panel ──
export function rAnalyticsHTML() {
  let h = '';
  // Spark latency + ops + errors
  h += '<div class="analytics-section"><b>ops/min 추이</b>' + drawSparkSvg(S.sparkData.ops, '#44AA44', 280, 40) + '</div>';
  h += '<div class="analytics-section"><b>에러 추이</b>' + drawSparkSvg(S.sparkData.errs, '#CC3300', 280, 30) + '</div>';
  if (S.sparkData.lat.length > 1) h += '<div class="analytics-section"><b>레이턴시 추이</b>' + drawSparkSvg(S.sparkData.lat, '#6666CC', 280, 30) + '</div>';
  // Tool Group distribution
  h += '<div class="analytics-section"><b>도구 그룹 분포</b>';
  const total2 = Object.values(S.groupStats).reduce((s, g) => s + g.total, 0) || 1;
  Object.entries(S.groupStats).forEach(([g, s]) => {
    const p = (s.total / total2 * 100).toFixed(0);
    h += '<div class="sb"><span class="n">' + g + '</span><div class="b"><div class="f" style="width:' + p + '%;background:' + (GROUPS[g] || '#888') + '"></div></div><span class="v">' + s.total + '</span></div>';
  });
  h += '</div>';
  // Heatmap
  h += '<div class="analytics-section"><b>활동 히트맵 (요일×시간)</b>' + renderHeatmapSvg() + '</div>';
  return h;
}

// ══════════════════════════════════════════════════════
// ── COMMAND HISTORY RENDER (in-panel live update) ──
// ══════════════════════════════════════════════════════
export function renderCmdHist() {
  const countEl = document.getElementById('cmdCount');
  if (countEl) countEl.textContent = S.cmdHistory.length;
  const el = document.getElementById('cmdHist');
  if (!el) return;
  el.innerHTML = S.cmdHistory.slice(0, 30).map(c => {
    const stCls = c.status === 'completed' ? 'queued' : c.status === 'queued' ? 'queued' : c.status === 'executing' ? 'executing' : c.status === 'rejected' || c.status === 'failed' ? 'rejected' : 'pending';
    const statusIcon = c.status === 'executing' ? '\u2699\ufe0f ' : c.status === 'completed' ? '\u2705 ' : c.status === 'failed' ? '\u274c ' : c.status === 'queued' ? '\ud83d\udccb ' : '\u23f3 ';
    return `<div class="cmd-entry"><span class="ct">${statusIcon}${esc(c.command)}</span><span class="cs ${stCls}">${c.status}${c.reason ? ' : ' + esc(c.reason) : ''}</span><br><span style="color:#8B7860;font-size:9px">${c.ts.toLocaleTimeString('ko-KR')}</span>${c.result ? '<div style="margin-top:2px;padding:2px 4px;background:#FFF0D0;border:1px solid #D4B896;border-radius:2px;font-size:9px;max-height:60px;overflow:auto;white-space:pre-wrap">' + esc(String(c.result)) + '</div>' : ''}</div>`;
  }).join('');
}

// ══════════════════════════════════════════════════════
// ── MCP TRACKING ──
// ══════════════════════════════════════════════════════
export function trackMcp(entry) {
  const tool = entry.tool || entry.tool_name || '';
  if (tool.startsWith('mcp__')) {
    const parts = tool.split('__');
    if (parts.length >= 3) {
      const server = parts[1], toolName = parts.slice(2).join('__');
      if (!S.mcpServerData[server]) S.mcpServerData[server] = { calls: 0, tools: {}, lastSeen: null };
      S.mcpServerData[server].calls++;
      S.mcpServerData[server].tools[toolName] = (S.mcpServerData[server].tools[toolName] || 0) + 1;
      S.mcpServerData[server].lastSeen = entry.ts || entry.timestamp;
      S.mcpTotalCalls++;
    }
  }
  if (entry.skill_routed) {
    S.skillRouteData[entry.skill_routed] = (S.skillRouteData[entry.skill_routed] || 0) + 1;
    S.skillTotalRouted++;
  }
}

// ══════════════════════════════════════════════════════
// ── THROTTLED UI UPDATE (sUI / uUI) ──
// ══════════════════════════════════════════════════════
export function sUI() {
  if (!S.uiD) {
    S.uiD = true;
    if (!S.uiT) S.uiT = setTimeout(() => { S.uiT = null; S.uiD = false; uUI(); }, 500);
  }
}

export function uUI() {
  const d = S.entries,
    al = d.reduce((a, e) => a + (e.decision === 'allow' ? 1 : 0), 0),
    dn = d.reduce((a, e) => a + (e.decision === 'deny' ? 1 : 0), 0);
  // Top bar stats with delta
  const sTEl = document.getElementById('sT'); if (sTEl) sTEl.textContent = d.length;
  const sAel = document.getElementById('sA'); if (sAel) sAel.textContent = al;
  const deltaEl = document.getElementById('sAd');
  if (deltaEl && d.length > S.prevTotal) {
    const diff = d.length - S.prevTotal;
    deltaEl.textContent = '+' + diff; deltaEl.className = 'delta up';
    setTimeout(() => { deltaEl.textContent = ''; }, 2000);
  }
  S.prevTotal = d.length;
  const sDEl = document.getElementById('sD'); if (sDEl) sDEl.textContent = dn;
  if (S.serverMetrics) {
    const sOEl = document.getElementById('sO'); if (sOEl) sOEl.textContent = S.serverMetrics.opsPerMin || '-';
  }
  const lcEl = document.getElementById('lc'); if (lcEl) lcEl.textContent = d.length;
  const mcEl = document.getElementById('mc');
  if (mcEl && S.serverMetrics) mcEl.textContent = `${S.serverMetrics.opsPerMin || 0}/m`;
  if (S.panelOpen) renderPanel();
}
