// ── agents.js ── Agent state machine (Ag class) and agents array
import { S, C, DESKS, AGENT_FLOOR, AT, AGENT_TRAITS } from './state.js';
import { spawnP, spawnFloatingText, cW, cH, drawCh } from './renderer-views.js';
import { narr, toast } from './ui.js';
import { getActivityIntensity } from './utils.js';

// ── Trait lookup ──
export function getAgentTraits(type, lv) {
  const traits = AGENT_TRAITS[type] || [];
  return traits.filter(t => lv >= t.lv);
}

// ── Agent class (Kairosoft-style state machine) ──
export class Ag {
  constructor(t, i) {
    this.t = t; this.i = i; this.floor = AGENT_FLOOR[t] || 0;
    this.x = DESKS[i].x + (Math.random() - .5) * .02; this.y = .78; this.tx = this.x; this.ty = this.y;
    this.d = 1; this.st = 'idle'; this.wf = Math.random() * 100; this.tk = ''; this.wt = 0; this.di = -1;
    this.xp = 0; this.lv = 1; this.pw = 100; this.tot = 0;
    this.mood = 0; this.moodTimer = 60 + Math.random() * 120;
    this.compFx = 0;
    // Kairosoft 4-stat system
    this.stats = { code: 0, research: 0, network: 0, speed: 0 };
    this._lastOpsTs = Date.now(); this._recentOps = 0; this.promoted = false;
  }

  go(tk) {
    this.di = this.i; const d = DESKS[this.i];
    this.tx = d.x + (Math.random() - .5) * .02; this.ty = .48;
    this.st = 'walk'; this.tk = tk; this.wt = 60 + Math.random() * 80;
    this.tot++; this.pw = Math.max(0, this.pw - 5);
    this.mood = 0;
    this.xp += 8 + Math.floor(Math.random() * 7);
    // Track speed stat (ops per minute window)
    this._recentOps++;
    const elapsed = (Date.now() - this._lastOpsTs) / 60000;
    if (elapsed >= 1) {
      this.stats.speed = Math.min(99, Math.round(this._recentOps / elapsed));
      this._recentOps = 0; this._lastOpsTs = Date.now();
    }
    if (this.xp >= this.lv * 80) {
      this.xp -= this.lv * 80; this.lv++;
      narr(C[this.t].l + ' Lv.' + this.lv + ' 레벨업!', this.t);
      spawnP(d.x * cW(), cH() * .55, 8);
      spawnFloatingText(d.x * cW(), cH() * .45, 'LV UP!', '#FFD080');
      // Promotion check
      const traits = getAgentTraits(this.t, this.lv);
      if (traits.length > 0 && !this.promoted) {
        const latest = traits[traits.length - 1];
        this.promoted = true;
        toast(C[this.t].l + ' 승진: ' + latest.name + '!', 'ok');
        spawnFloatingText(d.x * cW(), cH() * .38, latest.name, latest.color, 16);
        for (let i = 0; i < 15; i++) spawnP(d.x * cW() + (Math.random() - .5) * 60, cH() * .45, 3, 'success');
      }
    }
    DESKS[this.i].act = true;
  }

  up() {
    if (this.compFx > 0) this.compFx--;
    if (this.st === 'walk') {
      const dx = this.tx - this.x, dy = this.ty - this.y;
      // Speed scales with activity intensity + opsPerMin
      const ai = getActivityIntensity();
      const opm = (S.serverMetrics && S.serverMetrics.opsPerMin || 0) / 100;
      const spd = .06 + Math.min(.08, Math.max(ai, opm) * .08);
      if (Math.hypot(dx, dy) > .004) {
        this.x += dx * spd; this.y += dy * spd; this.d = dx > 0 ? 1 : -1; this.wf++;
      } else {
        this.st = this.di >= 0 ? 'work' : 'idle'; // keep last direction (don't reset to 1)
      }
    } else if (this.st === 'work') {
      this.wt--;
      if (this.wt <= 0) {
        DESKS[this.i].act = false; this.tk = '';
        this.compFx = 20;
        spawnP(DESKS[this.i].x * cW(), cH() * .55, 5);
        this.tx = DESKS[this.i].x + (Math.random() - .5) * .03; this.ty = .78 + Math.random() * .03;
        this.st = 'walk'; this.di = -1; this.pw = Math.min(100, this.pw + 3);
      }
    } else {
      this.pw = Math.min(100, this.pw + .02);
      this.moodTimer--;
      if (this.moodTimer <= 0) {
        this.mood = (this.mood + 1) % 5;
        this.moodTimer = 80 + Math.random() * 160;
      }
      if (Math.random() < .003) {
        this.tx = DESKS[this.i].x + (Math.random() - .5) * .04;
        this.ty = Math.max(.73, Math.min(.84, this.y + (Math.random() - .5) * .03)); this.st = 'walk';
      }
      // Random direction change while idle (looking around)
      if (Math.random() < .005) this.d = this.d > 0 ? -1 : 1;
    }
  }

  draw(w, h) {
    drawCh(this.x * w, this.y * h, this.t, this.wf, this.d, this.st === 'work', this.st === 'work' ? this.tk : '', this);
  }
}

// ── Instantiate agents array ──
export const agents = AT.map((t, i) => new Ag(t, i));

// Wire into shared state so other modules can access via S.agents
S.agents = agents;
