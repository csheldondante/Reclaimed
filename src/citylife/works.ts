// (living town, docs/design/LIVING_TOWN.md §4–§6) The works: the quarry dug bench by bench, the stores' stockpile put
// on its yard, the clearing's camp and trees, fells to stumps, replanting, riders on the live ground, and the piles'
// look (works.wgsl). World operations on the window's own buffers; their input is what the riders left in the living
// town's state words. A LivingStage: encoded in the living town's frame, after the riders.
import worksWgsl from './works.wgsl?raw';
import commonWgsl from '../shaders/common.wgsl?raw';
import layersWgsl from '../shaders/layers.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import vegplanWgsl from '../shaders/vegplan.wgsl?raw';
import worldopsWgsl from '../shaders/worldops.wgsl?raw';
import { makeBindGroup, makeCompute, type BindSpec, type ComputeKernel } from '../gpu/pipeline';
import type { LivingStage, LivingTown } from './living';

/** the world's buffers the works read and write (WorldGpu's) */
export interface WorksWorld {
  globals: GPUBuffer;
  chunks: GPUBuffer;
  materials: GPUBuffer;
  layers: GPUBuffer;
  veg: GPUBuffer;
  vegNext: GPUBuffer;
}

type K =
  | 'worksInit' | 'quarryStep' | 'dig' | 'yardPick' | 'yardFix' | 'pile' | 'campPick' | 'campFix' | 'treeListClear'
  | 'treeList' | 'treeListDone' | 'fellApply' | 'fellDone' | 'regrow' | 'riderZ' | 'pileVox';
const SPECS: Record<K, BindSpec> = {
  worksInit: { 0: 'uniform', 40: 'rw' },
  quarryStep: { 0: 'uniform', 40: 'rw', 43: 'uniform' },
  dig: { 0: 'uniform', 1: 'read', 2: 'uniform', 40: 'rw', 43: 'uniform', 44: 'rw', 45: 'rw', 46: 'rw', 47: 'rw' },
  yardPick: { 0: 'uniform', 40: 'rw', 43: 'uniform', 49: 'read', 50: 'read' },
  yardFix: { 0: 'uniform', 40: 'rw', 43: 'uniform', 49: 'read' },
  pile: { 0: 'uniform', 1: 'read', 2: 'uniform', 40: 'rw', 43: 'uniform', 47: 'rw', 49: 'read', 55: 'rw' },
  campPick: { 0: 'uniform', 1: 'read', 2: 'uniform', 40: 'rw', 41: 'rw', 43: 'uniform', 45: 'rw' },
  campFix: { 0: 'uniform', 40: 'rw', 43: 'uniform' },
  treeListClear: { 0: 'uniform', 40: 'rw' },
  treeList: { 0: 'uniform', 1: 'read', 2: 'uniform', 40: 'rw', 41: 'rw', 43: 'uniform', 45: 'rw' },
  treeListDone: { 0: 'uniform', 40: 'rw' },
  fellApply: { 0: 'uniform', 1: 'read', 2: 'uniform', 40: 'rw', 41: 'rw', 42: 'rw', 43: 'uniform', 45: 'rw', 46: 'rw' },
  fellDone: { 0: 'uniform', 40: 'rw' },
  regrow: { 0: 'uniform', 1: 'read', 40: 'rw', 43: 'uniform', 45: 'rw', 46: 'rw' },
  riderZ: { 0: 'uniform', 1: 'read', 40: 'rw', 42: 'rw', 43: 'uniform', 47: 'rw', 48: 'read' },
  pileVox: { 0: 'uniform', 40: 'rw', 43: 'uniform', 48: 'read', 53: 'rw', 54: 'rw' },
};
/** the quarry's footprint room (columns: the largest side's) and the yard's (20 × 22) */
const QG_ROOM = 84 * 96;
const PUT_ROOM = 20 * 22;

export class Works implements LivingStage {
  readonly vox: GPUBuffer;
  readonly vargs: GPUBuffer;
  private k: Record<K, ComputeKernel>;
  private g: Record<K, GPUBindGroup>;
  private all: GPUBuffer[] = [];

  constructor(
    device: GPUDevice,
    private life: LivingTown,
    world: WorksWorld,
  ) {
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const buf = (label: string, bytes: number, usage = S) => {
      const b = device.createBuffer({ label: `living ${label}`, size: Math.max(16, bytes), usage });
      this.all.push(b);
      return b;
    };
    const qg = buf('quarry ground', QG_ROOM * 4);
    const put = buf('yard puts', PUT_ROOM * 4);
    this.vox = buf('pile voxels', 300 * 32);
    this.vargs = buf('pile voxel args', 16, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(this.vargs, 0, new Uint32Array([36, 0, 0, 0]));
    const R: Record<number, GPUBuffer> = {
      0: world.globals, 1: world.chunks, 2: world.materials, 40: life.lt, 41: life.walk, 42: life.rid, 43: life.uni, 44: qg,
      45: world.veg, 46: world.vegNext, 47: world.layers, 48: life.input.heights, 49: life.input.records, 50: life.input.counts,
      53: this.vox, 54: this.vargs, 55: put,
    };
    this.k = {} as Record<K, ComputeKernel>;
    this.g = {} as Record<K, GPUBindGroup>;
    const parts = [commonWgsl, layersWgsl, materialsWgsl, vegplanWgsl, worldopsWgsl, worksWgsl];
    for (const [name, spec] of Object.entries(SPECS) as [K, BindSpec][]) {
      const k = makeCompute(device, `living ${name}`, parts, spec, name);
      this.k[name] = k;
      this.g[name] = makeBindGroup(device, `living ${name}`, k.layout, Object.fromEntries(Object.keys(spec).map((b) => [Number(b), R[Number(b)]])));
    }
  }

  encode(cp: GPUComputePassEncoder, frame: number): void {
    const run = (k: K, x: number, y = 1) => {
      cp.setPipeline(this.k[k].pipeline);
      cp.setBindGroup(0, this.g[k]);
      cp.dispatchWorkgroups(x, y);
    };
    const { w, h } = this.life.input;
    const v = this.life.values;
    run('worksInit', 1);
    // (the quarry: its budget to the bench's progress, the columns taken; the yard found, the inbox put on it)
    run('quarryStep', 1);
    run('dig', Math.ceil((v.quarry.side + 2) / 8), Math.ceil((v.quarry.side / 0.866 + 2) / 8));
    if (frame % 15 === 0) run('yardPick', Math.ceil(this.life.input.lotRoom / 64));
    run('yardFix', 1);
    run('pile', 3, 3);
    // (the clearing: its site looked for every 16 frames until found — cheap once it is; the trees listed when used up)
    if (frame % 16 === 8) {
      run('campPick', Math.ceil((w * h) / 64));
      run('campFix', 1);
    }
    if (frame % 30 === 0) {
      const span = Math.ceil(v.forest.radius) * 2 + 1;
      run('treeListClear', 1);
      run('treeList', Math.ceil(span / 8), Math.ceil(span / 0.866 / 8));
      run('treeListDone', 1);
    }
    run('fellApply', 1);
    run('fellDone', 1);
    if (frame % 30 === 15) run('regrow', 4);
    run('riderZ', Math.ceil(this.life.riders / 64) || 1);
    run('pileVox', 1);
  }

  get bytes(): number {
    return this.all.reduce((s, b) => s + b.size, 0);
  }

  dispose(): void {
    for (const b of this.all) b.destroy();
  }
}
