// Lava (docs/PHYSICS.md "Lava"; DECISIONS round 47): molten rock as a third
// liquid. The heat beam melts the ground it hits into it, volcano vents pour
// it; it flows while hot, cools, boils water off as steam, spits embers, and
// sets into basalt on top of the layers. All of it runs on the GPU
// (lava_flux.wgsl, lava.wgsl); the CPU sets the beam and the vents.

import { makeBindGroup, makeCompute, type BindSpec, type ComputeKernel } from '../gpu/pipeline';
import type { Profiler } from '../gpu/profiler';
import commonWgsl from '../shaders/common.wgsl?raw';
import layersWgsl from '../shaders/layers.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import lavaFluxWgsl from '../shaders/lava_flux.wgsl?raw';
import lavaWgsl from '../shaders/lava.wgsl?raw';
import { dispatch, type SimSystem } from './system';
import type { WorldGpu } from './world-gpu';
import { TICK_DT } from './simulation';

export const MAX_VENTS = 4;

export interface Vent {
  x: number;
  y: number;
  /** cells³ of lava a second */
  rate: number;
  radius: number;
  /** seconds left */
  left: number;
}

/** Prism vertices per instance (renderer.ts VERTS_PER_PRISM). */
const VERTS_PER_PRISM = 30;

export class LavaSystem implements SimSystem {
  readonly name = 'lava';
  readonly period = 1;
  /** the beam on the ground: where it hits, its radius and power (heat/s) */
  beam: { at: [number, number, number]; radius: number; power: number } | null = null;
  readonly vents: Vent[] = [];
  /** lava prisms for the opaque pipeline (Renderer.addPrisms) */
  readonly inst: GPUBuffer;
  readonly indirect: GPUBuffer;
  private uni: GPUBuffer;
  private k: Record<string, { k: ComputeKernel; g: GPUBindGroup }> = {};

  constructor(
    private device: GPUDevice,
    private world: WorldGpu,
    private prof: Profiler,
  ) {
    this.inst = world.buf('lavaInst', world.cells * 16, GPUBufferUsage.STORAGE);
    this.indirect = world.buf('lavaIndirect', 16, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST);
    this.uni = world.buf('lavaU', 32 + 16 * MAX_VENTS, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const res: Record<number, GPUBuffer | GPUTextureView> = {
      0: world.globals,
      1: world.chunks,
      2: world.materials,
      3: world.lava,
      4: world.lavaFlux,
      5: world.lavaNext,
      6: world.water,
      7: world.layers,
      8: this.inst,
      9: this.indirect,
      12: world.particles,
      13: world.particleCounters,
      17: world.driftView,
      21: world.bodyProjView,
      22: this.uni,
    };
    const kernel = (name: string, parts: string[], spec: BindSpec, entry = 'main', over: Record<number, GPUBuffer | GPUTextureView> = {}) => {
      const all: BindSpec = { 0: 'uniform', 2: 'uniform', ...spec };
      const k = makeCompute(device, name, parts, all, entry);
      const b = { ...res, ...over };
      const g = makeBindGroup(device, name, k.layout, Object.fromEntries(Object.keys(all).map((n) => [n, b[Number(n)]])));
      this.k[name] = { k, g };
    };
    kernel('lava-flux', [commonWgsl, materialsWgsl, lavaFluxWgsl], { 3: 'read', 4: 'read', 5: 'rw', 17: 'tex', 21: 'tex' }, 'main', {
      3: world.surface,
      4: world.lava,
      5: world.lavaFlux,
    });
    const parts = [commonWgsl, layersWgsl, materialsWgsl, lavaWgsl];
    kernel('lava-depth', parts, { 1: 'read', 3: 'read', 4: 'read', 5: 'rw', 6: 'rw', 7: 'rw', 12: 'rw', 13: 'rw', 22: 'uniform' }, 'depth');
    kernel('lava-prep', parts, { 3: 'read', 8: 'rw', 9: 'rw' }, 'prep');
  }

  /** A vent at world (x, y): it pours `rate` cells³/s for `seconds`. The oldest goes past MAX_VENTS. */
  addVent(x: number, y: number, seconds = 25, rate = 6, radius = 1.6): void {
    if (this.vents.length >= MAX_VENTS) this.vents.shift();
    this.vents.push({ x, y, rate, radius, left: seconds });
  }

  private writeUniforms(dt: number): void {
    const u = new Float32Array(8 + 4 * MAX_VENTS);
    const b = this.beam;
    if (b) u.set([b.at[0], b.at[1], b.at[2], b.radius, b.power, 1, 0, 0], 0);
    for (let i = this.vents.length - 1; i >= 0; i--) {
      this.vents[i].left -= dt;
      if (this.vents[i].left <= 0) this.vents.splice(i, 1);
    }
    this.vents.forEach((v, i) => u.set([v.x, v.y, v.rate, v.radius], 8 + 4 * i));
    this.device.queue.writeBuffer(this.uni, 0, u);
  }

  encode(enc: GPUCommandEncoder): void {
    this.writeUniforms(TICK_DT);
    this.device.queue.writeBuffer(this.indirect, 0, new Uint32Array([VERTS_PER_PRISM, 0, 0, 0]));
    const run = (name: string) => dispatch(enc, this.prof, name, this.k[name].k, this.k[name].g, this.world.groups);
    run('lava-flux');
    run('lava-depth');
    enc.copyBufferToBuffer(this.world.lavaNext, 0, this.world.lava, 0, this.world.lava.size);
    run('lava-prep');
  }
}
