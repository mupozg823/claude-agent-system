// ── game-systems.js ── Kairosoft-style game mechanics
// Combo, XP, achievements, events, reputation, RP, facility combos, MCP tracking
import { S, ACHIEVEMENTS, FACILITY_COMBOS, KAIRO_EVENTS } from './state.js';
import { getGameCalendar } from './utils.js';
import { toast, narr } from './ui.js';
import { spawnP, spawnFloatingText, cW, cH, triggerShake } from './renderer-views.js';

// ── Achievements ──
export function checkAchievements() {
  for (const a of ACHIEVEMENTS) {
    if (!S.achievements.includes(a.id) && a.cond()) {
      S.achievements.push(a.id);
      toast('업적 달성: ' + a.name + '!', 'ok');
      spawnP(cW() / 2, cH() / 2, 12, 'success');
      narr('업적 달성! ' + a.name + ' - ' + a.desc, 'agent');
    }
  }
}

// ── Facility Combo System (Kairosoft) ──
export function checkFacilityCombos() {
  const working = S.agents.filter(a => a.st === 'work').map(a => a.t);
  const newCombos = [];
  for (const fc of FACILITY_COMBOS) {
    if (fc.agents.every(a => working.includes(a))) {
      newCombos.push(fc.name);
      if (!S.activeComboNames.includes(fc.name)) {
        // Newly activated combo
        toast('콤보! ' + fc.name + ' (x' + fc.bonus + ')', 'ok');
        narr('시설 콤보 발동: ' + fc.name, 'agent');
        S.facilityComboXP += Math.floor(20 * fc.bonus);
        const cx2 = cW() / 2, cy2 = cH() * .3;
        for (let i = 0; i < 8; i++) spawnP(cx2 + (Math.random() - .5) * 80, cy2, 2, 'success');
        spawnFloatingText(cx2, cy2, fc.name + ' x' + fc.bonus, fc.color);
      }
    }
  }
  S.activeComboNames = newCombos;
}

// ── Combo + XP System ──
export function addCombo(success) {
  if (success) {
    S.combo++;
    if (S.combo > S.maxCombo) S.maxCombo = S.combo;
    clearTimeout(S.comboTimer);
    S.comboTimer = setTimeout(() => { S.combo = 0; }, 5000);
    const xpGain = Math.floor((10 + S.combo * 2) * S.eventXPMultiplier);
    S.totalXP += xpGain;
    // Floating XP text (every 3rd success to avoid spam)
    if (S.combo % 3 === 1 || S.combo >= 5) {
      const fx = cW() * .1 + Math.random() * cW() * .8;
      const fy = cH() * .3 + Math.random() * cH() * .2;
      spawnFloatingText(fx, fy, '+' + xpGain + ' XP',
        S.combo >= 10 ? '#FF4444' : S.combo >= 5 ? '#FFAA22' : '#88BBFF',
        S.combo >= 5 ? 14 : 11);
    }
    // Check facility combos every 5 successes
    if (S.combo % 5 === 0 || S.combo === 1) checkFacilityCombos();
    if (S.combo >= 5 && S.combo % 5 === 0) {
      toast(S.combo + '콤보!', 'ok');
      spawnP(cW() / 2, cH() * .4, 6 + S.combo, 'success');
    }
    // Level up check
    const newLvl = Math.floor(S.totalXP / 500) + 1;
    if (newLvl > S.prevLevel) {
      S.prevLevel = newLvl;
      toast('LEVEL UP! Lv.' + newLvl, 'ok');
      triggerShake(3);
      for (let i = 0; i < 20; i++) spawnP(cW() * Math.random(), cH() * Math.random(), 5, 'success');
      spawnFloatingText(cW() / 2, cH() * .25, 'LEVEL UP!', '#FFD080', 22);
      spawnFloatingText(cW() / 2, cH() * .32, 'Lv.' + newLvl, '#FFFFFF', 18);
      // All agents celebrate
      S.agents.forEach(a => { a.compFx = 20; });
    }
    // Random agent joy bounce on success
    const joyAg = S.agents[Math.floor(Math.random() * S.agents.length)];
    if (joyAg && joyAg.st === 'work') joyAg.compFx = Math.max(joyAg.compFx || 0, 8);
  } else {
    S.combo = 0;
  }
  checkAchievements();
}

