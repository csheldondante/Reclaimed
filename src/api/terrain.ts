// world.terrain (docs/WORLD_API.md): the ground, read from a CPU mirror in
// world coordinates, and the editor's ground ops as commands.

import type { WorldCore } from '../scenes/world-core';
import { EventKind } from '../sim/globals';
import { ROW_H, cellAt, cellPos } from '../world/lattice';
import { EDIT_TAGS } from '../sim/world-gpu';
import { CHUNK, columnSlots, readColumn, sfZ, SLOT_WORDS } from '../world/layout';
import { MAT, MATERIALS, MatState } from '../world/materials';
import { columnAt, materialId, materialName, materialState, type MaterialName } from './common';
import { PULL_SLOTS } from '../sim/systems';
import type { Mirror } from './mirror';
import { blendedTop } from './smooth';

/** edit.wgsl ops (op · 32 + material; + STROKE_START: each command its own press) */
const OP_BUILD = 1;
const OP_DIG = 2;
const OP_POUR = 10;
const OP_CRATER = 13;
const OP_TAKE = 14;
const OP_PUT = 15;
const STROKE_START = 512;

export interface Layer {
  z0: number;
  z1: number;
  material: MaterialName;
  state: 'solid' | 'loose' | 'liquid' | 'plant' | 'air';
}

export interface SampleOpts {
  /**
   * Sample the way the field mesh draws the ground: the columns' tops
   * blended over the three nearest cell centres at the mesh's warped point,
   * so a rider glides instead of stepping hex to hex. What the mesh leaves
   * sharp (ruins drawn as prisms, structures' cubes) stays sharp: over one,
   * its top.
   */
  smooth?: boolean;
}

export interface PullOpts {
  /** what lies over the pulled run: 'lift' rides up with it (loose cover then slumps off by itself), 'through' cracks the solids on it to their rubble */
  mode?: 'lift' | 'through';
  /** how broken its outline is, 0..1 (default: 0.6 for a solid, 0.15 for loose ground) */
  roughness?: number;
  /** lean the pull: higher toward `dir` (amount 1: the far rim twice the height, the near one nothing) */
  lean?: { dir: readonly [number, number]; amount: number };
  /** shake off the loose ground it lifts, 0..1 (default 1): for 4 s it slips at a slope up to 80% less steep, up to 1.5× as fast, roots letting go, so it runs off rather than riding up (as off a rising volcano) */
  shake?: number;
}

/**
 * A layer pull under way (terrain.pull): call `to` each frame with the
 * brush's centre, radius and the stroke's height so far; overlapping calls
 * compose (each column moves toward the most the stroke has asked of it,
 * never twice), so a drag with a growing height builds smoothly. `end`
 * when the drag lets go.
 */
export class PullStroke {
  private started = false;
  private done = false;
  constructor(
    private owner: Terrain,
    readonly slot: number,
    private material: number,
    private opts: PullOpts,
  ) {}

  to(x: number, y: number, at: { radius: number; height: number }): void {
    if (this.done) throw new Error('world.terrain.pull: the stroke has ended');
    const o = this.opts;
    const l = o.lean ? Math.hypot(o.lean.dir[0], o.lean.dir[1]) || 1 : 1;
    this.owner.queuePull({
      x,
      y,
      radius: at.radius,
      height: at.height,
      material: this.material,
      mode: o.mode === 'through' ? 1 : 0,
      slot: this.slot,
      start: !this.started,
      roughness: o.roughness ?? (materialState(this.material) === 'solid' ? 0.6 : 0.15),
      dir: o.lean ? [o.lean.dir[0] / l, o.lean.dir[1] / l] : [0, 0],
      lean: o.lean?.amount ?? 0,
      shake: o.shake ?? 1,
    });
    this.started = true;
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    this.owner.releaseSlot(this.slot);
  }
}

export interface RaiseOpts {
  /** the brush's half-width (cells; default range 8, mesa 6) */
  radius?: number;
  /** range: its height over the ground (default 22); mesa: its top over the ground where the stroke starts (default 10) */
  height?: number;
  /** mesa: its top level, absolute z (default: the ground where the stroke starts + height) */
  level?: number;
}

