// ---- present/mode.ts --------------------------------------------------------------------------------------------
// (round 124, `presentation`; BACKLOG PRE1) The region presentation as a camera mode: given to the rig from outside
// (CameraRig.setPresent), it runs after the framing, the turn and the tilt and blends its profile in by the region's
// weight — the zoom, the pitch, a route-facing turn, a look-ahead — and writes the frame's presentation look (the
// canopy's treatments, the understory light) for the renderer. Pure: the Node tests step it with poses.
//
// The weight: the region's (1 inside its radius, 0 past its edge band) approached at 1/transition seconds, so a hero
// riding in eases the zoom in over the transition and out again on the way out. A review can hold it in or out, or
// replay the transition from 0.

import type { CamContext, CameraMode, CamFrame } from '../api/contracts/camera';
import type { PresentationProfile, PresentRegion } from '../api/contracts/presentation';

const DEG = Math.PI / 180;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const smooth = (t: number) => t * t * (3 - 2 * t);

/** the region's weight at a point: 1 within its radius, falling to 0 over its edge band */
export function regionWeight(r: PresentRegion, x: number, y: number): number {
  const d = Math.hypot(x - r.centre[0], y - r.centre[1]);
  if (d <= r.radius) return 1;
  if (d >= r.radius + r.edge) return 0;
  return 1 - smooth((d - r.radius) / Math.max(r.edge, 1e-6));
}

export type PresentHold = 'auto' | 'in' | 'out';

export class PresentMode implements CameraMode {
  readonly id = 'present' as const;
  /** after the chase (0), the turn (1) and the tilt (2); before the cuts (3+) */
  readonly stage = 2.5;
  /** the transition's progress 0..1 (eased for use) */
  w = 0;
  /** auto: the region decides; in / out: held there (the review's buttons) */
  hold: PresentHold = 'auto';
  /** the route-facing turn's own azimuth (radians), sprung toward behind the heading */
  private az: number | null = null;
  private azSpeed = 0;
  /** the look-ahead's offset (cells), eased */
  private lead: [number, number] = [0, 0];
  /** the heading the route-facing turn follows (radians), held while the hero is slow */
  private heading: number | null = null;
  /** seconds the velocity has pointed back against the heading */
  private reversal = 0;

  constructor(
    public profile: PresentationProfile,
    public region: PresentRegion | null,
  ) {}

  /** the transition replayed: from the overworld's framing in again */
  replay(): void {
    this.w = 0;
  }

  reset(frame: CamFrame): void {
    this.az = frame.view.azimuth;
    this.azSpeed = 0;
    this.lead = [0, 0];
    this.heading = null;
  }

  shift(): void {
    // (nothing kept in window coordinates: the lead is an offset)
  }

  /** the weight the region asks for now */
  want(x: number, y: number): number {
    if (this.hold === 'in') return 1;
    if (this.hold === 'out') return 0;
    return this.region ? regionWeight(this.region, x, y) : 1;
  }

  step(ctx: CamContext, frame: CamFrame): void {
    const P = this.profile;
    const v = frame.view;
    const pose = ctx.pose;
    const goal = this.want(pose.at[0], pose.at[1]);
    const rate = ctx.dt / Math.max(P.transition.seconds, 1e-3);
    this.w = goal > this.w ? Math.min(goal, this.w + rate) : Math.max(goal, this.w - rate);
    const e = smooth(this.w);
    const c = P.camera;
    // the zoom: from the chase's toward the profile's (geometric: an even feel of approach), out with speed
    if (c.zoom !== null) {
      const z1 = c.zoom * (1 - c.speedOut * Math.min(1, pose.fast));
      v.zoom = Math.exp(Math.log(v.zoom) + (Math.log(Math.max(z1, 1)) - Math.log(v.zoom)) * e);
    }
    // the pitch
    if (c.elevation !== null) v.elevation += (c.elevation * DEG - v.elevation) * e;
    // the route-facing turn: the eye behind the way the hero goes (the way ahead up the screen), sprung and
    // rate-limited, a dead zone so small weaves don't swing the view
    if (c.routeFacing) {
      const sp = Math.hypot(pose.vel[0], pose.vel[1]);
      // (only at speed; a reversal — a bounce off a wall — must hold half a second before the view follows it)
      if (sp > 4) {
        const h = Math.atan2(pose.vel[1], pose.vel[0]);
        const off = this.heading === null ? 0 : Math.abs(wrap(h - this.heading));
        if (off > 110 * DEG) this.reversal += ctx.dt;
        else this.reversal = 0;
        if (this.heading === null || this.reversal > 0.5) {
          this.heading = h;
          this.reversal = 0;
        } else if (off <= 110 * DEG) this.heading = wrap(this.heading + wrap(h - this.heading) * Math.min(1, ctx.dt * 2));
      }
      if (this.az === null) this.az = v.azimuth;
      if (this.heading !== null) {
        const goalAz = wrap(this.heading + Math.PI);
        const d = wrap(goalAz - this.az);
        const k = 2.2;
        this.azSpeed += (k * k * d - 2 * k * this.azSpeed) * ctx.dt;
        const max = 75 * DEG;
        this.azSpeed = Math.max(-max, Math.min(max, this.azSpeed));
        this.az = wrap(this.az + this.azSpeed * ctx.dt);
      }
      v.azimuth = wrap(v.azimuth + wrap(this.az - v.azimuth) * e);
    } else if (c.azimuth !== null) {
      v.azimuth = wrap(v.azimuth + wrap(c.azimuth * DEG - v.azimuth) * e);
      this.az = v.azimuth;
    } else this.az = v.azimuth;
    // the look-ahead: the screen's centre further along the hero's velocity
    const want: [number, number] = [pose.vel[0] * c.lookAhead * e, pose.vel[1] * c.lookAhead * e];
    const k = 1 - Math.exp(-3 * ctx.dt);
    this.lead[0] += (want[0] - this.lead[0]) * k;
    this.lead[1] += (want[1] - this.lead[1]) * k;
    v.target[0] += this.lead[0];
    v.target[1] += this.lead[1];
    // the look: the canopy's treatments and the light, by the transition's style
    const cp = P.canopy;
    const sc = P.scale;
    const any = cp.dither || cp.cutaway || cp.stipple || P.light.dapple > 0 || sc.trees !== 1 || sc.thin > 0;
    if (!any || this.w <= 0) return;
    const style = P.transition.style;
    frame.present = {
      at: [pose.at[0], pose.at[1], pose.at[2]],
      floor: pose.floor,
      canopy: { dither: cp.dither, cutaway: cp.cutaway, stipple: cp.stipple },
      radius: cp.radius,
      cutHeight: cp.cutHeight,
      stippleShare: cp.stippleShare,
      // ('zoom': the treatment simply on while the hero is in the region at all; the others by the transition)
      weight: style === 'zoom' ? 1 : e,
      even: style === 'crossfade' ? 1 : 0,
      dapple: P.light.dapple,
      reach: Math.max(cp.radius * 2.6, 24),
      treeScale: sc.trees,
      thin: sc.thin,
    };
  }
}
