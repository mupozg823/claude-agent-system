// ── renderer-views.js ── Game loop, HUD, building view, weather, floor system
import { S, C, FLOORS, DESKS, AT, TOOL_COLORS } from './state.js';
import { getSessionLabel, getDayPhase, getActivityStatus, getActivityIntensity } from './utils.js';
import { cW, cH, buildBg, drawCh, drawActiveScreen, spawnP, drawPts, updateFloatingTexts, spawnFloatingText, triggerShake, getParticleTexture } from './renderer-core.js';

// Re-export from core for other modules
export { cW, cH, buildBg, drawCh, drawActiveScreen, spawnP, drawPts, updateFloatingTexts, spawnFloatingText, triggerShake, getParticleTexture };
export { initCanvas } from './renderer-core.js';

// ── (Game tick removed — operational mode) ──

// ── Day phase overlay init ──
export function initWeatherOverlay() {
  if (!S.pixiReady) return;
  const overlay = new PIXI.Graphics();
  S.L.weather.addChild(overlay);
  S._dayOverlay = overlay;
}

// ── Day phase overlay (minimal — no seasonal weather) ──
function drawDayOverlay(w, h) {
  const phase = getDayPhase();
  if (S.pixiReady && S._dayOverlay) {
    S._dayOverlay.clear();
    if (phase === 'evening') S._dayOverlay.rect(0, 0, w, h).fill({ color: 0xFF8800, alpha: 0.03 });
    else if (phase === 'night') S._dayOverlay.rect(0, 0, w, h).fill({ color: 0x000022, alpha: 0.04 });
    else if (phase === 'morning') S._dayOverlay.rect(0, 0, w, h).fill({ color: 0xFFE8B0, alpha: 0.02 });
  } else {
    const cx = S.cx;
    if (phase === 'evening') { cx.fillStyle = '#FF880008'; cx.fillRect(0, 0, w, h); }
    else if (phase === 'night') { cx.fillStyle = '#0000220A'; cx.fillRect(0, 0, w, h); }
    else if (phase === 'morning') { cx.fillStyle = '#FFE8B005'; cx.fillRect(0, 0, w, h); }
  }
  // Activity sparkle particles only
  const status = getActivityStatus();
  if (status === 'active' && Math.random() < .04) {
    S.weatherParticles.push({ x: Math.random() * w, y: Math.random() * h * .3, vx: 0, vy: 0, l: 40 + Math.random() * 30, type: 'sparkle', r: Math.random() * 6.28, sprite: null });
  }
  // Update remaining particles
  S.weatherParticles = S.weatherParticles.filter(p => {
    p.x += (p.vx || 0); p.y += (p.vy || 0); p.l--;
    if (p.l <= 0 || p.y > h || p.x > w + 60) { if (p.sprite) { p.sprite.destroy(); p.sprite = null; } return false; }
    const alpha = Math.min(p.l / 20, 1);
    if (S.pixiReady && S.L.weather) {
      if (!p.sprite) { const g = new PIXI.Graphics(); S.L.weather.addChild(g); p.sprite = g; }
      const g = p.sprite; g.clear();
      if (p.type === 'sparkle') { p.r += .05; g.rect(p.x + Math.cos(p.r) * 2 - 1, p.y - 1, 2, 2).fill({ color: 0xFFE8B0, alpha: alpha * .4 }); g.rect(p.x - 1, p.y + Math.sin(p.r) * 2 - 1, 2, 2).fill({ color: 0xFFE8B0, alpha: alpha * .4 }); }
    } else {
      const cx = S.cx;
      if (p.type === 'sparkle') { p.r += .05; cx.globalAlpha = alpha * .4; cx.fillStyle = '#FFE8B0'; cx.fillRect(p.x + Math.cos(p.r) * 2 - 1, p.y - 1, 2, 2); cx.fillRect(p.x - 1, p.y + Math.sin(p.r) * 2 - 1, 2, 2); cx.globalAlpha = 1; }
    }
    return true;
  });
}

