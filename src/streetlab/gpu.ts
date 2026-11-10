// (street lab, milestone 1) The street lab's GPU runner: the window's heights and water read from the world's own
// buffers (height.wgsl, at load), then a technique's street lines over them (streets.wgsl) and the display mesh
// (Renderer.addMesh) — every pass on the GPU; the CPU only writes the passes' numbers and encodes the dispatches. The one
// read back is the run's eight timestamps (64 bytes, after a run — never a frame's). It owns its buffers; it knows the
// world only through StreetWorld.
import commonWgsl from '../shaders/common.wgsl?raw';
import layersWgsl from '../shaders/layers.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import heightWgsl from './height.wgsl?raw';
import streetsWgsl from './streets.wgsl?raw';
import { makeBindGroup, makeCompute, makeLayout, makeModule, type ComputeKernel } from '../gpu/pipeline';
import { ROW_H } from '../world/lattice';

export const TECHNIQUES = ['L1 height contours', 'L2 water/cliff distance contours', 'L2 + radial (rings, spokes)', 'L4 tensor streamlines'] as const;

export interface StreetParams {
  /** index into TECHNIQUES */
  technique: number;
  /** major streets' spacing and the minor ones' (world units) */
  majorSpacing: number;
  minorSpacing: number;
  /** street widths (world units; the half each side of the centreline) */
  majorWidth: number;
  minorWidth: number;
  /** L1's height between contours (cells) */
  contourStep: number;
  /** a street rising more than this along itself needs stairs (rise / run) */
  stairs: number;
  /** ground steeper than this is a cliff the streets keep off and follow (rise / run, smoothed) */
  cliff: number;
  /** the town's radius (world units) round its centre */
  townR: number;
}

/** what the street lab needs of the world */
export interface StreetWorld {
  w: number;
  h: number;
  globals: GPUBuffer;
  chunks: GPUBuffer;
  layers: GPUBuffer;
  water: GPUBuffer;
  /** the town's centre (window world) */
  centre: [number, number];
}

/** GPU ms of a run's stages (timestamps; null: the device has no timestamp-query) */
export interface StreetTimes {
  height: number | null;
  field: number | null;
  lines: number | null;
  mesh: number | null;
  /** first stage's start to the last's end */
  total: number | null;
}

const SLOT = 256;
const MAX_PASSES = 256;
const UNI_BYTES = 96;
const NONE = 0xffffffff;
const F32BITS = (v: number) => new Uint32Array(new Float32Array([v]).buffer)[0];
const KERNELS = ['fill', 'blur', 'feat', 'jfa', 'jdist', 'center', 'tensor', 'trace', 'mesh', 'meshCap'] as const;
type Kernel = (typeof KERNELS)[number];
/** the display's room: hexagons for this share of the window's columns (12 vertices, 32 bytes each) */
const MESH_SHARE = 0.5;
const STAGES = ['height', 'field', 'lines', 'mesh'] as const;

interface Uni {
  k?: number;
  mode?: number;
  count?: number;
  cap?: number;
  a?: number[];
  b?: number[];
  c?: number[];
}
type Bufs = Partial<Record<1 | 2 | 3 | 4 | 5 | 6 | 7, GPUBuffer>>;

export class StreetLabGpu {
  readonly verts: GPUBuffer;
  readonly args: GPUBuffer;
  readonly vertCap: number;
  private pipes!: Record<Kernel, GPUComputePipeline>;
  private layout: GPUBindGroupLayout;
  private heightK: ComputeKernel;
  private uni: GPUBuffer;
  private uniData = new ArrayBuffer(SLOT * MAX_PASSES);
  private nPass = 0;
  private B: Record<string, GPUBuffer>;
  private dummies: GPUBuffer[];
  private qs?: GPUQuerySet;
  private qRes?: GPUBuffer;
  private qRead?: GPUBuffer;
  private haveHeights = false;
  private busy: Promise<unknown> = Promise.resolve();
  private dead = false;
  private all: GPUBuffer[] = [];
  /** the last run's dispatches */
  dispatches = 0;

