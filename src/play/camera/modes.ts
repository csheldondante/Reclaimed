// ---- play/camera/modes.ts ---------------------------------------------------------------------------------------
// (round 121, herolab; BACKLOG CAM1) The camera modes, each a CameraMode (contracts/camera.ts) writing its own part of
// the frame, so they combine: the chase frames (where the screen's centre is, the zoom), auto-rotate turns the view,
// the tilt raises it toward top-down, and the cuts — cutaway, edge-only, dither — say what's left out of the draw.
// Each reads its numbers live from the camera tuning (params.ts). Pure: the world through SightWorld, the probe
// sight.ts (the renderer's cut, mirrored), so every mode runs in Node.

import type { CamContext, CameraMode, CamFrame, CamSee, Interest, SightWorld, V3 } from '../../api/contracts/camera';
import type { ChaseFraming } from '../../api/contracts/hero';
import { Chase, DEFAULT_CHASE, reachAlong, type ChaseView } from '../core/chase';
import type { CamParams } from './params';
import { eyeDir, groundOnScreen, halfScreen, hiddenBy, wrap } from './sight';
import type { CamCut } from '../../api/contracts/camera';

const DEG = Math.PI / 180;
const ease = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

/** how high over its base a point is looked at (a figure's chest; a way's rider) */
export const LOOK_Z: Record<Interest['kind'], number> = { hero: 1.2, ahead: 1.0, enemy: 1.0, objective: 1.0, pickup: 0.5 };

/** the point an interest is looked at */
export const lookAt = (i: Interest): V3 => [i.at[0], i.at[1], i.at[2] + LOOK_Z[i.kind]];

/**
 * The weighted share of the points hidden from (az, el), the cut left out (0 none hidden .. 1 all): what the
 * rotate and the tilt search on, and the cuts' "is it hidden" with a threshold.
 */
export function hiddenShare(world: SightWorld, pts: { at: V3; w: number }[], az: number, el: number, cut: CamCut | null = null): number {
  const e = eyeDir(az, el);
  let sum = 0;
  let hid = 0;
  for (const p of pts) {
    if (p.w <= 0) continue;
    sum += p.w;
    if (hiddenBy(world, p.at, e, cut)) hid += p.w;
  }
  return sum > 0 ? hid / sum : 0;
}

/** the hero and its interests as weighted points, the way ahead's weighed by `aheadW` */
function weighted(ctx: CamContext, aheadW: number): { at: V3; w: number }[] {
  return ctx.interests.map((i) => ({ at: lookAt(i), w: i.weight * (i.kind === 'ahead' ? aheadW : 1) }));
}

/** the base framing: today's chase (play/core/chase.ts), the hero's HeroCamera.chase scaled by the tuning */
export class ChaseMode implements CameraMode {
  readonly id = 'chase' as const;
  readonly stage = 0;
  readonly chase = new Chase(DEFAULT_CHASE, 30);
  private framing: ChaseFraming = DEFAULT_CHASE;
  private base = 30;
  /** the lead as framed (cells): the chase's along the velocity, swung toward the way ahead by `lookAhead` */
  lead: [number, number] = [0, 0];
  constructor(private p: CamParams) {}

  /** the hero's own framing and zoom (a new hero) */
  setHero(f: ChaseFraming | undefined, zoom: number): void {
    this.framing = f ?? DEFAULT_CHASE;
    this.base = zoom;
  }

  private scaled(): ChaseFraming {
    const c = this.p.chase;
    const f = this.framing;
    return { ...f, lead: f.lead * c.leadX, leadMax: f.leadMax * c.leadX, ahead: f.ahead * c.aheadX, minZoom: f.minZoom * c.minZoomX };
  }

  reset(frame: CamFrame): void {
    this.chase.reset(this.scaled(), this.base * this.p.chase.zoomX);
    frame.view.zoom = this.chase.zoom;
    this.lead = [0, 0];
  }

