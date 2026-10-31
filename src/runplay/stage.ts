// ---- runplay/stage.ts -------------------------------------------------------------------------------------------
// (round 119, `runplay`) A run's stage played in the level, as the hero (play/session.ts): set up round where the hero
// is (the course's gates and kickers, the rival riders, the quarry, the raiders, the fort's towers), watched each frame
// (rules.ts judge), and its result handed back to the run (runplan/level-run.ts picks the outcome: rules.ts
// outcomeFor). Everything is put in the world through contracts: the world API (heights, water, building the towers
// and pouring the kickers), the Units contract (raiders), play's world (vehicles for the hook) and the session's
// voxel draw (gates, flags, riders). Readable on the phone: a banner with the goal and the count, an arrow at the
// screen's edge toward what's next, a 3-2-1 before a race.

import type { ControllerProfile } from '../api/contracts/play';
import type { RunStage } from '../api/contracts/run';
import type { UnitId, Units } from '../api/contracts/units';
import type { Sim } from '../api/world';
import type { PlaySession } from '../play/session';
import { tunedParams } from '../play/session';
import type { BikeTuning } from '../play/core/bike';
import type { Part, Voxels } from '../play/draw/shapes';
import { MAT } from '../world/materials';
import { layCourse, progress, type P2 } from './course';
import { onScreen, SIGNPOSTED, signposted } from './notice';
import { GATE_R, Quarry, Racer } from './riders';
import { judge, stageSpec, type Observation, type StageSpec, type StageStatus } from './rules';

export interface StageResult {
  status: StageStatus;
  /** seconds it was played */
  seconds: number;
  spec: StageSpec;
  /** a line for the card: what the hero did (gates, raiders, towers) */
  summary: string;
}

export interface StageDeps {
  ui: HTMLElement;
  api: Sim;
  units: Units;
  session: PlaySession;
  /** the window's extent (x cells, y world units) */
  bounds: [number, number];
  /** the hero's profile (what kind of play each encounter becomes) */
  profile: () => ControllerProfile;
}

/** seconds of 3-2-1 before a race or a chase */
const COUNTDOWN = 3;
/** a tower is down when what's left of it is under this share of its height */
const TOWER_DOWN = 0.5;

/** a gate: two posts and a bar, in half-cell voxels (bottom centre at its foot) */
function gateVoxels(mat: number, finish: boolean): Voxels {
  const v: Voxels = [];
  const s = 0.5;
  // (posts 13 cells apart, the passing reach GATE_R round the middle: a bike's turn at speed is wide — round 119's
  // autopilot circled gates 7 wide at 11-13 cells)
  for (let u = 0; u < 8; u++) for (const r of [-6.5, 6.5]) v.push({ at: [0, r, u * s + s / 2], mat: MAT.Steel });
  for (let r = -6.5; r <= 6.5; r += s) v.push({ at: [0, r, 4 + s / 2], mat: finish ? ((Math.round(r / s) & 1) ? MAT.Snow : MAT.Obsidian) : mat });
  return v;
}
/** a flag over a tower still standing, and the quarry's marker */
function flagVoxels(mat: number): Voxels {
  const v: Voxels = [];
  for (let u = 0; u < 6; u++) v.push({ at: [0, 0, u * 0.5 + 0.25], mat: MAT.Wood });
  for (let f = 0; f < 3; f++) for (let u = 4; u < 6; u++) v.push({ at: [f * 0.5 + 0.5, 0, u * 0.5 + 0.25], mat });
  return v;
}
const Q0: [number, number, number, number] = [0, 0, 0, 1];
const yawQ = (a: number): [number, number, number, number] => [0, 0, Math.sin(a / 2), Math.cos(a / 2)];