// ── Operational HUD ──
function drawHUD(w, h) {
  const agents = S.agents;
  let hx;
  if (S.pixiReady) {
    if (!S.hudCanvas || !S.hudCx) return;
    const hudLogW = Math.min(250, w), hudLogH = 110;
    S.hudCanvas.width = hudLogW * S.dpr; S.hudCanvas.height = hudLogH * S.dpr;
    S.hudCx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    S.hudCx.clearRect(0, 0, hudLogW, hudLogH);
    hx = S.hudCx;
  } else { hx = S.cx; }
  let ac = 0; agents.forEach(a => { if (a.st === 'work') ac++; });
  if (ac !== S.hudPrev) { S.hudWait = 0; S.hudPrev = ac; } else if (S.hudWait < 31) S.hudWait++;
  if (S.hudWait >= 30) S.hudShow = S.hudPrev;

  const m = S.serverMetrics;
  const hudW2 = 220;
  const hasOrch = S.orchRun && S.orchRun.state && S.orchRun.state !== 'done' && S.orchRun.state !== 'failed';
  const hudH2 = 80 + (hasOrch ? 12 : 0);
  const xpX = 5;

  // Background
  hx.fillStyle = '#000000AA'; hx.fillRect(4, 4, hudW2, hudH2);
  hx.fillStyle = '#1A1A3A'; hx.fillRect(5, 5, hudW2 - 2, hudH2 - 2);
  hx.fillStyle = '#8B6914'; hx.fillRect(5, 5, hudW2 - 2, 2); hx.fillRect(5, 3 + hudH2, hudW2 - 2, 2);

  // Online indicator + time
  hx.fillStyle = S.agentOnline ? '#44CC44' : '#CC0000'; hx.fillRect(8, 8, 6, 6);
  hx.fillStyle = '#FFF'; hx.font = '8px monospace'; hx.textAlign = 'left'; hx.fillText(S.agentOnline ? 'ON' : 'OFF', 16, 13);
  const sess = getSessionLabel();
  hx.font = 'bold 9px monospace'; hx.textAlign = 'right'; hx.fillStyle = '#88BBDD'; hx.fillText(sess.label, hudW2 - 4, 14);

  // Active agents + ops/min
  hx.textAlign = 'left'; hx.font = 'bold 13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
  if (S.hudShow > 0) { hx.fillStyle = '#FF6644'; hx.fillRect(8, 18, 12, 12); hx.fillStyle = '#FFD080'; hx.fillText(S.hudShow + '\uBA85 \uC791\uC5C5 \uC911', 24, 29); }
  else { hx.fillStyle = '#88AACC'; hx.fillText('\uB300\uAE30 \uC911', 8, 29); }
  if (m && m.opsPerMin) { hx.fillStyle = '#6688AA'; hx.fillRect(134, 18, 1, 14); hx.fillStyle = '#88BBDD'; hx.font = 'bold 11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'; hx.fillText(m.opsPerMin + ' ops/m', 140, 29); }

  // Success rate bar
  const total = S.entries.length || 1;
  const errs = S._localErrors || 0;
  const successRate = Math.max(0, ((total - errs) / total * 100) | 0);
  const srW = 100, srH = 5, srY = 33;
  hx.fillStyle = '#222'; hx.fillRect(xpX, srY, srW, srH);
  const srG = hx.createLinearGradient(xpX, 0, xpX + srW * successRate / 100, 0);
  srG.addColorStop(0, successRate > 90 ? '#44AA44' : '#FF4444'); srG.addColorStop(1, successRate > 90 ? '#66CC66' : '#FF8844');
  hx.fillStyle = srG; hx.fillRect(xpX, srY, srW * successRate / 100, srH);
  hx.fillStyle = '#CCC'; hx.font = 'bold 8px monospace'; hx.fillText(successRate + '% \uC131\uACF5', srW + 8, srY + 5);

  // Activity intensity bar
  const intensity = getActivityIntensity();
  const aiY = srY + 8, aiW = srW, aiH = 3;
  hx.fillStyle = '#222'; hx.fillRect(xpX, aiY, aiW, aiH);
  const aiG = hx.createLinearGradient(xpX, 0, xpX + aiW * intensity, 0);
  if (intensity > .7) { aiG.addColorStop(0, '#FF4444'); aiG.addColorStop(1, '#FF8844'); }
  else if (intensity > .3) { aiG.addColorStop(0, '#FFAA22'); aiG.addColorStop(1, '#FFDD44'); }
  else { aiG.addColorStop(0, '#44AA44'); aiG.addColorStop(1, '#66CC66'); }
  hx.fillStyle = aiG; hx.fillRect(xpX, aiY, aiW * intensity, aiH);
  hx.fillStyle = '#888'; hx.font = '8px monospace'; hx.fillText(S.activityHistory.length + 'ops', aiW + 8, aiY + 3);

  // Mini sparkline
  const slY = aiY + 6, slH = 12, slW = aiW;
  hx.fillStyle = '#1A1A2A88'; hx.fillRect(xpX, slY, slW, slH);
  const now2 = Date.now(), bins = 15, binW2 = slW / bins;
  const binCounts = new Array(bins).fill(0);
  for (const t of S.activityHistory) { const ago = (now2 - t) / 1000; if (ago < 30) { const bi = Math.min(Math.floor(ago / 2), bins - 1); binCounts[bins - 1 - bi]++; } }
  const maxBin = Math.max(...binCounts, 1);
  for (let i = 0; i < bins; i++) { const bh = (binCounts[i] / maxBin) * slH; hx.fillStyle = binCounts[i] > 3 ? '#FF884488' : binCounts[i] > 1 ? '#44AA4488' : '#FFFFFF22'; hx.fillRect(xpX + i * binW2, slY + slH - bh, binW2 - 1, bh); }

  // Pipeline stats line
  let extraY = slY + slH + 3;
  const ps = S.pipelineStatus;
  hx.fillStyle = '#888'; hx.font = 'bold 8px monospace'; hx.textAlign = 'left';
  hx.fillText('ERR:' + errs + '  DENY:' + ps.denies + '  TOOLS:' + total, xpX, extraY + 5); extraY += 9;

  // Current tool
  if (ps.lastTool) {
    const lastCmd = S.toolStats[ps.lastTool]?.lastCmd || '';
    hx.fillStyle = '#44DD66'; hx.font = 'bold 8px monospace';
    hx.fillText('\u25B6 ' + ps.lastTool + ': ' + lastCmd.slice(0, 28), xpX, extraY + 5); extraY += 9;
  }

  // Orchestration progress
  if (hasOrch) {
    const oTotal = S.orchRun.total || 1, oDone = S.orchRun.done || 0, oW2 = srW, oH2 = 4;
    hx.fillStyle = '#222'; hx.fillRect(xpX, extraY, oW2, oH2);
    const oPct = Math.min(oDone / oTotal, 1);
    const oG = hx.createLinearGradient(xpX, 0, xpX + oW2 * oPct, 0); oG.addColorStop(0, '#CC6600'); oG.addColorStop(1, '#FFAA44');
    hx.fillStyle = oG; hx.fillRect(xpX, extraY, oW2 * oPct, oH2);
    hx.fillStyle = '#FFD080'; hx.font = 'bold 8px monospace'; hx.fillText('DAG ' + oDone + '/' + oTotal, xpX + oW2 + 4, extraY + 4);
  }

  if (S.pixiReady && S.hudSprite) {
    if (S.hudSprite._tex) S.hudSprite._tex.destroy(true);
    S.hudSprite._tex = PIXI.Texture.from(S.hudCanvas); S.hudSprite.texture = S.hudSprite._tex; S.hudSprite.x = 0; S.hudSprite.y = 0;
    S.hudSprite.scale.set(1 / S.dpr);
  }
}

