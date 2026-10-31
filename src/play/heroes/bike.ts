// ---- play/heroes/bike.ts ----------------------------------------------------------------------------------------
// The hover rider (ported from GameplayGM runtimes/hoverbike/src/units/hover.ts BikeUnit + air.ts, round 117).
//   drive   core/bike.ts: glide on a lift cushion, launch off crests, BOOST (the button / Space), crash hard into a
//           barricade, the stick hauled against the way it's going at speed lays it into an Akira slide
//   ram     faster than ramMin, what it touches is hit, harder the faster
//   slash   a swipe on one side of the bike slashes that side. The swipe says only the side (Layer B's intent
//           "strike-side"); the planner (core/intercept.ts) waits for the pass of a target that side, steers alongside
//           a little, angles the blade down to one below; the blade's real sweep decides what it hits (Layer C) — "a
//           miss the player earned stays a miss"
//   lance   a drag held: couched toward the thumb (bent to an enemy near its line); what its point meets is hit as
//           hard as the bike runs into it
//   air     its wake in the wind, the downwash pulsed under it, dust, a landing's slam
// Its numbers are the live Params (controllers/hoverbike.ts BIKE_PARAMS): the sandbox's sliders.

import type { HeroCamera } from '../../api/contracts/hero';
import type { V2, V3 } from '../../api/contracts/units';
import { assist as aimAssist, lean } from '../core/aim';
import { makeBike, speedOf, stepBike, type Bike, type BikeTuning } from '../core/bike';
import type { Pt } from '../core/gestures';
import { ASSIST, passPlanner, segmentDistance, type PassBudget, type PassPlan } from '../core/intercept';
import { IntentLog, type IntentRecord } from '../core/intent';
import { BIKE_CAMERA, BIKE_DEFAULTS, type BikeParams } from '../controllers/hoverbike';
import { attitude, BLADE_LENGTH, buildBike, buildBlade, buildLance, LANCE_LENGTH, qAxis, qMul, type Part } from '../draw/shapes';
import type { ButtonLook, Pad, PlayInput } from '../input/types';
import type { PlayWorld } from '../world';
import { MAT } from '../../world/materials';
import { PlayHero, type Hit } from './base';
import { Hook } from './hook';

/** The swing's length (s), the share it cuts in, the hand's height (cells), the blade's width; read-back lead (s). */
export const SLASH = { time: 0.3, active: [0.3, 0.75], hand: 1.1, width: 0.35, perSpeed: 0.25, lead: 0.08 };
/** The lance: how fast it turns (rad/s), the cone and range it bends to a target in, its point's radius; slower than `min` along it, nothing. */
export const LANCE = { turn: 10, cone: 0.45, range: 4.5, radius: 0.8, min: 4, damage: 8, push: 0.9 };
const RAM_RADIUS = 1.3;
const ASSISTS = [ASSIST.strict, ASSIST.moderate, ASSIST.forgiving];

const BIKE_VOXELS = buildBike();
const BLADE = buildBlade();
const LANCE_VOXELS = buildLance();

/** The blade's trail: how long a sample lingers (s), the voxels along each sample, their edge (cells) — the swing read at play zoom. */
export const TRAIL = { life: 0.22, per: 4, size: 0.22 };

/** One intent log for the page (the sandbox's debug line reads the last). */
export const intents = new IntentLog();

export class BikeHero extends PlayHero {
  readonly b: Bike;
  readonly pad: Pad = {
    move: 'stick',
    buttons: [{ icon: '🚀', name: 'boost', held: true }],
    hint: 'Left thumb: ride · hold BOOST (Space) · swipe beside the bike: slash · tap a foe: on the line (swipe back: reel it in) · tap the ground: swing round it · tap a rider: pull up alongside · swipe: cut the line · hold a drag: lance',
  };
  readonly camera: HeroCamera = BIKE_CAMERA;
  private swing: { side: 1 | -1; yaw: number; pitch: number; reach: number; t: number; plan: PassPlan | null; cut: Set<number>; rec: IntentRecord } | null = null;
  private swingT = 0;
  private lanceA: number | null = null;
  /** the grappling hook (heroes/hook.ts): a swing, a foe on the line, alongside a vehicle */
  readonly hook: Hook;
  /** the blade's sweep, sampled each step it's out (base, tip, when) */
  private trail: { base: V3; tip: V3; t: number }[] = [];
  /** the last slash, for the debug line */
  told = '';
  private pulseT = 0;
  /** seconds since the blade last cut something (the HUD's HIT) */
  hitT = 99;
  private dustT = 0;
  /** best airtime this ride (s), for the HUD's trick line */
  bestAir = 0;

