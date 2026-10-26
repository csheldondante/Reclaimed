// ---- api/cutaway.ts -----------------------------------------------------------
// Keeping what matters in sight (round 82, V21; round 83 split it). Three mechanisms, each on its own — a
// game uses any of them, each with whatever point it cares about (the user: "They should be independent
// mechanisms. There should be an API to set certain surfaces or 3d points as ditherable"):
// - Slice: a point under a roof (a cave, an overhang) — nothing over the roof's underside is drawn, the whole
//   view, lowered over a moment rather than at once; what solid it cuts shows dark (a section, as a plan
//   shows). "being in a lower layer should probably just skip rendering the layers above".
// - Orbit: a large obstacle (a cliff, a mountain) between a point and the eye turns the view, on a spring,
//   to the nearest angle it's seen from, and stays there ("Camera orbit actually works well but it feels
//   weird that it is not continuous").
// - Dither: points a game keeps seen (a character) — what stands in front of one is dithered out round it
//   while it's hidden, opening and closing like an iris; surfaces (boxes) a game marks limit what may be.
//   Nothing is seen by default: the camera's puck (api/puck.ts) isn't one.
// The shadows are the world's as it stands (the sun's camera cuts nothing).
//
//   const slice = new Slice(sim.terrain, core.camera), orbit = new Orbit(sim.terrain, core.camera)
//   const dither = new Dither(sim.terrain, core.camera)
//   each frame, before drawing:
//     slice.update(x, y, floor, dt); orbit.update(x, y, floor, dt)   // e.g. the puck's
//     dither.see('rider', fx, fy, fz); dither.update(dt)                 // the character's feet

import type { Camera } from '../render/camera';
import type { Terrain } from './terrain';

type Solid = { z0: number; z1: number }[] | null;

/** the columns' solid looked at (this frame's), and the lines of sight through them */
class Sight {
  private cols = new Map<number, Solid>();
  private gen = -1;
  constructor(
    private terrain: Terrain,
    private camera: Camera,
  ) {}

  /** the solid in the column at (x, y), bottom up (cached until the next frame) */
  solidAt(x: number, y: number): Solid {
    const g = performance.now() >> 4;
    if (g !== this.gen) {
      this.cols.clear();
      this.gen = g;
    }
    const key = Math.floor(y) * 65536 + Math.floor(x);
    let s = this.cols.get(key);
    if (s === undefined) {
      s = this.terrain.layersAt(x, y)?.filter((v) => v.state === 'solid' || v.state === 'loose') ?? null;
      this.cols.set(key, s);
    }
    return s;
  }

  /**
   * How high over `floor` what hides (x, y, z) from the eye at azimuth `az` rises (cells), or null if nothing
   * does; what the slice leaves out (over the camera's slice) hides nothing.
   */
  hiddenBy(x: number, y: number, z: number, floor: number, az: number): number | null {
    const el = Math.asin(Math.max(-1, Math.min(1, this.camera.eye[2])));
    const ex = Math.cos(az) * Math.cos(el);
    const ey = Math.sin(az) * Math.cos(el);
    const ez = Math.sin(el);
    const cut = this.camera.cut.slice ?? Infinity;
    let top: number | null = null;
    for (let t = 1; t <= 60; t += 0.5) {
      const pz = z + ez * t;
      if (pz > cut) break;
      const s = this.solidAt(x + ex * t, y + ey * t);
      if (!s?.length) continue;
      if (s.some((v) => pz >= v.z0 && pz < v.z1)) {
        const h = Math.min(cut, s[s.length - 1].z1) - floor;
        top = top === null ? h : Math.max(top, h);
      }
    }
    return top;
  }
}

/** A point under a roof: the view cut at the roof's underside. */
export class Slice {
  /** the slice lowers and lifts at this rate (1/s) */
  rate = 6;
  /** the slice's height (world z) when cut; null none */
  get z(): number | null {
    return this.at;
  }
  private at: number | null = null;
  private sight: Sight;
  constructor(
    terrain: Terrain,
    private camera: Camera,
  ) {
    this.sight = new Sight(terrain, camera);
  }

