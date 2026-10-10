// Structural integrity and falling pieces (round 14, BACKLOG F7; round 17
// K1: bodies sleep where they lie, projected into the terrain grid, within a
// budget) — the sandbox's physics playground. Places where structures changed (a smash, a
// placed model, a cyclone passing, a body landing) are marked dirty; a few
// times a second the layers are read back, the dirty boxes analysed
// (fracture.ts), what breaks free is cut out of the world and becomes a
// rigid body (bodies.ts), crumbled cross-sections burst into chips, and a
// body that comes to rest is written back as voxels.
// The world is edited column by column on the CPU and written back (like the
// place tool); the GPU structure rule only collapses damage here (its
// span-support rule would turn overhangs to rubble before this sees them).

import { packInterval, readColumn, columnSlots, type Interval } from '../world/layout';
import { MAT } from '../world/materials';
import { analyse, WorldVox, type Voxel } from './fracture';
import { Bodies, type Body } from './bodies';
import type { WorldCore } from '../scenes/world-core';
import { ignoreTeardown } from '../gpu/pipeline';

const PASS = 0.35; // s between analyses while anything is dirty or moving

export class Integrity {
  readonly bodies: Bodies;
  private world: WorldVox;
  /** boxes to analyse: x0, y0, x1, y1, passes left (edits reach the GPU a
   *  tick after they are queued, so each box is looked at twice) */
  private dirty: [number, number, number, number, number][] = [];
  private t = 0;
  private busy = false;
  /** chips where something crumbles or a body hits hard */
  onChips?: (x: number, y: number, z: number, count: number) => void;
  /** stats for the perf overlay / tests */
  stats = { passes: 0, bodies: 0, crumbled: 0, settled: 0, crumbledBodies: 0, lastMs: 0 };
  /** sleeping bodies projected per column: top, bottom (top < 0: none) — the
   *  GPU's bodyProj texture and the bodies' own collision share it */
  readonly proj: Float32Array;
  /** budget for sleeping bodies (DECISIONS round 17) */
  static readonly MAX_SLEEPING = 64;
  static readonly MAX_SLEEP_VOXELS = 16384;

  constructor(private core: WorldCore) {
    this.world = new WorldVox(core.packed, new Uint32Array(0));
    this.bodies = new Bodies(this.world);
    const N = core.dims.w * core.dims.h;
    this.proj = new Float32Array(N * 4);
    this.resetProjection();
    this.bodies.proj = this.proj;
    this.bodies.onSleep = () => {
      this.stats.settled++;
      this.keepBudget();
      this.project();
    };
    this.bodies.onImpact = (speed, at) => this.onChips?.(at[0], at[1], at[2], Math.min(12, Math.round(speed / 3)));
  }

  /** Structures around (x, y) within r may have changed. */
  markDirty(x: number, y: number, r: number): void {
    this.markBox(x - r, y - r, x + r, y + r);
  }
  markBox(x0: number, y0: number, x1: number, y1: number): void {
    this.dirty.push([x0, y0, x1, y1, 2]);
  }

  /** Forget every falling piece (undo restores the world beneath them). */
  clear(): void {
    this.bodies.list = [];
    this.dirty = [];
    this.project();
  }

  private resetProjection(): void {
    for (let i = 0; i < this.proj.length; i += 4) {
      this.proj[i] = -1;
      this.proj[i + 1] = 0;
    }
  }

  /**
   * Rasterise every sleeping body into the terrain grid: per column, the top
   * and bottom of any body voxel over it (each voxel's rotated-cube box, so a
   * little generous at skewed edges). Written to the bodyProj texture.
   */
  private project(): void {
    this.resetProjection();
    const { w: W, h: H } = this.core.dims;
    const P = this.proj;
    for (const b of this.bodies.list) {
      if (!b.asleep) continue;
      this.bodies.voxelBounds(b, (lo, hi) => {
        for (let y = Math.max(0, Math.floor(lo[1] + 0.15)); y <= Math.min(H - 1, Math.floor(hi[1] - 0.15)); y++)
          for (let x = Math.max(0, Math.floor(lo[0] + 0.15)); x <= Math.min(W - 1, Math.floor(hi[0] - 0.15)); x++) {
            const i = (y * W + x) * 4;
            if (P[i] < 0) {
              P[i] = hi[2];
              P[i + 1] = lo[2];
            } else {
              P[i] = Math.max(P[i], hi[2]);
              P[i + 1] = Math.min(P[i + 1], lo[2]);
            }
          }
      });
    }
    const dev = this.core.host.gpu.device;
    dev.queue.writeTexture({ texture: this.core.world.bodyProj }, P as Float32Array<ArrayBuffer>, { bytesPerRow: W * 16 }, [W, H]);
  }

  /**
   * Over budget (DECISIONS round 17: about 64 sleeping bodies, 16k voxels):
   * the oldest small sleeping bodies crumble into loose ground where they lie
   * (the oldest of all if none is small).
   */
  private keepBudget(): void {
    for (;;) {
      const sleeping = this.bodies.list.filter((b) => b.asleep);
      const voxels = sleeping.reduce((s, b) => s + b.local.length, 0);
      if (sleeping.length <= Integrity.MAX_SLEEPING && voxels <= Integrity.MAX_SLEEP_VOXELS) return;
      const byAge = sleeping.sort((a, b) => a.sleptAt - b.sleptAt);
      const victim = byAge.find((b) => b.local.length < 200) ?? byAge[0];
      this.crumble(victim);
    }
  }