/**
 * A landform brush stroke under way (terrain.raise; round 64): call `to`
 * each frame with the brush's centre; the land rises along where it went
 * (a range: a ridge, peaks and spurs, on the ground; a mesa: flat at its
 * level, cliffs at the edge, banded sandstone and stone) at 18 cells/s.
 * `end` when the drag lets go (what's still rising finishes).
 */
export class RaiseStroke {
  private last?: [number, number];
  private level?: number;
  private static next = 1;
  private done = false;
  private serial = RaiseStroke.next++;
  constructor(
    private owner: Terrain,
    readonly shape: 'range' | 'mesa',
    private opts: RaiseOpts,
  ) {}

  to(x: number, y: number): void {
    if (this.done) throw new Error('world.terrain.raise: the stroke has ended');
    const mesa = this.shape === 'mesa';
    const height = this.opts.height ?? (mesa ? 10 : 22);
    if (mesa && this.level === undefined) {
      const g = this.owner.heightAt(x, y);
      if (g === null) throw new Error('world.terrain.raise: the ground is not read yet (await terrain.refresh())');
      this.level = this.opts.level ?? g + height;
    }
    this.owner.queueStamp({
      from: this.last ?? [x, y],
      to: [x, y],
      radius: this.opts.radius ?? (mesa ? 6 : 8),
      height: mesa ? this.level! : height,
      shape: this.shape,
      stroke: this.serial,
    });
    this.last = [x, y];
  }

  end(): void {
    this.done = true;
  }
}

/** meshregion.wgsl fieldMat: in the field mesh (else drawn as a prism: what's built) */
function fieldMat(m: number): boolean {
  return MATERIALS[m]?.state !== MatState.Solid || m === MAT.Stone || m === MAT.Trash || m === MAT.Basalt || m === MAT.Sandstone;
}

/**
 * Queries answer from the mirror (refreshed every `mirror.every` ms, 250 by
 * default; `readAt` says when): until the first read they return null.
 * The nature grid's layers; tilted structure grids count in `heightAt` and
 * `floorAt` (their projected floors), not in `materialAt` / `layersAt`.
 */
export class Terrain {
  /** per column, the top of its field-mesh ground (NaN: not worked out yet this read) */
  private fieldTops = new Float32Array(0);
  private topsGen = -1;
  /** stroke slots: when each was last taken (0 free) */
  private slots = new Float64Array(PULL_SLOTS);

  constructor(
    private core: WorldCore,
    private mirror: Mirror,
  ) {
    const w = core.world;
    mirror.addBuffer('surface', w.surface);
    // (perfopt, ?mirror=near: by pages round the camera's target between whole reads — api/mirror.ts)
    const p = core.packed;
    mirror.addBuffer('layers', w.layers, { chunksX: p.chunksX, chunksY: p.chunksY, chunkTable: p.chunkTable, slotBytes: SLOT_WORDS * 4, chunk: CHUNK, rowH: ROW_H, focus: () => [core.camera.target[0], core.camera.target[1]] });
    mirror.addTexture('drift', w.drift);
    mirror.addTexture('levels', w.levels);
  }

  get readAt(): number {
    return this.mirror.readAt;
  }

  refresh(): Promise<void> {
    return this.mirror.refresh();
  }

  private col(x: number, y: number): number {
    return columnAt(this.core.dims.w, this.core.dims.h, x, y);
  }

  private inMap(cx: number, cy: number): boolean {
    return cx >= 0 && cy >= 0 && cx < this.core.dims.w && cy < this.core.dims.h;
  }

