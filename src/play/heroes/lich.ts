// ---- play/heroes/lich.ts ----------------------------------------------------------------------------------------
// The lich (ported from GameplayGM runtimes/hoverbike/src/units/lich.ts, round 117; the enemies only for now — the
// physics bodies, torn-out rocks and the spellbook stay in GameplayGM until the engine's bodies have a world API):
// "The lich is a floating wrecking ball power fantasy." It levitates (core/levitate.ts: holds its height over the
// land, no bounce, untouched by slopes, wind and blows), goes where it's tapped (no stick), and its powers are
// gestures:
//   tap open ground / hold it       glide there
//   drag up or down from the lich   float higher or lower (floatLow..floatHigh)
//   tap an enemy                    float it: held helpless in the air till it drops
//   tap it again (a double tap)     face to face: held before its face, its soul drawn out (the lich heals)
//   drag starting on an enemy       telekinesis: it hangs on a spring above the thumb, smashing into what it meets;
//                                   let go and it flies on the way it was going
//   flick starting on an enemy      throw it that way, bent toward an enemy along the way (core/fling.ts)
//   flick toward the lich           pull: what's in that cone comes in and circles it
//   flick away from the lich        what's circling or floating is hurled that way, each at its own enemy; with
//                                   nothing held, a force push (a cone of shove)
//   tap the lich, or SLAM           (new in Reclaimed, the wrecking ball) a slam: a crater blown out of the ground
//                                   under it, a ring of shove and throw, the air slammed out
//   draw a circle                   a storm: the enemies near rise and circle it, wind and dust swirling up
// At most units.maxHeld held at once (the agents hold 8): floating, circling, carried and face to face together.

import type { HeroCamera } from '../../api/contracts/hero';
import type { UnitId, V2, V3 } from '../../api/contracts/units';
import { makeBike, speedOf, type Bike } from '../core/bike';
import { TOUCH, type Pt } from '../core/gestures';
import { flingPlanner, FLING_ASSIST } from '../core/fling';
import { LEVITATE, stepLevitate, type LevitateTuning } from '../core/levitate';
import { LICH_DEFAULTS, type LichParams } from '../controllers/lich';
import { buildLich, qAxis, qMul, type Part } from '../draw/shapes';
import type { Act, ButtonLook, Drag, Pad, PlayInput } from '../input/types';
import type { Blow, PlayWorld } from '../world';
import { PlayHero, UNIT_HEIGHT, type Hit } from './base';

/** The agents' thrown units fall at this (agents.ts AGENT_GRAVITY, cells/s²). */
const UNIT_GRAVITY = 20;
/** Tap to move: it eases off within `slow` cells, is there within `arrive`; a touch held `hold` s glides it while the thumb moves slower than `steer` px/s. */
export const MOVE = { slow: 2.5, arrive: 0.6, hold: 0.2, steer: 350 };
/** Floating height: cells per pixel dragged up from the lich. */
export const FLOAT_PER_PX = 1 / 25;
/** A finger this near a thing as it's seen (px) is on it; on the lich, only this near; a second tap within `again` px is on the same. */
export const PICK = { px: 48, self: 30, again: 60, double: 0.5 };
/** Floating: this high over the ground, bobbing, for `time` s. */
export const LIFT = { height: 2.2, bob: 0.2, time: 8 };
/** Circling: how far out, how high, how fast round (rad/s); let go after `time` s. */
export const ORBIT = { radius: 2.8, height: 1.4, spin: 2.6, time: 12 };
/** The pull's reach and cone (radians either side). */
export const PULL = { reach: 10, cone: 0.6 };
/** Telekinesis: hung `height` over the ground `lift` px above the thumb, its spring damped `damp` of critical; let go, `thumb` of the thumb's speed and `up` more; faster than `smack` it hits. */
export const CARRY = { height: 1.5, lift: 90, damp: 0.6, thumb: 0.4, up: 3, smack: 7, reach: 1.5, push: 0.6, every: 0.4, wall: 0.35 };
/** Face to face: held `ahead` before the lich at its face's height; a beat every `every` s. */
export const SOUL = { ahead: 1.4, face: 1.4, every: 0.25 };
/** The faint downdraft under it (a visual in place of a shadow): wind (cells/s) well under what moves enemies. */
export const DOWNDRAFT = { radius: 1.8, strength: 2.5, motes: 6 };

const VOXELS = buildLich();

