// ---- play/heroes/hook.ts ----------------------------------------------------------------------------------------
// The rider's grappling hook (rounds 117-118), its own piece so other riders (a knight's hook, a rival) can carry it.
// The user: "Maybe a grappling hook to reel in enemies or do sharp turns" (r117), then, having ridden it: "can you
// swipe to cut it and release early? It would be cool to pull enemies in or drag them that way too or to pull up along
// other vehicles" (r118). A tap throws it at what's under the finger:
//   the ground    an anchor: the bike swings round it on the rope (what pulls outward is taken off; the thumb's push
//                 turned along the swing), until its time or angle is up
//   a foe         on the line: dragged behind the bike at the rope's length, bouncing along, scraped and smashing
//                 into others when it's going fast; a swipe back toward the bike reels it in (a lob that lands where
//                 the bike will be)
//   a vehicle     the bike is reeled up alongside it and held there, matching its way, till cut
// A swipe cuts any of them (a swipe back toward the bike reels a foe in instead): what was moving keeps moving — the
// bike its swing's momentum, a dragged foe flung off the line. After a swing the thumb's stick is read turned by what
// the swing turned (till it's let go): holding the stick the old way doesn't haul the bike back into a slide.

import type { V2, V3 } from '../../api/contracts/units';
import type { Bike } from '../core/bike';
import type { Pt } from '../core/gestures';
import type { PlayWorld, Vehicle } from '../world';
import type { Hit, Target } from './base';

export interface HookParams {
  hookRange: number;
  hookTime: number;
  hookTurn: number;
  hookYank: number;
}

/** A foe on the line: how fast it's dragged before it's hurt (cells/s), how hard, and the blow it deals what it hits. */
export const DRAG = { scrape: 10, damage: 0.3, smack: 12, push: 0.5, radius: 1 };
/** Reeled alongside a vehicle: the closing speed per cell off the spot beside it (1/s; at most `close` cells/s), how quickly its speed is matched (1/s), how far beside (cells). */
export const ALONGSIDE = { pull: 4, match: 10, side: 2.6, close: 22 };

type State =
  | { kind: 'anchor'; at: [number, number]; len: number; t: number; swept: number; a: number; way0: number }
  | { kind: 'line'; id: number; at: V3; vel: V3; len: number; t: number }
  | { kind: 'vehicle'; id: string; t: number; side: 1 | -1 }
  | { kind: 'reel'; id: number; t: number };

export class Hook {
  state: State | null = null;
  /** after a swing: the stick's turn (radians) till it's let go */
  private turned: number | null = null;

  constructor(
    private b: Bike,
    private world: PlayWorld,
    private p: () => HookParams,
  ) {}

  get busy(): boolean {
    return this.state !== null;
  }

  status(): string | null {
    const s = this.state;
    return !s ? null : s.kind === 'anchor' ? 'SWING' : s.kind === 'line' ? 'ON THE LINE' : s.kind === 'vehicle' ? 'ALONGSIDE' : 'REEL IN';
  }

  /** A tap (not on the bike): throw at what's under it — a vehicle, a foe (as they're seen, within 48 px), else the ground. */
  tap(at: Pt, screen: Pt, foes: Target[]): void {
    const b = this.b;
    const p = this.p();
    if (p.hookRange <= 0) return;
    this.cut();
    const seen = (x: number, y: number, z: number) => {
      const s = this.world.project(x, y, z);
      return Math.hypot(s[0] - screen[0], s[1] - screen[1]);
    };
    let veh: Vehicle | null = null;
    let bd = 56;
    for (const v of this.world.vehicles?.() ?? []) {
      if (Math.hypot(v.at[0] - b.x, v.at[1] - b.y) > p.hookRange * 1.5) continue;
      const d = seen(v.at[0], v.at[1], v.at[2] + 0.6);
      if (d < bd) [veh, bd] = [v, d];
    }
    if (veh) {
      const side = -(veh.at[0] - b.x) * Math.sin(veh.heading) + (veh.at[1] - b.y) * Math.cos(veh.heading) > 0 ? -1 : 1;
      this.state = { kind: 'vehicle', id: veh.id, t: 0, side };
      return;
    }
    let foe: Target | null = null;
    bd = 48;
    for (const e of foes) {
      if (Math.hypot(e.at[0] - b.x, e.at[1] - b.y) > p.hookRange) continue;
      const d = seen(e.at[0], e.at[1], e.at[2] + e.height * 0.5);
      if (d < bd) [foe, bd] = [e, d];
    }
    if (foe && this.world.units.hold(foe.id, foe.at)) {
      const len = Math.max(3, Math.hypot(foe.at[0] - b.x, foe.at[1] - b.y));
      this.state = { kind: 'line', id: foe.id, at: [...foe.at], vel: [0, 0, 0], len, t: 0 };
      return;
    }
    const d = Math.hypot(at[0] - b.x, at[1] - b.y);
    if (d < 1.5 || d > p.hookRange) return;
    this.state = { kind: 'anchor', at: [at[0], at[1]], len: d, t: 0, swept: 0, a: Math.atan2(b.y - at[1], b.x - at[0]), way0: Math.atan2(b.vy, b.vx) };
  }