  /** column (cx, cy)'s field-mesh ground: the top of its highest interval the mesh draws (0: none) */
  private fieldTop(cx: number, cy: number): number | null {
    if (!this.inMap(cx, cy)) return null;
    const u = this.mirror.u32('layers');
    const f = this.mirror.f32('layers');
    if (!u || !f) return null;
    if (this.topsGen !== this.mirror.gen) {
      if (this.fieldTops.length !== this.core.dims.w * this.core.dims.h) this.fieldTops = new Float32Array(this.core.dims.w * this.core.dims.h);
      this.fieldTops.fill(NaN);
      this.topsGen = this.mirror.gen;
    }
    const i = cy * this.core.dims.w + cx;
    let t = this.fieldTops[i];
    if (Number.isNaN(t)) {
      t = 0;
      const { base, k } = columnSlots(this.core.packed, cx, cy);
      for (let s = 0; s < k; s++) {
        const o = (base + s) * SLOT_WORDS;
        // (an empty slot ends the column: layout.ts readSlot)
        if (u[o + 1] === 0) break;
        if (fieldMat(u[o + 2] & 0xff)) t = Math.max(t, f[o + 1]);
      }
      this.fieldTops[i] = t;
    }
    return t;
  }

  /** The ground the field mesh draws at (x, y), with what it leaves sharp on top (`sharp`: a column's own top over its field ground). */
  private smoothAt(x: number, y: number, sharp: (i: number) => number): number | null {
    const z = blendedTop(x, y, (cx, cy) => this.fieldTop(cx, cy));
    const i = this.col(x, y);
    if (z === null || i < 0) return z;
    const [cx, cy] = cellAt(x, y);
    const own = sharp(i);
    return own > (this.fieldTop(cx, cy) ?? 0) + 0.05 ? Math.max(z, own) : z;
  }

  /** The height of the open sky's floor at (x, y): the ground, loose ground on it, or a structure's top. */
  heightAt(x: number, y: number, opts?: SampleOpts): number | null {
    const lv = this.mirror.f32('levels');
    const i = this.col(x, y);
    if (!lv || i < 0) return null;
    if (opts?.smooth) return this.smoothAt(x, y, (j) => lv[j * 4]);
    return lv[i * 4];
  }

  /** The nature grid's own ground at (x, y) (its top and the loose ground on it), ignoring structures. */
  groundAt(x: number, y: number, opts?: SampleOpts): number | null {
    const s = this.mirror.u32('surface');
    const d = this.mirror.f32('drift');
    const i = this.col(x, y);
    if (!s || !d || i < 0) return null;
    if (opts?.smooth) return this.smoothAt(x, y, (j) => sfZ(s[j]) + d[j * 4]);
    return sfZ(s[i]) + d[i * 4];
  }

  /**
   * The floor under height z at (x, y): the highest floor of open air at or
   * below z (+0.5); null none. Open air under structures' projected
   * intervals (the levels) and in the column's own layers (a cave's floor,
   * round 62).
   */
  floorAt(x: number, y: number, z: number): number | null {
    const f = this.mirror.f32('levels');
    const lf = this.mirror.f32('layers');
    const lu = this.mirror.u32('layers');
    const i = this.col(x, y);
    if (!f || !lf || !lu || i < 0) return null;
    let best: number | null = null;
    for (let k = 0; k < 4; k++) {
      const v = f[i * 4 + k];
      if (v < 0) continue;
      if (v <= z + 0.5 && (best === null || v > best)) best = v;
    }
    // (an interval's top with air over it: the next one starts higher, or none)
    const [cx, cy] = cellAt(x, y);
    const { base, k } = columnSlots(this.core.packed, cx, cy);
    for (let s = 0; s < k; s++) {
      const o = (base + s) * SLOT_WORDS;
      if (lu[o + 1] === 0) break;
      const z1 = lf[o + 1];
      if (z1 > z + 0.5) break;
      const next = s + 1 < k && lu[o + SLOT_WORDS + 1] !== 0 ? lf[o + SLOT_WORDS] : Infinity;
      if (next > z1 + 1e-3 && (best === null || z1 > best)) best = z1;
    }
    return best;
  }

  /** The column's layers at (x, y), bottom up. */
  layersAt(x: number, y: number): Layer[] | null {
    const l = this.mirror.u32('layers');
    if (!l || this.col(x, y) < 0) return null;
    const [cx, cy] = cellAt(x, y);
    return readColumn(this.core.packed, l, cx, cy).map((iv) => ({ z0: iv.z0, z1: iv.z1, material: materialName(iv.mat), state: materialState(iv.mat) }));
  }