  constructor(
    private device: GPUDevice,
    private world: StreetWorld,
  ) {
    const { w, h } = world;
    const N = w * h;
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const buf = (label: string, bytes: number, usage = S) => {
      const b = device.createBuffer({ label: `streetlab ${label}`, size: Math.max(16, bytes), usage });
      this.all.push(b);
      return b;
    };
    this.uni = buf('passes', SLOT * MAX_PASSES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.B = {};
    for (const n of ['H', 'M', 'HS', 'TB', 'T0', 'FD', 'S0', 'S1', 'CL', 'DIST', 'ROAD', 'CLS', 'ANG', 'OCC', 'CLS2', 'BLK']) this.B[n] = buf(n, N * 4);
    this.vertCap = Math.floor(N * MESH_SHARE) * 12;
    this.verts = buf('mesh', this.vertCap * 32, GPUBufferUsage.STORAGE);
    this.args = buf('mesh args', 16, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(this.args, 0, new Uint32Array([0, 1, 0, 0]));
    this.dummies = [1, 2, 3, 4, 5, 6, 7, 8].map((k) => buf(`dummy ${k}`, 16));
    this.layout = makeLayout(device, 'streetlab', { 0: 'uniform', 1: 'read', 2: 'read', 3: 'read', 4: 'read', 5: 'rw', 6: 'rw', 7: 'rw', 8: 'rw' }, GPUShaderStage.COMPUTE);
    const module = makeModule(device, 'streetlab', [streetsWgsl]);
    const pl = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    this.pipes = Object.fromEntries(KERNELS.map((k) => [k, device.createComputePipeline({ label: `streetlab ${k}`, layout: pl, compute: { module, entryPoint: k } })])) as Record<Kernel, GPUComputePipeline>;
    this.heightK = makeCompute(device, 'streetlab height', [commonWgsl, layersWgsl, materialsWgsl, heightWgsl], { 0: 'uniform', 1: 'read', 3: 'read', 4: 'read', 5: 'rw', 6: 'rw' });
    if (device.features.has('timestamp-query')) {
      const n = STAGES.length * 2;
      this.qs = device.createQuerySet({ type: 'timestamp', count: n });
      this.qRes = buf('stamps', n * 8, GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC);
      this.qRead = buf('stamps read', n * 8, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    }
  }

  dispose(): void {
    this.dead = true;
    this.qs?.destroy();
    for (const b of this.all) b.destroy();
  }

  /** run a technique (runs queue: one at a time) */
  run(p: StreetParams): Promise<StreetTimes> {
    const r = this.busy.then(() => this.once(p));
    this.busy = r.catch(() => undefined);
    return r;
  }

  private slot(u: Uni): number {
    if (this.nPass >= MAX_PASSES) throw new Error(`streetlab: more than ${MAX_PASSES} passes in a run`);
    const i = this.nPass++;
    const dv = new DataView(this.uniData, i * SLOT, UNI_BYTES);
    const { w, h, centre } = this.world;
    [w, h, u.k ?? 0, u.mode ?? 0, u.count ?? 0, u.cap ?? 0, 0, 0].forEach((v, j) => dv.setUint32(j * 4, v >>> 0, true));
    const f = [...(u.a ?? [0, 0, 0, 0]), ...(u.b ?? [0, 0, 0, 0]), ...(u.c ?? [0, 0, 0, 0]), centre[0], centre[1], this.p.townR, this.p.stairs];
    f.forEach((v, j) => dv.setFloat32(32 + j * 4, v, true));
    return i;
  }

  private p!: StreetParams;
  private cp!: GPUComputePassEncoder;

  private k(name: Kernel, u: Uni, bufs: Bufs, wx: number, wy = 1): void {
    const i = this.slot(u);
    const entries: Record<number, GPUBuffer | GPUBufferBinding> = { 0: { buffer: this.uni, offset: i * SLOT, size: UNI_BYTES }, 8: name === 'mesh' || name === 'meshCap' ? this.args : this.dummies[7] };
    for (let b = 1; b <= 7; b++) entries[b] = bufs[b as 1] ?? this.dummies[b - 1];
    this.cp.setPipeline(this.pipes[name]);
    this.cp.setBindGroup(0, makeBindGroup(this.device, `streetlab ${name}`, this.layout, entries));
    this.cp.dispatchWorkgroups(wx, wy);
    this.dispatches++;
  }
  /** one thread a column */
  private k2(name: Kernel, u: Uni, bufs: Bufs): void {
    this.k(name, u, bufs, Math.ceil(this.world.w / 8), Math.ceil(this.world.h / 8));
  }
  private fill(buf: GPUBuffer, count: number, val: number): void {
    this.k('fill', { count, k: val }, { 5: buf }, Math.ceil(count / 64));
  }
  /**
   * A jump flood of `src`'s seeds through `tmp`: returns the buffer that holds it. `reach` (columns): only distances
   * under it are wanted — the flood starts at the power of two at or over it (a seed farther off may be missed: the
   * column keeps NONE or a farther seed); default the whole window.
   */
  private jfa(src: GPUBuffer, tmp: GPUBuffer, reach = Math.max(this.world.w, this.world.h)): GPUBuffer {
    let a = src;
    let b = tmp;
    let k = 1;
    while (k < reach && k * 2 < Math.max(this.world.w, this.world.h)) k *= 2;
    for (; k >= 1; k >>= 1) {
      this.k2('jfa', { k }, { 1: a, 5: b });
      [a, b] = [b, a];
    }
    // (one more at step 1: JFA+1)
    this.k2('jfa', { k: 1 }, { 1: a, 5: b });
    return b;
  }
  private blur(src: GPUBuffer, dst: GPUBuffer, r: number, times: number): void {
    for (let t = 0; t < times; t++) {
      this.k2('blur', { a: [r, 0, 0, 0], mode: 0 }, { 1: t ? dst : src, 5: this.B.TB });
      this.k2('blur', { a: [r, 0, 0, 0], mode: 1 }, { 1: this.B.TB, 5: dst });
    }
  }
  private pass(stage: (typeof STAGES)[number]): GPUComputePassDescriptor {
    const s = STAGES.indexOf(stage) * 2;
    return { label: `streetlab ${stage}`, timestampWrites: this.qs ? { querySet: this.qs, beginningOfPassWriteIndex: s, endOfPassWriteIndex: s + 1 } : undefined };
  }

  private async once(p: StreetParams): Promise<StreetTimes> {
    if (this.dead) throw new Error('streetlab: disposed');
    this.p = p;
    this.nPass = 0;
    this.dispatches = 0;
    const { device } = this;
    const { w, h } = this.world;
    const N = w * h;
    const B = this.B;
    const enc = device.createCommandEncoder({ label: 'streetlab run' });
    const firstHeights = !this.haveHeights;
    // the heights and the water, once (the land doesn't change in milestone 1: later, on dirty chunks only)
    if (firstHeights) {
      const cp = enc.beginComputePass(this.pass('height'));
      const W = this.world;
      cp.setPipeline(this.heightK.pipeline);
      cp.setBindGroup(0, makeBindGroup(device, 'streetlab height', this.heightK.layout, { 0: W.globals, 1: W.chunks, 3: W.layers, 4: W.water, 5: B.H, 6: B.M }));
      cp.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
      cp.end();
      this.haveHeights = true;
    }
    // the fields: smoothed heights, the features (water, cliffs) and the smoothed distance to them; L4 its tensor field
    this.cp = enc.beginComputePass(this.pass('field'));
    this.blur(B.H, B.HS, 2, 2);
    this.k2('feat', { a: [p.cliff, 0, 0, 0] }, { 1: B.HS, 2: B.M, 5: B.S0, 7: B.BLK });
    const fr = this.jfa(B.S0, B.S1);
    this.k2('jdist', { mode: 0 }, { 1: fr, 5: B.T0, 7: B.CLS2 });
    this.blur(B.T0, B.FD, 5, 3);
    if (p.technique === 3) this.k2('tensor', { a: [0.25, 1.0, 1.0, 2.0], b: [0.3, 30, 60, 4] }, { 1: B.HS, 2: B.FD, 5: B.ANG });
    this.cp.end();
    // the centrelines, then one flood from them: each column's distance to its street less the street's half width
    this.cp = enc.beginComputePass(this.pass('lines'));
    if (p.technique < 3) {
      const spokes = Math.max(6, Math.round((Math.PI * p.townR) / p.minorSpacing));
      this.k2('center', { mode: p.technique + 1, a: [p.contourStep, p.majorSpacing, p.minorSpacing, spokes] }, { 1: B.HS, 2: B.FD, 4: B.BLK, 5: B.CL });
    } else {
      this.fill(B.CL, N, NONE);
      this.fill(B.DIST, N, F32BITS(1e9));
      const Wx = w + 0.5;
      const Hy = h * ROW_H;
      for (const [mode, ds] of [
        [0, p.majorSpacing],
        [1, p.minorSpacing],
      ]) {
        const cs = ds * 0.6;
        this.fill(B.OCC, Math.ceil(Wx / cs) * Math.ceil(Hy / cs), 0);
        for (const [ox, oy] of [
          [0, 0],
          [0.5, 0.5],
          [0.5, 0],
          [0, 0.5],
        ]) {
          const m = Math.ceil(Math.max(Wx, Hy) / (ds * 2)) + 1;
          this.k('trace', { count: m, mode, a: [ds, cs, 0, 0], c: [ox, oy, 0, 0] }, { 1: B.ANG, 2: B.DIST, 3: B.BLK, 4: B.HS, 5: B.CL, 6: B.OCC }, Math.ceil((m * m) / 64));
          this.k2('jfa', { k: 0 }, { 1: B.CL, 5: B.S0 });
          // (the distance to the lines so far matters only under a seed's 0.9 ds: the flood reaches ds)
          const r = this.jfa(B.S0, B.S1, ds);
          this.k2('jdist', { mode: 0 }, { 1: r, 5: B.DIST, 7: B.T0 });
        }
      }
    }
    this.k2('jfa', { k: 0 }, { 1: B.CL, 5: B.S0 });
    // (the widths: only a street's half width from its centreline matters — twice the widest's reach, for the
    // nearest of two streets close together)
    const r = this.jfa(B.S0, B.S1, Math.max(p.majorWidth, p.minorWidth) * 2);
    this.k2('jdist', { mode: 1, a: [p.majorWidth / 2, p.minorWidth / 2, 0, 0] }, { 1: r, 5: B.ROAD, 7: B.CLS });
    this.cp.end();
    // the display: a hexagon a street column
    enc.clearBuffer(this.args, 0, 4);
    this.cp = enc.beginComputePass(this.pass('mesh'));
    this.k2('mesh', { cap: this.vertCap }, { 1: B.ROAD, 2: B.CLS, 3: B.H, 4: B.BLK, 6: this.verts });
    this.k('meshCap', { cap: this.vertCap }, {}, 1);
    this.cp.end();
    device.queue.writeBuffer(this.uni, 0, this.uniData, 0, this.nPass * SLOT);
    const n = STAGES.length * 2;
    if (this.qs) {
      enc.resolveQuerySet(this.qs, 0, n, this.qRes!, 0);
      enc.copyBufferToBuffer(this.qRes!, 0, this.qRead!, 0, n * 8);
    }
    device.queue.submit([enc.finish()]);
    if (!this.qs) return { height: null, field: null, lines: null, mesh: null, total: null };
    await this.qRead!.mapAsync(GPUMapMode.READ);
    const t = new BigUint64Array(this.qRead!.getMappedRange().slice(0));
    this.qRead!.unmap();
    const ms = (s: number) => Number(t[s * 2 + 1] - t[s * 2]) / 1e6;
    const first = firstHeights ? 0 : 1;
    return {
      height: firstHeights ? ms(0) : null,
      field: ms(1),
      lines: ms(2),
      mesh: ms(3),
      total: Number(t[7] - t[first * 2]) / 1e6,
    };
  }
}