  step(ctx: CamContext, frame: CamFrame): void {
    const v = frame.view;
    this.chase.f = this.scaled();
    this.chase.base = this.base * this.p.chase.zoomX;
    const az = v.azimuth;
    const el = v.elevation;
    const cv: ChaseView = { w: v.w, h: v.h, squash: Math.sin(el), margin: v.margin, screenOf: (dx, dy) => groundOnScreen(az, el, dx, dy) };
    this.chase.step(ctx.dt, ctx.pose.vel[0], ctx.pose.vel[1], ctx.pose.fast, cv);
    const at = ctx.pose.at;
    // (round 121: the lead swung toward the way ahead's end — round a turn the screen looks round it — no further than
    // the chase's own limit that way, so the hero stays on screen)
    let want: [number, number] = [this.chase.lead[0], this.chase.lead[1]];
    const look = this.p.chase.lookAhead;
    const end = look > 0 ? ctx.interests.find((i) => i.id === 'ahead') : undefined;
    if (end) {
      const dx = end.at[0] - at[0];
      const dy = end.at[1] - at[1];
      const d = Math.hypot(dx, dy);
      if (d > 1e-3) {
        const lim = (this.chase.f.leadShare * reachAlong(cv, dx / d, dy / d)) / Math.max(this.chase.zoom, 1e-3);
        const l = Math.min(d, lim, this.chase.f.leadMax);
        want = [want[0] + ((dx / d) * l - want[0]) * look, want[1] + ((dy / d) * l - want[1]) * look];
      }
    }
    const k = ease(this.chase.f.follow, ctx.dt);
    this.lead[0] += (want[0] - this.lead[0]) * (look > 0 ? k : 1);
    this.lead[1] += (want[1] - this.lead[1]) * (look > 0 ? k : 1);
    v.target[0] = at[0] + this.lead[0];
    v.target[1] = at[1] + this.lead[1];
    v.target[2] += (at[2] - v.target[2]) * ease(this.chase.f.follow, ctx.dt);
    v.zoom = this.chase.zoom;
  }
}

/** Auto-rotate: the view turns, on a spring, to the nearest angle the hero and the way ahead are seen from. */
export class RotateMode implements CameraMode {
  readonly id = 'rotate' as const;
  readonly stage = 1;
  goal: number | null = null;
  private speed = 0;
  private look = 0;
  constructor(private p: CamParams) {}

  reset(): void {
    this.goal = null;
    this.speed = 0;
    this.look = 0;
  }

  step(ctx: CamContext, frame: CamFrame): void {
    const P = this.p.rotate;
    const v = frame.view;
    this.look -= ctx.dt;
    if (this.look <= 0) {
      this.look = P.look;
      this.choose(ctx, v.azimuth, v.elevation);
    }
    const w = P.rate;
    if (this.goal !== null) {
      const d = wrap(this.goal - v.azimuth);
      this.speed += (w * w * d - 2 * w * this.speed) * ctx.dt;
      if (Math.abs(d) < 0.003 && Math.abs(this.speed) < 0.01) {
        this.goal = null;
        this.speed = 0;
      }
    } else this.speed -= 2 * w * this.speed * ctx.dt;
    const max = P.maxSpeed * DEG;
    this.speed = Math.max(-max, Math.min(max, this.speed));
    v.azimuth = wrap(v.azimuth + this.speed * ctx.dt);
  }

  /** the angle's cost: what's hidden from it, how far it turns, how far from behind the heading */
  cost(ctx: CamContext, a: number, from: number, el: number, pts: { at: V3; w: number }[]): number {
    const P = this.p.rotate;
    const behind = ctx.pose.heading + Math.PI;
    return hiddenShare(ctx.world, pts, a, el) + (P.turnCost * Math.abs(wrap(a - from))) / Math.PI + (P.behind * Math.max(0, Math.abs(wrap(a - behind)) - P.dead * DEG)) / Math.PI;
  }

