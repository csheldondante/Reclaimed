// Liquids as runs in the columns (?flow=1, docs/ARCHITECTURE.md "The flow model"; liquid.wgsl). One system, one kernel set; a liquid is
// a few numbers (LiquidKind). Water replaces the water system: its open runs ARE the water contract (`water`,
// `waterPrev`, `flux`), so every reader of water is unchanged; runs under rock (caves, tunnels) and the falling
// streams are the system's own. Lava here is the same kernels with lava's numbers (the sandbox's beam and
// volcanoes keep sim/lava.ts).

import { makeBindGroup, makeCompute, type BindSpec, type ComputeKernel } from '../gpu/pipeline';
import type { Profiler } from '../gpu/profiler';
import commonWgsl from '../shaders/common.wgsl?raw';
import layersWgsl from '../shaders/layers.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import liquidWgsl from '../shaders/liquid.wgsl?raw';
import { dispatch, type SimSystem } from '../sim/system';
import type { WorldGpu } from '../sim/world-gpu';
import { FLOW_SUB, flowConst } from '../sim/flow';

/** A liquid's numbers: what makes water water and lava lava. */
export interface LiquidKind {
  name: 'water' | 'lava';
  /** material id drawn (render.wgsl) */
  mat: number;
  /** the pipe's gain (how fast a level difference moves it sideways) and the flux kept from last tick */
  gain: number;
  friction: number;
  /** it won't move down a step smaller than this (cells) */
  yieldZ: number;
  /** thinner than this it barely flows, as (depth / thick)^2 (0: off) */
  thick: number;
  /** heat: fresh (springs), where it stops flowing and sets, where it runs freely (0: no heat) */
  hot: number;
  set: number;
  runny: number;
  /** a drop past this under the run's floor is a fall (a stream) */
  drop: number;
  /** cooling: e-folds a second for a cell of depth (thinner cools faster; 0: none) */
  cool: number;
}

export const WATER: LiquidKind = { name: 'water', mat: 8, gain: 0.08, friction: 0.985, yieldZ: 0, thick: 0, hot: 0, set: 0, runny: 1, drop: 1.25, cool: 0 };
export const LAVA: LiquidKind = { name: 'lava', mat: 24, gain: 0.02, friction: 0.9, yieldZ: 0.12, thick: 0.4, hot: 1250, set: 750, runny: 1150, drop: 1.25, cool: 0.02 };

export const MAX_SPRINGS = 8;
export interface Spring {
  x: number;
  y: number;
  /** the height it pours in at (cells): in a tunnel, its floor */
  z: number;
  /** cells^3 a second */
  rate: number;
}

const VERTS_PER_PRISM = 30;

const f = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
function prelude(k: LiquidKind): string {
  return [
    `const LQ_MAT: u32 = ${k.mat}u;`,
    `const LQ_WATER: bool = ${k.name === 'water'};`,
    `const LQ_GAIN: f32 = ${f(k.gain)};`,
    `const LQ_FRIC: f32 = ${f(k.friction)};`,
    `const LQ_YIELD: f32 = ${f(k.yieldZ)};`,
    `const LQ_THICK: f32 = ${f(k.thick)};`,
    `const LQ_HOT: f32 = ${f(k.hot)};`,
    `const LQ_SET: f32 = ${f(k.set)};`,
    `const LQ_RUNNY: f32 = ${f(k.runny)};`,
    `const LQ_DROP: f32 = ${f(k.drop)};`,
    `const LQ_COOL: f32 = ${f(k.cool)};`,
    '',
  ].join('\n');
}

export class LiquidSystem implements SimSystem {
  readonly name: string;
  readonly period = 1;
  readonly springs: Spring[] = [];
  /** the water pipeline's list (runs under rock, streams) and the opaque one's (open lava) */
  readonly inst: GPUBuffer;
  readonly indirect: GPUBuffer;
  readonly instO: GPUBuffer;
  readonly indirectO: GPUBuffer;
  /** the open runs' depth (water: world.water) */
  readonly open: GPUBuffer;
  /** the step the records carry; it stands still while the whole system is skipped */
  step = 1;
  /** skip the simulation passes (everything with liquid frozen: only the draw lists made) */
  skip: () => boolean = () => false;
  /** passes dispatched at the last encode (the cost report) */
  ran = 0;
  private uni: GPUBuffer;
  private runs: GPUBuffer[];
  private uniData = new ArrayBuffer(16 + 16 * MAX_SPRINGS + 16 * 512);
  /** frozen chunks' flux rescaled next step (chunk -> factor; steady.ts: their supply changed) */
  readonly rescale = new Map<number, number>();
  private k: Record<string, ComputeKernel> = {};
  private g: Record<string, GPUBindGroup[]> = {};

