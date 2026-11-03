// ---- play/heroes/knight.ts --------------------------------------------------------------------------------------
// (knight, round 128) The knight: on foot with a sword and a bow (ported from GameplayGM runtimes/iso-adventure, branch
// runtime/iso-adventure: the feel and the numbers — src/sim/combat.ts, src/sim/data/weapons.ts, src/sim/lab/momentum.ts,
// src/app/gestures.ts — not its architecture). Its numbers are the live Params (controllers/knight.ts KNIGHT_PARAMS).
//   move    the left stick: a run (core/foot.ts), snappy, that never stops for a swing (the swing keeps 0.9 of it)
//   sword   a swipe anywhere else slashes that way the moment it's long enough, the knight lunging into it and the
//           swipe leaned a little toward the enemy it most likely means (core/aim.ts leanAim); swipe again as a swing
//           ends to chain the combo (light, light, a wide finisher); two quick swipes the same way: the lunge, a
//           dash-strike that way
//   spin    draw a circle (or ✦): a spinning top, the blade swept round, cutting what it touches and caroming off
//           bodies and walls; drag and let go while it spins to flick it that way (iso-adventure's spin flick)
//   bow     ⇄ to it: pull back from anywhere and let go — the arrow flies the opposite way, as fast and hard as it was
//           drawn (a full draw takes 0.7 s, and the pull's length caps it); the aim sticks a little over an enemy; a
//           quick long flick on the bow is a roll; ✦ with the bow: a volley of three
//   dodge   DODGE: a dash the stick's way (or the way it faces) that blows pass through
// What it deals goes to the units as AreaHits (knock, a little throw, the agents' stun status); the raiders hit back
// through its Actor.

import type { V2, V3 } from '../../api/contracts/units';
import { leanAim } from '../core/aim';
import { carom, makeFoot, speedOf, stepFoot, type Foot, type FootTuning, type SlideTuning } from '../core/foot';
import type { Pt } from '../core/gestures';
import { isDouble, StickyAim, STICKY, ThumbReader, type ThumbEvent, type ThumbMode } from '../core/swordplay';
import { KNIGHT_BODY, KNIGHT_CAMERA, KNIGHT_DEFAULTS, type KnightParams } from '../controllers/knight';
import { PosedBody } from '../draw/rigpose';
import { BOW, buildArrow, buildBow, buildSword, qAxis, qMul, SWORD_LENGTH, type Part } from '../draw/shapes';
import { onGround, type ButtonLook, type Pad, type PlayInput, type Thumb } from '../input/types';
import type { PlayWorld } from '../world';
import { MAT } from '../../world/materials';
import { PlayHero, type Hit, type Target } from './base';

export type Arm = 'sword' | 'bow';

const SWORD = buildSword();
const BOW_VOXELS = buildBow();
const ARROW = buildArrow();

/** the hand's height when it swings (cells over the feet), a body's radius (cells), the blade's trail */
const HAND = 1.15;
const BODY = 0.45;
const TRAIL = { life: 0.18, per: 4, size: 0.2 };
/** arrows: how long one flies (s) and how near it passes a body to hit it (cells) */
const ARROW_LIFE = 1.6;
const ARROW_HIT = 0.5;

/** One swing of the combo: its times, reach, arc, blow and lunge (from KnightParams). */
interface SwingDef {
  windup: number;
  active: number;
  recovery: number;
  range: number;
  arc: number;
  damage: number;
  knock: number;
  lunge: number;
  stun: number;
}

type Act =
  | { kind: 'idle' }
  | { kind: 'swing'; phase: 'windup' | 'active' | 'recovery'; t: number; n: number; lunge: boolean; dir: Pt; cut: Set<number>; queued: { dir: Pt; lunge: boolean }[] }
  | { kind: 'dodge'; t: number }
  | { kind: 'draw'; charge: number; dir: Pt; cap: number; reader: number }
  | { kind: 'spin'; fuel: number; hit: Map<number, number> };

interface Arrow {
  at: V3;
  vel: V3;
  t: number;
  damage: number;
  knock: number;
}