  /** A swipe while hooked: a foe on the line reeled in if it's toward the bike, else the line cut. Returns whether it took the swipe. */
  flick(from: Pt, dir: Pt): boolean {
    const s = this.state;
    if (!s || s.kind === 'reel') return false;
    if (s.kind === 'line') {
      // (toward the bike from where the swipe began: reel it in)
      const toward = (this.b.x - from[0]) * dir[0] + (this.b.y - from[1]) * dir[1] > 0;
      if (toward) return this.reel(s), true;
    }
    this.cut();
    return true;
  }

  /** Let go of whatever it holds: a swing ends with its momentum, a foe flies off the line as it was going. */
  cut(): void {
    const s = this.state;
    if (!s) return;
    if (s.kind === 'line') this.world.units.release(s.id, [s.vel[0], s.vel[1], Math.max(s.vel[2], 2)]);
    if (s.kind === 'anchor') this.endSwing(s);
    this.state = null;
  }

  /** The stick as the bike should read it: along a swing; turned by a finished swing till it's let go. */
  stick(stick: Pt): Pt {
    const m = Math.hypot(stick[0], stick[1]);
    const s = this.state;
    // (alongside: the rope holds it there; the thumb's thrust would only pull it ahead of the spot)
    if (s?.kind === 'vehicle') return [0, 0];
    if (s?.kind === 'anchor') {
      const t = this.tangent(s.at);
      this.b.slide = 0;
      return [t[0] * m, t[1] * m];
    }
    if (this.turned !== null) {
      if (m < 0.2) {
        this.turned = null;
        return stick;
      }
      const c = Math.cos(this.turned);
      const n = Math.sin(this.turned);
      return [stick[0] * c - stick[1] * n, stick[0] * n + stick[1] * c];
    }
    return stick;
  }

