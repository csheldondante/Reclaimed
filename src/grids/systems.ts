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
import { dispatch, type SimSystem } from '../sim/system';
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
  constructor(device: GPUDevice, private world: WorldGpu, private prof: Profiler) {
    this.s = gridKernel(device, world, 'project', projectWgsl, { 3: 'read', 4: 'read', 24: 'tex', 25: 'stex', 26: 'stex', 27: 'stex' }, {
      3: world.strFrames,
      4: world.strVox,
      24: world.bodyCpuView,
      25: world.bodyProjView,
      26: world.foreignView,
      27: world.projView,
    });
  }
  encode(enc: GPUCommandEncoder): void {
    dispatch(enc, this.prof, this.name, this.s.k, this.s.group, this.world.groups);
  }
}

/** The structure grids' own tick (structtick.wgsl): sand cover and moss, sampled from the nature grid. */
export class StructTickSystem implements SimSystem {
  readonly name = 'structtick';
  readonly period = 4;
  private s;
  constructor(device: GPUDevice, private world: WorldGpu, private prof: Profiler) {
    this.s = gridKernel(device, world, 'structtick', structTickWgsl, { 3: 'read', 4: 'rw', 5: 'read', 6: 'read', 7: 'read', 17: 'tex' }, {
      3: world.strFrames,
      4: world.strVox,
      5: world.surface,
      6: world.moisture,
      7: world.veg,
      17: world.driftView,
    });
  }
  encode(enc: GPUCommandEncoder): void {
    const n = this.world.strVoxels;
    if (n === 0) return;
    dispatch(enc, this.prof, this.name, this.s.k, this.s.group, [Math.ceil(n / 64), 1]);
  }
}