export class KnightHero extends PlayHero {
  readonly f: Foot;
  readonly camera = KNIGHT_CAMERA;
  readonly pad: Pad = {
    move: 'stick',
    buttons: [
      { icon: '💨', name: 'dodge' },
      { icon: '⇄', name: 'bow' },
      { icon: '🌀', name: 'spin' },
    ],
    // (player text: docs/WRITING.md on dialog2 — plain words, one idea a sentence)
    hint: 'Run with your left thumb. Swipe to slash. Swipe twice fast to lunge. Draw a circle to spin. While you spin, drag and let go to fly that way. Tap BOW to switch. Pull back and let go to shoot.',
  };
  arm: Arm = 'sword';
  act: Act = { kind: 'idle' };
  private readers = new Map<number, { r: ThumbReader; seen: number }>();
  private lastStrike: { dir: Pt; t: number } | null = null;
  private prevButtons: boolean[] = [];
  private cool = { dodge: 0, bow: 0, spin: 0, volley: 0 };
  private iframes = 0;
  private sticky = new StickyAim();
  readonly arrows: Arrow[] = [];
  private trail: { base: V3; tip: V3; t: number }[] = [];
  private body = new PosedBody(KNIGHT_BODY);
  private phase = 0;
  /** what it's done (the station's readout): blows landed, swings, arrows loosed and landed, spins, dodges, best speed */
  readonly stats = { hits: 0, swings: 0, lunges: 0, arrows: 0, arrowHits: 0, spins: 0, bounces: 0, dodges: 0, best: 0 };
  /** seconds since a blow landed (the HUD's HIT) */
  hitT = 99;
  /** the last swipe as read: its way on the ground, as swiped and as leaned (a test and the debug line read it) */
  lastAim: { swiped: Pt; aimed: Pt; target: number | null } | null = null;

  constructor(world: PlayWorld, at: V2, params: KnightParams = { ...KNIGHT_DEFAULTS }) {
    super('knight', world, params, params.health);
    this.f = makeFoot(at[0], at[1], world.floor);
  }

  get p(): KnightParams {
    return this.params as unknown as KnightParams;
  }
  private get foot(): FootTuning {
    const p = this.p;
    return { speed: p.speed, accel: p.accel, friction: p.friction, step: p.step, slope: p.slope, gravity: p.gravity, wade: 1.2, wadeMul: 0.6 };
  }
  private get slide(): SlideTuning {
    const p = this.p;
    return { drag: p.spinDrag, decel: p.spinDecel, restitution: p.spinBounce, steer: p.spinSteer, max: p.speed };
  }

  position(): V3 {
    return [this.f.x, this.f.y, this.f.z];
  }
  heading(): number {
    return this.f.heading;
  }
  speed(): number {
    return speedOf(this.f);
  }
  profileClimb(): number {
    return this.p.slope;
  }
  fast(): number {
    return Math.min(1, speedOf(this.f) / Math.max(1, this.p.speed * 2));
  }
  place(at: V2): void {
    Object.assign(this.f, makeFoot(at[0], at[1], this.world.floor));
    this.act = { kind: 'idle' };
    this.readers.clear();
    this.arrows.length = 0;
  }
  shift(dx: number, dy: number, dz: number): void {
    this.f.x += dx;
    this.f.y += dy;
    this.f.z += dz;
    for (const a of this.arrows) a.at = [a.at[0] + dx, a.at[1] + dy, a.at[2] + dz];
    for (const r of this.trail) {
      r.base = [r.base[0] + dx, r.base[1] + dy, r.base[2] + dz];
      r.tip = [r.tip[0] + dx, r.tip[1] + dy, r.tip[2] + dz];
    }
  }

  /** a blow from an enemy: passed through while dodging (its i-frames) */
  take(damage: number, from: V2): void {
    if (this.iframes > 0) return;
    super.take(damage, from);
  }
  protected knock(from: V2, _damage: number): void {
    const dx = this.f.x - from[0];
    const dy = this.f.y - from[1];
    const l = Math.hypot(dx, dy) || 1;
    this.f.vx += (dx / l) * 5;
    this.f.vy += (dy / l) * 5;
  }

  // ---- each step ------------------------------------------------------------------------------------------------

  protected step(input: PlayInput, dt: number, hits: Hit[]): void {
    const p = this.p;
    const f = this.f;
    this.hitT += dt;
    this.iframes = Math.max(0, this.iframes - dt);
    for (const k of ['dodge', 'bow', 'spin', 'volley'] as const) this.cool[k] = Math.max(0, this.cool[k] - dt);
    // the buttons, on the press: DODGE, ⇄ sword or bow, ✦ the weapon's second move
    const b = input.buttons;
    const pressed = (i: number) => !!b[i] && !this.prevButtons[i];
    if (pressed(0)) this.dodge(input.dir);
    if (pressed(1)) this.swap();
    if (pressed(2)) {
      if (this.arm === 'sword') this.spin();
      else this.volley();
    }
    this.prevButtons = [...b];
    // the right thumb, read as it's drawn
    const basis = input.basis ?? [[1, 0], [0, 1]];
    for (const th of input.thumbs ?? []) this.read(th, basis);
    this.drawBow(dt);
    this.swingStep(dt, hits);
    // the run
    const s = input.dir;
    const a = this.act;
    let mul = 1;
    if (a.kind === 'swing') mul = p.swingMove;
    else if (a.kind === 'draw') mul = p.bowMove;
    const want: Pt = a.kind === 'dodge' ? [f.vx, f.vy] : a.kind === 'spin' ? s : [s[0] * p.speed * mul, s[1] * p.speed * mul];
    stepFoot(f, want, dt, this.world.floor, this.world.depth, this.world.bounds, this.foot, a.kind === 'spin' ? this.slide : null);
    if (f.landed > 8) {
      this.shake = Math.max(this.shake, Math.min(0.6, f.landed / 30));
      this.world.burst('dust', f.x, f.y, f.z + 0.1, { count: 10, speed: 2.5, spread: 0.7 });
    }
    if (a.kind === 'dodge') {
      a.t += dt;
      if (a.t >= p.dodgeTime) this.act = { kind: 'idle' };
    }
    if (a.kind === 'spin') this.spinStep(dt, hits, f.wall !== null);
    // which way it faces: the swing's, the bow's aim, the spin's own turn, or the way it runs
    if (a.kind === 'swing') this.face(Math.atan2(a.dir[1], a.dir[0]), dt, 30);
    else if (a.kind === 'draw') this.face(Math.atan2(a.dir[1], a.dir[0]), dt, 20);
    else if (a.kind === 'spin') f.heading += p.spinRate * dt;
    else if (speedOf(f) > 0.6) this.face(Math.atan2(f.vy, f.vx), dt, 14);
    const sp = speedOf(f);
    this.phase += dt * Math.min(sp, p.speed * 1.2) / Math.max(0.2, this.body.rig.stride * 0.55) * 1.1;
    // (its run's best: not a lunge, a dodge or the spin's flick)
    if (this.act.kind === 'idle' && f.air === 0 && sp <= this.p.speed * 1.2) this.stats.best = Math.max(this.stats.best, sp);
    this.flyArrows(dt, hits);
  }

