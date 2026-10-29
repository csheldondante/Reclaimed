// The structure grids' systems (docs/GRIDS.md): the projection the nature
// grid sees them through, and their own tick. Both are GPU kernels; the
// CPU only dispatches them.

import { makeBindGroup, makeCompute, type BindSpec } from '../gpu/pipeline';
import type { Profiler } from '../gpu/profiler';
import commonWgsl from '../shaders/common.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import gridsWgsl from '../shaders/grids.wgsl?raw';
import projectWgsl from '../shaders/project.wgsl?raw';
import structTickWgsl from '../shaders/structtick.wgsl?raw';
import tiersWgsl from '../shaders/tiers.wgsl?raw';
import { dispatch, type SimSystem } from '../sim/system';
import { CUSTOM, TILES_BINDING, cullKernel, dispatchTiles } from '../sim/cull';
import { CHUNK } from '../world/layout';
import { ROW_H } from '../world/lattice';
import type { WorldGpu } from '../sim/world-gpu';

function gridKernel(device: GPUDevice, world: WorldGpu, label: string, src: string, spec: BindSpec, buffers: Record<number, GPUBuffer | GPUTextureView>) {
  const k = makeCompute(device, label, [commonWgsl, materialsWgsl, gridsWgsl, src], { 0: 'uniform', 2: 'uniform', ...spec });
  const group = makeBindGroup(device, label, k.layout, { 0: world.globals, 2: world.materials, ...buffers });
  return { k, group };
}

/**
 * Structure → nature (project.wgsl): every nature column's view of the
 * structure grids, merged with the CPU's sleeping bodies into bodyProj, plus
 * the top face's normal (foreign). Runs before anything that reads them.
 */
export class ProjectSystem implements SimSystem {
  readonly name = 'project';
  readonly period = 1;
  private s;
  /** (round 104, simscale) while any says so, every column every tick (physics: its voxels move anywhere) */
  readonly wholeWhile: (() => boolean)[] = [];
  /** the chunks the structures covered last tick: cleared of them this tick if they've gone */
  private prev = new Set<number>();
  /** chunks projected at the last tick (the perf overlay, tests) */
  lastChunks = 0;
  constructor(device: GPUDevice, private world: WorldGpu, private prof: Profiler) {
    const buffers = {
      3: world.strFrames,
      4: world.strVox,
      5: world.physCols,
      24: world.bodyCpuView,
      25: world.bodyProjView,
      26: world.foreignView,
      27: world.projView,
    };
    const spec: BindSpec = { 3: 'read', 4: 'read', 5: 'read', 24: 'tex', 25: 'stex', 26: 'stex', 27: 'stex' };
    if (world.tiles) {
      // (simscale: over the chunks its inputs touch — sim/cull.ts CUSTOM)
      const c = cullKernel(world.tiles, [commonWgsl, materialsWgsl, gridsWgsl, projectWgsl].join('\n'), { 0: 'uniform', 2: 'uniform', ...spec }, 'main', PROJECT_LIST);
      const k = makeCompute(device, 'project', [c.code], c.spec);
      this.s = { k, group: makeBindGroup(device, 'project', k.layout, { 0: world.globals, 2: world.materials, ...buffers, [TILES_BINDING]: c.buf }) };
    } else this.s = gridKernel(device, world, 'project', projectWgsl, spec, buffers);
  }
  encode(enc: GPUCommandEncoder): void {
    const t = this.world.tiles;
    if (!t) {
      dispatch(enc, this.prof, this.name, this.s.k, this.s.group, this.world.groups);
      return;
    }
    // (round 104, simscale) The projection changes only where its inputs do: the structures (their frames, and their
    // voxels' cover — structtick), the physics' voxels, the CPU's sleeping bodies (bodyCpu, written whole). So: every
    // chunk while the physics holds voxels, or for a tick after bodyCpu is written or the window slid (the streamer
    // fills what comes in with none); else the chunks under the structures, and those they've left.
    const all = this.world.projectAll || this.wholeWhile.some((f) => f());
    this.world.projectAll = false;
    const cur = new Set<number>();
    if (!all) for (const b of this.world.strBounds.values()) addChunks(cur, b, t.cx, t.cy);
    const list = all ? Array.from({ length: t.chunks }, (_, c) => c) : [...new Set([...cur, ...this.prev])];
    this.prev = cur;
    this.lastChunks = list.length;
    if (!list.length) return;
    t.setList(PROJECT_LIST, list);
    dispatchTiles(enc, this.prof, this.name, this.s.k, this.s.group, t, PROJECT_LIST);
  }
}

/** the projection's custom tile list (sim/cull.ts CUSTOM) */
const PROJECT_LIST = CUSTOM;

/** the chunks a world xy box (x0, y0, x1, y1) covers, a chunk of margin */
function addChunks(out: Set<number>, b: readonly [number, number, number, number], cx: number, cy: number): void {
  const i0 = Math.max(0, Math.floor(b[0] / CHUNK) - 1);
  const i1 = Math.min(cx - 1, Math.floor(b[2] / CHUNK) + 1);
  const j0 = Math.max(0, Math.floor(b[1] / ROW_H / CHUNK) - 1);
  const j1 = Math.min(cy - 1, Math.floor(b[3] / ROW_H / CHUNK) + 1);
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) out.add(j * cx + i);
}

/** The structure grids' own tick (structtick.wgsl): sand cover and moss, sampled from the nature grid. */
export class StructTickSystem implements SimSystem {
  readonly name = 'structtick';
  readonly period = 4;
  private s;
  constructor(device: GPUDevice, private world: WorldGpu, private prof: Profiler) {
    // (round 108, simtiers: tiers.wgsl, binding 50 - moss is the vegetation's)
    this.s = gridKernel(device, world, 'structtick', tiersWgsl + structTickWgsl, { 3: 'read', 4: 'rw', 5: 'read', 6: 'read', 7: 'read', 15: 'tex', 17: 'tex', 19: 'tex', 50: 'tex' }, {
      3: world.strFrames,
      4: world.strVox,
      5: world.surface,
      6: world.moisture,
      7: world.veg,
      17: world.driftView,
      15: world.windFieldView,
      19: world.airView,
      50: world.tierView,
    });
  }
  encode(enc: GPUCommandEncoder): void {
    const n = this.world.strVoxels;
    if (n === 0) return;
    dispatch(enc, this.prof, this.name, this.s.k, this.s.group, [Math.ceil(n / 64), 1]);
  }
}
