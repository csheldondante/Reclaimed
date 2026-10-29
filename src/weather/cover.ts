// The weather's cover past the window (round 108, TC20; DECISIONS round 108 — the user: "the distant tiles have seems
// and sometimes miss certain effects like snow ... My expectation is that the tiles are essentially the visual only
// version of full tiles"). The owner of one contract (WorldGpu.coverState / coverView): the snow lying on the land
// and how wet it is, at the atlas's scale round the window (shaders/coverfield.wgsl, cover.wgsl), read by the tiles
// when they're drawn — so the weather on a tile is never what it was baked with.
//  - The window's part is the window's: measured from its land every update (the climate sim's snow, its moisture).
//  - Land past it steps on its own: the storms' snow and rain, the melt in the warm, the drying back.
//  - A render-only tile's land seeds the texels the field doesn't hold yet, as it's made (`seed`: its peaks' snow,
//    its own moisture) — render/tilelandgpu.ts calls it with its world.

import { makeBindGroup, makeCompute, type ComputeKernel } from '../gpu/pipeline';
import type { Profiler } from '../gpu/profiler';
import type { SimSystem } from '../sim/system';
import type { WorldGpu } from '../sim/world-gpu';
import commonWgsl from '../shaders/common.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import coverFieldWgsl from '../shaders/coverfield.wgsl?raw';
import coverWgsl from '../shaders/cover.wgsl?raw';

/** the ring's texels a side, world cells a texel (coverfield.wgsl COVER_N, COVER_CELL: keep the two the same) */
export const COVER_N = 512;
export const COVER_CELL = 8;
/** ticks between updates (the field moves slowly: a storm's snow over seconds, the melt over minutes) */
const PERIOD = 15;

/** what the field is measured from: a world's Globals (its size and origin), its surface, moisture and drift */
export type CoverSource = Pick<WorldGpu, 'globals' | 'surface' | 'moisture' | 'water' | 'driftView'>;

export class WeatherCoverSystem implements SimSystem {
  readonly name = 'cover';
  readonly period = PERIOD;
  private measureK: ComputeKernel;
  private stepK: ComputeKernel;
  private params: GPUBuffer;
  private win: GPUBindGroup;
  private stepG: GPUBindGroup;
  private seeds = new Map<CoverSource, GPUBindGroup>();
  private seedParams = new Map<CoverSource, GPUBuffer>();

  constructor(private device: GPUDevice, private world: WorldGpu, private prof: Profiler) {
    const parts = [commonWgsl, materialsWgsl, coverFieldWgsl, coverWgsl];
    const spec = { 0: 'uniform', 2: 'uniform', 3: 'read', 4: 'read', 5: 'read', 6: 'rw', 7: 'stex16', 8: 'uniform', 17: 'tex' } as const;
    this.measureK = makeCompute(device, 'cover measure', parts, spec, 'measure');
    this.stepK = makeCompute(device, 'cover step', parts, spec, 'step');
    const u = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
    this.params = world.buf('cover params', 16, u);
    // (the step's seconds: the window's tick's dt times the period — simulation.ts's fixed step)
    device.queue.writeBuffer(this.params, 0, new Float32Array([0, PERIOD / 60, 0, 1e9]));
    this.win = this.group(this.measureK, world, this.params);
    this.stepG = this.group(this.stepK, world, this.params);
  }

  private group(k: ComputeKernel, src: CoverSource, params: GPUBuffer): GPUBindGroup {
    const w = this.world;
    return makeBindGroup(this.device, 'cover', k.layout, { 0: src.globals, 2: w.materials, 3: src.surface, 4: src.moisture, 5: src.water, 6: w.coverState, 7: w.coverView, 8: params, 17: src.driftView });
  }

  /** the texels a world of w x h cells meets (a texel past its far side: its origin needn't be a texel's) */
  private span(w: number, h: number): [number, number] {
    return [Math.ceil((Math.ceil(w / COVER_CELL) + 1) / 8), Math.ceil((Math.ceil(h / COVER_CELL) + 1) / 8)];
  }

  private pass(enc: GPUCommandEncoder, name: string, k: ComputeKernel, g: GPUBindGroup, n: [number, number]): void {
    const p = enc.beginComputePass({ label: name, timestampWrites: this.prof.timestamps(name) });
    p.setPipeline(k.pipeline);
    p.setBindGroup(0, g);
    p.dispatchWorkgroups(n[0], n[1]);
    p.end();
    this.prof.dispatches++;
  }

  encode(enc: GPUCommandEncoder): void {
    this.pass(enc, 'cover', this.measureK, this.win, this.span(this.world.w, this.world.h));
    this.pass(enc, 'cover-step', this.stepK, this.stepG, [COVER_N / 8, COVER_N / 8]);
  }

  /** a render-only tile's land (its world: render/tileworld.ts, `side` cells a side; its region cells [lo, hi) both
   *  ways — the rest border and empty), as made: the texels it covers that the field holds nothing of yet */
  seed(enc: GPUCommandEncoder, src: CoverSource, side: number, lo: number, hi: number): void {
    let g = this.seeds.get(src);
    if (!g) {
      const p = this.world.buf('cover seed params', 16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      this.device.queue.writeBuffer(p, 0, new Float32Array([1, 0, lo, hi]));
      this.seedParams.set(src, p);
      this.seeds.set(src, (g = this.group(this.measureK, src, p)));
    }
    this.pass(enc, 'tile-cover', this.measureK, g, this.span(side, side));
  }
}