export class LichHero extends PlayHero {
  readonly b: Bike;
  readonly pad: Pad = {
    move: 'none',
    buttons: [
      { icon: '💥', name: 'slam' },
      { icon: '🖐️', name: 'drop all' },
    ],
    hint: 'Tap the ground: glide · tap a foe: float it, tap again: drain its soul · drag a foe to swing it, let go to fling · flick away: force push · tap the lich (or 💥): slam · drag up from the lich: rise · draw a circle: storm',
  };
  readonly camera: HeroCamera = { zoom: 26, behind: Math.PI / 4 };
  hover: number;
  private liftFrom: number | null = null;
  private goal: Pt | null = null;
  private heldT = 0;
  private touched: UnitId | null = null;
  private thumb: Pt | null = null;
  private floats: { id: UnitId; at: Pt; t: number }[] = [];
  private orbit: { id: UnitId; a: number }[] = [];
  private orbitT = 0;
  private storm = 0;
  private spin = 1;
  private draft: Blow | null = null;
  private swirl: Blow | null = null;
  private carried: { id: UnitId; at: V3; vel: V3; want: V3 | null; wantVel: V3; struck: Map<number, number> } | null = null;
  private soul: { id: UnitId; t: number } | null = null;
  private lastTap: { id: UnitId; t: number; screen: Pt } | null = null;
  private slamT = 0;
  private down: boolean[] = [];

  constructor(world: PlayWorld, at: V2, params: LichParams = { ...LICH_DEFAULTS }) {
    super('lich', world, params, 30);
    this.hover = params.floatLow;
    this.b = makeBike(at[0], at[1], world.floor);
    this.b.z = world.floor(at[0], at[1]) + this.hover;
  }

  private get p(): LichParams {
    return this.params as LichParams;
  }
  private float(): LevitateTuning {
    const p = this.p;
    return { ...LEVITATE, hover: this.hover, max: p.max, accel: p.accel, rise: p.rise, sink: p.sink, step: p.step, climb: p.climb };
  }

  position(): V3 {
    return [this.b.x, this.b.y, this.b.z];
  }
  heading(): number {
    return this.b.heading;
  }
  speed(): number {
    return speedOf(this.b);
  }
  fast(): number {
    return Math.min(1, speedOf(this.b) / Math.max(this.p.max, 1)) * 0.3 + Math.min(1, (this.hover - this.p.floatLow) / 10) * 0.4;
  }
  place(at: V2): void {
    this.dropAll();
    Object.assign(this.b, makeBike(at[0], at[1], this.world.floor));
    this.b.z = this.world.floor(at[0], at[1]) + this.hover;
    this.goal = null;
  }
  shift(dx: number, dy: number, dz: number): void {
    this.b.x += dx;
    this.b.y += dy;
    this.b.z += dz;
    if (this.goal) this.goal = [this.goal[0] + dx, this.goal[1] + dy];
    for (const f of this.floats) f.at = [f.at[0] + dx, f.at[1] + dy];
    if (this.carried) for (let i = 0; i < 3; i++) this.carried.at[i] += [dx, dy, dz][i];
  }
  /** blows hurt it but never move it */
  protected knock(): void {}

  /** where it went (for tests and the sandbox): the tapped goal */
  get target(): Pt | null {
    return this.goal;
  }
  /** what it holds: floating, circling, carried, face to face */
  held(): UnitId[] {
    return [...this.floats.map((f) => f.id), ...this.orbit.map((o) => o.id), ...(this.carried ? [this.carried.id] : []), ...(this.soul ? [this.soul.id] : [])];
  }
  private holding(id: UnitId): boolean {
    return this.held().includes(id);
  }
  private room(): boolean {
    return this.held().length < this.world.units.maxHeld;
  }