  constructor(world: PlayWorld, at: V2, params: BikeParams = { ...BIKE_DEFAULTS }) {
    super('hover rider', world, params, 10);
    this.b = makeBike(at[0], at[1], world.top, this.tuning());
    this.hook = new Hook(this.b, world, () => this.p);
  }

  private get p(): BikeParams {
    return this.params as unknown as BikeParams;
  }
  private tuning(): BikeTuning {
    return this.params as unknown as BikeTuning;
  }
  private get budget(): PassBudget {
    return ASSISTS[Math.max(0, Math.min(2, Math.round(this.p.assist)))];
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
  profileClimb(): number {
    return this.p.climb;
  }
  fast(): number {
    return Math.min(1, speedOf(this.b) / Math.max(this.p.limit, this.p.boostMax));
  }
  place(at: V2): void {
    Object.assign(this.b, makeBike(at[0], at[1], this.world.top, this.tuning()));
    this.swing = null;
    this.lanceA = null;
    this.hook.cut();
  }
  shift(dx: number, dy: number, dz: number): void {
    this.b.x += dx;
    this.b.y += dy;
    this.b.z += dz;
    // (what's kept in window coordinates moves with it: the hook's anchor, the blade's trail — a slide mid-swing had
    // left the anchor behind, and the rope snapped the bike back across the window)
    this.hook.shift(dx, dy, dz);
    for (const r of this.trail) {
      r.base = [r.base[0] + dx, r.base[1] + dy, r.base[2] + dz];
      r.tip = [r.tip[0] + dx, r.tip[1] + dy, r.tip[2] + dz];
    }
  }
  protected knock(from: V2, _damage: number): void {
    const dx = this.b.x - from[0];
    const dy = this.b.y - from[1];
    const l = Math.hypot(dx, dy) || 1;
    this.b.vx += (dx / l) * 3;
    this.b.vy += (dy / l) * 3;
  }

  protected step(input: PlayInput, dt: number, hits: Hit[]): void {
    const b = this.b;
    const p = this.p;
    this.hitT += dt;
    for (const act of input.acts) if (act.kind === 'tap' && !act.self) this.hook.tap(act.at, act.screen, this.targets(b.x, b.y, p.hookRange + 2));
    // (a swipe while hooked is the hook's: it cuts the line, or reels a foe in — not a slash)
    const acts = input.acts.filter((a) => !(a.kind === 'flick' && !a.self && this.hook.flick(a.from, a.dir)));
    const stick = this.hook.stick(input.dir);
    stepBike(b, stick, dt, this.world.top, this.world.bounds, this.tuning(), !!input.buttons[0]);
    this.hook.step(dt, hits);
    if (b.air > this.bestAir) this.bestAir = b.air;
    this.air(dt);
    const sp = speedOf(b);
    if (sp > p.ramMin) hits.push({ at: [b.x, b.y], z: b.z + 0.5, radius: RAM_RADIUS, damage: (sp - p.ramMin) * p.ramDamage * dt * 10, push: sp * p.ramPush, dir: [b.vx / sp, b.vy / sp] });
    if (b.slide > 0) this.skid(dt);
    this.swingT = Math.max(0, this.swingT - dt);
    for (const act of acts) if (act.kind === 'flick' && !act.self && this.swingT <= 0) this.startSwing(act.from);
    this.swingBlade(dt, hits);
    this.couch(input, dt, hits);
  }

  /** What it does to the air: its wake, the downwash pulsed under it, dust, a landing's and a crash's slam. */
  private air(dt: number): void {
    const b = this.b;
    const w = this.world;
    const ground = w.top(b.x, b.y);
    const wash = Math.max(0, Math.min(1, 1 - (b.z - ground - 1) / 5));
    const sp = speedOf(b);
    const fast = Math.min(1, sp / Math.max(this.p.max, 1));
    if (sp > 0.5) w.wake('hero', { at: [b.x, b.y], vel: [b.vx, b.vy], width: 7, passes: Math.max(1, Math.round(2 * (0.4 + 0.6 * wash))) });
    this.pulseT += dt * 12;
    if (this.pulseT >= 1 && wash > 0) {
      this.pulseT %= 1;
      w.blast(b.x, b.y, 5 + 2 * fast, 3 * wash * (1 + fast));
    }
    if (b.landed > 3) {
      const hard = Math.min(1, b.landed / 15);
      this.shake = Math.max(this.shake, hard * 0.6);
      w.blast(b.x, b.y, 5 + 3 * hard, 3 * (1.5 + 4 * hard));
      w.burst('dust', b.x, b.y, ground + 0.2, { count: Math.ceil(8 + 16 * hard), speed: 3 + 4 * hard, spread: 0.8 });
    }
    if (b.crash > 0) {
      const hard = Math.min(1, b.crash / 25);
      this.shake = 1;
      w.blast(b.x, b.y, 7, 3 * (3 + 5 * hard));
      w.burst('chips', b.x, b.y, ground + 0.5, { count: Math.ceil(10 + 20 * hard), speed: 4 + 6 * hard, spread: 0.6 });
    }
    this.dustT += dt * 30 * wash * (0.35 + 0.65 * fast) * (w.depth(b.x, b.y) > 0.1 ? 0.5 : 1);
    while (this.dustT >= 1) {
      this.dustT -= 1;
      const a = Math.random() * Math.PI * 2;
      const r = 1 + Math.random() * 1.5;
      const back = fast * (1 + Math.random() * 2);
      const dir: Pt = sp > 0.05 ? [b.vx / sp, b.vy / sp] : [1, 0];
      w.burst(w.depth(b.x, b.y) > 0.1 ? 'splash' : 'dust', b.x + Math.cos(a) * r - dir[0] * back, b.y + Math.sin(a) * r - dir[1] * back, ground + 0.1, { count: 2, speed: 1 + 2 * wash + 2 * fast });
    }
  }

  /** The Akira slide's spray. */
  private skid(dt: number): void {
    const b = this.b;
    const sp = speedOf(b);
    const z = this.world.top(b.x, b.y);
    if (Math.random() < dt * 30) this.world.burst('dust', b.x, b.y, z, { count: 3, speed: 1.5 + sp * 0.2, spread: 0.7 });
    if (Math.random() < dt * 6) this.world.gust(b.x + b.vx * 0.15, b.y + b.vy * 0.15, 2.5, 2 + sp * 0.2, sp > 0 ? [b.vx / sp, b.vy / sp] : [1, 0]);
  }

  /** The bike's way (its velocity, or its heading when slow). */
  private way(): Pt {
    const b = this.b;
    const sp = speedOf(b);
    return sp > 1 ? [b.vx / sp, b.vy / sp] : [Math.cos(b.heading), Math.sin(b.heading)];
  }

  /** A swipe on one side (where it started, on the ground): the planner's slash that side, or a plain swing. */
  private startSwing(from: Pt): void {
    const b = this.b;
    const f = this.way();
    const side: 1 | -1 = f[0] * (from[1] - b.y) - f[1] * (from[0] - b.x) >= 0 ? 1 : -1;
    const budget = this.budget;
    const targets = this.targets(b.x, b.y, 14);
    const rider = { at: [b.x, b.y, b.z] as V3, vel: [b.vx, b.vy, b.vz] as V3, heading: b.heading, hand: SLASH.hand, gravity: b.air > 0 ? this.p.gravity : 0 };
    const intent = { kind: 'strike-side', side } as const;
    const planned = passPlanner.plan(intent, { rider, targets }, budget);
    const plan = planned.plan;
    const rec = intents.add('bike', intent, passPlanner.name, planned, plan?.id ?? null, this.t);
    const yaw = plan ? plan.yaw : Math.atan2(f[0] * side, -f[1] * side);
    this.swing = { side, yaw, pitch: plan?.pitch ?? 0, reach: plan?.reach ?? budget.reach, t: plan ? -Math.max(0, plan.t - SLASH.time / 2) : 0, plan, cut: new Set(), rec };
    this.swingT = this.p.slashEvery + Math.max(0, -this.swing.t);
    this.told = IntentLog.describe(rec);
  }

  /** The slash in progress: steered alongside within the plan while it waits, then the blade's real sweep. */
  private swingBlade(dt: number, hits: Hit[]): void {
    const s = this.swing;
    if (!s) return;
    const b = this.b;
    const p = s.plan;
    if (p && s.t < SLASH.time / 2 && p.t > 0) {
      const k = dt / p.t;
      b.vx += p.steer[0] * k;
      b.vy += p.steer[1] * k;
      if (b.air > 0) b.vz += p.lift * k;
    }
    s.t += dt;
    if (s.t < 0) return;
    const hand: V3 = [b.x, b.y, b.z + SLASH.hand];
    const all = this.targets(b.x, b.y, 8);
    const tg = p ? all.find((t) => t.id === p.id) : undefined;
    if (tg) {
      // (turned to where the target is, within its reach: the plan adapts to the real pass)
      const at: V3 = [tg.at[0] + tg.vel[0] * SLASH.lead, tg.at[1] + tg.vel[1] * SLASH.lead, tg.at[2] + tg.height * 0.5];
      const flat = Math.hypot(at[0] - hand[0], at[1] - hand[1]);
      const side = Math.cos(s.yaw) * (at[0] - hand[0]) + Math.sin(s.yaw) * (at[1] - hand[1]);
      if (side > 0) {
        s.yaw = Math.atan2(at[1] - hand[1], at[0] - hand[0]);
        s.pitch = Math.max(-0.4, Math.min(1.2, Math.atan2(hand[2] - at[2], flat)));
        s.reach = Math.max(this.budget.reach, Math.min(this.budget.reachMax, Math.hypot(flat, at[2] - hand[2])));
      }
    }
    const u = s.t / SLASH.time;
    const [base, tip] = this.bladeAt(hand, s, u);
    if (u <= 1) this.trail.push({ base, tip, t: this.t });
    if (u >= SLASH.active[0] && u <= SLASH.active[1]) {
      const sp = speedOf(b);
      const out: Pt = [Math.cos(s.yaw), Math.sin(s.yaw)];
      const way = lean(out, this.way(), 0.4);
      for (const e of all) {
        if (s.cut.has(e.id)) continue;
        const mid: V3 = [e.at[0] + e.vel[0] * SLASH.lead, e.at[1] + e.vel[1] * SLASH.lead, e.at[2] + e.height * 0.5];
        if (segmentDistance(mid, hand, tip) > e.height * 0.65 + SLASH.width) continue;
        s.cut.add(e.id);
        hits.push({ at: [e.at[0], e.at[1]], z: mid[2], radius: 0.6, damage: this.p.slashDamage + sp * SLASH.perSpeed, push: this.p.slashPush + sp * SLASH.perSpeed, dir: way, lift: this.p.slashLift, stun: 0.6 });
        // (the hit, readable at play zoom: a spray of sparks along the cut, a puff of dust off the one struck)
        this.world.burst('sparks', mid[0], mid[1], mid[2], { count: 24, speed: 6, spread: 0.7, vel: [way[0] * 6, way[1] * 6, 2] });
        this.world.burst('dust', e.at[0], e.at[1], e.at[2] + 0.3, { count: 10, speed: 3, spread: 0.6 });
        this.hitT = 0;
        this.shake = Math.max(this.shake, 0.5);
      }
    }
    if (u >= 1) {
      intents.settle(s.rec, s.plan ? s.cut.has(s.plan.id) : s.cut.size > 0);
      this.told = IntentLog.describe(s.rec);
      this.swing = null;
    }
  }

  /** The blade's hilt end and tip at `u` (0..1) through the swing: swept front to back, angled down. */
  private bladeAt(hand: V3, s: NonNullable<BikeHero['swing']>, u: number): [V3, V3] {
    const a = s.yaw - (u - 0.5) * 1.6 * s.side;
    const c = Math.cos(s.pitch);
    const d: V3 = [Math.cos(a) * c, Math.sin(a) * c, -Math.sin(s.pitch)];
    const at = (r: number): V3 => [hand[0] + d[0] * r, hand[1] + d[1] * r, hand[2] + d[2] * r];
    return [at(s.reach * 0.35), at(s.reach)];
  }

  /** The lance, while a drag's held: out toward the thumb, bent to an enemy near its line. */
  private couch(input: PlayInput, dt: number, hits: Hit[]): void {
    const drag = input.drag;
    const b = this.b;
    if (!drag || drag.self || drag.extent < 0.1) {
      this.lanceA = null;
      return;
    }
    let dir: Pt = [drag.at[0] - b.x, drag.at[1] - b.y];
    const l = Math.hypot(dir[0], dir[1]);
    if (l < 0.5) return;
    dir = [dir[0] / l, dir[1] / l];
    const a = aimAssist([b.x, b.y], dir, this.targets(b.x, b.y, LANCE.range).map((e) => [e.at[0], e.at[1]] as Pt), LANCE.cone, LANCE.range);
    if (a) dir = lean(dir, a.dir, 0.8);
    const want = Math.atan2(dir[1], dir[0]);
    if (this.lanceA === null) this.lanceA = want;
    const d = Math.atan2(Math.sin(want - this.lanceA), Math.cos(want - this.lanceA));
    this.lanceA += Math.max(-LANCE.turn * dt, Math.min(LANCE.turn * dt, d));
    const u: Pt = [Math.cos(this.lanceA), Math.sin(this.lanceA)];
    const along = b.vx * u[0] + b.vy * u[1];
    if (along < LANCE.min) return;
    const tip = LANCE_LENGTH - LANCE.radius * 0.5;
    hits.push({ at: [b.x + u[0] * tip, b.y + u[1] * tip], z: b.z + 1, radius: LANCE.radius, damage: along * LANCE.damage * dt, push: along * LANCE.push, dir: u });
  }

  parts(): Part[] {
    const b = this.b;
    const flash = this.hurtT < 0.12 ? 1 : 0;
    const out: Part[] = [{ voxels: BIKE_VOXELS, at: [b.x, b.y, b.z], q: attitude(b.heading, b.pitch, b.bank), flash }];
    const hand: V3 = [b.x, b.y, b.z + SLASH.hand];
    if (this.swing && this.swing.t >= 0) {
      const s = this.swing;
      const a = s.yaw - (s.t / SLASH.time - 0.5) * 1.6 * s.side;
      const off = Math.max(0, s.reach - BLADE_LENGTH);
      const c = Math.cos(s.pitch);
      out.push({ voxels: BLADE, at: [hand[0] + Math.cos(a) * c * off, hand[1] + Math.sin(a) * c * off, hand[2] - Math.sin(s.pitch) * off], q: qMul(qAxis([0, 0, 1], a), qAxis([0, 1, 0], s.pitch)) });
    }
    // the trail: glowing voxels along each of the blade's recent sweeps, thinning as they age
    this.trail = this.trail.filter((r) => this.t - r.t < TRAIL.life);
    if (this.trail.length) {
      const vox: { at: V3; mat: number }[] = [];
      for (const r of this.trail) {
        const k = 1 - (this.t - r.t) / TRAIL.life;
        const n = Math.max(1, Math.round(TRAIL.per * k));
        for (let i = 0; i < n; i++) {
          const f = 1 - i / TRAIL.per;
          vox.push({ at: [r.base[0] + (r.tip[0] - r.base[0]) * f - b.x, r.base[1] + (r.tip[1] - r.base[1]) * f - b.y, r.base[2] + (r.tip[2] - r.base[2]) * f - b.z], mat: MAT.Bone });
        }
      }
      // (in world offsets from the bike, unturned: modelToWorld turns by q — the identity here — and flips its y)
      out.push({ voxels: vox.map((v) => ({ at: [v.at[0], -v.at[1], v.at[2]], mat: v.mat })), at: [b.x, b.y, b.z], q: [0, 0, 0, 1], flash: 1, size: TRAIL.size });
    }
    // the rope, hand to the anchor or to the enemy yanked
    const end = this.hook.end();
    if (end) {
      const n = Math.min(80, Math.ceil(Math.hypot(end[0] - hand[0], end[1] - hand[1], end[2] - hand[2]) / 0.35));
      const vox: { at: V3; mat: number }[] = [];
      for (let i = 1; i <= n; i++) {
        const f = i / n;
        vox.push({ at: [hand[0] + (end[0] - hand[0]) * f - b.x, -(hand[1] + (end[1] - hand[1]) * f - b.y), hand[2] + (end[2] - hand[2]) * f - b.z], mat: MAT.Rust });
      }
      out.push({ voxels: vox, at: [b.x, b.y, b.z], q: [0, 0, 0, 1], size: 0.12 });
    }
    if (this.lanceA !== null) out.push({ voxels: LANCE_VOXELS, at: hand, q: qMul(qAxis([0, 0, 1], this.lanceA), qAxis([0, 1, 0], 0.08)) });
    return out;
  }

  looks(): ButtonLook[] {
    return [{ gauge: this.b.fuel, lit: this.b.boosting }];
  }

  status(): string {
    const b = this.b;
    if (b.crashed > 0) return 'CRASH!';
    if (b.slide > 0) return 'SLIDE';
    if (this.hitT < 0.6) return 'HIT!';
    const hs = this.hook.status();
    if (hs) return hs;
    return `${Math.round(speedOf(b) * 3.6)} km/h${b.air > 0.25 ? ` · AIR ${b.air.toFixed(1)} s` : ''}${this.lanceA !== null ? ' · LANCE' : ''}`;
  }
}