export class StagePlay {
  readonly spec: StageSpec;
  t = -COUNTDOWN;
  status: StageStatus = { state: 'playing' };
  private banner: HTMLDivElement;
  /** (round 120, PL20) the arrows at the screen's edge: what's next, and (a race's) the gate after it — each with its distance */
  private arrows: { el: HTMLDivElement; tip: HTMLDivElement; label: HTMLDivElement }[] = [];
  /** seconds since the last gate was passed (the arrows pulse to the next) */
  private passedT = 99;
  private big: HTMLDivElement;
  // race / trial
  private gates: P2[] = [];
  private gateZ: number[] = [];
  private passed = 0;
  private racers: Racer[] = [];
  private from: P2 = [0, 0];
  // chase
  private quarry: Quarry | null = null;
  private quarryHeading: number | null = null;
  // fight / smash
  private foes: UnitId[] = [];
  private towers: { at: P2; base: number; down: boolean }[] = [];
  private towerT = 0;
  private done: ((r: StageResult) => void) | null = null;
  readonly result: Promise<StageResult>;

  constructor(
    private d: StageDeps,
    readonly stage: RunStage,
  ) {
    this.spec = stageSpec(stage, d.profile());
    this.result = new Promise((res) => (this.done = res));
    this.banner = div(d.ui, 'position:absolute;left:50%;transform:translateX(-50%);top:calc(max(8px, env(safe-area-inset-top)) + 4px);max-width:min(70vw,420px);padding:6px 12px;border-radius:9px;background:rgba(18,16,12,0.78);color:#f3e8cf;font:600 13px/1.3 system-ui,sans-serif;text-align:center;pointer-events:none;z-index:7;');
    // (the next: big and gold; the one after: smaller and paler, so the line through the next can be planned)
    for (const [size, color, alpha] of [[17, '#ffd35a', 1], [11, '#fff0c0', 0.75]] as const) {
      const el = div(d.ui, `position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;z-index:7;display:none;opacity:${alpha};`);
      const tip = div(el, `position:absolute;left:${-size}px;top:${-size}px;width:0;height:0;border-left:${size}px solid transparent;border-right:${size}px solid transparent;border-bottom:${size * 2}px solid ${color};filter:drop-shadow(0 1px 3px rgba(0,0,0,.7));`);
      const label = div(el, `position:absolute;left:0;top:${size + 4}px;transform:translateX(-50%);white-space:nowrap;padding:1px 6px;border-radius:7px;background:rgba(18,16,12,0.72);color:${color};font:700 ${size >= 15 ? 13 : 11}px/1.3 system-ui,sans-serif;`);
      this.arrows.push({ el, tip, label });
    }
    this.big = div(d.ui, 'position:absolute;left:50%;top:34%;transform:translate(-50%,-50%);color:#fff3c4;font:800 64px system-ui,sans-serif;text-shadow:0 3px 12px rgba(0,0,0,.8);pointer-events:none;z-index:7;');
    this.setUp();
  }

  private get hero() {
    return this.d.session.hero;
  }
  private get world() {
    return this.d.session.world;
  }
  private heroAt(): P2 {
    const p = this.hero.position();
    return [p[0], p[1]];
  }
  /** the way into the window from (x, y): toward its middle (where there's land made round the hero) */
  private inward(at: P2): number {
    const [W, H] = this.d.bounds;
    return Math.atan2(H / 2 - at[1], W / 2 - at[0]);
  }
  private tuning(): BikeTuning {
    return tunedParams('hoverbike') as unknown as BikeTuning;
  }