  protected step(input: PlayInput, dt: number, hits: Hit[]): void {
    const b = this.b;
    this.slamT = Math.max(0, this.slamT - dt);
    this.heldT = input.drag ? this.heldT + dt : 0;
    this.touch(input.drag, dt);
    const thumb = input.drag?.screenAt ?? null;
    const slow = !!thumb && !!this.thumb && Math.hypot(thumb[0] - this.thumb[0], thumb[1] - this.thumb[1]) < MOVE.steer * dt;
    this.thumb = thumb;
    if (input.drag && !input.drag.self && !this.carried && this.touched === null && this.heldT >= MOVE.hold && slow) this.goal = input.drag.at;
    // the stick (keys), else the way to a tapped spot
    let stick = input.dir;
    if (Math.hypot(stick[0], stick[1]) > 0.1) this.goal = null;
    else if (this.goal) {
      const dx = this.goal[0] - b.x;
      const dy = this.goal[1] - b.y;
      const d = Math.hypot(dx, dy);
      if (d < MOVE.arrive) this.goal = null;
      else stick = [(dx / d) * Math.min(1, d / MOVE.slow), (dy / d) * Math.min(1, d / MOVE.slow)];
    }
    stepLevitate(b, stick, dt, this.world.floor, this.world.bounds, this.float());
    // its height, dragged up or down from the lich
    const drag = input.drag;
    if (drag?.self && this.touched === null && !this.carried) {
      this.liftFrom ??= this.hover;
      this.hover = Math.max(this.p.floatLow, Math.min(this.p.floatHigh, this.liftFrom + drag.up * FLOAT_PER_PX));
    } else this.liftFrom = null;
    // buttons: slam, drop all (pressed, not held)
    if (input.buttons[0] && !this.down[0]) this.slam(hits);
    if (input.buttons[1] && !this.down[1]) this.dropAll();
    this.down = [...input.buttons];
    const carrying = this.carry(input, dt, hits);
    for (const act of input.acts) if (!(carrying && (act.kind === 'flick' || act.kind === 'circle'))) this.power(act, hits);
    this.downdraft(dt);
    this.keepFloats(dt);
    this.keepOrbit(dt);
    this.drain(dt, hits);
    if (this.storm > 0) this.stir(dt);
  }

  /** an enemy's middle now (null: gone) */
  private at(id: UnitId): V3 | null {
    const u = this.world.units.get(id);
    return u && u.alive ? [u.at[0], u.at[1], u.at[2] + UNIT_HEIGHT * 0.4] : null;
  }
  private gap(id: UnitId, screen: Pt): number {
    const p = this.at(id);
    if (!p) return Infinity;
    const s = this.world.project(p[0], p[1], p[2]);
    return Math.hypot(s[0] - screen[0], s[1] - screen[1]);
  }
  /** what the finger's on, as it's seen (held things too); on the lich, only what's right under the finger */
  private under(screen: Pt, at: Pt, self: boolean): UnitId | null {
    let best: UnitId | null = null;
    let bd = self ? PICK.self : PICK.px;
    const ids = new Set([...this.held(), ...this.world.units.near(at[0], at[1], 8).map((u) => u.id)]);
    for (const id of ids) {
      const d = this.gap(id, screen);
      if (d < bd) [best, bd] = [id, d];
    }
    return best;
  }
  private touch(drag: Drag | null, dt: number): void {
    if (!drag) this.touched = null;
    else if (this.heldT <= dt + 1e-6) this.touched = this.under(drag.screen, drag.from, drag.self);
  }

  /** Telekinesis: a drag that starts on an enemy takes it once it's more than a tap; it hangs on a spring above the thumb. */
  private carry(input: PlayInput, dt: number, hits: Hit[]): boolean {
    const drag = input.drag;
    const w = this.world;
    const moved = drag ? Math.hypot(drag.screenAt[0] - drag.screen[0], drag.screenAt[1] - drag.screen[1]) : 0;
    if (this.touched !== null && !this.carried && (moved > TOUCH.tapPx || this.heldT > TOUCH.tapTime)) {
      const id = this.touched;
      const p = this.at(id);
      this.touched = null;
      if (p && (this.holding(id) || this.room())) {
        this.forget(id);
        this.carried = { id, at: [...p], vel: [0, 0, 0], want: null, wantVel: [0, 0, 0], struck: new Map() };
      }
    }
    const c = this.carried;
    if (!c) return false;
    if (!this.at(c.id)) {
      this.carried = null;
      return false;
    }
    if (!drag) {
      // let go: it flies on
      w.units.release(c.id, [c.vel[0] + c.wantVel[0] * CARRY.thumb, c.vel[1] + c.wantVel[1] * CARRY.thumb, c.vel[2] + CARRY.up]);
      this.carried = null;
      return true;
    }
    // where the thumb wants it: `lift` px above the thumb, `height` over the ground there
    const rise = w.project(0, 0, 0)[1] - w.project(0, 0, 1)[1];
    const g = w.groundAt([drag.screenAt[0], drag.screenAt[1] - CARRY.lift + CARRY.height * rise]);
    const want: V3 = [g[0], g[1], w.floor(g[0], g[1]) + CARRY.height];
    if (c.want) for (let i = 0; i < 3; i++) c.wantVel[i] += ((want[i] - c.want[i]) / Math.max(dt, 1e-3) - c.wantVel[i]) * Math.min(1, dt * 15);
    c.want = want;
    const k = this.p.carrySpring;
    const damp = 2 * Math.sqrt(k) * CARRY.damp;
    for (let i = 0; i < 3; i++) c.vel[i] += (k * (want[i] - c.at[i]) - damp * c.vel[i]) * dt;
    const sp = Math.hypot(...c.vel);
    if (sp > this.p.carryMax) for (let i = 0; i < 3; i++) c.vel[i] *= this.p.carryMax / sp;
    const prev: V3 = [...c.at];
    for (let i = 0; i < 3; i++) c.at[i] += c.vel[i] * dt;
    this.smack(c, prev, hits);
    w.units.hold(c.id, [c.at[0], c.at[1], c.at[2] - UNIT_HEIGHT * 0.4]);
    return true;
  }

