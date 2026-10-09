// Structural integrity and falling pieces (round 14, BACKLOG F7) — the
// sandbox's physics playground. Places where structures changed (a smash, a
// placed model, a cyclone passing, a body landing) are marked dirty; a few
// times a second the layers are read back, the dirty boxes analysed
// (fracture.ts), what breaks free is cut out of the world and becomes a
// rigid body (bodies.ts), crumbled cross-sections burst into chips, and a
// body that comes to rest is written back as voxels.
// The world is edited column by column on the CPU and written back (like the
// place tool); the GPU structure rule only collapses damage here (its
// span-support rule would turn overhangs to rubble before this sees them).

import { packInterval, readColumn, columnSlots, type Interval } from '../world/layout';
import { mergeColumn } from '../world/models';
import { MAT } from '../world/materials';
import { analyse, WorldVox, type Voxel } from './fracture';
import { Bodies } from './bodies';
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
  stats = { passes: 0, bodies: 0, crumbled: 0, settled: 0, lastMs: 0 };

  constructor(private core: WorldCore) {
    this.world = new WorldVox(core.packed, new Uint32Array(0));
    this.bodies = new Bodies(this.world);
    this.bodies.onSettle = (cells) => {
      this.stats.settled++;
      this.addCells(cells);
      const xs = cells.map((c) => c.x);
      const ys = cells.map((c) => c.y);
      this.markBox(Math.min(...xs) - 3, Math.min(...ys) - 3, Math.max(...xs) + 4, Math.max(...ys) + 4);
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
  }

  update(dt: number): void {
    if (this.world.slots.length && dt > 0) this.bodies.update(dt);
    const { data, count } = this.bodies.pack();
    this.core.renderer.setBodies(data, count);
    this.t -= dt;
    if (this.busy || this.t > 0 || (!this.dirty.length && !this.bodies.list.length && this.world.slots.length)) return;
    this.t = PASS;
    this.busy = true;
    void this.core.readBuffer('layers').then((f) => {
      this.busy = false;
      this.world.slots = new Uint32Array(f.buffer);
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

  /**
   * Write a settled body's cells into the world. A cell already taken (the
   * body came to rest a little into something) is put on the top of its
   * column as rubble instead.
   */
  private addCells(cells: Voxel[]): void {
    const byCol = new Map<number, Voxel[]>();
    const { w: W, h: H, zMax } = this.core.dims;
    for (const c of cells) {
      if (c.x < 0 || c.y < 0 || c.x >= W || c.y >= H || c.z < 0 || c.z >= zMax - 1) continue;
      const k = c.y * W + c.x;
      if (!byCol.has(k)) byCol.set(k, []);
      byCol.get(k)!.push(c);
    }
    for (const [k, cs] of byCol) {
      const x = k % W;
      const y = (k - x) / W;
      const col = readColumn(this.core.packed, this.world.slots, x, y);
      const runs: Interval[] = [];
      let displaced = 0;
      for (const c of cs.sort((a, b) => a.z - b.z)) {
        if (this.world.matAt(x, y, c.z)) {
          displaced++;
          continue;
        }
        const last = runs[runs.length - 1];
        if (last && last.z1 === c.z && last.mat === c.mat) last.z1++;
        else runs.push({ z0: c.z, z1: c.z + 1, mat: c.mat, aux: 15 << 4 });
      }
      let merged = mergeColumn(col, runs);
      if (displaced) {
        const top = merged.length ? merged[merged.length - 1].z1 : 0;
        if (top + displaced < zMax - 1) merged = mergeColumn(merged, [{ z0: top, z1: top + displaced, mat: MAT.Rubble }]);
      }
      this.writeColumn(x, y, merged);
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