  private setUp(): void {
    const s = this.spec;
    const at = this.heroAt();
    const h = (x: number, y: number) => this.d.api.terrain!.heightAt(x, y);
    const top = (x: number, y: number) => this.world.top(x, y);
    const depth = (x: number, y: number) => this.world.depth(x, y);
    switch (s.kind) {
      case 'race':
      case 'trial': {
        const c = layCourse(h, depth, at, this.inward(at), { gates: s.gates!, spacing: s.spacing!, bounds: this.d.bounds, margin: 20 });
        this.gates = c.gates;
        this.gateZ = c.gates.map(([x, y]) => top(x, y));
        this.from = c.start;
        this.hero.place(c.start);
        // (kickers: sand poured in a mound where the course has no crest of its own — a bump to launch off)
        if (s.kind === 'race') for (const [x, y] of c.kickers) this.d.api.terrain!.deposit(x, y, 'sand', { radius: 3, layers: 3 });
        for (let i = 0; i < (s.rivals ?? 0); i++) {
          // (lined up beside and a little behind the hero)
          const side = (i % 2 ? -1 : 1) * (4 + 3 * Math.floor(i / 2));
          const back = -3 - 2 * i;
          const p: P2 = [c.start[0] + Math.cos(c.heading) * back + Math.cos(c.heading + Math.PI / 2) * side, c.start[1] + Math.sin(c.heading) * back + Math.sin(c.heading + Math.PI / 2) * side];
          this.racers.push(new Racer(`rival${i}`, p, this.tuning(), s.rivalPace ?? 0.9, top, this.d.bounds, i, this.gates));
        }
        this.world.vehicles = () => this.racers.map((r) => r.vehicle());
        break;
      }
      case 'chase': {
        // (he runs the open way: the direction whose ground rises and falls least over 60 cells, leaning inward — round
        // 119's first chase sent him off along a chasm's cliffs, and the bike crashed into them)
        const a = this.openWay(at, top);
        const q = s.quarry!;
        const p: P2 = [at[0] + Math.cos(a) * q.lead, at[1] + Math.sin(a) * q.lead];
        this.quarry = new Quarry('quarry', p, this.tuning(), q.pace, top, this.d.bounds);
        // (it sees the hero coming: off at its pace when the clock starts)
        this.quarryHeading = a;
        this.world.vehicles = () => (this.quarry ? [this.quarry.vehicle()] : []);
        break;
      }
      case 'fight':
        this.t = 0;
        this.spawnFoes(at, s.foes!, 12, 22);
        break;
      case 'smash': {
        this.t = 0;
        const a0 = this.inward(at);
        const n = s.towers!;
        // (the fort ahead: its towers in a ring 14 cells across, its middle 24 cells in from the hero)
        const c: P2 = [at[0] + Math.cos(a0) * 24, at[1] + Math.sin(a0) * 24];
        for (let i = 0; i < n; i++) {
          const a = a0 + Math.PI + (2 * Math.PI * (i + 0.5)) / n;
          const p: P2 = [c[0] + Math.cos(a) * 9, c[1] + Math.sin(a) * 9];
          const base = h(p[0], p[1]) ?? 0;
          this.d.api.terrain!.build(p[0], p[1], 'brick', { radius: 2, layers: s.towerHeight! });
          this.towers.push({ at: p, base, down: false });
        }
        // (the garrison comes out from beyond the fort: raiders stood among the towers were what a tap on a tower picked
        // — the lich lifted them instead of gliding there, round 119's first look)
        this.spawnFoes([c[0] + Math.cos(a0) * 20, c[1] + Math.sin(a0) * 20], s.foes ?? 0, 0, 4);
        break;
      }
    }
  }

  /** the way from `at` with the least rise and fall over the next 60 cells (and inward, other things equal) */
  private openWay(at: P2, top: (x: number, y: number) => number): number {
    const inward = this.inward(at);
    let best = inward;
    let bs = Infinity;
    for (let k = 0; k < 12; k++) {
      const a = inward + ((k - 6) * Math.PI) / 6;
      let rough = 0;
      let prev = top(at[0], at[1]);
      for (let r = 6; r <= 60; r += 6) {
        const z = top(at[0] + Math.cos(a) * r, at[1] + Math.sin(a) * r);
        rough += Math.abs(z - prev);
        prev = z;
      }
      const s = rough + Math.abs(k - 6) * 0.5;
      if (s < bs) (bs = s), (best = a);
    }
    return best;
  }