  /** What's carried, swung fast into an enemy or the ground: a blow to both. */
  private smack(c: NonNullable<LichHero['carried']>, prev: V3, hits: Hit[]): void {
    const w = this.world;
    const sp = Math.hypot(...c.vel);
    const h = Math.hypot(c.vel[0], c.vel[1]) || 1;
    const dir: V2 = [c.vel[0] / h, c.vel[1] / h];
    const hurtSelf = (k: number) => hits.push({ at: [c.at[0], c.at[1]], z: c.at[2], radius: 0.3, damage: sp * this.p.carryDamage * k });
    const ground = w.floor(c.at[0], c.at[1]);
    if (c.at[2] < ground + 0.2 && prev[2] >= w.floor(prev[0], prev[1]) + 0.2) {
      if (sp > CARRY.smack) {
        w.burst('chips', c.at[0], c.at[1], ground + 0.3, { count: 8, speed: sp * 0.2, spread: 0.4 });
        w.burst('dust', c.at[0], c.at[1], ground + 0.3, { count: 10, speed: 3, spread: 0.6 });
        w.blast(c.at[0], c.at[1], 2, 3 + sp * 0.2);
        hurtSelf(1);
      }
      c.at = [prev[0], prev[1], Math.max(prev[2], ground + 0.4)];
      for (let i = 0; i < 3; i++) c.vel[i] *= -CARRY.wall;
      return;
    }
    if (sp < CARRY.smack) return;
    for (const e of w.units.near(c.at[0], c.at[1], CARRY.reach)) {
      if (e.id === c.id || this.t - (c.struck.get(e.id) ?? -1e9) < CARRY.every) continue;
      if (c.at[2] < e.at[2] - 0.3 || c.at[2] > e.at[2] + UNIT_HEIGHT + 0.5) continue;
      c.struck.set(e.id, this.t);
      hits.push({ at: [e.at[0], e.at[1]], z: e.at[2] + 0.6, radius: 0.6, damage: sp * this.p.carryDamage, push: sp * CARRY.push, dir, lift: 3 });
      w.burst('dust', e.at[0], e.at[1], e.at[2] + 0.6, { count: 6, speed: 3, spread: 0.3 });
      hurtSelf(0.5);
    }
  }

  /** A gesture let go. */
  private power(act: Act, hits: Hit[]): void {
    const b = this.b;
    if (act.kind === 'circle') {
      if (act.turns >= 1.25) this.startStorm(act.ccw);
      return;
    }
    if (act.kind === 'tap') {
      const last = this.lastTap;
      const quick = last && this.t - last.t < PICK.double && this.at(last.id) ? last : null;
      const id = quick && Math.hypot(act.screen[0] - quick.screen[0], act.screen[1] - quick.screen[1]) < PICK.again ? quick.id : this.under(act.screen, act.at, act.self);
      const again = id !== null && !!quick && id === quick.id;
      this.lastTap = id !== null && !again ? { id, t: this.t, screen: act.screen } : null;
      if (id === null && act.self) return this.slam(hits);
      if (id !== null && again) this.faceToFace(id);
      else if (id !== null) this.lift(id);
      else this.goal = act.at;
      return;
    }
    const { dir } = act;
    const id = this.under(act.screen, act.from, act.self);
    if (id === null && act.self) return;
    if (id !== null) {
      this.forget(id);
      this.fling(id, dir, this.p.flingSpeed * (0.6 + 0.4 * act.power));
      this.world.gust(act.from[0], act.from[1], 3, 5, dir);
      return;
    }
    const away = (act.from[0] - b.x) * dir[0] + (act.from[1] - b.y) * dir[1] >= 0;
    if (away) this.launch(dir, act.power, hits);
    else this.pull([-dir[0], -dir[1]]);
  }