  /** What's at height z in (x, y) ('air' between layers), or the top layer's material when z is left out. */
  materialAt(x: number, y: number, z?: number): MaterialName | null {
    const ls = this.layersAt(x, y);
    if (!ls) return null;
    if (z === undefined) return ls.length ? ls[ls.length - 1].material : 'air';
    for (const l of ls) if (z >= l.z0 && z < l.z1) return l.material;
    return 'air';
  }

  private edit(op: number, mat: number, x: number, y: number, radius: number, strength: number): void {
    // (the world's event queue: a tick carries four, the rest wait for the next)
    this.core.globals.events.push({ kind: EventKind.Edit, x, y, z: op * 32 + mat + STROKE_START, radius, strength });
  }

  /** A meteor's bowl at (x, y): ejecta round it as drift; `z` the height it hits (default the ground). */
  crater(x: number, y: number, opts: { radius?: number; z?: number } = {}): void {
    const z = opts.z ?? this.heightAt(x, y) ?? 0;
    this.edit(OP_CRATER, 0, x, y, (opts.radius ?? 6) * 2.5, z);
  }

  /**
   * Take `amount` cellsÂ³ off the top of the column at (x, y), exactly: off
   * its top interval only (one material; the map keeps z 2). Resolves with
   * what was taken, once the tick that took it has been read back (a frame
   * or two). Round 63: what a unit picks up.
   */
  take(x: number, y: number, amount: number): Promise<{ material: MaterialName; amount: number }> {
    return this.exactOp(OP_TAKE, 0, x, y, amount).then(([a, m]) => ({ material: materialName(m), amount: a }));
  }

  /**
   * Put `amount` cellsÂ³ of `material` on top of the column at (x, y),
   * exactly (loose material then slumps like any other). Resolves with the
   * amount put: 0 when the column has no free interval for a new material
   * (BACKLOG Q21). Round 63: what a unit sets down, or throws.
   */
  put(x: number, y: number, material: MaterialName, amount: number): Promise<number> {
    const m = materialId(material);
    const st = materialState(m);
    if (st !== 'solid' && st !== 'loose') throw new Error(`world.terrain.put: "${material}" isn't ground (a solid or loose material)`);
    return this.exactOp(OP_PUT, m, x, y, amount).then(([a]) => a);
  }

  /** In flight: tag â†’ [the tick it was sent at or after, resolve] */
  private exacts = new Map<number, { tick: number; done: (r: [number, number]) => void }>();
  private nextTag = 0;
  private polling = false;

  /** (the plants module too) An exact one-column edit op; resolves with editResult's x and y for it. */
  exactOp(op: number, mat: number, x: number, y: number, amount: number): Promise<[number, number]> {
    if (!(amount >= 0)) throw new Error(`world.terrain: amount must be â‰¥ 0 (got ${amount})`);
    if (this.exacts.size >= EDIT_TAGS) throw new Error(`world.terrain: ${EDIT_TAGS} takes and puts in flight at most`);
    while (this.exacts.has(this.nextTag)) this.nextTag = (this.nextTag + 1) % EDIT_TAGS;
    const tag = this.nextTag;
    this.nextTag = (tag + 1) % EDIT_TAGS;
    // (its column's centre, a radius only it lies in)
    const [cx, cy] = cellAt(x, y);
    const [px, py] = cellPos(cx, cy);
    const p = new Promise<[number, number]>((done) => this.exacts.set(tag, { tick: this.core.sim.tick, done }));
    this.core.globals.events.push({ kind: EventKind.Edit, x: px, y: py, z: op * 32 + mat + STROKE_START + tag * 1024, radius: 0.3, strength: amount });
    if (!this.polling) void this.poll();
    return p;
  }