// ── Building Cross-Section View ──
function renderBuildingView(w, h) {
  if (!S.pixiReady) return;
  if (!S.buildingCanvas) { S.buildingCanvas = document.createElement('canvas'); S.buildingCx2 = S.buildingCanvas.getContext('2d'); }
  S.buildingCanvas.width = w; S.buildingCanvas.height = h;
  const bx = S.buildingCx2, fr = S.fr, agents = S.agents;
  bx.clearRect(0, 0, w, h);
  const phase = getDayPhase(), isNight = phase === 'night', isEvening = phase === 'evening';
  const skyG = bx.createLinearGradient(0, 0, 0, h * .85);
  if (isNight) { skyG.addColorStop(0, '#0A0A2A'); skyG.addColorStop(1, '#2A2A4A'); }
  else if (isEvening) { skyG.addColorStop(0, '#2A1A4A'); skyG.addColorStop(.5, '#CC6644'); skyG.addColorStop(1, '#FFD8A0'); }
  else { skyG.addColorStop(0, '#4488CC'); skyG.addColorStop(1, '#AACCEE'); }
  bx.fillStyle = skyG; bx.fillRect(0, 0, w, h * .85);
  if (isNight) { bx.fillStyle = '#FFF'; for (let i = 0; i < 15; i++) { const sx2 = ((i * 37 + fr * .02) % 1) * w, sy2 = ((i * 53 + i * 17) % 1) * h * .5; bx.globalAlpha = Math.sin(fr * .05 + i * 2) * .3 + .4; bx.fillRect(sx2, sy2, 1.5, 1.5); } bx.globalAlpha = 1; }
  bx.fillStyle = '#8B9E6B'; bx.fillRect(0, h * .85, w, h * .15); bx.fillStyle = '#A0A0A0'; bx.fillRect(0, h * .87, w, h * .06);
  const bL = w * .1, bR = w * .9, bW = bR - bL, groundY = h * .85, roofY = h * .06, totalH = groundY - roofY, flH = totalH / 3.3, margin = 2, startY = groundY - flH * 3 - margin * 2;
  bx.fillStyle = '#8A7A6A'; bx.fillRect(bL, startY, 4, groundY - startY); bx.fillStyle = '#9A8A7A'; bx.fillRect(bR - 4, startY, 4, groundY - startY);
  bx.fillStyle = '#7A6A5A'; bx.fillRect(bL - 4, startY - 8, bW + 8, 10);
  for (let rx = bL; rx < bR; rx += 12) { bx.fillStyle = '#8A8A8A'; bx.fillRect(rx, startY - 16, 2, 8); bx.fillRect(rx, startY - 16, 12, 2); }
  const signW = bW * .55, signX = bL + (bW - signW) / 2, signY = startY - 32;
  bx.fillStyle = '#1A1A3A'; bx.fillRect(signX, signY, signW, 18); bx.strokeStyle = '#8B6914'; bx.lineWidth = 1.5; bx.strokeRect(signX, signY, signW, 18);
  bx.fillStyle = `rgba(255,208,128,${.7 + Math.sin(fr * .08) * .3})`; bx.font = 'bold 11px -apple-system,sans-serif'; bx.textAlign = 'center'; bx.fillText('\uC5D0\uC774\uC804\uD2B8 \uAC1C\uBC1C\uAD6D', bL + bW / 2, signY + 13);
  bx.fillStyle = '#666'; bx.fillRect(bL + bW * .5 - 1, startY - 48, 3, 18);
  if (fr % 40 < 20) { bx.fillStyle = '#FF000060'; bx.beginPath(); bx.arc(bL + bW * .5 + .5, startY - 50, 4, 0, 6.28); bx.fill(); }
  const eX = bR - bW * .12, eW2 = bW * .08;
  bx.fillStyle = '#2A2A3A'; bx.fillRect(eX, startY, eW2, groundY - startY);
  bx.fillStyle = '#4A4A5A'; bx.fillRect(eX + 1, startY, 1.5, groundY - startY); bx.fillRect(eX + eW2 - 2.5, startY, 1.5, groundY - startY);
  const eCabY = startY + (groundY - startY) * .5 + Math.sin(fr * .02) * (groundY - startY) * .2;
  bx.fillStyle = '#8888AA'; bx.fillRect(eX + 2, eCabY - 6, eW2 - 4, 12);
  const entX = bL + bW * .4, entW = bW * .2;
  bx.fillStyle = '#CC6600'; bx.fillRect(entX - 4, groundY - 14, entW + 8, 3); bx.fillStyle = '#4A3A2A'; bx.fillRect(entX, groundY - 11, entW, 11);
  bx.fillStyle = '#FFD080'; bx.fillRect(entX + entW / 2 - 5, groundY - 6, 3, 1.5); bx.fillRect(entX + entW / 2 + 2, groundY - 6, 3, 1.5);
  [[bL - 18, groundY], [bR + 10, groundY]].forEach(([tx, ty]) => { bx.fillStyle = '#5A3A1A'; bx.fillRect(tx, ty - 14, 3, 14); bx.fillStyle = '#3A8A3A'; bx.beginPath(); bx.arc(tx + 1.5, ty - 18, 8, 0, 6.28); bx.fill(); bx.fillStyle = '#4A9A4A'; bx.beginPath(); bx.arc(tx + 4, ty - 20, 6, 0, 6.28); bx.fill(); });
  S.buildingFloorHits = [];
  for (let fi = 2; fi >= 0; fi--) {
    const fl = FLOORS[fi], fc = fl.colors, fy2 = startY + (2 - fi) * (flH + margin), flL = bL + 4, flR = eX - 2, flW = flR - flL;
    S.buildingFloorHits.push({ fi, x: flL, y: fy2, w: flW, h: flH });
    const wg = bx.createLinearGradient(0, fy2, 0, fy2 + flH); wg.addColorStop(0, fc.wall[0]); wg.addColorStop(.7, fc.wall[1]); wg.addColorStop(1, fc.wall[2] || fc.wall[1]);
    bx.fillStyle = wg; bx.fillRect(flL, fy2, flW, flH);
    const fg = bx.createLinearGradient(0, fy2 + flH * .78, 0, fy2 + flH); fg.addColorStop(0, fc.floor[0]); fg.addColorStop(1, fc.floor[1]);
    bx.fillStyle = fg; bx.fillRect(flL, fy2 + flH * .78, flW, flH * .22);
    bx.fillStyle = '#6B4E00'; bx.fillRect(flL, fy2 + flH - 2, flW, 3); bx.fillStyle = '#00000015'; bx.fillRect(flL, fy2, flW, 2);
    for (let wi = 0; wi < 4; wi++) { const wx = flL + flW * .08 + wi * (flW * .22), wy = fy2 + flH * .15, ww = flW * .1, wh = flH * .3; bx.fillStyle = '#5A4A3A'; bx.fillRect(wx - 1, wy - 1, ww + 2, wh + 2); bx.fillStyle = isNight ? (agents.some(a => a.floor === fi && a.st === 'work') ? '#FFE8A060' : '#333850') : '#88BBEE50'; bx.fillRect(wx, wy, ww, wh); bx.fillStyle = '#5A4A3A'; bx.fillRect(wx + ww / 2 - .5, wy, 1, wh); bx.fillRect(wx, wy + wh / 2 - .5, ww, 1); }
    const lx = flL + flW * .5; bx.fillStyle = '#888'; bx.fillRect(lx - 6, fy2 + 2, 12, 2); bx.fillStyle = fc.accent; bx.fillRect(lx - 5, fy2 + 4, 10, 1.5);
    if (agents.some(a => a.floor === fi && a.st === 'work')) { bx.fillStyle = fc.accent + '18'; bx.fillRect(lx - 25, fy2 + 4, 50, flH * .35); }
    if (fi === S.currentFloor) { bx.strokeStyle = '#FFD080'; bx.lineWidth = 2; bx.strokeRect(flL - 1, fy2 - 1, flW + 2, flH + 2); bx.fillStyle = '#FFD080'; bx.beginPath(); bx.moveTo(flL - 7, fy2 + flH / 2); bx.lineTo(flL - 1, fy2 + flH / 2 - 4); bx.lineTo(flL - 1, fy2 + flH / 2 + 4); bx.fill(); }
    const wc = agents.filter(a => a.floor === fi && a.st === 'work').length;
    if (wc > 0) { const pulse = Math.sin(fr * .08) * .06 + .08; bx.fillStyle = fc.accent + Math.floor(pulse * 255).toString(16).padStart(2, '0'); bx.fillRect(flL, fy2, flW, flH); }
    bx.fillStyle = '#00000070'; bx.fillRect(flL + 3, fy2 + 2, 72, 13); bx.fillStyle = fc.accent; bx.font = 'bold 9px -apple-system,sans-serif'; bx.textAlign = 'left'; bx.fillText(fl.nameKo, flL + 5, fy2 + 12);
    DESKS.forEach((d, di) => { if (d.floor !== fi) return; const dx2 = flL + d.x * flW, dy2 = fy2 + flH * .6; bx.fillStyle = '#B08858'; bx.fillRect(dx2 - 8, dy2, 16, 4); bx.fillStyle = '#9A7848'; bx.fillRect(dx2 - 7, dy2 + 4, 3, 3); bx.fillRect(dx2 + 4, dy2 + 4, 3, 3); bx.fillStyle = '#333'; bx.fillRect(dx2 - 4, dy2 - 8, 8, 7); bx.fillStyle = d.act ? C[AT[di]].s + '90' : '#0A0A2A'; bx.fillRect(dx2 - 3, dy2 - 7, 6, 5); bx.fillStyle = '#8B7860'; bx.font = '7px -apple-system,sans-serif'; bx.textAlign = 'center'; bx.fillText(d.label, dx2, dy2 + 12); });
    agents.filter(a => a.floor === fi).forEach(a => { const ax = flL + a.x * flW, ay = fy2 + a.y * flH * .55 + flH * .25, cc = C[a.t], ms = 1.8, bob = a.st === 'work' ? Math.sin(fr * .12 + a.i) * .6 : 0; bx.fillStyle = '#00000018'; bx.beginPath(); bx.ellipse(ax, ay + 4 * ms, 3 * ms, 1 * ms, 0, 0, 6.28); bx.fill(); bx.fillStyle = cc.s; bx.fillRect(ax - 2 * ms, ay + bob, 4 * ms, 3.5 * ms); bx.fillStyle = '#FFD8B0'; bx.fillRect(ax - 2.5 * ms, ay - 3 * ms + bob, 5 * ms, 3.5 * ms); bx.fillStyle = cc.h; bx.fillRect(ax - 2.7 * ms, ay - 3.5 * ms + bob, 5.4 * ms, 1.8 * ms); if (a.st === 'work') { bx.fillStyle = cc.s + '60'; bx.beginPath(); bx.arc(ax, ay - 4 * ms + bob, 3 * ms, .3, -.3, true); bx.fill(); } });
    bx.fillStyle = fi === S.currentFloor ? '#FFD080' : '#555'; bx.fillRect(eX - 1, fy2 + flH / 2 - 1, 2, 2); bx.font = '6px monospace'; bx.textAlign = 'right'; bx.fillText((fi + 1) + 'F', eX - 3, fy2 + flH / 2 + 2);
  }
  S.elevatorPackets = S.elevatorPackets.filter(p => { p.progress += p.speed; if (p.progress >= 1) return false; const fromY = startY + (2 - p.from) * (flH + margin) + flH / 2, toY = startY + (2 - p.to) * (flH + margin) + flH / 2, py = fromY + (toY - fromY) * p.progress; bx.fillStyle = p.color; bx.fillRect(eX + eW2 / 2 - 2, py - 2, 4, 4); bx.fillStyle = p.color + '40'; bx.beginPath(); bx.arc(eX + eW2 / 2, py, 6, 0, 6.28); bx.fill(); return true; });
  if (S.bgSprite) { if (S.bgSprite._tex) S.bgSprite._tex.destroy(true); S.bgSprite._tex = PIXI.Texture.from(S.buildingCanvas); S.bgSprite.texture = S.bgSprite._tex; S.bgSprite.width = w; S.bgSprite.height = h; }
}