  private face(want: number, dt: number, rate: number): void {
    const d = Math.atan2(Math.sin(want - this.f.heading), Math.cos(want - this.f.heading));
    this.f.heading += d * Math.min(1, dt * rate);
  }

  /** a stroke's new samples into its reader (made when it went down, for what's in hand then), its events acted on */
  private read(th: Thumb, basis: [Pt, Pt]): void {
    let rd = this.readers.get(th.id);
    if (!rd) {
      if (!th.samples.length) return;
      const mode: ThumbMode = this.act.kind === 'spin' ? 'fling' : this.arm;
      rd = { r: new ThumbReader(mode, th.samples[0]), seen: 1 };
      this.readers.set(th.id, rd);
      if (mode === 'bow') this.sticky.reset();
    }
    for (; rd.seen < th.samples.length; rd.seen++) rd.r.move(th.samples[rd.seen]);
    if (th.ended) {
      rd.r.end({ at: rd.r.at.at, t: Math.max(rd.r.at.t, th.endedAt ?? rd.r.at.t) });
      this.readers.delete(th.id);
    }
    const r = rd.r;
    // (the bow while drawn: the aim, opposite the pull, on the ground and sticking over an enemy; the draw's cap)
    if (r.mode === 'bow' && r.drawing && this.arm === 'bow' && (this.act.kind === 'idle' || (this.act.kind === 'draw' && this.act.reader === th.id))) {
      const g = onGround(basis, r.drawing.dir);
      const dir = this.stick(g);
      if (this.act.kind === 'draw') {
        this.act.dir = dir;
        this.act.cap = r.drawing.draw;
      } else if (this.cool.bow <= 0) this.act = { kind: 'draw', charge: 0, dir, cap: r.drawing.draw, reader: th.id };
    }
    for (const e of r.drain()) this.event(e, basis, th.id);
  }

  private event(e: ThumbEvent, basis: [Pt, Pt], reader: number): void {
    switch (e.kind) {
      case 'strike': {
        if (this.arm !== 'sword') return;
        const swiped = onGround(basis, e.dir);
        const lunge = isDouble(this.lastStrike, e);
        this.lastStrike = { dir: e.dir, t: e.t };
        this.strike(swiped, lunge);
        return;
      }
      case 'spin':
        return this.spin();
      case 'fling':
        return this.flick(onGround(basis, e.dir), e.power);
      case 'roll':
        if (this.act.kind === 'draw') this.act = { kind: 'idle' };
        return this.dodge(onGround(basis, e.dir));
      case 'loose':
        if (this.act.kind === 'draw' && this.act.reader === reader) this.loose();
        return;
      case 'tap':
        return;
    }
  }

  // ---- the sword ------------------------------------------------------------------------------------------------

  /** a swing by its place in the combo (0, 1 light; 2 the finisher), or the lunge */
  private swingDef(n: number, lunge: boolean): SwingDef {
    const p = this.p;
    if (lunge) return { windup: p.lungeWindup, active: p.lungeActive, recovery: p.lungeRecovery, range: p.lungeRange, arc: p.lungeArc, damage: p.lungeDamage, knock: p.lungeKnock, lunge: p.lungeSpeed, stun: p.lungeStun };
    if (n >= 2) return { windup: p.finWindup, active: p.finActive, recovery: p.finRecovery, range: p.finRange, arc: p.finArc, damage: p.finDamage, knock: p.finKnock, lunge: p.finLunge, stun: p.finStun };
    return { windup: p.slashWindup, active: p.slashActive, recovery: p.slashRecovery, range: p.slashRange, arc: p.slashArc, damage: p.slashDamage, knock: p.slashKnock, lunge: p.slashLunge, stun: p.slashStun };
  }