  /** Thrown from where it is along `dir`, bent onto an enemy along the way (the fling planner); returns who it's aimed at. */
  private fling(id: UnitId, dir: Pt, speed: number, avoid: number[] = []): number | null {
    const from = this.at(id);
    if (!from) return null;
    const others = this.targets(from[0], from[1], 30).filter((t) => t.id !== id);
    const scene = (list: typeof others) => ({ from, speed, cone: this.p.flingCone, range: 24, up: 3, gravity: UNIT_GRAVITY, targets: list, heightAt: this.world.floor });
    const intent = { kind: 'fling' as const, thing: id, dir: [dir[0], dir[1]] as [number, number], power: 1 };
    let planned = flingPlanner.plan(intent, scene(others.filter((t) => !avoid.includes(t.id))), FLING_ASSIST.moderate);
    if (planned.plan?.target === null) planned = flingPlanner.plan(intent, scene(others), FLING_ASSIST.moderate);
    const plan = planned.plan!;
    this.world.units.release(id, plan.vel);
    return plan.target;
  }

  /** Float it where it is. */
  private lift(id: UnitId): void {
    const p = this.at(id);
    if (!p || this.holding(id)) return;
    if (!this.room()) {
      if (!this.floats.length) return;
      this.drop(this.floats[0].id);
    }
    this.floats.push({ id, at: [p[0], p[1]], t: LIFT.time });
    this.world.gust(p[0], p[1], 2.5, 4, [0, 0]);
  }

  private faceToFace(id: UnitId): void {
    if (this.soul && this.soul.id !== id) this.drop(this.soul.id);
    this.forget(id);
    this.soul = { id, t: SOUL.every };
  }

  /** Face to face: held before the lich, its soul drawn out into the lich, till it's ash. */
  private drain(dt: number, hits: Hit[]): void {
    const s = this.soul;
    if (!s) return;
    const b = this.b;
    const e = this.world.units.get(s.id);
    if (!e || !e.alive) {
      this.soul = null;
      return;
    }
    const [c, n] = [Math.cos(b.heading), Math.sin(b.heading)];
    const face = b.z + SOUL.face;
    if (!this.world.units.hold(s.id, [b.x + c * SOUL.ahead, b.y + n * SOUL.ahead, face - UNIT_HEIGHT * 0.75])) {
      this.soul = null;
      return;
    }
    s.t -= dt;
    if (s.t <= 0) {
      s.t += SOUL.every;
      hits.push({ at: [e.at[0], e.at[1]], z: e.at[2] + 0.5, radius: 0.3, damage: this.p.soulDamage });
      this.hp = Math.min(this.maxHealth, this.hp + this.p.soulDamage * this.p.soulHeal);
      if (e.health <= this.p.soulDamage) this.world.burst('ash', e.at[0], e.at[1], e.at[2] + 0.8, { count: 24, speed: 1.5, spread: 0.6, vel: [0, 0, 1] });
    }
    if (Math.random() < dt * 24) {
      const from: V3 = [e.at[0], e.at[1], e.at[2] + UNIT_HEIGHT * 0.7];
      this.world.burst('sparks', from[0], from[1], from[2], { count: 1, speed: 0.2, spread: 0.15, vel: [(b.x - from[0]) * 2.5, (b.y - from[1]) * 2.5, (face - from[2]) * 2.5] });
    }
  }