  /** Reads editResult back until every take and put in flight has its answer. */
  private async poll(): Promise<void> {
    this.polling = true;
    const dev = this.core.host.gpu.device;
    const tex = this.core.world.editResult;
    const buf = dev.createBuffer({ label: 'editResult read', size: EDIT_TAGS * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    try {
      while (this.exacts.size) {
        await new Promise((r) => requestAnimationFrame(r));
        const enc = dev.createCommandEncoder({ label: 'editResult read' });
        enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: EDIT_TAGS * 16 }, [EDIT_TAGS, 1]);
        dev.queue.submit([enc.finish()]);
        await buf.mapAsync(GPUMapMode.READ);
        const f = new Float32Array(buf.getMappedRange().slice(0));
        buf.unmap();
        for (const [tag, e] of this.exacts) {
          if (f[tag * 4 + 3] === 1 && f[tag * 4 + 2] >= e.tick) {
            this.exacts.delete(tag);
            e.done([f[tag * 4], f[tag * 4 + 1]]);
          }
        }
      }
    } finally {
      buf.destroy();
      this.polling = false;
    }
  }

  /** Take `layers` cells off the top within `radius` (loose ground first). */
  dig(x: number, y: number, opts: { radius?: number; layers?: number } = {}): void {
    this.edit(OP_DIG, 0, x, y, opts.radius ?? 3, opts.layers ?? 1);
  }

  /** Pour `layers` cells of a loose material over (x, y): it falls, lands and slumps to its angle of repose. */
  deposit(x: number, y: number, material: MaterialName, opts: { radius?: number; layers?: number } = {}): void {
    const m = materialId(material);
    if (materialState(m) !== 'loose') throw new Error(`world.terrain.deposit: "${material}" isn't a loose material (build() lays solids)`);
    // (pours land over the next ticks: the brush state has to run every tick)
    this.core.sim.edit.always = true;
    this.edit(OP_POUR, m, x, y, opts.radius ?? 3, opts.layers ?? 1);
  }

  /**
   * Grab `material`'s layer and pull it (BACKLOG E2): its run under a brush
   * grows (or, with a negative height, sinks), rough by its own noise, and
   * what lies over it moves with it (opts.mode). A drag: call `to` each
   * frame on the stroke this returns, then `end`. Up to 8 strokes at once;
   * a ninth takes over the one begun longest ago.
   */
  pull(material: MaterialName, opts: PullOpts = {}): PullStroke {
    const m = materialId(material);
    const st = materialState(m);
    if (st !== 'solid' && st !== 'loose') throw new Error(`world.terrain.pull: "${material}" isn't ground (a solid or loose material)`);
    let slot = this.slots.findIndex((t) => t === 0);
    if (slot < 0) slot = this.slots.indexOf(Math.min(...this.slots));
    this.slots[slot] = performance.now();
    return new PullStroke(this, slot, m, opts);
  }

  /**
   * Paint a landform (round 64): 'range' raises a ridge along the stroke,
   * 'mesa' a flat-topped plateau with banded cliffs; the land comes up
   * under the brush over a second or two. Call `to` each frame, then `end`.
   */
  raise(shape: 'range' | 'mesa', opts: RaiseOpts = {}): RaiseStroke {
    return new RaiseStroke(this, shape, opts);
  }

  /** (RaiseStroke) */
  queueStamp(s: import('../sim/systems').LandStamp): void {
    this.core.sim.land.queue.push(s);
  }

  /** One pull at (x, y): raise `material` by `height` under a brush of `radius` (a stroke of one call). */
  pullLayer(material: MaterialName, x: number, y: number, at: { radius: number; height: number } & PullOpts): void {
    const s = this.pull(material, at);
    s.to(x, y, at);
    s.end();
  }

  /** (PullStroke) */
  queuePull(p: import('../sim/systems').LayerPull): void {
    this.core.sim.pulls.queue.push(p);
  }

  /** (PullStroke) */
  releaseSlot(slot: number): void {
    this.slots[slot] = 0;
  }

  /** Lay `layers` cells of a solid material on top within `radius`. */
  build(x: number, y: number, material: MaterialName, opts: { radius?: number; layers?: number } = {}): void {
    const m = materialId(material);
    if (materialState(m) !== 'solid') throw new Error(`world.terrain.build: "${material}" isn't a solid (deposit() pours loose ground)`);
    this.edit(OP_BUILD, m, x, y, opts.radius ?? 3, opts.layers ?? 1);
  }
}