  /** the swipe's way, leaned toward the enemy it most likely means */
  private aim(swiped: Pt): Pt {
    const p = this.p;
    const tg = this.targets(this.f.x, this.f.y, p.aimRange + 2);
    const l = leanAim([this.f.x, this.f.y], swiped, tg.map((t) => [t.at[0], t.at[1]] as Pt), p.aimCone, p.aimRange, p.aimLean);
    this.lastAim = { swiped, aimed: l.dir, target: l.i === null ? null : tg[l.i].id };
    return l.dir;
  }

  /** A swipe: a swing that way (or queued to chain, or the lunge). */
  private strike(swiped: Pt, lunge: boolean): void {
    const a = this.act;
    if (a.kind === 'dodge' || a.kind === 'draw') return;
    if (a.kind === 'spin') return;
    const dir = this.aim(swiped);
    if (a.kind === 'swing') {
      // (swiped again mid-swing: queued, to chain when the recovery allows — iso-adventure took it only once the blade
      // was out; a thumb's second swipe can come sooner, and dropping it reads as a missed slash)
      if (a.queued.length < 2) a.queued.push({ dir, lunge });
      return;
    }
    this.startSwing(0, dir, lunge);
  }

  private startSwing(n: number, dir: Pt, lunge: boolean, queued: { dir: Pt; lunge: boolean }[] = []): void {
    this.act = { kind: 'swing', phase: 'windup', t: 0, n, lunge, dir, cut: new Set(), queued };
    this.stats.swings++;
    if (lunge) this.stats.lunges++;
  }

  /** The swing in progress (combat.ts's phases): the lunge forward as it cuts, the blade's arc, the chain. */
  private swingStep(dt: number, hits: Hit[]): void {
    const a = this.act;
    if (a.kind !== 'swing') return;
    const d = this.swingDef(a.n, a.lunge);
    a.t += dt;
    if (a.phase === 'windup' && a.t >= d.windup) {
      a.phase = 'active';
      a.t = 0;
      // the lunge: an impulse along the swing (core/foot.ts bleeds what's over the run)
      this.f.vx += a.dir[0] * d.lunge;
      this.f.vy += a.dir[1] * d.lunge;
      this.world.burst('dust', this.f.x, this.f.y, this.f.z + 0.1, { count: a.lunge ? 10 : 4, speed: 2, spread: 0.6 });
    }
    if (a.phase === 'active') {
      this.cut(a, d, hits);
      if (a.t >= d.active) {
        a.phase = 'recovery';
        a.t = 0;
      }
    } else if (a.phase === 'recovery') {
      const q = a.queued[0];
      // (a double swipe lunges; a swipe chains the next of the combo, from the finisher back to the first)
      // (iso-adventure combat.ts: the finisher doesn't chain — a swipe during its recovery starts the combo over when it ends)
      // (two swipes can wait: a quick string of them is as many swings)
      const rest = a.queued.slice(1);
      if (q && (q.lunge || a.n < 2) && a.t >= d.recovery * this.p.chainAt) {
        this.startSwing(q.lunge ? 0 : a.n + 1, q.dir, q.lunge, rest);
      } else if (a.t >= d.recovery) {
        this.act = { kind: 'idle' };
        if (q) this.startSwing(0, q.dir, false, rest);
      }
    }
  }

  /** The blade's cut while active: what's in its reach and arc is hit, once a swing. */
  private cut(a: Extract<Act, { kind: 'swing' }>, d: SwingDef, hits: Hit[]): void {
    const f = this.f;
    const facing = Math.atan2(a.dir[1], a.dir[0]);
    const [base, tip] = this.bladeAt(a, d);
    this.trail.push({ base, tip, t: this.t });
    for (const e of this.targets(f.x, f.y, d.range + 2)) {
      if (a.cut.has(e.id)) continue;
      const dx = e.at[0] - f.x;
      const dy = e.at[1] - f.y;
      const dist = Math.hypot(dx, dy);
      if (dist - e.radius > d.range) continue;
      const off = Math.abs(Math.atan2(Math.sin(Math.atan2(dy, dx) - facing), Math.cos(Math.atan2(dy, dx) - facing)));
      if (dist > 0.3 && off > d.arc / 2) continue;
      if (Math.abs(e.at[2] - f.z) > 2.5) continue;
      a.cut.add(e.id);
      const n: Pt = dist > 1e-3 ? [dx / dist, dy / dist] : a.dir;
      this.blow(e, hits, d.damage, d.knock, n, this.p.slashLift * (a.n >= 2 || a.lunge ? 1.5 : 1), d.stun);
    }
  }