  /** Away from the lich: whatever it holds flies that way, each at its own enemy; with nothing held, a force push. */
  private launch(dir: Pt, power: number, hits: Hit[]): void {
    const b = this.b;
    const all = this.held().filter((id) => id !== this.carried?.id);
    if (all.length) {
      const aimed: number[] = [];
      for (const id of all) {
        this.forget(id);
        const e = this.fling(id, dir, this.p.flingSpeed * (0.7 + 0.3 * power), aimed);
        if (e !== null) aimed.push(e);
      }
      this.storm = 0;
      for (const s of [0.3, 0.6]) this.world.gust(b.x + dir[0] * this.p.forceReach * s, b.y + dir[1] * this.p.forceReach * s, 3, 6, dir);
      return;
    }
    const push = this.p.forcePush * (0.5 + 0.5 * power);
    hits.push({ at: [b.x, b.y], radius: this.p.forceReach, damage: this.p.forceDamage, push, dir, lift: push * 0.25, cone: 0.6, axis: dir });
    for (const s of [0.3, 0.6, 0.9]) {
      const [x, y] = [b.x + dir[0] * this.p.forceReach * s, b.y + dir[1] * this.p.forceReach * s];
      this.world.gust(x, y, 2 + 2 * s, 7, dir);
      this.world.burst('dust', x, y, this.world.floor(x, y) + 0.3, { count: 6, speed: 4, spread: 0.5, vel: [dir[0] * 6, dir[1] * 6, 1] });
    }
    b.heading = Math.atan2(dir[1], dir[0]);
  }