  private choose(ctx: CamContext, cur: number, el: number): void {
    const P = this.p.rotate;
    const pts = weighted(ctx, P.aheadW);
    const from = this.goal ?? cur;
    const now = this.cost(ctx, from, cur, el, pts);
    // (nothing hidden and nothing pulling: stay)
    if (now <= 1e-6) return;
    const step = Math.max(1, P.step) * DEG;
    const K = Math.max(1, Math.round(P.swing / Math.max(1, P.step)));
    let best = from;
    let bestC = now;
    for (let k = 1; k <= K; k++)
      for (const s of [1, -1]) {
        const a = wrap(cur + s * k * step);
        const c = this.cost(ctx, a, cur, el, pts);
        if (c < bestC - 1e-9) {
          best = a;
          bestC = c;
        }
      }
    if (bestC < now - P.keep) this.goal = best;
  }
}

/** Top-down tilt: the view rises toward overhead as what hides the hero and the way ahead rises; eases back after. */
export class TiltMode implements CameraMode {
  readonly id = 'tilt' as const;
  readonly stage = 2;
  goal = 30 * DEG;
  private hold = 0;
  private look = 0;
  constructor(private p: CamParams) {}

  reset(frame: CamFrame): void {
    this.goal = this.p.tilt.base * DEG;
    frame.view.elevation = this.goal;
    this.hold = 0;
    this.look = 0;
  }

  /** the lowest elevation (in steps from the base) the points are seen from within the allowance, or the most */
  want(ctx: CamContext, az: number): number {
    const P = this.p.tilt;
    const pts = weighted(ctx, P.aheadW);
    const top = Math.max(P.base, P.max);
    for (let e = P.base; e < top; e += Math.max(1, P.step)) if (hiddenShare(ctx.world, pts, az, e * DEG) <= P.allow) return e * DEG;
    return top * DEG;
  }

  step(ctx: CamContext, frame: CamFrame): void {
    const P = this.p.tilt;
    const v = frame.view;
    this.look -= ctx.dt;
    if (this.look <= 0) {
      this.look = P.look;
      const w = this.want(ctx, v.azimuth);
      if (w >= this.goal - 1e-6) {
        this.goal = w;
        this.hold = P.hold;
      } else if (this.hold <= 0) this.goal = w;
    }
    this.hold -= ctx.dt;
    const rate = this.goal > v.elevation ? P.up : P.down;
    v.elevation += (this.goal - v.elevation) * ease(rate, ctx.dt);
  }
}

/** a hole that opens while its point is hidden and closes when it's seen (or is kept open) */
class Holes {
  private open = new Map<string, number>();
  /** this frame's holes: each point's radius scaled by how open it is */
  step(dt: number, easeS: number, pts: { id: string; at: V3; look: V3; r: number }[], hidden: (look: V3) => boolean, always: boolean): CamSee[] {
    const k = dt / Math.max(easeS, 1e-3);
    const out: CamSee[] = [];
    const seen = new Set<string>();
    for (const p of pts) {
      seen.add(p.id);
      const want = p.r > 0 && (always || hidden(p.look));
      const o = Math.max(0, Math.min(1, (this.open.get(p.id) ?? 0) + (want ? k : -k)));
      this.open.set(p.id, o);
      const s = o * o * (3 - 2 * o);
      if (s * p.r > 0.05) out.push({ id: p.id, at: p.at, r: s * p.r });
    }
    for (const id of [...this.open.keys()]) if (!seen.has(id)) this.open.delete(id);
    return out;
  }
  clear(): void {
    this.open.clear();
  }
}

/** a hole joined into the frame's (the same point's larger hole wins) */
function addSee(frame: CamFrame, s: CamSee): void {
  const o = frame.cut.see.find((x) => x.id === s.id);
  if (o) o.r = Math.max(o.r, s.r);
  else frame.cut.see.push({ ...s, at: [...s.at] as V3 });
}