// ── Game Loop (PixiJS) ──
function gameLoop() {
  const w = cW(), h = cH(); if (w < 10 || h < 10) return;
  if (!S.bg || S.bgW !== w || S.bgH !== h) {
    const bgBuf = document.createElement('canvas'); bgBuf.width = w; bgBuf.height = h;
    const prevBuf = S.buf, prevCx = S.cx; S.buf = bgBuf; S.cx = bgBuf.getContext('2d');
    buildBg(w, h); S.buf = prevBuf; S.cx = prevCx;
    if (S.bgSprite._tex) S.bgSprite._tex.destroy(true); S.bgSprite._tex = PIXI.Texture.from(S.bg);
    S.bgSprite.texture = S.bgSprite._tex; S.bgSprite.width = w; S.bgSprite.height = h;
  }
  // Floor transition animation (PixiJS)
  if (S.floorTransition) {
    const ft = S.floorTransition;
    ft.progress = Math.min((performance.now() - ft.startTime) / 400, 1);
    ft.eased = 1 - (1 - ft.progress) * (1 - ft.progress);
    if (!ft.fromSprite && ft.fromBg && S.L.bg) {
      ft.fromSprite = new PIXI.Sprite(PIXI.Texture.from(ft.fromBg));
      ft.fromSprite.width = w; ft.fromSprite.height = h;
      S.L.bg.addChild(ft.fromSprite);
    }
    if (ft.fromSprite) ft.fromSprite.y = ft.dir * ft.eased * h;
    S.bgSprite.y = -ft.dir * (1 - ft.eased) * h;
    if (S.L.effects) {
      if (!ft._divLine) { ft._divLine = new PIXI.Graphics(); S.L.effects.addChild(ft._divLine); }
      const bndY = ft.dir > 0 ? ft.eased * h : (1 - ft.eased) * h;
      ft._divLine.clear().rect(0, bndY - 1, w, 2).fill({ color: 0xFFD080, alpha: 0.4 * (1 - ft.eased) });
    }
    if (ft.progress >= 1) finishFloorTransition();
  }
  if (S.shakeFrames > 0) { S.pixiApp.stage.x = (Math.random() - .5) * S.shakeIntensity; S.pixiApp.stage.y = (Math.random() - .5) * S.shakeIntensity; S.shakeFrames--; }
  else { S.pixiApp.stage.x = 0; S.pixiApp.stage.y = 0; }
  drawDayOverlay(w, h);
  const agents = S.agents;
  if (S.viewMode === 'building') {
    renderBuildingView(w, h); updateFloorBadges(); agents.forEach(a => a.up());
    DESKS.forEach((d, i) => { if (S.deskSprites[i]) S.deskSprites[i].visible = false; });
    agents.forEach(a => { if (S.agentSprites[a.i]) S.agentSprites[a.i].visible = false; });
  } else {
    const fy = h * .55;
    DESKS.forEach((d, i) => { const onFloor = d.floor === S.currentFloor; if (d.act && S.deskSprites[i] && onFloor) { const dc = S.deskCanvases[i], s = S.P, sx2 = 6.4 * s, sy2 = 5.8 * s; dc.width = Math.ceil(sx2 * S.dpr); dc.height = Math.ceil(sy2 * S.dpr); const prevBuf = S.buf, prevCx = S.cx; S.buf = dc; S.cx = dc.getContext('2d'); S.cx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0); const dsx = d.x * w, sxOff = -dsx + 3.2 * s, syOff = -(fy + 2) + 7.5 * s; S.cx.save(); S.cx.translate(sxOff, syOff); drawActiveScreen(dsx, fy, AT[i]); S.cx.restore(); S.buf = prevBuf; S.cx = prevCx; if (S.deskSprites[i]._tex) S.deskSprites[i]._tex.destroy(true); S.deskSprites[i]._tex = PIXI.Texture.from(dc); S.deskSprites[i].texture = S.deskSprites[i]._tex; S.deskSprites[i].x = d.x * w - 3.2 * s; S.deskSprites[i].y = fy + 2 - 7.5 * s; S.deskSprites[i].visible = true; S.deskSprites[i].alpha = S.floorTransition ? S.floorTransition.eased : 1; S.deskSprites[i].scale.set(1 / S.dpr); } else if (S.deskSprites[i]) { S.deskSprites[i].visible = false; } });
    agents.forEach(a => a.up()); agents.sort((a, b) => a.y - b.y); updateFloorBadges();
    agents.forEach((a) => { const onFloor = a.floor === S.currentFloor, ac = S.agentCanvases[a.i]; if (!ac) return; const sp = S.agentSprites[a.i]; if (!onFloor) { if (sp) sp.visible = false; return; } const aw = 110, ah = 120; ac.width = aw * S.dpr; ac.height = ah * S.dpr; const prevBuf = S.buf, prevCx = S.cx; S.buf = ac; S.cx = ac.getContext('2d'); S.cx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0); S.cx.clearRect(0, 0, aw, ah); drawCh(aw / 2, ah * .65, a.t, a.wf, a.d, a.st === 'work', a.st === 'work' ? a.tk : '', a); S.buf = prevBuf; S.cx = prevCx; if (sp) { if (sp._tex) sp._tex.destroy(true); sp._tex = PIXI.Texture.from(ac); sp.texture = sp._tex; sp.anchor.set(0.5, 0.65); sp.x = a.x * w; sp.y = a.y * h; sp.zIndex = Math.floor(a.y * 1000); sp.visible = true; sp.alpha = S.floorTransition ? S.floorTransition.eased : 1; sp.scale.set(1 / S.dpr); } });
  }
  drawPts(); updateFloatingTexts(); drawHUD(w, h); S.fr++;
}