  private spawnFoes(c: P2, n: number, r0: number, r1: number): void {
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n + Math.random() * 0.4;
      const r = r0 + Math.random() * (r1 - r0);
      const p: P2 = [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r];
      this.foes.push(this.d.units.spawn('raider', p, 'f-raiders', { hostile: true, health: this.spec.foeHealth ?? 3, sight: 40, speed: 3.5, role: 'raider' }));
    }
  }

  private foesLeft(): number {
    let n = 0;
    for (const id of this.foes) if (this.d.units.get(id)?.alive) n++;
    return n;
  }

  /** the voxels to draw with the hero (gates, riders, flags) */
  parts(): Part[] {
    const out: Part[] = [];
    this.gates.forEach((g, i) => {
      if (i < this.passed) return;
      const next = i === this.passed;
      const finish = i === this.gates.length - 1;
      const prev = i === 0 ? this.from : this.gates[i - 1];
      // (the gate faces the way the course comes through it)
      const yaw = Math.atan2(g[1] - prev[1], g[0] - prev[0]);
      out.push({ voxels: next ? NEXT_GATE : finish ? FINISH : GATE, at: [g[0], g[1], this.gateZ[i]], q: yawQ(yaw), size: 0.5 });
    });
    for (const r of this.racers) out.push(r.part());
    if (this.quarry) {
      out.push(this.quarry.part());
      const b = this.quarry.b;
      out.push({ voxels: QUARRY_FLAG, at: [b.x, b.y, b.z + 1.5], q: Q0, size: 0.5 });
    }
    for (const t of this.towers) if (!t.down) out.push({ voxels: TOWER_FLAG, at: [t.at[0], t.at[1], t.base + (this.spec.towerHeight ?? 9) + 0.5], q: Q0, size: 0.5 });
    return out;
  }

  /** the window slid: what's kept in window coordinates moves with it */
  shift(dx: number, dy: number, dz: number): void {
    const mv = (p: P2): P2 => [p[0] + dx, p[1] + dy];
    this.gates = this.gates.map(mv);
    this.gateZ = this.gateZ.map((z) => z + dz);
    this.from = mv(this.from);
    for (const r of this.racers) r.shift(dx, dy, dz);
    this.quarry?.shift(dx, dy, dz);
    for (const t of this.towers) {
      t.at = mv(t.at);
      t.base += dz;
    }
  }

  /** what's next for the hero, for the arrow (null: nothing to point at) */
  objective(): P2 | null {
    switch (this.spec.kind) {
      case 'race':
      case 'trial':
        return this.gates[this.passed] ?? null;
      case 'chase':
        return this.quarry ? this.quarry.at : null;
      case 'fight': {
        const me = this.heroAt();
        let best: P2 | null = null;
        let bd = Infinity;
        for (const id of this.foes) {
          const u = this.d.units.get(id);
          if (!u?.alive) continue;
          const dd = Math.hypot(u.at[0] - me[0], u.at[1] - me[1]);
          if (dd < bd) (bd = dd), (best = [u.at[0], u.at[1]]);
        }
        return best;
      }
      case 'smash': {
        const me = this.heroAt();
        const up = this.towers.filter((t) => !t.down).sort((a, b) => Math.hypot(a.at[0] - me[0], a.at[1] - me[1]) - Math.hypot(b.at[0] - me[0], b.at[1] - me[1]));
        return up[0]?.at ?? null;
      }
    }
  }

  /** Each frame, after the session stepped the hero. */
  update(dt: number): void {
    if (this.status.state !== 'playing') return;
    const s = this.spec;
    const wasCounting = this.t < 0;
    this.t += dt;
    this.passedT += dt;
    const go = this.t >= 0;
    if (wasCounting) this.big.textContent = go ? 'GO!' : String(Math.ceil(-this.t));
    if (go && this.t > 0.8 && this.big.textContent) this.big.textContent = '';
    const me = this.heroAt();
    const o: Observation = { t: Math.max(0, this.t), heroAlive: this.hero.alive };
    if (s.kind === 'race' || s.kind === 'trial') {
      const g = this.gates[this.passed];
      if (g && Math.hypot(g[0] - me[0], g[1] - me[1]) < GATE_R + 1) {
        this.passed++;
        this.passedT = 0;
        this.world.burst('dust', g[0], g[1], this.gateZ[this.passed - 1] + 1);
      }
      if (go) for (const r of this.racers) r.step(dt);
      o.gate = this.passed;
      o.rivalGate = Math.max(0, ...this.racers.map((r) => progress(this.gates, r.passed, r.at, this.from)));
      o.rivalDone = this.racers.some((r) => r.done);
    } else if (s.kind === 'chase' && this.quarry) {
      if (go && this.quarryHeading !== null) {
        this.quarry.launch(this.quarryHeading);
        this.quarryHeading = null;
      }
      if (go) this.quarry.step(dt, me);
      o.quarry = Math.hypot(this.quarry.at[0] - me[0], this.quarry.at[1] - me[1]);
    } else {
      o.foesLeft = this.foesLeft();
      if (s.kind === 'smash') {
        // (a tower's top read back a few times a second: the slams crater it down — world.crater at the lich)
        this.towerT -= dt;
        if (this.towerT <= 0 && this.t > 1.5) {
          this.towerT = 0.25;
          const H = s.towerHeight ?? 9;
          for (const tw of this.towers) {
            if (tw.down) continue;
            // (what's left of it: the mean over its middle and four cells round — a stump at its edge doesn't hold it up)
            let sum = 0;
            let n = 0;
            for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const z = this.d.api.terrain!.heightAt(tw.at[0] + dx, tw.at[1] + dy);
              if (z !== null) (sum += z), n++;
            }
            if (n && sum / n < tw.base + H * TOWER_DOWN) {
              tw.down = true;
              this.world.burst('dust', tw.at[0], tw.at[1], tw.base + 2);
            }
          }
        }
        o.down = this.towers.filter((t) => t.down).length;
      }
    }
    this.status = go ? judge(s, o) : this.hero.alive ? { state: 'playing' } : { state: 'lost', how: 'died' };
    this.drawHud(o, me);
    if (this.status.state !== 'playing') this.finish(o);
  }

  private place(): number {
    // (the hero's place in the race: rivals ahead of its progress, plus one)
    const mine = progress(this.gates, this.passed, this.heroAt(), this.from);
    return 1 + this.racers.filter((r) => progress(this.gates, r.passed, r.at, this.from) > mine).length;
  }

  private drawHud(o: Observation, me: P2): void {
    const s = this.spec;
    const left = Math.max(0, s.limit - Math.max(0, this.t));
    const clock = `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
    let line = '';
    switch (s.kind) {
      case 'race':
        line = `🏁 Gate ${Math.min(this.passed + 1, s.gates!)}/${s.gates} · ${ordinal(this.place())} of ${this.racers.length + 1}`;
        break;
      case 'trial':
        line = `⚐ Marker ${Math.min(this.passed + 1, s.gates!)}/${s.gates}`;
        break;
      case 'chase':
        line = `⇝ ${Math.round(o.quarry ?? 0)} cells behind him${this.hero.role === 'hoverbike' ? ' · tap him: hook on' : ''}`;
        break;
      case 'fight':
        line = `⚔ ${o.foesLeft} of ${s.foes} raiders left`;
        break;
      case 'smash':
        line = `✸ ${o.down ?? 0} of ${s.towers} towers down · float over one and slam`;
        break;
    }
    const text = `${line} · ⏱ ${clock}`;
    if (this.banner.textContent !== text) this.banner.textContent = text;
    // the arrows at the screen's edge toward what's next (a race: the next gate and the one after), off screen or far
    const marks: { at: P2; label: string }[] = [];
    if (s.kind === 'race' || s.kind === 'trial') {
      for (let i = this.passed; i < this.gates.length && signposted(i, this.passed); i++)
        marks.push({ at: this.gates[i], label: `${i === this.gates.length - 1 ? '🏁' : i + 1} · ${Math.round(Math.hypot(this.gates[i][0] - me[0], this.gates[i][1] - me[1]))}` });
    } else {
      const tgt = this.objective();
      if (tgt) marks.push({ at: tgt, label: String(Math.round(Math.hypot(tgt[0] - me[0], tgt[1] - me[1]))) });
    }
    this.arrows.forEach((a, k) => this.pointAt(a, marks[k] ?? null, me, k === 0 ? Math.max(0, 1 - this.passedT / 0.6) : 0));
  }

  /** one arrow toward `m` at the screen's edge (or over it when it's on screen and far); `pulse` 0..1 swells it */
  private pointAt(a: { el: HTMLDivElement; tip: HTMLDivElement; label: HTMLDivElement }, m: { at: P2; label: string } | null, me: P2, pulse: number): void {
    if (!m) {
      a.el.style.display = 'none';
      return;
    }
    const tgt = m.at;
    const z = this.world.top(tgt[0], tgt[1]);
    const [sx, sy] = this.world.project(tgt[0], tgt[1], z);
    const W = innerWidth;
    const H = innerHeight;
    const pad = 40;
    const on = onScreen(sx, sy, W, H, pad) && sy > pad + 40;
    if (on && Math.hypot(tgt[0] - me[0], tgt[1] - me[1]) < 60) {
      a.el.style.display = 'none';
      return;
    }
    const cx = W / 2;
    const cy = H / 2;
    let dx = sx - cx;
    let dy = sy - cy;
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    // (clamped to the screen's edge, inset; room under it for the label)
    const k = Math.min(Math.abs((W / 2 - pad) / (dx || 1e-6)), Math.abs((H / 2 - pad - 18) / (dy || 1e-6)));
    const ax = on ? sx : cx + dx * k;
    const ay = on ? sy - 30 : cy + dy * k;
    a.el.style.display = '';
    a.el.style.transform = `translate(${ax}px, ${ay}px)`;
    a.tip.style.transform = `rotate(${Math.atan2(dy, dx) + Math.PI / 2}rad) scale(${1 + pulse * 0.6})`;
    if (a.label.textContent !== m.label) a.label.textContent = m.label;
  }

  /** (round 120) the gates signposted now (scripts/runplay.mjs measures each gate's warning by it) */
  signpostedGates(): number[] {
    const out: number[] = [];
    for (let i = this.passed; i < this.gates.length && i < this.passed + SIGNPOSTED; i++) out.push(i);
    return out;
  }

  private finish(o: Observation): void {
    const s = this.spec;
    const st = this.status;
    let summary = '';
    if (s.kind === 'race' || s.kind === 'trial') summary = `${this.passed}/${s.gates} gates${s.kind === 'race' ? `, ${ordinal(this.place())}` : ''}`;
    else if (s.kind === 'chase') summary = `${Math.round(o.quarry ?? 0)} cells off him`;
    else if (s.kind === 'fight') summary = `${s.foes! - (o.foesLeft ?? 0)} of ${s.foes} raiders down`;
    else summary = `${o.down ?? 0} of ${s.towers} towers down`;
    this.big.textContent = st.state === 'won' ? 'WON' : st.state === 'playing' ? '' : st.how === 'died' ? 'DOWN' : st.how === 'clock' ? 'TIME' : st.how === 'beaten' ? 'BEATEN' : 'GONE';
    for (const a of this.arrows) a.el.style.display = 'none';
    this.done?.({ status: st, seconds: Math.max(0, this.t), spec: s, summary });
  }

  dispose(): void {
    this.banner.remove();
    for (const a of this.arrows) a.el.remove();
    this.big.remove();
    for (const id of this.foes) this.d.units.remove(id);
    this.foes = [];
    this.world.vehicles = undefined;
  }
}

const GATE = gateVoxels(MAT.Canvas, false);
const NEXT_GATE = gateVoxels(MAT.Lava, false);
const FINISH = gateVoxels(MAT.Snow, true);
const TOWER_FLAG = flagVoxels(MAT.Lava);
const QUARRY_FLAG = flagVoxels(MAT.Lava);

function ordinal(n: number): string {
  return n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
}

function div(parent: HTMLElement, css: string): HTMLDivElement {
  const d = document.createElement('div');
  d.style.cssText = css;
  parent.appendChild(d);
  return d;
}