  /** after the bike's step: the rope's pull */
  step(dt: number, hits: Hit[]): void {
    const s = this.state;
    if (!s) return;
    const b = this.b;
    const p = this.p();
    s.t += dt;
    if (s.kind === 'reel') {
      if (s.t > p.hookYank) this.state = null;
      return;
    }
    if (s.kind === 'anchor') {
      const rx = b.x - s.at[0];
      const ry = b.y - s.at[1];
      const r = Math.hypot(rx, ry) || 1;
      const [ux, uy] = [rx / r, ry / r];
      if (r > s.len) {
        b.x = s.at[0] + ux * s.len;
        b.y = s.at[1] + uy * s.len;
        const out = b.vx * ux + b.vy * uy;
        if (out > 0) {
          b.vx -= out * ux;
          b.vy -= out * uy;
        }
      }
      const a = Math.atan2(b.y - s.at[1], b.x - s.at[0]);
      s.swept += Math.abs(Math.atan2(Math.sin(a - s.a), Math.cos(a - s.a)));
      s.a = a;
      if (s.t > p.hookTime || s.swept > p.hookTurn) {
        this.endSwing(s);
        this.state = null;
      }
      return;
    }
    if (s.kind === 'vehicle') {
      const v = this.world.vehicles?.().find((x) => x.id === s.id);
      if (!v) return void (this.state = null);
      // the spot beside it, on the side the bike came from: pulled there, its speed matched
      const [rx, ry] = [-Math.sin(v.heading) * s.side, Math.cos(v.heading) * s.side];
      const want: V2 = [v.at[0] + rx * ALONGSIDE.side, v.at[1] + ry * ALONGSIDE.side];
      // (its velocity eased to the vehicle's plus a closing speed toward the spot: reeled in, then held there)
      const k = 1 - Math.exp(-ALONGSIDE.match * dt);
      let [cx, cy] = [(want[0] - b.x) * ALONGSIDE.pull, (want[1] - b.y) * ALONGSIDE.pull];
      const cl = Math.hypot(cx, cy);
      if (cl > ALONGSIDE.close) [cx, cy] = [(cx / cl) * ALONGSIDE.close, (cy / cl) * ALONGSIDE.close];
      b.vx += (v.vel[0] + cx - b.vx) * k;
      b.vy += (v.vel[1] + cy - b.vy) * k;
      b.slide = 0;
      return;
    }
    // a foe on the line: dragged behind at the rope's length, falling to the ground, bouncing along
    const w = this.world;
    const prev: V3 = [...s.at];
    s.vel[2] -= 20 * dt;
    for (let i = 0; i < 3; i++) s.at[i] += s.vel[i] * dt;
    const dx = s.at[0] - b.x;
    const dy = s.at[1] - b.y;
    const d = Math.hypot(dx, dy) || 1;
    if (d > s.len) {
      s.at[0] = b.x + (dx / d) * s.len;
      s.at[1] = b.y + (dy / d) * s.len;
    }
    const g = w.floor(s.at[0], s.at[1]);
    if (s.at[2] < g) {
      s.at[2] = g;
      s.vel[2] = Math.abs(s.vel[2]) * 0.3;
    }
    for (let i = 0; i < 2; i++) s.vel[i] = (s.at[i] - prev[i]) / Math.max(dt, 1e-3);
    const sp = Math.hypot(s.vel[0], s.vel[1]);
    if (sp > DRAG.scrape) {
      hits.push({ at: [s.at[0], s.at[1]], z: s.at[2] + 0.5, radius: 0.3, damage: DRAG.damage * dt * (sp / DRAG.scrape) });
      if (Math.random() < dt * 20) w.burst('dust', s.at[0], s.at[1], g + 0.2, { count: 3, speed: 2, spread: 0.5 });
    }
    // (what it's swung into: a blow just ahead of it along its way, so it spares the one on the line)
    if (sp > DRAG.smack) {
      const [ux, uy] = [s.vel[0] / sp, s.vel[1] / sp];
      const ahead = DRAG.radius + 0.3;
      hits.push({ at: [s.at[0] + ux * ahead, s.at[1] + uy * ahead], z: s.at[2] + 0.5, radius: DRAG.radius, damage: 0.4, push: sp * DRAG.push, dir: [ux, uy], lift: 3 });
    }
    if (!w.units.hold(s.id, s.at)) this.state = null;
  }

  /** where the rope ends (to draw it), or null */
  end(): V3 | null {
    const s = this.state;
    if (!s) return null;
    if (s.kind === 'anchor') return [s.at[0], s.at[1], this.world.floor(s.at[0], s.at[1]) + 0.2];
    if (s.kind === 'line') return [s.at[0], s.at[1], s.at[2] + 0.8];
    if (s.kind === 'reel') {
      const u = this.world.units.get(s.id);
      return u ? [u.at[0], u.at[1], u.at[2] + 0.8] : null;
    }
    const v = this.world.vehicles?.().find((x) => x.id === s.id);
    return v ? [v.at[0], v.at[1], v.at[2] + 0.8] : null;
  }

  shift(dx: number, dy: number, dz: number): void {
    const s = this.state;
    if (s?.kind === 'anchor') s.at = [s.at[0] + dx, s.at[1] + dy];
    if (s?.kind === 'line') s.at = [s.at[0] + dx, s.at[1] + dy, s.at[2] + dz];
  }

  private reel(s: Extract<State, { kind: 'line' }>): void {
    const b = this.b;
    const T = this.p().hookYank;
    const to: V3 = [b.x + b.vx * T, b.y + b.vy * T, b.z + 0.5];
    this.world.units.release(s.id, [(to[0] - s.at[0]) / T, (to[1] - s.at[1]) / T, (to[2] - s.at[2] + 0.5 * 20 * T * T) / T]);
    this.state = { kind: 'reel', id: s.id, t: 0 };
  }

  private endSwing(s: Extract<State, { kind: 'anchor' }>): void {
    const way = Math.atan2(this.b.vy, this.b.vx);
    this.turned = Math.atan2(Math.sin(way - s.way0), Math.cos(way - s.way0));
  }

  /** the way round the anchor the bike is going */
  private tangent(at: [number, number]): Pt {
    const b = this.b;
    const rx = b.x - at[0];
    const ry = b.y - at[1];
    const l = Math.hypot(rx, ry) || 1;
    const t: Pt = [-ry / l, rx / l];
    return t[0] * b.vx + t[1] * b.vy >= 0 ? t : [-t[0], -t[1]];
  }
}