// ── Canvas 2D fallback render ──
function render(ts) {
  requestAnimationFrame(render);
  if (ts - S.lastRender < 33) return; S.lastRender = ts;
  const w = cW(), h = cH(); if (w < 10 || h < 10) return;
  if (!S.bg || S.bgW !== w || S.bgH !== h) buildBg(w, h);
  let sx = 0, sy = 0;
  if (S.shakeFrames > 0) { sx = (Math.random() - .5) * S.shakeIntensity; sy = (Math.random() - .5) * S.shakeIntensity; S.shakeFrames--; }
  const cx = S.cx; cx.save(); cx.translate(sx, sy);
  if (S.floorTransition) {
    const ft = S.floorTransition;
    ft.progress = Math.min((performance.now() - ft.startTime) / 400, 1);
    ft.eased = 1 - (1 - ft.progress) * (1 - ft.progress);
    if (ft.fromBg) cx.drawImage(ft.fromBg, 0, 0, ft.fromBg.width, ft.fromBg.height, 0, ft.dir * ft.eased * h, w, h);
    cx.drawImage(S.bg, 0, 0, S.bg.width, S.bg.height, 0, -ft.dir * (1 - ft.eased) * h, w, h);
    const bndY = ft.dir > 0 ? ft.eased * h : (1 - ft.eased) * h;
    cx.globalAlpha = 0.4 * (1 - ft.eased); cx.fillStyle = '#FFD080'; cx.fillRect(0, bndY - 1, w, 2); cx.globalAlpha = 1;
    if (ft.progress >= 1) finishFloorTransition();
  } else {
    cx.drawImage(S.bg, 0, 0, S.bg.width, S.bg.height, 0, 0, w, h);
  }
  drawDayOverlay(w, h);
  const fy = h * .55;
  if (S.floorTransition) cx.globalAlpha = S.floorTransition.eased;
  DESKS.forEach((d, i) => { if (d.act && d.floor === S.currentFloor) drawActiveScreen(d.x * w, fy, AT[i]); });
  S.agents.forEach(a => a.up()); S.agents.sort((a, b) => a.y - b.y);
  S.agents.filter(a => a.floor === S.currentFloor).forEach(a => a.draw(w, h));
  if (S.floorTransition) cx.globalAlpha = 1;
  updateFloorBadges(); drawPts(); updateFloatingTexts(); drawHUD(w, h);
  cx.restore(); S.fr++;
  if (window._mainCx) window._mainCx.drawImage(S.buf, 0, 0);
}

