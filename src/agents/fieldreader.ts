// A CPU copy of one agents field (round 52, docs/AGENTS.md), for walkers the
// CPU moves itself (a game's enemies, tumbling and grabbed and burning):
// they steer by the field the way the GPU units do instead of heading
// straight at their target.

import { cellAt, cellPos, nbr } from '../world/lattice';
import { NAV_K, type Agents } from './agents';

const FAR = 1e9;

/** What a field says at a point: the distance to its seeds and the way down it. */
export interface FieldSample {
  /** to the nearest seed (Infinity: unreachable from here, or no surface) */
  dist: number;
  /** a unit vector in the world plane toward the seeds ([0, 0] at a seed or unreachable) */
  dir: [number, number];
  /** the surface's height there */
  z: number;
  /** the surface's room and region (0: no place) */
  room: number;
  region: number;
}

/**
 * `refresh()` reads the field back (every 250-500 ms is plenty; `start`
 * does it on a timer); `sample()` steers like agents.wgsl unitStep.
 */
export class FieldReader {
  private nav: Uint32Array = new Uint32Array(0);
  private navF: Float32Array = new Float32Array(0);
  private dist: Float32Array = new Float32Array(0);
  private timer = 0;
  /** when the copy was read (performance.now), 0 never */
  readAt = 0;

  constructor(
    private agents: Agents,
    readonly field: number,
    private w: number,
    private h: number,
  ) {}

  async refresh(): Promise<void> {
    const r = await this.agents.readField(this.field);
    if (!r.nav.length) return;
    this.nav = r.nav;
    this.navF = new Float32Array(r.nav.buffer);
    this.dist = r.dist;
    this.readAt = performance.now();
  }

  /** Refresh every `ms` until stop(). */
  start(ms = 300): this {
    this.stop();
    void this.refresh();
    this.timer = window.setInterval(() => void this.refresh(), ms);
    return this;
  }

  stop(): void {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = 0;
  }

  private zOf(s: number): number {
    return this.navF[s * 4];
  }

  /** the surface of column i nearest below (or a step above) z; -1 none */
  private surfaceAt(i: number, z: number): number {
    let best = -1;
    let bd = FAR;
    for (let k = 0; k < NAV_K; k++) {
      const zk = this.zOf(i * NAV_K + k);
      if (zk < 0) break;
      if (zk > z + 1.1) continue;
      if (z - zk < bd) {
        bd = z - zk;
        best = i * NAV_K + k;
      }
    }
    return best;
  }

  /** The field at world (x, y), on the surface nearest below z (default: the top). Null before the first refresh. */
  sample(x: number, y: number, z = 1e4): FieldSample | null {
    if (!this.readAt) return null;
    const [cx, cy] = cellAt(x, y);
    const none: FieldSample = { dist: Infinity, dir: [0, 0], z: 0, room: 0, region: 0 };
    if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) return none;
    const s = this.surfaceAt(cy * this.w + cx, z + 0.5);
    if (s < 0) return none;
    const at = { z: this.zOf(s), room: this.nav[s * 4 + 2] & 0xffff, region: this.nav[s * 4 + 2] >>> 16 };
    const here = this.dist[s];
    if (here >= FAR) return { ...none, ...at };
    // the neighbours' drops, each toward its centre; the best step when that points nowhere useful
    let gx = 0;
    let gy = 0;
    let bestD = here;
    let bx = 0;
    let by = 0;
    const links = this.nav[s * 4 + 1] >>> 9;
    for (let d = 0; d < 6; d++) {
      const l = (links >>> (3 * d)) & 7;
      if (!l) continue;
      const [qx, qy] = nbr(cx, cy, d);
      const dn = this.dist[(qy * this.w + qx) * NAV_K + l - 1];
      if (dn >= FAR) continue;
      const [px, py] = cellPos(qx, qy);
      const len = Math.hypot(px - x, py - y) || 1;
      const tx = (px - x) / len;
      const ty = (py - y) / len;
      gx += tx * Math.max(here - dn, 0);
      gy += ty * Math.max(here - dn, 0);
      if (dn < bestD) {
        bestD = dn;
        bx = tx;
        by = ty;
      }
    }
    const gl = Math.hypot(gx, gy);
    const useG = gl > 0.2 && (gx * bx + gy * by) / gl > 0.3;
    return { dist: here, dir: useG ? [gx / gl, gy / gl] : [bx, by], ...at };
  }
}