  /** a blow landed on `e`: the AreaHit, sparks, a jolt */
  private blow(e: Target, hits: Hit[], damage: number, push: number, dir: Pt, lift: number, stun: number): void {
    const mid: V3 = [e.at[0], e.at[1], e.at[2] + e.height * 0.5];
    hits.push({ at: [e.at[0], e.at[1]], z: mid[2], radius: 0.6, damage, push, dir, lift, stun });
    this.world.burst('sparks', mid[0], mid[1], mid[2], { count: 16, speed: 5, spread: 0.7, vel: [dir[0] * 5, dir[1] * 5, 2] });
    this.world.burst('dust', e.at[0], e.at[1], e.at[2] + 0.3, { count: 6, speed: 2.5, spread: 0.6 });
    this.stats.hits++;
    this.hitT = 0;
    this.shake = Math.max(this.shake, 0.35);
  }

  /** the blade's hilt and tip through a swing: swept across the arc, from one side to the other */
  private bladeAt(a: Extract<Act, { kind: 'swing' }>, d: SwingDef): [V3, V3] {
    const f = this.f;
    const yaw = this.sweep(a, d);
    const hand: V3 = [f.x + Math.cos(yaw) * 0.5, f.y + Math.sin(yaw) * 0.5, f.z + HAND];
    const r = Math.min(d.range, SWORD_LENGTH + 0.6);
    return [hand, [hand[0] + Math.cos(yaw) * r, hand[1] + Math.sin(yaw) * r, hand[2] - 0.15]];
  }

  /** the blade's angle at this moment of the swing (the arc swept right to left, alternating each swing) */
  private sweep(a: Extract<Act, { kind: 'swing' }>, d: SwingDef): number {
    const facing = Math.atan2(a.dir[1], a.dir[0]);
    const u = a.phase === 'windup' ? 0 : a.phase === 'active' ? Math.min(1, a.t / d.active) : 1;
    const side = a.n % 2 === 0 ? 1 : -1;
    if (a.lunge) return facing;
    return facing + side * (0.5 - u) * Math.min(d.arc, 2.6);
  }

  // ---- the spin -------------------------------------------------------------------------------------------------

  /** A circle drawn (or ✦): a spinning top from where it stands (iso-adventure's sword spin: speed 0 to start). */
  private spin(): void {
    if (this.arm !== 'sword' || this.cool.spin > 0) return;
    if (this.act.kind === 'spin' || this.act.kind === 'dodge') return;
    this.f.vx = 0;
    this.f.vy = 0;
    this.act = { kind: 'spin', fuel: this.p.spinTime, hit: new Map() };
    this.cool.spin = this.p.spinEvery;
    this.stats.spins++;
    this.world.blast(this.f.x, this.f.y, 4, 6);
    this.world.burst('dust', this.f.x, this.f.y, this.f.z + 0.1, { count: 14, speed: 3, spread: 0.9 });
  }

  /** Spinning, drag and let go: flicked that way, as hard as the drag was long; it keeps spinning a while more. */
  private flick(dir: Pt, power: number): void {
    const a = this.act;
    if (a.kind !== 'spin') return;
    const p = this.p;
    const v = p.spinFlickLow + (p.spinFlickHigh - p.spinFlickLow) * power;
    this.f.vx = dir[0] * v;
    this.f.vy = dir[1] * v;
    a.fuel = Math.max(a.fuel, p.spinFlickFuel);
    this.world.burst('dust', this.f.x, this.f.y, this.f.z + 0.1, { count: 8, speed: 3, spread: 0.6 });
  }

  /** The spin: caroms off bodies (and walls: core/foot.ts), the blade cutting what's within its reach. */
  private spinStep(dt: number, hits: Hit[], walled: boolean): void {
    const a = this.act;
    if (a.kind !== 'spin') return;
    const p = this.p;
    const f = this.f;
    a.fuel -= dt;
    if (walled && speedOf(f) > 3) {
      this.shake = Math.max(this.shake, 0.3);
      this.world.burst('chips', f.x, f.y, f.z + 0.5, { count: 6, speed: 3, spread: 0.6 });
    }
    // (the blade's circle, drawn as a trail round it)
    const yaw = f.heading;
    const hand: V3 = [f.x + Math.cos(yaw) * 0.4, f.y + Math.sin(yaw) * 0.4, f.z + HAND - 0.2];
    this.trail.push({ base: hand, tip: [f.x + Math.cos(yaw) * (BODY + p.spinReach + 0.3), f.y + Math.sin(yaw) * (BODY + p.spinReach + 0.3), hand[2]], t: this.t });
    for (const e of this.targets(f.x, f.y, BODY + p.spinReach + 2)) {
      if (Math.abs(e.at[2] - f.z) > 2.5) continue;
      const sp = speedOf(f);
      // met and closing: carom off (a top bouncing off them) — at the blade's edge, not only body to body: its blow
      // shoves them off first, and the units' positions are a frame or two old, so a body-only carom seldom happened
      if (carom(f, [e.at[0], e.at[1]], BODY + e.radius + p.spinTouch, p.spinBounce)) {
        this.stats.bounces++;
        this.shake = Math.max(this.shake, 0.25);
      }
      const dx = e.at[0] - f.x;
      const dy = e.at[1] - f.y;
      const d = Math.hypot(dx, dy);
      if (d > BODY + e.radius + p.spinReach) continue;
      const last = a.hit.get(e.id);
      if (last !== undefined && this.t - last < p.spinRehit) continue;
      a.hit.set(e.id, this.t);
      const n: Pt = d > 1e-3 ? [dx / d, dy / d] : [Math.cos(yaw), Math.sin(yaw)];
      this.blow(e, hits, Math.max(1, Math.round(p.spinDamage + sp * p.spinPerSpeed)), p.spinKnock + sp * p.spinKnockPerSpeed, n, 1.5, p.spinStun);
    }
    if (a.fuel <= 0) this.act = { kind: 'idle' };
  }