/** Dither: what stands between the eye and the hero (and its interests) dithered out round each while it's hidden. */
export class DitherMode implements CameraMode {
  readonly id = 'dither' as const;
  readonly stage = 5;
  private holes = new Holes();
  constructor(private p: CamParams) {}
  reset(): void {
    this.holes.clear();
  }
  step(ctx: CamContext, frame: CamFrame): void {
    const P = this.p.dither;
    const v = frame.view;
    const e = eyeDir(v.azimuth, v.elevation);
    // (hidden as the frame's cut so far leaves it: a hole the cutaway already opened needs none)
    const cut = { slice: frame.cut.slice, see: [...frame.cut.see] };
    const pts = ctx.interests.map((i) => ({ id: i.id, at: i.at, look: lookAt(i), r: i.kind === 'hero' ? P.heroR : i.kind === 'ahead' ? P.aheadR : P.otherR }));
    for (const s of this.holes.step(ctx.dt, P.ease, pts, (q) => !!hiddenBy(ctx.world, q, e, cut), false)) addSee(frame, s);
  }
}

/** Edge-only: the centre (round the hero) and the way ahead kept clear; what occludes stays at the screen's edges. */
export class EdgeMode implements CameraMode {
  readonly id = 'edge' as const;
  readonly stage = 4;
  private holes = new Holes();
  constructor(private p: CamParams) {}
  reset(): void {
    this.holes.clear();
  }
  step(ctx: CamContext, frame: CamFrame): void {
    const P = this.p.edge;
    const v = frame.view;
    const half = halfScreen(v);
    const e = eyeDir(v.azimuth, v.elevation);
    const pts = ctx.interests
      .filter((i) => i.kind === 'hero' || i.kind === 'ahead')
      .map((i) => ({ id: i.id, at: i.at, look: lookAt(i), r: (i.kind === 'hero' ? P.centre : P.ahead) * half }));
    const cut = { slice: frame.cut.slice, see: [...frame.cut.see] };
    for (const s of this.holes.step(ctx.dt, P.ease, pts, (q) => !!hiddenBy(ctx.world, q, e, cut), P.always >= 0.5)) addSee(frame, s);
  }
}

/** Cutaway: anything taller than a short height over the surface the hero is on is cut down, round the hero, a rim lit. */
export class CutawayMode implements CameraMode {
  readonly stage: number;
  /** the slice's height now (world z); null: none */
  z: number | null = null;
  private floor: number | null = null;
  private linger = 0;
  /** `cutaway` (a hard slice) or `cutfade` (its top and edge thinned by the dither): the same mode, its own numbers */
  constructor(
    private p: CamParams,
    readonly id: 'cutaway' | 'cutfade' = 'cutaway',
  ) {
    this.stage = id === 'cutaway' ? 3 : 3.5;
  }

  reset(): void {
    this.z = null;
    this.floor = null;
    this.linger = 0;
  }

  shift(_dx: number, _dy: number, dz: number): void {
    if (this.z !== null) this.z += dz;
    if (this.floor !== null) this.floor += dz;
  }

  step(ctx: CamContext, frame: CamFrame): void {
    const P = this.p[this.id];
    const v = frame.view;
    const dt = ctx.dt;
    // (the floor eased: a bump under the bike doesn't bob the whole cut)
    this.floor = this.floor === null ? ctx.pose.floor : this.floor + (ctx.pose.floor - this.floor) * ease(4, dt);
    let need = P.when < 0.5;
    if (!need) {
      const pts = weighted(ctx, 1).filter((p) => p.w > 0);
      need = hiddenShare(ctx.world, pts, v.azimuth, v.elevation, frame.cut) > 0;
    }
    if (need) this.linger = P.linger;
    else this.linger -= dt;
    const want = this.linger > 0 ? this.floor + P.height : null;
    const high = this.floor + 60;
    const k = Math.min(1, dt * P.rate);
    if (want !== null) this.z = (this.z ?? high) + (want - (this.z ?? high)) * k;
    else if (this.z !== null) {
      this.z += (high + 5 - this.z) * k;
      if (this.z >= high) this.z = null;
    }
    // (both cuts on: the second leaves the first's slice when it has none of its own)
    if (this.z === null) return;
    frame.cut.slice = { z: this.z, at: [ctx.pose.at[0], ctx.pose.at[1]], radius: P.radius * halfScreen(v), rim: P.rim, fade: P.fade, fadeR: P.fadeR, bowl: P.bowl, nearOnly: P.nearOnly >= 0.5, occluders: P.occluders >= 0.5 };
  }
}
