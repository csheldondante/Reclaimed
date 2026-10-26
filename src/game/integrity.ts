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

import { packColumn, readColumn, columnSlots, SLOT_WORDS, type Interval } from '../world/layout';
import { MAT } from '../world/materials';
import { analyse, analyseRock, WorldVox, type Voxel } from './fracture';
import { Bodies, type Body } from './bodies';
import type { WorldCore } from '../scenes/world-core';
import { ignoreTeardown } from '../gpu/pipeline';
import { cellAt, cellPos, ROW_H } from '../world/lattice';
import { EventKind } from '../sim/globals';

/** edit.wgsl's ops that take ground away (an Edit event's z: op · 32 + material + 512 + tag · 1024) */
const OP_DIG = 2;
const OP_SMASH = 12;
const OP_CRATER = 13;
const OP_TAKE = 14;

const PASS = 0.35; // s between analyses while anything is dirty or moving

/**
 * (perfopt, round 83 audit: ?intread=near) A pass reads back only the layers' chunks it looks at — round the dirty
 * boxes (4 cells), the cut columns (24: the rock hanging from them), the bodies (4) — into a CPU copy of all of
 * them, not all 16 MB of the atlas's window every 0.35 s while anything is dirty (riding: every region come in) or
 * every 1 s while bodies exist. After a slide (the window's epoch) the next read is whole again.
 */
const READ_NEAR = typeof location !== 'undefined' && new URLSearchParams(location.search).get('intread') === 'near';

// Impacts (round 21: "crumble much more easily, break up more; impacts make
// dust"): a body that hits something at IMPACT_BREAK cells/s or more
// shatters into about weakness · speed² · voxels / SHATTER pieces (the small
// ones near the point hit), then loses the voxels within a radius growing
// with the speed around that point (to loose ground, with dust and chips);
// pieces of up to IMPACT_CRUMB voxels crumble too. Metal breaks far less than
// stone. Softer hits only puff dust.
const IMPACT_BREAK = 1.2; // cells/s
const SHATTER = 700;
const IMPACT_CRUMB = 16; // voxels
const impactRadius = (speed: number) => Math.min(2.5, 0.5 + 0.3 * speed);
const impactReach = (m: number) => (m === MAT.Steel || m === MAT.Rust ? 0.4 : m === MAT.Wood ? 0.7 : 1);