// ── Start render loop ──
export function startRenderLoop() {
  if (S.pixiReady) { initWeatherOverlay(); S.pixiApp.ticker.add(() => gameLoop()); }
  else { requestAnimationFrame(render); }
}

// ── Floor transition cleanup ──
function finishFloorTransition() {
  if (!S.floorTransition) return;
  if (S.floorTransition.fromSprite) {
    const tex = S.floorTransition.fromSprite.texture;
    if (tex && tex !== PIXI.Texture.EMPTY) tex.destroy(true);
    S.floorTransition.fromSprite.destroy();
    S.floorTransition.fromSprite = null;
  }
  if (S.floorTransition._divLine) {
    S.floorTransition._divLine.destroy();
    S.floorTransition._divLine = null;
  }
  S.floorTransition.fromBg = null;
  S.floorTransition = null;
  if (S.bgSprite) S.bgSprite.y = 0;
}

// ── Floor system ──
export function switchFloor(fi) {
  if (fi < 0 || fi > 2 || fi === S.currentFloor) return;
  if (S.floorTransition) finishFloorTransition();
  const dir = fi > S.currentFloor ? 1 : -1;
  S.floorTransition = { from: S.currentFloor, to: fi, progress: 0, dir, fromBg: S.bg, fromSprite: null, startTime: performance.now() };
  S.currentFloor = fi; S.viewMode = 'floor'; S.bg = null;
  updateFloorBadges();
  const flEl = document.querySelector('.floor-nav');
  if (flEl) { flEl.querySelectorAll('.fb').forEach((b, i) => { b.classList.toggle('active', i === fi); }); }
}

export function toggleBuildingView() {
  if (S.floorTransition) finishFloorTransition();
  S.viewMode = S.viewMode === 'building' ? 'floor' : 'building'; S.bg = null;
}

// Cached DOM refs + throttled (called from gameLoop but only updates every 15 frames)
let _fbEls = null, _fbFrame = 0;
export function updateFloorBadges() {
  if (++_fbFrame % 15 !== 0) return;
  if (!_fbEls) _fbEls = [0, 1, 2].map(i => document.getElementById('fb' + i));
  for (let fi = 0; fi < 3; fi++) {
    const badge = _fbEls[fi];
    if (badge) {
      const wc = S.agents.filter(a => a.floor === fi && a.st === 'work').length;
      badge.textContent = wc > 0 ? wc : '';
      badge.style.display = wc > 0 ? '' : 'none';
    }
  }
}

export function spawnElevatorPacket(from, to, tool) {
  const tc = TOOL_COLORS[tool]; const color = tc ? tc[0] : '#FFD080';
  S.elevatorPackets.push({ from, to, progress: 0, speed: 0.03 + Math.random() * 0.02, color });
}