// ── Research Points (RP) System (Kairosoft) ──
export function addRP(amount, source) {
  S.totalRP += amount;
  S.rpHistory.push({ t: Date.now(), a: amount, s: source });
  if (S.rpHistory.length > 200) S.rpHistory.shift();
  // RP per minute calculation
  const now = Date.now();
  const window_ = S.rpHistory.filter(r => now - r.t < 60000);
  S.rpPerMin = window_.reduce((s, r) => s + r.a, 0);
}

// ── Satisfaction / Reputation Meter (Kairosoft) ──
export function updateReputation() {
  const total = S.entries.length || 1;
  const errors = S._localErrors || 0;
  const errorRate = errors / total;
  const comboFactor = Math.min(S.maxCombo / 20, 1);
  const opsFactor = Math.min((S.serverMetrics && S.serverMetrics.opsPerMin || 0) / 50, 1);
  const rpFactor = Math.min(S.rpPerMin / 30, 1);
  // 1~5 star score
  S.reputation = Math.max(1, Math.min(5,
    3.0 + comboFactor * 1.0 + opsFactor * 0.5 + rpFactor * 0.5 - errorRate * 3.0
  ));
  S.reputation = Math.round(S.reputation * 10) / 10;
}

// ── Kairosoft Event System ──
export function checkKairoEvent() {
  const now = Date.now();
  if (now - S.lastEventCheck < 30000) return; // 30sec interval
  S.lastEventCheck = now;
  if (S.activeEvent) return; // event already in progress
  const cal = getGameCalendar();
  // 15% chance per check
  if (Math.random() < 0.15) {
    const ev = KAIRO_EVENTS[Math.floor(Math.random() * KAIRO_EVENTS.length)];
    S.activeEvent = { ...ev, start: now, endsAt: now + ev.duration * 1000 };
    S.eventTimer = ev.duration;
    S.eventLog.push({ event: ev.name, time: cal.label });
    if (S.eventLog.length > 20) S.eventLog.shift();
    // Apply event effects
    if (ev.effect === 'xp_boost') S.eventXPMultiplier = 2;
    else if (ev.effect === 'rp_boost') S.eventRPMultiplier = 3;
    else if (ev.effect === 'morale') S.agents.forEach(a => { a.pw = 100; a.compFx = 15; });
    else if (ev.effect === 'reputation') S.reputation = Math.min(5, S.reputation + 0.5);
    // Show popup
    S.eventPopup = { event: ev, alpha: 1, y: 0 };
    toast('EVENT: ' + ev.name, 'in');
    narr(ev.name + ' - ' + ev.desc, 'agent');
    spawnFloatingText(cW() / 2, cH() * .2, ev.name, ev.color, 18);
    for (let i = 0; i < 12; i++) spawnP(cW() * Math.random(), cH() * .3, 3, 'success');
  }
}

// ── Event Timer Update ──
export function updateEvent() {
  if (!S.activeEvent) return;
  const now = Date.now();
  S.eventTimer = Math.max(0, Math.floor((S.activeEvent.endsAt - now) / 1000));
  if (now >= S.activeEvent.endsAt) {
    // Event ended
    S.eventXPMultiplier = 1;
    S.eventRPMultiplier = 1;
    toast(S.activeEvent.name + ' 종료!', 'in');
    S.activeEvent = null;
    S.eventTimer = 0;
  }
  if (S.eventPopup) {
    S.eventPopup.y += 0.3;
    S.eventPopup.alpha -= 0.005;
    if (S.eventPopup.alpha <= 0) S.eventPopup = null;
  }
}

// ── MCP / Skill Route Tracking ──
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