  /** Each frame: the point (its floor, world z). Writes the camera's `cut.slice`. */
  update(x: number, y: number, floor: number, dt: number): void {
    const roof = this.roofOver(x, y, floor);
    // (from high over the roof: the mountain over a cave is peeled off down to it, and back up when it's left)
    const high = floor + 60;
    const k = Math.min(1, dt * this.rate);
    if (roof !== null) this.at = (this.at ?? high) + (roof - 0.05 - (this.at ?? high)) * k;
    else if (this.at !== null) {
      this.at += (high + 5 - this.at) * k;
      if (this.at >= high) this.at = null;
    }
    this.camera.cut.slice = this.at;
  }

  /** The lowest underside of rock over the point (its column and the ring round it, within 12 cells), or null. */
  private roofOver(x: number, y: number, floor: number): number | null {
    let roof: number | null = null;
    let n = 0;
    let covered = 0;
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const s = this.sight.solidAt(x + dx, y + dy);
      if (!s) continue;
      n++;
      const over = s.find((v) => v.z0 > floor + 1.5 && v.z0 < floor + 12);
      if (!over) continue;
      covered++;
      roof = roof === null ? over.z0 : Math.min(roof, over.z0);
    }
    // (most of it covered: a cave's mouth, half in the open, isn't)
    return covered * 2 > n ? roof : null;
  }
}

/** A large obstacle between a point and the eye turns the view, on a spring, to where it's seen from. */
export class Orbit {
  /** what hides the point no higher than this over its floor (cells) doesn't turn the view */
  large = 8;
  /** the spring (1/s: its natural rate; critically damped) */
  rate = 2.6;
  /** radians a second, at most */
  maxSpeed = 2.2;
  /** the azimuth it's turning to; null at rest */
  goal: number | null = null;
  /**
   * (round 83, the hoverbike: "settle within 30° of behind the bike") A preferred azimuth: while the point
   * is seen, the view is drawn back within `dead` of `az` (radians) — on the spring, twice as firm past
   * `firm`; when it's hidden, the clear angle nearest that zone is taken. Set it each frame (a heading
   * moves); null: none, the view stays where it's turned to.
   */
  prefer: { az: number; dead: number; firm?: number } | null = null;
  private speed = 0;
  private look = 0;
  private sight: Sight;
  constructor(
    terrain: Terrain,
    private camera: Camera,
  ) {
    this.sight = new Sight(terrain, camera);
  }

  /** Each frame: the point kept seen (world) and its floor. Turns the camera's `azimuth`. */
  update(x: number, y: number, floor: number, dt: number): void {
    const cam = this.camera;
    // (looked again every 0.15 s, turning or not: the goal follows the point as it moves)
    this.look -= dt;
    if (this.look <= 0) {
      this.look = 0.15;
      this.choose(x, y, floor);
    }
    const pf = this.prefer;
    const far = pf?.firm !== undefined && Math.abs(wrap(cam.azimuth - pf.az)) > pf.firm;
    const w = this.rate * (far ? 2 : 1);
    if (this.goal !== null) {
      const d = wrap(this.goal - cam.azimuth);
      this.speed += (w * w * d - 2 * w * this.speed) * dt;
      if (Math.abs(d) < 0.003 && Math.abs(this.speed) < 0.01) {
        this.goal = null;
        this.speed = 0;
      }
    } else this.speed -= 2 * w * this.speed * dt;
    this.speed = Math.max(-this.maxSpeed, Math.min(this.maxSpeed, this.speed));
    cam.azimuth = wrap(cam.azimuth + this.speed * dt);
  }