  /** The wrecking ball: a crater under it, a ring of shove and throw, the air slammed out. */
  slam(hits: Hit[]): void {
    if (this.slamT > 0) return;
    const p = this.p;
    const b = this.b;
    this.slamT = p.slamEvery;
    const g = this.world.floor(b.x, b.y);
    if (p.slamCrater > 0) this.world.crater(b.x, b.y, p.slamCrater);
    hits.push({ at: [b.x, b.y], radius: p.slamReach, damage: p.slamDamage, push: p.slamPush, lift: p.slamLift, stun: 1 });
    this.world.blast(b.x, b.y, p.slamReach + 2, 12);
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      const r = p.slamReach * 0.5;
      const [x, y] = [b.x + Math.cos(a) * r, b.y + Math.sin(a) * r];
      this.world.burst('dust', x, y, this.world.floor(x, y) + 0.2, { count: 5, speed: 5, spread: 0.4, vel: [Math.cos(a) * 8, Math.sin(a) * 8, 2] });
    }
    this.world.burst('chips', b.x, b.y, g + 0.3, { count: 24, speed: 8, spread: 0.7 });
  }

  /** Toward the lich: what's in the cone that way comes in and circles it. */
  private pull(axis: Pt): void {
    const b = this.b;
    for (const e of this.world.units.near(b.x, b.y, PULL.reach)) {
      const dx = e.at[0] - b.x;
      const dy = e.at[1] - b.y;
      const d = Math.hypot(dx, dy);
      if (d > 0.5 && (dx * axis[0] + dy * axis[1]) / d >= Math.cos(PULL.cone)) this.circle(e.id);
    }
    for (const s of [0.9, 0.6, 0.3]) this.world.gust(b.x + axis[0] * PULL.reach * s, b.y + axis[1] * PULL.reach * s, 2 + 2 * s, 4, [-axis[0], -axis[1]]);
    b.heading = Math.atan2(axis[1], axis[0]);
  }

  private circle(id: UnitId): void {
    if (this.orbit.some((o) => o.id === id)) return;
    const p = this.at(id);
    if (!p) return;
    const wasFloating = this.floats.some((f) => f.id === id);
    if (!wasFloating && !this.room()) return;
    this.floats = this.floats.filter((f) => f.id !== id);
    this.orbit.push({ id, a: Math.atan2(p[1] - this.b.y, p[0] - this.b.x) });
    this.orbitT = ORBIT.time;
  }

  /** A circle drawn: the storm. The enemies near rise and circle. */
  private startStorm(ccw: boolean): void {
    const b = this.b;
    this.storm = this.p.stormTime;
    this.spin = ccw ? 1 : -1;
    this.goal = null;
    for (const e of this.world.units.near(b.x, b.y, this.p.stormReach)) this.circle(e.id);
    this.world.blast(b.x, b.y, this.p.stormReach, 6);
  }

  private forget(id: UnitId): void {
    if (this.soul?.id === id) this.soul = null;
    if (this.carried?.id === id) this.carried = null;
    this.floats = this.floats.filter((f) => f.id !== id);
    this.orbit = this.orbit.filter((o) => o.id !== id);
  }
  private drop(id: UnitId): void {
    this.forget(id);
    this.world.units.release(id, [0, 0, 0]);
  }
  /** let go of everything (the button; a respawn) */
  dropAll(): void {
    for (const id of this.held()) this.drop(id);
    this.storm = 0;
  }

  private keepFloats(dt: number): void {
    for (const f of [...this.floats]) {
      f.t -= dt;
      if (f.t <= 0 || !this.at(f.id)) {
        this.drop(f.id);
        continue;
      }
      const bob = Math.sin(this.t * 2 + f.at[0]) * LIFT.bob;
      if (!this.world.units.hold(f.id, [f.at[0], f.at[1], this.world.floor(f.at[0], f.at[1]) + LIFT.height + bob])) this.forget(f.id);
    }
  }

  private keepOrbit(dt: number): void {
    if (!this.orbit.length) return;
    const b = this.b;
    this.orbitT -= dt;
    if (this.orbitT <= 0) {
      for (const o of [...this.orbit]) this.drop(o.id);
      return;
    }
    const z = this.world.floor(b.x, b.y) + ORBIT.height;
    const n = this.orbit.length;
    for (const [i, o] of [...this.orbit].entries()) {
      if (!this.at(o.id)) {
        this.forget(o.id);
        continue;
      }
      const even = this.orbit[0].a + (i / n) * Math.PI * 2;
      o.a += this.spin * ORBIT.spin * dt + Math.atan2(Math.sin(even - o.a), Math.cos(even - o.a)) * dt;
      const r = ORBIT.radius + 0.4;
      if (!this.world.units.hold(o.id, [b.x + Math.cos(o.a) * r, b.y + Math.sin(o.a) * r, z + Math.sin(o.a * 2 + this.t) * 0.3])) this.forget(o.id);
    }
  }

  /** The storm round it: a swirl of wind held while it lasts, dust thrown up in a ring. */
  private stir(dt: number): void {
    const b = this.b;
    this.storm = Math.max(0, this.storm - dt);
    const swirl = { x: b.x, y: b.y, radius: ORBIT.radius + 3, strength: this.p.stormWind, counterClockwise: this.spin > 0, time: 0.2 };
    if (this.swirl?.alive) this.swirl.set(swirl);
    else this.swirl = this.world.blow({ ...swirl, mode: 'swirl' });
    if (Math.random() < dt * 40) {
      const a = Math.random() * Math.PI * 2;
      const r = ORBIT.radius * (0.6 + Math.random() * 0.9);
      const [x, y] = [b.x + Math.cos(a) * r, b.y + Math.sin(a) * r];
      this.world.burst('dust', x, y, this.world.floor(x, y) + 0.2, { count: 3, speed: 4, spread: 0.5, vel: [-Math.sin(a) * 5 * this.spin, Math.cos(a) * 5 * this.spin, 2] });
    }
  }

  /** Under it, always: a faint wind blowing out, pale motes rising off its robe. */
  private downdraft(dt: number): void {
    const b = this.b;
    const draft = { x: b.x, y: b.y, radius: DOWNDRAFT.radius, strength: DOWNDRAFT.strength, time: 0.2 };
    if (this.draft?.alive) this.draft.set(draft);
    else this.draft = this.world.blow({ ...draft, mode: 'out' });
    if (Math.random() < dt * DOWNDRAFT.motes) {
      const a = Math.random() * Math.PI * 2;
      this.world.burst('sparks', b.x + Math.cos(a) * 0.4, b.y + Math.sin(a) * 0.4, b.z + 0.2, { count: 1, speed: 0.2, spread: 0.2, vel: [0, 0, 0.6] });
    }
  }

  parts(): Part[] {
    const b = this.b;
    const lean = Math.min(0.25, speedOf(b) * 0.03);
    const q = qMul(qAxis([0, 0, 1], b.heading), qAxis([0, -1, 0], -lean));
    return [{ voxels: VOXELS, at: [b.x, b.y, b.z + Math.sin(this.t * 1.6) * 0.04], q, flash: this.hurtT < 0.12 ? 1 : 0 }];
  }

  looks(): ButtonLook[] {
    return [{ gauge: 1 - this.slamT / Math.max(this.p.slamEvery, 1e-3) }, { lit: this.held().length > 0 }];
  }

  status(): string {
    if (this.storm > 0) return `STORM · ${this.orbit.length} circling`;
    if (this.carried) return 'CARRYING';
    if (this.soul) return `FACE TO FACE · ${this.hp.toFixed(1)}/${this.maxHealth}`;
    if (this.orbit.length) return `${this.orbit.length} circling`;
    if (this.floats.length) return `${this.floats.length} floating`;
    return `levitating · ${this.hover.toFixed(1)} up`;
  }
}