  constructor(
    private device: GPUDevice,
    private world: WorldGpu,
    private prof: Profiler,
    readonly kind: LiquidKind,
    act: GPUBuffer,
    /** the frozen column's wake tolerance: |in - out| (cells^3 a tick) */
    wakeTol: number,
  ) {
    if (FLOW_SUB !== 1) throw new Error(`?flow=1 runs at the 60 Hz tick only (?simhz=${60 / FLOW_SUB} given)`);
    this.name = `liquid-${kind.name}`;
    const N = world.cells;
    const S = GPUBufferUsage.STORAGE;
    this.open = kind.name === 'water' ? world.water : world.buf(`${kind.name}Open`, N * 4, S | GPUBufferUsage.COPY_DST);
    const runs = [0, 1].map((p) => world.buf(`${kind.name}Runs${p}`, N * 4 * 16, S | GPUBufferUsage.COPY_SRC));
    this.runs = runs;
    const fl = world.buf(`${kind.name}Flux`, N * 4 * 2 * 16, S);
    const emit = world.buf(`${kind.name}Emit`, N * 4, S);
    this.inst = world.buf(`${kind.name}RunInst`, N * 16 * 2, S);
    this.indirect = world.buf(`${kind.name}RunIndirect`, 16, S | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    this.instO = world.buf(`${kind.name}OpenInst`, kind.name === 'water' ? 48 : N * 16 * 3, S);
    this.indirectO = world.buf(`${kind.name}OpenIndirect`, 16, S | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST);
    this.uni = world.buf(`${kind.name}U`, this.uniData.byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    new Uint32Array(this.uniData, 0, 4)[2] = new Uint32Array(new Float32Array([wakeTol]).buffer)[0];
    const size = { width: world.w, height: world.h };
    const tex = () => device.createTexture({ label: `${kind.name}Jet`, size, format: 'rgba32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING });
    const jets = [0, 1].map(() => [tex(), tex(), tex()].map((t) => t.createView()));

    const parts = [commonWgsl, layersWgsl, materialsWgsl, prelude(kind) + flowConst(kind.name) + liquidWgsl];
    const base: BindSpec = { 0: 'uniform', 1: 'read', 2: 'uniform', 21: 'tex', 33: 'uniform' };
    const specs: Record<string, BindSpec> = {
      flux: { 3: 'rw', 5: 'rw', 6: 'read', 8: 'rw', 9: 'rw', 10: 'read' },
      jets: { 3: 'rw', 5: 'rw', 6: 'read', 8: 'rw', 9: 'rw', 22: 'tex', 23: 'tex', 24: 'tex', 25: 'stex', 26: 'stex', 27: 'stex' },
      depth: { 3: 'rw', 4: 'read', 5: 'rw', 6: 'read', 7: 'rw', 8: 'rw', 11: 'rw', 17: 'tex', 22: 'tex', 23: 'tex', 24: 'tex' },
      publishWater: { 4: 'read', 5: 'rw', 7: 'rw', 8: 'rw', 14: 'rw', 16: 'read', 19: 'rw' },
      publishLava: { 3: 'rw', 5: 'rw', 7: 'rw', 11: 'rw', 12: 'rw', 13: 'rw', 20: 'rw' },
      prep: { 5: 'rw', 6: 'read', 12: 'rw', 13: 'rw', 22: 'tex', 23: 'tex', 24: 'tex', 29: 'rw', 30: 'rw', 31: 'rw', 32: 'rw' },
    };
    const entries = ['flux', 'jets', 'depth', kind.name === 'water' ? 'publishWater' : 'publishLava', 'prep'];
    for (const e of entries) {
      // (the water's publish and the prep don't read the layers' chunk table: one storage slot fewer)
      const spec: BindSpec = { ...base, ...specs[e] };
      if (e === 'publishWater' || e === 'prep') delete spec[1];
      const k = makeCompute(device, `${this.name}-${e}`, parts, spec, e);
      this.k[e] = k;
      // per parity: runs/jets in and out
      this.g[e] = [0, 1].map((par) => {
        const res: Record<number, GPUBuffer | GPUTextureView> = {
          0: world.globals,
          1: world.chunks,
          2: world.materials,
          3: world.layers,
          4: world.surface,
          5: this.open,
          6: e === 'prep' ? runs[1 - par] : runs[par],
          7: runs[1 - par],
          8: fl,
          9: emit,
          10: world.oil,
          11: act,
          12: world.particles,
          13: world.particleCounters,
          14: world.waterPrev,
          16: world.waterSource,
          17: world.driftView,
          19: world.flux,
          20: world.water,
          21: world.bodyProjView,
          // (jets reads last step's and writes this one's; depth and prep read this one's)
          22: e === 'jets' ? jets[par][0] : jets[1 - par][0],
          23: e === 'jets' ? jets[par][1] : jets[1 - par][1],
          24: e === 'jets' ? jets[par][2] : jets[1 - par][2],
          25: jets[1 - par][0],
          26: jets[1 - par][1],
          27: jets[1 - par][2],
          29: this.inst,
          30: this.indirect,
          31: this.instO,
          32: this.indirectO,
          33: this.uni,
        };
        return makeBindGroup(device, `${this.name}-${e}-${par}`, k.layout, Object.fromEntries(Object.keys(spec).map((n) => [n, res[Number(n)]])));
      });
    }
  }

  /** Pour `rate` cells^3/s in at world (x, y), height z (a tunnel's floor, a crater); the oldest goes past MAX_SPRINGS. */
  addSpring(x: number, y: number, z: number, rate: number): void {
    if (this.springs.length >= MAX_SPRINGS) this.springs.shift();
    this.springs.push({ x, y, z, rate });
  }

  /**
   * (scripts) The runs as they stand: the enclosed runs' count and volume over the map, the instances drawn
   * (runs under rock + stream segments), and column (x, y)'s runs (floor, depth, heat; slot 0 the open run's floor).
   */
  async probe(x = -1, y = -1): Promise<{ enclosed: number; enclosedVol: number; drawn: number; col?: number[][] }> {
    const dev = this.device;
    const src = this.runs[1 - (this.step & 1)];
    const a = dev.createBuffer({ size: src.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const b = dev.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = dev.createCommandEncoder();
    enc.copyBufferToBuffer(src, 0, a, 0, src.size);
    enc.copyBufferToBuffer(this.indirect, 0, b, 0, 16);
    dev.queue.submit([enc.finish()]);
    const now = this.step & 0x3ffff;
    await Promise.all([a.mapAsync(GPUMapMode.READ), b.mapAsync(GPUMapMode.READ)]);
    const r = new Float32Array(a.getMappedRange());
    const drawn = new Uint32Array(b.getMappedRange())[1];
    let enclosed = 0;
    let enclosedVol = 0;
    for (let i = 0; i < this.world.cells; i++) {
      const w = r[i * 16 + 3];
      if (w >>> 3 !== now) continue;
      for (let s = 1; s <= (w & 7); s++) {
        enclosed++;
        enclosedVol += r[i * 16 + s * 4 + 1];
      }
    }
    let col: number[][] | undefined;
    if (x >= 0) {
      const i = y * this.world.w + x;
      col = [0, 1, 2, 3].map((s) => [...r.slice(i * 16 + s * 4, i * 16 + s * 4 + 4)]);
    }
    a.destroy();
    b.destroy();
    return { enclosed, enclosedVol, drawn, col };
  }

  private writeUniforms(): void {
    const u = new Uint32Array(this.uniData, 0, 4);
    u[0] = this.step;
    u[1] = this.springs.length;
    const fv = new Float32Array(this.uniData, 16);
    this.springs.forEach((s, i) => fv.set([s.x, s.y, s.z, s.rate], i * 4));
    const sc = new Float32Array(this.uniData, 16 + 16 * MAX_SPRINGS);
    sc.fill(1);
    for (const [k, r] of this.rescale) if (k < sc.length) sc[k] = r;
    this.device.queue.writeBuffer(this.uni, 0, this.uniData);
  }

  encode(enc: GPUCommandEncoder): void {
    // (a rescale to apply: the passes run this step, whatever's frozen — their frozen paths apply it)
    const sim = !this.skip() || this.rescale.size > 0;
    if (sim) this.step++;
    this.writeUniforms();
    this.rescale.clear();
    const par = this.step & 1;
    const run = (e: string) => dispatch(enc, this.prof, `${this.name}-${e}`, this.k[e], this.g[e][par], this.world.groups);
    this.ran = 0;
    if (sim) {
      for (const e of ['flux', 'jets', 'depth', this.kind.name === 'water' ? 'publishWater' : 'publishLava']) run(e);
      this.ran = 4;
    }
    this.device.queue.writeBuffer(this.indirect, 0, new Uint32Array([VERTS_PER_PRISM, 0, 0, 0]));
    this.device.queue.writeBuffer(this.indirectO, 0, new Uint32Array([VERTS_PER_PRISM, 0, 0, 0]));
    run('prep');
    this.ran++;
  }
}