  // ---- the bow --------------------------------------------------------------------------------------------------

  /** the bow's aim, sticking a little over an enemy in reach */
  private stick(dir: Pt): Pt {
    const f = this.f;
    const angles = this.targets(f.x, f.y, STICKY.range).map((t) => Math.atan2(t.at[1] - f.y, t.at[0] - f.x));
    const a = this.sticky.update(Math.atan2(dir[1], dir[0]), angles);
    return [Math.cos(a), Math.sin(a)];
  }

  private drawBow(dt: number): void {
    const a = this.act;
    if (a.kind !== 'draw') return;
    // (the draw grows with time, capped by how far the string's pulled: easing back lowers it)
    a.charge = Math.min(a.cap, a.charge + dt / this.p.bowDraw);
    // (the stroke that drew it is gone without a loose — a cancelled touch: the draw's dropped)
    if (!this.readers.has(a.reader)) this.act = { kind: 'idle' };
  }

  /** let go: an arrow along the aim, as fast and hard as it was drawn (below bowMin it fizzles) */
  private loose(): void {
    const a = this.act;
    if (a.kind !== 'draw') return;
    this.act = { kind: 'idle' };
    const p = this.p;
    if (a.charge < p.bowMin) return;
    this.shoot(a.dir, a.charge);
    this.cool.bow = p.bowEvery;
  }

  private shoot(dir: Pt, k: number): void {
    const p = this.p;
    const f = this.f;
    const v = p.arrowSlow + (p.arrowFast - p.arrowSlow) * k;
    this.arrows.push({
      at: [f.x + dir[0] * 0.5, f.y + dir[1] * 0.5, f.z + HAND + 0.15],
      vel: [dir[0] * v, dir[1] * v, 0],
      t: 0,
      damage: p.arrowDamageLow + (p.arrowDamageHigh - p.arrowDamageLow) * k,
      knock: p.arrowKnockLow + (p.arrowKnockHigh - p.arrowKnockLow) * k,
    });
    this.stats.arrows++;
  }

  /** ✦ with the bow: a fan of arrows the way it faces, at a full draw */
  private volley(): void {
    if (this.cool.volley > 0 || this.act.kind === 'dodge') return;
    const p = this.p;
    const n = Math.max(1, Math.round(p.volleyArrows));
    // (aimed at the nearest enemy ahead, or the way it faces)
    const h = this.f.heading;
    const tg = this.targets(this.f.x, this.f.y, STICKY.range);
    let a = h;
    let best = Infinity;
    for (const t of tg) {
      const b = Math.atan2(t.at[1] - this.f.y, t.at[0] - this.f.x);
      const off = Math.abs(Math.atan2(Math.sin(b - h), Math.cos(b - h)));
      if (off < 1 && off < best) [best, a] = [off, b];
    }
    for (let i = 0; i < n; i++) {
      const o = n === 1 ? 0 : (i / (n - 1) - 0.5) * 2 * p.volleySpread;
      this.shoot([Math.cos(a + o), Math.sin(a + o)], 1);
    }
    this.f.heading = a;
    this.cool.volley = p.volleyEvery;
    if (this.act.kind === 'draw') this.act = { kind: 'idle' };
  }

  private flyArrows(dt: number, hits: Hit[]): void {
    const tg = this.arrows.length ? this.targets(this.f.x, this.f.y, 60) : [];
    for (let i = this.arrows.length - 1; i >= 0; i--) {
      const r = this.arrows[i];
      const from = r.at;
      r.t += dt;
      r.at = [from[0] + r.vel[0] * dt, from[1] + r.vel[1] * dt, from[2] + r.vel[2] * dt];
      let gone = r.t > ARROW_LIFE || this.world.floor(r.at[0], r.at[1]) > r.at[2];
      if (!gone)
        for (const e of tg) {
          // (a body is a standing column: passed within its radius over the ground, between its feet and its head)
          if (r.at[2] < e.at[2] - 0.2 || r.at[2] > e.at[2] + e.height + 0.2) continue;
          if (segDist([e.at[0], e.at[1], 0], [from[0], from[1], 0], [r.at[0], r.at[1], 0]) > ARROW_HIT + e.radius * 0.5) continue;
          const sp = Math.hypot(r.vel[0], r.vel[1]) || 1;
          this.blow(e, hits, r.damage, r.knock, [r.vel[0] / sp, r.vel[1] / sp], 1, 0.2);
          this.stats.arrowHits++;
          gone = true;
          break;
        }
      if (gone) {
        if (r.t <= ARROW_LIFE) this.world.burst('chips', r.at[0], r.at[1], r.at[2], { count: 4, speed: 2, spread: 0.6 });
        this.arrows.splice(i, 1);
      }
    }
  }