export class Integrity {
  readonly bodies: Bodies;
  private world: WorldVox;
  /** boxes to analyse: x0, y0, x1, y1, passes left (edits reach the GPU a
   *  tick after they are queued, so each box is looked at twice) */
  private dirty: [number, number, number, number, number][] = [];
  /** (round 83) the columns an edit cut ("y,x" keys) and the passes each is looked at still: where rock is judged */
  private rockSeeds = new Map<number, number>();
  private t = 0;
  private busy = false;
  /** chips where something crumbles or a body hits hard */
  onChips?: (x: number, y: number, z: number, count: number) => void;
  /** something came down here: the low crash (voxels broken or landing) */
  onCollapse?: (x: number, y: number, z: number, amount: number) => void;
  /** dust where something breaks or a body hits (grains, spread in cells, the material it's made of) */
  onDust?: (x: number, y: number, z: number, count: number, spread: number, mat: number) => void;
  /** stats for the perf overlay / tests */
  stats = { passes: 0, bodies: 0, crumbled: 0, settled: 0, crumbledBodies: 0, impacts: 0, shatters: 0, shattered: 0, lastMs: 0 };
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
    this.bodies.onWake = () => this.project();
    this.bodies.onImpact = (b, speed, at) => this.impact(b, speed, at);
    // (round 83, the user: "the meteors and sandbox tools don't wake up the rocks") every edit that takes
    // ground away — a dig, a smash, a crater (a meteor's), a take — whoever queued it (the world API, the
    // sandbox's tools, the level's meteors): what it cut is judged, the rock by its columns
    core.sim.eventTaps.push((sent) => {
      for (const e of sent) {
        if (e.kind !== EventKind.Edit) continue;
        const op = ((e.z ?? 0) & 511) >> 5;
        if (op === OP_DIG || op === OP_SMASH || op === OP_CRATER || op === OP_TAKE) this.markDirty(e.x, e.y, e.radius + 14, Math.max(0.5, e.radius));
      }
    });
  }

  /**
   * Structures around (x, y) within r may have changed; `cut` (round 83): an edit cut the ground within that
   * radius — the rock by those columns is judged too (land come in, a cyclone passing: structures only, the
   * ground as it was made stands).
   */
  markDirty(x: number, y: number, r: number, cut?: number): void {
    this.markBox(x - r, y - r, x + r, y + r);
    if (cut !== undefined) this.markCut(x, y, cut);
  }
  /** (round 83) the columns within r of (x, y) were cut: the rock by them is judged, two passes */
  markCut(x: number, y: number, r: number): void {
    const [c0x, c0y] = cellAt(x - r - 1, y - r - 1);
    const [c1x, c1y] = cellAt(x + r + 1, y + r + 1);
    for (let cy = Math.max(0, c0y); cy <= Math.min(this.core.dims.h - 1, c1y); cy++)
      for (let cx = Math.max(0, c0x); cx <= Math.min(this.core.dims.w - 1, c1x); cx++) {
        const [px, py] = cellPos(cx, cy);
        if (Math.hypot(px - x, py - y) <= r + 0.75) this.rockSeeds.set(cy * 65536 + cx, 2);
      }
  }
  markBox(x0: number, y0: number, x1: number, y1: number): void {
    this.dirty.push([x0, y0, x1, y1, 2]);
  }

  /** The visible top of a column: solid ground plus loose ground, or a fallen body's top. */
  topAt(x: number, y: number): number {
    const i = y * this.core.dims.w + x;
    // (the layers hold the loose ground too)
    const ground = this.world.slots.length ? this.world.colTop(x, y) : 0;
    return Math.max(ground, this.proj[i * 4]);
  }

  /** Forget every falling piece (undo restores the world beneath them). */
  clear(): void {
    this.bodies.list = [];
    this.pendingLoose.clear();
    this.dirty = [];
    this.rockSeeds.clear();
    this.project();
  }

  private resetProjection(): void {
    for (let i = 0; i < this.proj.length; i += 4) {
      this.proj[i] = -1;
      this.proj[i + 1] = 0;
      this.proj[i + 2] = 0;
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
        // (the cells whose centres the voxel's box covers: the grid is hex)
        for (let y = Math.max(0, Math.floor((lo[1] + 0.15) / ROW_H - 0.5)); y <= Math.min(H - 1, Math.ceil((hi[1] - 0.15) / ROW_H - 0.5)); y++)
          for (let x = Math.max(0, Math.floor(lo[0] - 1)); x <= Math.min(W - 1, Math.ceil(hi[0])); x++) {
            const [cx, cy] = cellPos(x, y);
            if (cx < lo[0] + 0.15 || cx > hi[0] - 0.15 || cy < lo[1] + 0.15 || cy > hi[1] - 0.15) continue;
            const i = (y * W + x) * 4;
            if (P[i] < 0) {
              P[i] = hi[2];
              P[i + 1] = lo[2];
              P[i + 2] = b.id;
            } else {
              if (hi[2] > P[i]) P[i + 2] = b.id;
              P[i] = Math.max(P[i], hi[2]);
              P[i + 1] = Math.min(P[i + 1], lo[2]);
            }
          }
      });
    }
    const dev = this.core.host.gpu.device;
    dev.queue.writeTexture({ texture: this.core.world.bodyCpu }, P as Float32Array<ArrayBuffer>, { bytesPerRow: W * 16 }, [W, H]);
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
   * dust). Through the deposit buffer (y, z), which the sediment pass folds into the layers.
   */
  crumble(b: Body): void {
    this.toLoose(this.bodies.worldVoxels(b));
    this.bodies.list = this.bodies.list.filter((x) => x !== b);
    this.stats.crumbledBodies++;
  }

  /**
   * Break bodies at a world point (the Break tool, round 18): voxels within
   * the radius go (chips), the rest splits into pieces that wake and fall;
   * crumbs become loose ground. True if a body was hit.
   */
  breakBodies(at: [number, number, number], radius: number): boolean {
    const { removed, crumbs } = this.bodies.breakAt(at, radius);
    if (!removed.length) return false;
    this.chips(removed.map((v) => v.p), 1);
    this.onDust?.(at[0], at[1], at[2], Math.min(50, 8 + removed.length * 2), radius, mainMat(removed));
    this.toLoose(crumbs);
    this.project();
    return true;
  }

  /** A body hit something at `speed` (cells/s) at world point `at`. */
  private impact(b: Body, speed: number, at: [number, number, number]): void {
    this.stats.impacts++;
    const mat = mainMat(b.local);
    this.onDust?.(at[0], at[1], at[2], Math.min(40, Math.round(4 + speed * 4)), 0.6 + speed * 0.2, mat);
    if (speed < IMPACT_BREAK) {
      this.onCollapse?.(at[0], at[1], at[2], b.local.length * speed * 0.05);
      return;
    }
    const weak = b.local.reduce((s, v) => s + impactReach(v.mat), 0) / b.local.length;
    const k = Math.min(8, Math.floor((weak * speed * speed * b.local.length) / SHATTER));
    const shards = this.bodies.shatter(b, at, k, IMPACT_CRUMB);
    const { removed, crumbs } = this.bodies.breakAt(at, impactRadius(speed), IMPACT_CRUMB, impactReach);
    crumbs.push(...shards);
    if (k >= 2) this.stats.shatters++;
    this.onCollapse?.(at[0], at[1], at[2], removed.length + crumbs.length + b.local.length * speed * 0.05);
    if (!removed.length && !crumbs.length) return;
    this.stats.shattered += removed.length + crumbs.length;
    this.onDust?.(at[0], at[1], at[2], Math.min(60, 10 + removed.length * 3), impactRadius(speed) + 0.5, mat);
    this.toLoose([...removed, ...crumbs]);
    this.project();
  }

  /** loose ground waiting to go to the GPU: column → amount and material votes */
  private pendingLoose = new Map<number, { amount: number; mats: Map<number, number> }>();
  private looseFlushedAt = -Infinity;

  /** Voxels (world centres) into loose ground at the columns under them. */
  private toLoose(vox: { p: [number, number, number]; mat: number }[]): void {
    const { w: W, h: H } = this.core.dims;
    const add = this.pendingLoose;
    for (const v of vox) {
      const x = Math.floor(v.p[0]);
      const y = Math.floor(v.p[1]);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = y * W + x;
      const m = looseFrom(v.mat);
      const e = add.get(i) ?? { amount: 0, mats: new Map() };
      e.amount += 1;
      e.mats.set(m, (e.mats.get(m) ?? 0) + 1);
      add.set(i, e);
    }
    this.chips(vox.map((v) => v.p), 1);
    this.flushLoose();
  }

  /**
   * Chips at some points, `each` per point, as one burst per column (the
   * particle queue holds 64 bursts a tick; one per voxel crowded out the
   * dust clouds).
   */
  private chips(pts: [number, number, number][], each: number): void {
    const cols = new Map<string, { p: [number, number, number]; n: number }>();
    for (const p of pts) {
      const k = `${Math.floor(p[0])},${Math.floor(p[1])}`;
      const e = cols.get(k);
      if (e) {
        e.n += each;
        e.p[2] = Math.max(e.p[2], p[2]);
      } else cols.set(k, { p: [...p], n: each });
    }
    for (const { p, n } of cols.values()) this.onChips?.(p[0], p[1], p[2], Math.min(12, n));
  }

  /**
   * the deposit's y, z are overwritten, not added to, so a column is only written again
   * once the drift pass (period 2) has folded the last write in: at most one
   * flush per two sim ticks; in between, crumbs gather here.
   */
  private flushLoose(): void {
    const tick = this.core.globals.tick;
    if (!this.pendingLoose.size || tick - this.looseFlushedAt < 2) return;
    this.looseFlushedAt = tick;
    const dev = this.core.host.gpu.device;
    for (const [i, e] of this.pendingLoose) {
      let best: number = MAT.Rubble;
      let n = -1;
      for (const [m, c] of e.mats) if (c > n) [best, n] = [m, c];
      dev.queue.writeBuffer(this.core.world.deposit, i * 16 + 4, new Float32Array([e.amount, best]));
    }
    this.pendingLoose.clear();
  }

  update(dt: number): void {
    if (this.world.slots.length && dt > 0) {
      this.bodies.update(dt);
    }
    this.flushLoose();
    const { data, count } = this.bodies.pack();
    this.core.renderer.setBodies(data, count);
    this.t -= dt;
    if (this.busy || this.t > 0 || (!this.dirty.length && !this.rockSeeds.size && !this.bodies.list.length && this.world.slots.length)) return;
    // (with only sleeping bodies about, a slower pass still checks they're held up)
    this.t = this.dirty.length || this.rockSeeds.size || this.bodies.anyAwake ? PASS : 1.0;
    this.busy = true;
    // the layers (structures, solid ground) and the loose ground's depth
    // (bodies lie on it) — read back together
    void Promise.all([READ_NEAR ? this.readNear() : this.core.readBuffer('layers').then((f) => ((this.readBytes += f.byteLength), f)), this.core.readTexture(this.core.world.drift)]).then(([f, d]) => {
      this.busy = false;
      if (f) this.world.slots = new Uint32Array(f.buffer);
      const loose = new Float32Array(d.w * d.h);
      for (let i = 0; i < loose.length; i++) loose[i] = d.data[i * 4];
      this.bodies.loose = loose;
      this.pass();
    }, ignoreTeardown);
  }

  /** (intread=near) the window's epoch the CPU copy is of, and bytes read back so far (scripts read it) */
  private readEpoch = -1;
  readBytes = 0;

  /** (intread=near) the chunks a pass looks at, read back into the CPU copy of the layers (whole after a slide) */
  private async readNear(): Promise<Float32Array | null> {
    const core = this.core;
    if (!this.world.slots.length || core.windowEpoch !== this.readEpoch) {
      const e = core.windowEpoch;
      const f = await core.readBuffer('layers');
      this.readEpoch = e;
      this.readBytes += f.byteLength;
      return f;
    }
    const p = core.packed;
    const C = 16;
    const want = new Set<number>();
    const box = (x0: number, y0: number, x1: number, y1: number) => {
      const cx0 = Math.max(0, Math.floor(x0 / C));
      const cx1 = Math.min(p.chunksX - 1, Math.floor(x1 / C));
      const cy0 = Math.max(0, Math.floor(y0 / ROW_H / C));
      const cy1 = Math.min(p.chunksY - 1, Math.floor(y1 / ROW_H / C));
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) want.add(cy * p.chunksX + cx);
    };
    for (const [x0, y0, x1, y1] of this.dirty) box(x0 - 6, y0 - 6, x1 + 6, y1 + 6);
    for (const k of this.rockSeeds.keys()) {
      const [px, py] = cellPos(k % 65536, Math.floor(k / 65536));
      box(px - 24, py - 24, px + 24, py + 24);
    }
    for (const b of this.bodies.list) {
      let r = 0;
      for (const v of b.local) r = Math.max(r, Math.hypot(v.p[0], v.p[1], v.p[2]));
      box(b.pos[0] - r - 4, b.pos[1] - r - 4, b.pos[0] + r + 4, b.pos[1] + r + 4);
    }
    if (!want.size) return null;
    const dev = core.host.gpu.device;
    const ranges: [number, number][] = [];
    let bytes = 0;
    for (const ci of want) {
      const at = p.chunkTable[ci * 2] * SLOT_WORDS * 4;
      const n = C * C * p.chunkTable[ci * 2 + 1] * SLOT_WORDS * 4;
      ranges.push([at, n]);
      bytes += n;
    }
    const e = core.windowEpoch;
    const tmp = dev.createBuffer({ label: 'integrity near', size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = dev.createCommandEncoder();
    let o = 0;
    for (const [at, n] of ranges) {
      enc.copyBufferToBuffer(core.world.layers, at, tmp, o, n);
      o += n;
    }
    dev.queue.submit([enc.finish()]);
    await tmp.mapAsync(GPUMapMode.READ);
    // (the window slid meanwhile: the pages moved — the whole of it next time)
    if (core.windowEpoch !== e) {
      tmp.destroy();
      this.readEpoch = -1;
      return null;
    }
    const all = new Uint32Array(tmp.getMappedRange());
    o = 0;
    for (const [at, n] of ranges) {
      this.world.slots.set(all.subarray(o / 4, (o + n) / 4), at / 4);
      o += n;
    }
    tmp.destroy();
    this.readBytes += bytes;
    return null;
  }

  private pass(): void {
    const t0 = performance.now();
    // a sleeping body with nothing left under it (broken, dug, washed out) wakes
    for (const b of this.bodies.list) if (b.asleep && !this.bodies.supported(b)) this.bodies.wake(b);
    const boxes = this.dirty;
    this.dirty = [];
    this.stats.passes++;
    for (const [x0, y0, x1, y1, left] of boxes) {
      if (left > 1) this.dirty.push([x0, y0, x1, y1, left - 1]);
      const r = analyse(this.world, x0 - 2, y0 - 2, x1 + 2, y1 + 2);
      if (this.apply(r)) {
        // what the cut held is looked at again next pass (it now hangs free)
        this.markBox(x0, y0, x1, y1);
      }
    }
    // (round 83) rock, by the columns an edit cut: the hanging runs by them, and only those
    if (this.rockSeeds.size) {
      const seeds: [number, number][] = [];
      for (const [k, left] of this.rockSeeds) {
        seeds.push([k % 65536, Math.floor(k / 65536)]);
        if (left > 1) this.rockSeeds.set(k, left - 1);
        else this.rockSeeds.delete(k);
      }
      const r = analyseRock(this.world, seeds);
      // (what gave: its columns looked at again, what it held now hanging free)
      if (this.apply(r)) for (const c of r.crumble) this.rockSeeds.set(c.y * 65536 + c.x, 2);
    }
    this.stats.lastMs = performance.now() - t0;
  }

  /** What an analysis found, done: what crumbles crumbles, what breaks free falls. Did anything crumble? */
  private apply(r: { bodies: Voxel[][]; crumble: Voxel[] }): boolean {
    if (r.crumble.length) {
      this.removeCells(r.crumble);
      this.spillRubble(r.crumble);
      this.stats.crumbled += r.crumble.length;
      this.chips(r.crumble.map((c) => [c.x + 0.5, c.y + 0.5, c.z + 0.5]), 4);
    }
    for (const cells of r.bodies) {
      this.removeCells(cells);
      this.bodies.spawn(cells);
      // a cloud where it tore free (its lowest cells), to soften the moment
      const z0 = Math.min(...cells.map((c) => c.z));
      const foot = cells.filter((c) => c.z <= z0 + 1);
      const fx = foot.reduce((s, c) => s + c.x, 0) / foot.length + 0.5;
      const fy = foot.reduce((s, c) => s + c.y, 0) / foot.length + 0.5;
      this.onDust?.(fx, fy, z0 + 0.5, Math.min(40, 10 + foot.length), Math.sqrt(foot.length) * 0.6 + 0.5, mainMat(cells));
      this.onCollapse?.(fx, fy, z0 + 0.5, foot.length + r.crumble.length);
      this.stats.bodies++;
    }
    return r.crumble.length > 0;
  }

  /**
   * Crushed cells (a cross-section that gave way) don't vanish (round 23,
   * Q3): each one's volume squeezes out as its rubble (looseFrom) onto the
   * lowest open ground beside it — not where it was, where the rubble would
   * go on holding up what the section held.
   */
  private spillRubble(cells: Voxel[]): void {
    const { w: W, h: H } = this.core.dims;
    const gone = new Set(cells.map((c) => c.y * W + c.x));
    const tops = new Map<number, number>();
    const topAt = (x: number, y: number): number => {
      const k = y * W + x;
      let t = tops.get(k);
      if (t === undefined) {
        const col = readColumn(this.core.packed, this.world.slots, x, y);
        t = col.length ? col[col.length - 1].z1 : 0;
        tops.set(k, t);
      }
      return t;
    };
    const out: { p: [number, number, number]; mat: number }[] = [];
    for (const c of cells) {
      let best: [number, number] = [c.x, c.y];
      let low = Infinity;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = c.x + dx;
          const y = c.y + dy;
          if (x < 0 || y < 0 || x >= W || y >= H || gone.has(y * W + x)) continue;
          const t = topAt(x, y);
          if (t < low) [best, low] = [[x, y], t];
        }
      out.push({ p: [best[0] + 0.5, best[1] + 0.5, c.z + 0.5], mat: c.mat });
    }
    this.toLoose(out);
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
    const data = packColumn(col, k);
    this.world.slots.set(data, base * SLOT_WORDS);
    this.core.host.gpu.device.queue.writeBuffer(this.core.world.layers, base * SLOT_WORDS * 4, data);
    // (round 80: a column written under a sleeping chunk wakes it — its surface, its water, its slumping)
    this.core.sleep?.wake(x + 0.5, (y + 0.5) * ROW_H, 16, 8, performance.now() / 1000);
  }
}

/** What a body voxel of material m crumbles to (a loose material). */
function looseFrom(m: number): number {
  if (m === MAT.Wood || m === MAT.Canvas || m === MAT.Leaves) return MAT.Ash;
  if (m === MAT.Bone) return MAT.Drift;
  if (m === MAT.Trash) return MAT.Litter;
  if (m === MAT.Ice) return MAT.Snow;
  if (m === MAT.Crystal) return MAT.Sand;
  return MAT.Rubble;
}

/** The commonest material among some voxels. */
function mainMat(vox: { mat: number }[]): number {
  const n = new Map<number, number>();
  let best = 0;
  let most = 0;
  for (const v of vox) {
    const c = (n.get(v.mat) ?? 0) + 1;
    n.set(v.mat, c);
    if (c > most) [best, most] = [v.mat, c];
  }
  return best;
}