  /**
   * The goal: kept while the point's seen from it (drawn into the preferred zone, when there is one, if it's
   * seen from there); else the nearest angle (5° steps either way) it is, and 10° on — nearest the preferred
   * zone when there is one.
   */
  private choose(x: number, y: number, floor: number): void {
    const from = this.goal ?? this.camera.azimuth;
    const pf = this.prefer;
    // (the nearest angle in the preferred zone)
    const into = (a: number) => {
      if (!pf) return a;
      const d = wrap(a - pf.az);
      return Math.abs(d) <= pf.dead ? a : wrap(pf.az + Math.sign(d) * pf.dead);
    };
    if (this.seen(x, y, floor, from)) {
      const z = into(from);
      if (z !== from && this.seen(x, y, floor, z)) this.goal = z;
      return;
    }
    const at = into(from);
    if (at !== from && this.seen(x, y, floor, at)) {
      this.goal = at;
      return;
    }
    const step = Math.PI / 36;
    for (let k = 1; k <= 36; k++)
      for (const s of [1, -1]) {
        const a = at + s * k * step;
        if (this.seen(x, y, floor, a)) {
          const on = a + s * 2 * step;
          this.goal = wrap(this.seen(x, y, floor, on) ? on : a);
          return;
        }
      }
  }

  /** Is (x, y) on its floor seen from azimuth `az` — nothing over `large` between it and the eye? (public: a game's own camera rules) */
  seen(x: number, y: number, floor: number, az: number): boolean {
    const h = this.sight.hiddenBy(x, y, floor + 1.2, floor, az);
    return h === null || h <= this.large;
  }
}

/** Points kept seen (what's in front dithered out round them while they're hidden); surfaces that may be. */
export class Dither {
  /** a hole's radius on screen (world units) */
  radius = 9;
  /** seconds for a hole to open or close */
  ease = 0.3;
  private points = new Map<string, { x: number; y: number; z: number; r: number; open: number }>();
  private boxes = new Map<string, [number, number, number, number, number, number]>();
  private sight: Sight;
  constructor(
    terrain: Terrain,
    private camera: Camera,
  ) {
    this.sight = new Sight(terrain, camera);
  }

  /** Keep the point (world; e.g. a character's feet) seen, a hole `radius` round it; call each frame it moves. At most 4. */
  see(id: string, x: number, y: number, z: number, radius = this.radius): void {
    const p = this.points.get(id);
    if (p) Object.assign(p, { x, y, z, r: radius });
    else {
      if (this.points.size >= MAX_SEE) throw new Error(`Dither.see: at most ${MAX_SEE} points (render.wgsl Camera.see)`);
      this.points.set(id, { x, y, z, r: radius, open: 0 });
    }
  }

  forget(id: string): void {
    this.points.delete(id);
  }

  /**
   * Mark a surface (the box lo..hi, world) as what may be dithered: once any is marked, only what's in one is.
   * At most 4.
   */
  surface(id: string, lo: [number, number, number], hi: [number, number, number]): void {
    if (!this.boxes.has(id) && this.boxes.size >= MAX_BOX) throw new Error(`Dither.surface: at most ${MAX_BOX} (render.wgsl Camera.boxes)`);
    this.boxes.set(id, [...lo, ...hi]);
  }

  unsurface(id: string): void {
    this.boxes.delete(id);
  }

  /** Each frame, before drawing: the holes open (hidden) or close. Writes the camera's `cut.see` and `cut.boxes`. */
  update(dt: number): void {
    const step = dt / Math.max(this.ease, 1e-3);
    const see: [number, number, number, number][] = [];
    for (const p of this.points.values()) {
      const hidden = this.sight.hiddenBy(p.x, p.y, p.z + 1.2, p.z, this.camera.azimuth) !== null;
      p.open = Math.max(0, Math.min(1, p.open + (hidden ? step : -step)));
      const r = p.r * smooth(p.open);
      if (r > 0.05) see.push([p.x, p.y, p.z, r]);
    }
    this.camera.cut.see = see;
    this.camera.cut.boxes = [...this.boxes.values()];
  }
}

/** render.wgsl Camera.see, Camera.boxes */
export const MAX_SEE = 4;
export const MAX_BOX = 4;

const smooth = (t: number) => t * t * (3 - 2 * t);
const wrap = (a: number) => a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI;