  // ---- weapons, the dodge ---------------------------------------------------------------------------------------

  /** ⇄: the sword or the bow (not mid-swing or mid-spin: the swap waits for it to finish) */
  private swap(): void {
    if (this.act.kind === 'swing' || this.act.kind === 'spin') return;
    this.arm = this.arm === 'sword' ? 'bow' : 'sword';
    if (this.act.kind === 'draw') this.act = { kind: 'idle' };
  }

  /** DODGE: a dash the given way (or the way it faces), blows passing through for a moment */
  private dodge(dir: Pt): void {
    const p = this.p;
    if (this.cool.dodge > 0) return;
    let [dx, dy] = dir;
    const l = Math.hypot(dx, dy);
    if (l < 0.1) [dx, dy] = [Math.cos(this.f.heading), Math.sin(this.f.heading)];
    else [dx, dy] = [dx / l, dy / l];
    this.act = { kind: 'dodge', t: 0 };
    this.cool.dodge = p.dodgeEvery + p.dodgeTime;
    this.iframes = Math.max(this.iframes, p.dodgeGuard);
    this.f.vx = dx * p.dodgeSpeed;
    this.f.vy = dy * p.dodgeSpeed;
    this.f.heading = Math.atan2(dy, dx);
    this.stats.dodges++;
    this.world.burst('dust', this.f.x, this.f.y, this.f.z + 0.1, { count: 8, speed: 2.5, spread: 0.6 });
  }

  // ---- looks ----------------------------------------------------------------------------------------------------

