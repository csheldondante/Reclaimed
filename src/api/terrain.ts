// world.terrain (docs/WORLD_API.md): the ground, read from a CPU mirror in
// world coordinates, and the editor's ground ops as commands.

import type { WorldCore } from '../scenes/world-core';
import { EventKind } from '../sim/globals';
import { cellAt } from '../world/lattice';
import { readColumn, sfZ } from '../world/layout';
import { columnAt, materialId, materialName, materialState, type MaterialName } from './common';
import type { Mirror } from './mirror';

/** edit.wgsl ops (op · 32 + material; + STROKE_START: each command its own press) */
const OP_BUILD = 1;
const OP_DIG = 2;
const OP_POUR = 10;
const OP_CRATER = 13;
const STROKE_START = 512;

export interface Layer {
  z0: number;
  z1: number;
  material: MaterialName;
  state: 'solid' | 'loose' | 'liquid' | 'plant' | 'air';
}

/**
 * Queries answer from the mirror (refreshed every `mirror.every` ms, 250 by
 * default; `readAt` says when): until the first read they return null.
 * The nature grid's layers; tilted structure grids count in `heightAt` and
 * `floorAt` (their projected floors), not in `materialAt` / `layersAt`.
 */
export class Terrain {
  constructor(
    private core: WorldCore,
    private mirror: Mirror,
  ) {
    const w = core.world;
    mirror.addBuffer('surface', w.surface);
    mirror.addBuffer('layers', w.layers);
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

  /** The height of the open sky's floor at (x, y): the ground, loose ground on it, or a structure's top. */
  heightAt(x: number, y: number): number | null {
    const lv = this.mirror.get('levels');
    const i = this.col(x, y);
    if (!lv || i < 0) return null;
    return new Float32Array(lv)[i * 4];
  }

  /** The nature grid's own ground at (x, y) (its top and the loose ground on it), ignoring structures. */
  groundAt(x: number, y: number): number | null {
    const s = this.mirror.get('surface');
    const d = this.mirror.get('drift');
    const i = this.col(x, y);
    if (!s || !d || i < 0) return null;
    return sfZ(new Uint32Array(s)[i]) + new Float32Array(d)[i * 4];
  }

  /** The floor under height z at (x, y): the highest floor of open air at or below z (+0.5); null none. */
  floorAt(x: number, y: number, z: number): number | null {
    const lv = this.mirror.get('levels');
    const i = this.col(x, y);
    if (!lv || i < 0) return null;
    const f = new Float32Array(lv);
    let best: number | null = null;
    for (let k = 0; k < 4; k++) {
      const v = f[i * 4 + k];
      if (v < 0) continue;
      if (v <= z + 0.5 && (best === null || v > best)) best = v;
    }
    return best;
  }

  /** The column's layers at (x, y), bottom up. */
  layersAt(x: number, y: number): Layer[] | null {
    const l = this.mirror.get('layers');
    if (!l) return null;
    const [cx, cy] = cellAt(x, y);
    if (this.col(x, y) < 0) return null;
    return readColumn(this.core.packed, new Uint32Array(l), cx, cy).map((iv) => ({ z0: iv.z0, z1: iv.z1, material: materialName(iv.mat), state: materialState(iv.mat) }));
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

  /** Lay `layers` cells of a solid material on top within `radius`. */
  build(x: number, y: number, material: MaterialName, opts: { radius?: number; layers?: number } = {}): void {
    const m = materialId(material);
    if (materialState(m) !== 'solid') throw new Error(`world.terrain.build: "${material}" isn't a solid (deposit() pours loose ground)`);
    this.edit(OP_BUILD, m, x, y, opts.radius ?? 3, opts.layers ?? 1);
  }
}
