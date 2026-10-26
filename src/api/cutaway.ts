// ---- api/cutaway.ts -----------------------------------------------------------
// The character always seen (round 82, V21). The user: "Imagine the camera as puck following gravity and
// sliding along a surface. When that surface goes below other surfaces I think we want to dither and show
// the surface" — "if you are inside a cave that opens onto a beach I expect to see the beach and cave
// interior not the cliffs above" — "Dithering or an outline make sense for small obstacles but very large
// obstacles probably should rotate the camera to an angle that isn't occluded and being in a lower layer
// should probably just skip rendering the layers above".
//
// A puck rests on the floor under the character (it falls to it: a jump leaves it on the ground) and slides
// with it. Each frame it looks up at the eye:
// - under a roof (rock over the puck: a cave, an overhang) — a slice: nothing over the roof's underside is
//   drawn, the whole view; what solid it cuts shows dark (render.wgsl cutAway, a section as a plan shows);
// - in the open, something low in front (a tree, a wall, a rock) — a hole: dithered out round the character,
//   opening and closing like an iris;
// - in the open, something large in front (a cliff, a mountain) — the view turns, the shortest way, to the
//   nearest angle the puck is seen from, and stays there.
// The shadows are the world's as it stands.
//
//   const cut = new Cutaway(sim.terrain, core.camera)
//   each frame, before drawing:  cut.update(x, y, z, dt)   // the character's feet (world)

import type { Camera } from '../render/camera';
import type { Terrain } from './terrain';

type Mode = 'clear' | 'hole' | 'slice' | 'turn';
type Solid = { z0: number; z1: number }[] | null;

export class Cutaway {
  /** a hole's radius on screen (world units) */
  radius = 9;
  /** what's in front no higher than this over the puck's floor (cells) is cut with a hole; higher, the view turns */
  large = 8;
  /** seconds for a hole to open or close */
  ease = 0.3;
  /** radians a second the view turns at, at most */
  turnRate = 2.5;
  /** what the last look found */
  mode: Mode = 'clear';
  /** 0 closed .. 1 open (the hole) */
  open = 0;
  /** the puck's floor (world z), once known */
  floor: number | null = null;
  /** the view's azimuth being turned to */
  private aim: number | null = null;
  private cols = new Map<number, Solid>();

  constructor(
    private terrain: Terrain,
    private camera: Camera,
  ) {}

  /** Each frame, before drawing: the character's feet (world). Writes the camera's `focus`, may turn it. */
  update(x: number, y: number, z: number, dt: number): void {
    this.cols.clear();
    const f = this.terrain.floorAt(x, y, z + 0.5);
    if (f !== null) this.floor = this.floor === null || Math.abs(f - this.floor) > 4 ? f : this.floor + (f - this.floor) * Math.min(1, dt * 12);
    const cam = this.camera;
    if (this.floor === null) {
      cam.focus = null;
      return;
    }
    const floor = this.floor;
    const roof = this.roofOver(x, y, floor);
    const step = dt / Math.max(this.ease, 1e-3);
    if (roof !== null) {
      // under a roof: the layer it's in, seen from above
      this.mode = 'slice';
      this.open = 0;
      cam.focus = [x, y, roof - 0.05, -1];
    } else {
      const hidden = this.hiddenBy(x, y, floor, cam.azimuth);
      if (hidden === null) this.mode = 'clear';
      else if (hidden <= this.large) this.mode = 'hole';
      else {
        // the nearest angle it's seen from, either way round, in steps of 15°
        const turn = this.aim === null ? this.clearAngle(x, y, floor, cam.azimuth) : null;
        if (turn !== null) this.aim = turn;
        this.mode = this.aim !== null ? 'turn' : 'hole';
      }
      this.open = Math.max(0, Math.min(1, this.open + (this.mode === 'hole' ? step : -step)));
      const r = this.radius * smooth(this.open);
      cam.focus = r > 0.05 ? [x, y, floor, r] : null;
    }
    if (this.aim !== null) {
      let d = this.aim - cam.azimuth;
      d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
      const s = this.turnRate * dt;
      if (Math.abs(d) <= s) {
        cam.azimuth = this.aim;
        this.aim = null;
      } else cam.azimuth += Math.sign(d) * s * Math.min(1, Math.abs(d) / 0.4 + 0.25);
    }
  }

  /** The solid in the column at (x, y), bottom up (this frame's). */
  private solidAt(x: number, y: number): Solid {
    const key = Math.floor(y) * 65536 + Math.floor(x);
    let s = this.cols.get(key);
    if (s === undefined) {
      s = this.terrain.layersAt(x, y)?.filter((v) => v.state === 'solid' || v.state === 'loose') ?? null;
      this.cols.set(key, s);
    }
    return s;
  }

  /** The lowest underside of rock over the puck (its column and the ring round it, within 12 cells), or null. */
  private roofOver(x: number, y: number, floor: number): number | null {
    let roof: number | null = null;
    let n = 0;
    let covered = 0;
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const s = this.solidAt(x + dx, y + dy);
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

  /** How high over the floor what hides the puck from the eye at azimuth `az` rises (cells), or null if nothing. */
  private hiddenBy(x: number, y: number, floor: number, az: number): number | null {
    const el = Math.asin(Math.max(-1, Math.min(1, this.camera.eye[2])));
    const ex = Math.cos(az) * Math.cos(el);
    const ey = Math.sin(az) * Math.cos(el);
    const ez = Math.sin(el);
    const z0 = floor + 1.2;
    let top: number | null = null;
    for (let t = 1; t <= 60; t += 0.5) {
      const px = x + ex * t;
      const py = y + ey * t;
      const pz = z0 + ez * t;
      const s = this.solidAt(px, py);
      if (!s?.length) continue;
      if (s.some((v) => pz >= v.z0 && pz < v.z1)) {
        const h = s[s.length - 1].z1 - floor;
        top = top === null ? h : Math.max(top, h);
      }
    }
    return top;
  }

  /** The nearest azimuth (15° steps either way) the puck is seen from, or null if none. */
  private clearAngle(x: number, y: number, floor: number, az: number): number | null {
    const step = Math.PI / 12;
    for (let k = 1; k <= 12; k++)
      for (const s of [1, -1]) {
        const a = az + s * k * step;
        if (this.hiddenBy(x, y, floor, a) === null) return a;
      }
    return null;
  }
}

const smooth = (t: number) => t * t * (3 - 2 * t);