  parts(): Part[] {
    const f = this.f;
    const a = this.act;
    const flash = this.hurtT < 0.12 ? 1 : this.iframes > 0 ? 0.3 : 0;
    const sp = speedOf(f);
    const fwd: Pt = [Math.cos(f.heading), Math.sin(f.heading)];
    const left: Pt = [-fwd[1], fwd[0]];
    const at = (k: number, l: number, u: number): V3 => [f.x + fwd[0] * k + left[0] * l, f.y + fwd[1] * k + left[1] * l, f.z + u];
    let handR: V3 | null = null;
    let handL: V3 | null = null;
    let lean = 0;
    let crouch = 0;
    let twist = 0;
    const out: Part[] = [];
    if (this.arm === 'sword') {
      let yaw: number;
      let pitch = 0.35;
      if (a.kind === 'swing') {
        const d = this.swingDef(a.n, a.lunge);
        yaw = this.sweep(a, d);
        pitch = a.lunge ? 0.05 : 0.15;
        lean = a.lunge ? 0.35 : 0.15;
        twist = Math.atan2(Math.sin(yaw - f.heading), Math.cos(yaw - f.heading)) * 0.4;
        handR = [f.x + Math.cos(yaw) * 0.55, f.y + Math.sin(yaw) * 0.55, f.z + HAND];
      } else if (a.kind === 'spin') {
        // (held straight out to the side, swept round with the turn)
        yaw = f.heading - Math.PI / 2;
        pitch = 0;
        handR = [f.x + Math.cos(yaw) * 0.6, f.y + Math.sin(yaw) * 0.6, f.z + HAND - 0.15];
      } else {
        // (held low and forward at its right side)
        yaw = f.heading - 0.25;
        handR = at(0.25, -0.38, HAND - 0.35);
      }
      if (handR) out.push({ voxels: SWORD, at: handR, q: qMul(qAxis([0, 0, 1], yaw), qAxis([0, 1, 0], pitch)), flash: this.hitT < 0.08 ? 0.6 : 0 });
    } else {
      // the bow in the left hand toward the aim; the right hand pulls the string back as far as it's drawn
      const aimA = a.kind === 'draw' ? Math.atan2(a.dir[1], a.dir[0]) : f.heading;
      const charge = a.kind === 'draw' ? a.charge : 0;
      const ax: Pt = [Math.cos(aimA), Math.sin(aimA)];
      handL = [f.x + ax[0] * 0.6, f.y + ax[1] * 0.6, f.z + HAND + 0.15];
      handR = [handL[0] - ax[0] * (0.15 + 0.45 * charge), handL[1] - ax[1] * (0.15 + 0.45 * charge), handL[2]];
      lean = a.kind === 'draw' ? 0.1 : 0;
      out.push({ voxels: BOW_VOXELS, at: handL, q: qAxis([0, 0, 1], aimA), size: 0.2 });
      // the string, tip to hand to tip
      const top: V3 = [handL[0] - ax[0] * BOW.back, handL[1] - ax[1] * BOW.back, handL[2] + BOW.half];
      const bot: V3 = [top[0], top[1], handL[2] - BOW.half];
      out.push(line([top, handR, bot], MAT.Canvas, 0.06));
      if (a.kind === 'draw') out.push({ voxels: ARROW, at: [handR[0], handR[1], handR[2] - 0.06], q: qAxis([0, 0, 1], aimA), size: 0.17 });
    }
    if (a.kind === 'dodge') {
      crouch = 0.25;
      lean = 0.45;
    }
    this.body.pose({ at: [f.x, f.y, f.z], heading: f.heading, pace: Math.min(1, sp / Math.max(1, this.p.speed)), phase: this.phase, vel: [f.vx, f.vy, f.vz], floor: this.world.floor, handR, handL, lean, twist, crouch });
    out.push(...this.body.parts(flash));
    // (arrows drawn thick, with a streak behind: a 1.3-cell shaft is a few px at play zoom)
    for (const r of this.arrows) {
      out.push({ voxels: ARROW, at: r.at, q: qAxis([0, 0, 1], Math.atan2(r.vel[1], r.vel[0])), size: 0.2 });
      const sp = Math.hypot(r.vel[0], r.vel[1]) || 1;
      const tail = Math.min(2.5, sp * 0.06);
      out.push(line([r.at, [r.at[0] - (r.vel[0] / sp) * tail, r.at[1] - (r.vel[1] / sp) * tail, r.at[2]]], MAT.Bone, 0.1, 1));
    }
    // the blade's trail: glowing voxels along its recent sweeps, thinning as they age
    this.trail = this.trail.filter((r) => this.t - r.t < TRAIL.life);
    if (this.trail.length) {
      const vox: { at: V3; mat: number }[] = [];
      for (const r of this.trail) {
        const k = 1 - (this.t - r.t) / TRAIL.life;
        const n = Math.max(1, Math.round(TRAIL.per * k));
        for (let i = 0; i < n; i++) {
          const u = 1 - i / TRAIL.per;
          vox.push({ at: [r.base[0] + (r.tip[0] - r.base[0]) * u - f.x, -(r.base[1] + (r.tip[1] - r.base[1]) * u - f.y), r.base[2] + (r.tip[2] - r.base[2]) * u - f.z], mat: MAT.Bone });
        }
      }
      out.push({ voxels: vox, at: [f.x, f.y, f.z], q: [0, 0, 0, 1], flash: 1, size: TRAIL.size });
    }
    return out;
  }

  looks(): ButtonLook[] {
    const p = this.p;
    return [
      { gauge: 1 - this.cool.dodge / Math.max(0.01, p.dodgeEvery + p.dodgeTime), lit: this.act.kind === 'dodge' },
      { icon: this.arm === 'sword' ? '🏹' : '🗡️', name: this.arm === 'sword' ? 'bow' : 'sword' },
      this.arm === 'sword'
        ? { icon: '🌀', name: 'spin', lit: this.act.kind === 'spin', gauge: this.act.kind === 'spin' ? this.act.fuel / p.spinTime : 1 - this.cool.spin / Math.max(0.01, p.spinEvery) }
        : { icon: '🎯', name: 'volley', gauge: 1 - this.cool.volley / Math.max(0.01, p.volleyEvery) },
    ];
  }

  status(): string {
    const a = this.act;
    if (this.hitT < 0.5) return `HIT! · ${this.stats.hits}`;
    if (a.kind === 'spin') return `SPIN · ${speedOf(this.f).toFixed(0)} c/s`;
    if (a.kind === 'dodge') return 'DODGE';
    if (a.kind === 'draw') return `DRAW ${Math.round(a.charge * 100)}%`;
    return `${this.arm === 'sword' ? '🗡️' : '🏹'} · ${speedOf(this.f).toFixed(1)} c/s`;
  }
}

/** how far p is from the segment a–b */
function segDist(p: V3, a: V3, b: V3): number {
  const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const k = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - d[0] * k, p[1] - a[1] - d[1] * k, p[2] - a[2] - d[2] * k);
}

/** voxels along a polyline (world points), as a part */
function line(pts: V3[], mat: number, size: number, flash = 0): Part {
  const o = pts[0];
  const vox: { at: V3; mat: number }[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / (size * 0.9)));
    for (let k = 0; k <= n; k++) {
      const u = k / n;
      vox.push({ at: [a[0] + (b[0] - a[0]) * u - o[0], -(a[1] + (b[1] - a[1]) * u - o[1]), a[2] + (b[2] - a[2]) * u - o[2]], mat });
    }
  }
  return { voxels: vox, at: o, q: [0, 0, 0, 1], size, flash };
}