  /**
   * A body turns into loose ground where it lies: each voxel's volume goes to
   * the column under it, as the loose material its own material breaks down
   * to (concrete, brick, stone, metal → gravel; wood, canvas → ash; bone →
   * dust). Through the looseAdd buffer, which the drift pass folds in.
   */
  crumble(b: Body): void {
    const { w: W, h: H } = this.core.dims;
    const add = new Map<number, { amount: number; mats: Map<number, number> }>();
    for (const v of this.bodies.worldVoxels(b)) {
      const x = Math.floor(v.p[0]);
      const y = Math.floor(v.p[1]);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = y * W + x;
      const m = looseFrom(v.mat);
      const e = add.get(i) ?? { amount: 0, mats: new Map() };
      e.amount += 1;
      e.mats.set(m, (e.mats.get(m) ?? 0) + 1);
      add.set(i, e);
      this.onChips?.(v.p[0], v.p[1], v.p[2], 1);
    }
    const dev = this.core.host.gpu.device;
    for (const [i, e] of add) {
      let best: number = MAT.Rubble;
      let n = -1;
      for (const [m, c] of e.mats) if (c > n) [best, n] = [m, c];
      dev.queue.writeBuffer(this.core.world.looseAdd, i * 8, new Float32Array([e.amount, best]));
    }
    this.bodies.list = this.bodies.list.filter((x) => x !== b);
    this.stats.crumbledBodies++;
  }

  update(dt: number): void {
    if (this.world.slots.length && dt > 0) this.bodies.update(dt);
    const { data, count } = this.bodies.pack();
    this.core.renderer.setBodies(data, count);
    this.t -= dt;
    if (this.busy || this.t > 0 || (!this.dirty.length && !this.bodies.anyAwake && this.world.slots.length)) return;
    this.t = PASS;
    this.busy = true;
    // the layers (structures, solid ground) and the loose ground's depth
    // (bodies lie on it) — read back together
    void Promise.all([this.core.readBuffer('layers'), this.core.readTexture(this.core.world.drift)]).then(([f, d]) => {
      this.busy = false;
      this.world.slots = new Uint32Array(f.buffer);
      const loose = new Float32Array(d.w * d.h);
      for (let i = 0; i < loose.length; i++) loose[i] = d.data[i * 4];
      this.bodies.loose = loose;
      this.pass();
    }, ignoreTeardown);
  }

  private pass(): void {
    const t0 = performance.now();
    const boxes = this.dirty;
    this.dirty = [];
    this.stats.passes++;
    for (const [x0, y0, x1, y1, left] of boxes) {
      if (left > 1) this.dirty.push([x0, y0, x1, y1, left - 1]);
      const r = analyse(this.world, x0 - 2, y0 - 2, x1 + 2, y1 + 2);
      if (r.crumble.length) {
        this.removeCells(r.crumble);
        this.stats.crumbled += r.crumble.length;
        for (const c of r.crumble) this.onChips?.(c.x + 0.5, c.y + 0.5, c.z + 0.5, 4);
        // what the cut held is looked at again next pass (it now hangs free)
        this.markBox(x0, y0, x1, y1);
      }
      for (const cells of r.bodies) {
        this.removeCells(cells);
        this.bodies.spawn(cells);
        this.stats.bodies++;
      }
    }
    this.stats.lastMs = performance.now() - t0;
  }

  /** Cut single cells out of their columns (CPU mirror + GPU). */
  private removeCells(cells: Voxel[]): void {
    const byCol = new Map<number, number[]>();
    const W = this.core.dims.w;
    for (const c of cells) {
      const k = c.y * W + c.x;
      if (!byCol.has(k)) byCol.set(k, []);
      byCol.get(k)!.push(c.z);
    }
    for (const [k, zs] of byCol) {
      const x = k % W;
      const y = (k - x) / W;
      let col = readColumn(this.core.packed, this.world.slots, x, y);
      for (const z of zs) {
        const out: Interval[] = [];
        for (const iv of col) {
          if (z < iv.z0 || z >= iv.z1) out.push(iv);
          else {
            if (iv.z0 < z) out.push({ ...iv, z1: z });
            if (z + 1 < iv.z1) out.push({ ...iv, z0: z + 1 });
          }
        }
        col = out;
      }
      this.writeColumn(x, y, col);
    }
  }

  private writeColumn(x: number, y: number, col: Interval[]): void {
    const { base, k } = columnSlots(this.core.packed, x, y);
    if (col.length > k) {
      // no room: keep the bottom k − 1 and pile the rest's mass as rubble on top
      const keep = col.slice(0, k - 1);
      const top = keep.length ? keep[keep.length - 1].z1 : 0;
      const rest = col.slice(k - 1).reduce((s, iv) => s + iv.z1 - iv.z0, 0);
      keep.push({ z0: top, z1: Math.min(top + rest, this.core.dims.zMax - 1), mat: MAT.Rubble });
      col = keep;
    }
    const data = new Uint32Array(k);
    col.forEach((iv, s) => (data[s] = packInterval(iv.z0, iv.z1, iv.mat, iv.aux ?? 0)));
    this.world.slots.set(data, base);
    this.core.host.gpu.device.queue.writeBuffer(this.core.world.layers, base * 4, data);
  }
}

/** What a body voxel of material m crumbles to (a loose material). */
function looseFrom(m: number): number {
  if (m === MAT.Wood || m === MAT.Canvas || m === MAT.Leaves) return MAT.Ash;
  if (m === MAT.Bone) return MAT.Drift;
  return MAT.Rubble;
}
