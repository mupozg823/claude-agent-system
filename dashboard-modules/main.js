// ── main.js ── Bootstrap, DOM events, window exposures
import { S, C, AT } from './state.js';
import { narr } from './ui.js';
import { openPanel, closePanel, switchTab } from './ui.js';
import { cW, cH, initCanvas, startRenderLoop, spawnP, switchFloor, toggleBuildingView, setGameTick } from './renderer-views.js';
import { agents } from './agents.js';
import { checkKairoEvent, updateEvent, updateReputation } from './game-systems.js';
import { getParams, doConnect, connectWith, sendCmd, quickCmd, requestStatus, trySSEFallback } from './connection.js';
import { pick } from './utils.js';
import { NR } from './state.js';

// ── Wire game tick (avoids circular dep: renderer ↔ game-systems) ──
setGameTick(() => {
  checkKairoEvent();
  updateEvent();
  if (S.fr % 60 === 0) updateReputation();
});

// ── Expose globals for HTML onclick handlers ──
window.switchFloor = switchFloor;
window.toggleBuildingView = toggleBuildingView;
window.openPanel = openPanel;
window.closePanel = closePanel;
window.switchTab = switchTab;
window.doConnect = doConnect;
window.sendCmd = sendCmd;
window.quickCmd = quickCmd;
window.requestStatus = requestStatus;

// ── Canvas touch/click support ──
const sceneEl = document.querySelector('.scene');
const _cTarget = sceneEl || document.getElementById('c');

function _canvasCoords(clientX, clientY) {
  const target = S.pixiApp ? S.pixiApp.canvas : document.getElementById('c');
  const rect = target.getBoundingClientRect();
  return { x: (clientX - rect.left) * (cW() / rect.width), y: (clientY - rect.top) * (cH() / rect.height) };
}

function _handleBuildingClick(cx2, cy2) {
  if (S.viewMode !== 'building' || !S.buildingFloorHits.length) return false;
  for (const h of S.buildingFloorHits) {
    if (cx2 >= h.x && cx2 <= h.x + h.w && cy2 >= h.y && cy2 <= h.y + h.h) {
      switchFloor(h.fi); spawnP(cx2, cy2, 5); return true;
    }
  }
  return false;
}

_cTarget.addEventListener('touchstart', (e) => {
  const touch = e.touches[0];
  const { x: cx2, y: cy2 } = _canvasCoords(touch.clientX, touch.clientY);
  S.swipeStartY = touch.clientY; S.swipeStartTime = Date.now(); S.swipeActive = true;
  if (_handleBuildingClick(cx2, cy2)) return;
  const hitAgent = agents.find(a => {
    const ax = a.x * cW(), ay = a.y * cH();
    return Math.abs(cx2 - ax) < 30 * S.P / 5 && Math.abs(cy2 - ay) < 40 * S.P / 5;
  });
  if (hitAgent) {
    const c2 = C[hitAgent.t];
    narr(`${c2.l} Lv.${hitAgent.lv} (${c2.r}) - ${hitAgent.st === 'work' ? '\uC791\uC5C5: ' + hitAgent.tk : hitAgent.st === 'walk' ? '\uC774\uB3D9 \uC911' : '\uB300\uAE30'} [${hitAgent.tot}ops]`, AT[hitAgent.i]);
    spawnP(hitAgent.x * cW(), hitAgent.y * cH() - 20, 3);
  }
}, { passive: true });

_cTarget.addEventListener('touchend', (e) => {
  if (!S.swipeActive) return; S.swipeActive = false;
  const touch = e.changedTouches[0];
  const dy = touch.clientY - S.swipeStartY, dt = Date.now() - S.swipeStartTime;
  if (dt < 500 && Math.abs(dy) > 50) {
    if (dy < -50 && S.currentFloor < 2) switchFloor(S.currentFloor + 1);
    else if (dy > 50 && S.currentFloor > 0) switchFloor(S.currentFloor - 1);
  }
}, { passive: true });

_cTarget.addEventListener('click', (e) => {
  const { x: cx2, y: cy2 } = _canvasCoords(e.clientX, e.clientY);
  _handleBuildingClick(cx2, cy2);
});

// ── Bottom sheet swipe ──
document.getElementById('panelSheet')?.addEventListener('touchstart', e => {
  S.sheetStartY = e.touches[0].clientY;
}, { passive: true });
document.getElementById('panelSheet')?.addEventListener('touchmove', e => {
  const dy = e.touches[0].clientY - S.sheetStartY;
  if (dy > 80) closePanel();
}, { passive: true });

// ── Drag & Drop JSONL ──
document.body.addEventListener('dragover', e => e.preventDefault());
document.body.addEventListener('drop', e => {
  e.preventDefault();
  const f = e.dataTransfer?.files[0];
  if (f) {
    const r = new FileReader();
    r.onload = v => {
      S.entries = v.target.result.trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      import('./connection.js').then(conn => { S.entries.forEach(e2 => conn.onE(e2)); });
      import('./ui.js').then(ui => { ui.sUI(); ui.toast(`\uB85C\uADF8 \uB85C\uB4DC! ${S.entries.length}\uAC74`, 'ok'); });
      narr(`\uB85C\uADF8 \uB85C\uB4DC! ${S.entries.length}\uAC74`);
    };
    r.readAsText(f);
  }
});

// ── Visibility change ──
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !S.connected && S.connParams) {
    // Trigger reconnect
    import('./connection.js').then(conn => conn.connectWith(S.connParams.url, S.connParams.key, S.connParams.sessionId));
  }
});

// ── Idle narration ──
setInterval(() => { if (Date.now() - S.lastET > 12000) narr(pick(NR.idle)); }, 8000);

// ── Tick liveness monitor ──
setInterval(() => {
  if (!S.connected) return;
  const sig = document.getElementById('sig'); if (!sig) return;
  const elapsed = Date.now() - S.lastTick;
  if (S.lastTick === 0 || elapsed < 70000) sig.className = 'signal';
  else if (elapsed < 130000) sig.className = 'signal mid';
  else sig.className = 'signal weak';
}, 10000);

// ── Auto-connect on load ──
window.addEventListener('DOMContentLoaded', () => {
  const p = getParams();
  const forceSSE = new URLSearchParams(location.search).get('sse') === '1';
  if (forceSSE) {
    document.getElementById('setupOverlay').style.display = 'none';
    document.getElementById('mainApp').style.display = '';
    requestAnimationFrame(async () => { await initCanvas(); startRenderLoop(); });
    trySSEFallback();
  } else if (p.url && p.key && p.session) {
    connectWith(p.url, p.key, p.session);
  } else {
    document.getElementById('setupOverlay').style.display = 'none';
    document.getElementById('mainApp').style.display = '';
    requestAnimationFrame(async () => { await initCanvas(); startRenderLoop(); });
    trySSEFallback();
    setTimeout(() => {
      if (!S.connected && !S.sseActive) {
        document.getElementById('setupOverlay').style.display = 'flex';
        document.getElementById('cfgUrl').value = p.url;
        document.getElementById('cfgKey').value = p.key;
        document.getElementById('cfgSession').value = p.session;
      }
    }, 5000);
  }
});
