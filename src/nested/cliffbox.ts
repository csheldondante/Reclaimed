// Nested scales lab, round 32 step B2 (docs/design/NESTED_SCALES.md "As built (round 32, step B2)"): ?cliff=5, the cliff
// rule drawn on real terrain. Owns the per-cell table of the 16 m window and the SPLIT cells' box list (built on the GPU by
// gpu/cliffbuild.wgsl when the window's contents change: a new window, or the store settling after an op; never per frame),
// and the module variant's two pipelines: the textured sheets with SPLIT cells discarded (fsST5) and the boxes marched
// inside (vsBox5 / fsBox5, gpu/cliff5.wgsl). Renderer calls update() before its passes and draws through it.
import storeWgsl from './gpu/store.wgsl?raw';
import cliffRuleWgsl from './gpu/cliffrule.wgsl?raw';
import cliffBuildWgsl from './gpu/cliffbuild.wgsl?raw';
import cliff5Wgsl from './gpu/cliff5.wgsl?raw';
import { SEG_BASE, TCAP, segWgsl, type GpuNest, type Win } from './gpu/nest';
import { cliffRulePrefix, drawModuleCode } from './render';

/** words a cell in the table (cliffrule.wgsl CR_REC) */
const REC = 12;
/** step B2's default amplitudes: step A's with the 8 m level at half a cell (amp8half, the calmer look) */
export const CLIFF_AMP_B2 = [0, 128, 256, 256, 24, 16, 8];

export function cliffBuildCode(S: number, segP: number, lv: number, upl: number, ampL: number[]): string {
  return `const TCAP: u32 = ${TCAP}u;\n${segWgsl(S, segP, true)}\n${storeWgsl}\n${cliffRulePrefix(lv, upl, ampL)}\n${cliffRuleWgsl}\n${cliffBuildWgsl}`;
}
export function cliffBoxCode(S: number, segP: number, lv: number, upl: number, ampL: number[]): string {
  return `${drawModuleCode(S, segP)}\n${cliffRulePrefix(lv, upl, ampL)}\n${cliffRuleWgsl}\n${cliff5Wgsl}`;
}

export class CliffBox {
  /** the window the table was last built for (the draws read the table in its frame; null before the first build) */
  built: Win | null = null;
  /** table builds so far (measurement) */
  builds = 0;
  /** the pipelines' creation time, ms */
  compileMs = 0;
  ready = false;
  sheet!: GPURenderPipeline;
  box!: GPURenderPipeline;
  private buildPipe!: GPUComputePipeline;
  private buildLayout: GPUBindGroupLayout;
  readonly drawLayout: GPUBindGroupLayout;
  private tab: GPUBuffer | null = null;
  private list: GPUBuffer | null = null;
  readonly args: GPUBuffer;
  private ubuf: GPUBuffer;
  private cap = 0;
  private dirty = true;
  private key = '';
  private drawBg: GPUBindGroup | null = null;
  readonly whenReady: Promise<void>;

  constructor(
    private device: GPUDevice,
    private nest: GpuNest,
    readonly lv: number,
    upl: number,
    ampL: number[],
    layout0: GPUBindGroupLayout,
    sheetDesc: GPURenderPipelineDescriptor,
    format: GPUTextureFormat,
  ) {
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const ro = { type: 'read-only-storage' as const };
    // (group 1 of the variant's draws: the table to the vertex and fragment stages, the box list to the vertex stage: the
    // fragment stage's storage buffers go from 1 + S to 2 + S)
    this.drawLayout = device.createBindGroupLayout({
      label: 'cliff box draw',
      entries: [
        { binding: 0, visibility: VF, buffer: ro },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: ro },
      ],
    });
    const C = GPUShaderStage.COMPUTE;
    const rw = { type: 'storage' as const };
    this.buildLayout = device.createBindGroupLayout({
      label: 'cliff table build',
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, buffer: ro },
        { binding: 2, visibility: C, buffer: rw },
        { binding: 3, visibility: C, buffer: rw },
        { binding: 4, visibility: C, buffer: rw },
        ...Array.from({ length: nest.S }, (_, j) => ({ binding: SEG_BASE + j, visibility: C, buffer: ro })),
      ],
    });
    this.args = device.createBuffer({ label: 'cliff box args', size: 16, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.ubuf = device.createBuffer({ label: 'cliff build uniform', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const t0 = performance.now();
    const mb = device.createShaderModule({ label: 'cliff table build', code: cliffBuildCode(nest.S, nest.segP, lv, upl, ampL) });
    const md = device.createShaderModule({ label: 'nest draw (cliff boxes)', code: cliffBoxCode(nest.S, nest.segP, lv, upl, ampL) });
    const pl = device.createPipelineLayout({ bindGroupLayouts: [layout0, this.drawLayout] });
    const targets = [{ format }, { format: 'rgba8unorm' as GPUTextureFormat }];
    this.whenReady = Promise.all([
      device.createComputePipelineAsync({ label: 'cliff table build', layout: device.createPipelineLayout({ bindGroupLayouts: [this.buildLayout] }), compute: { module: mb, entryPoint: 'crBuild' } }),
      device.createRenderPipelineAsync({ ...sheetDesc, label: 'nest draw sheets (cliff boxes)', layout: pl, vertex: { module: md, entryPoint: 'vsSheet5' }, fragment: { module: md, entryPoint: 'fsST5', targets } }),
      device.createRenderPipelineAsync({
        label: 'nest draw cliff boxes',
        layout: pl,
        vertex: { module: md, entryPoint: 'vsBox5' },
        fragment: { module: md, entryPoint: 'fsBox5', targets },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
      }),
    ]).then(([b, s, x]) => {
      this.buildPipe = b;
      this.sheet = s;
      this.box = x;
      this.compileMs = performance.now() - t0;
      this.ready = true;
    });
  }

  /** before the frame's passes: rebuild the table when the window changed or the store settled after a change */
  update(enc: GPUCommandEncoder): void {
    if (!this.ready) return;
    const w = this.nest.wins[this.lv];
    if (!w) return;
    const key = `${w.gx},${w.gy},${w.n}`;
    if (key !== this.key || !this.nest.settled || this.nest.switching) this.dirty = true;
    if (!this.dirty || !this.nest.settled || this.nest.switching) return;
    const cells = w.n * w.n;
    if (cells > this.cap) {
      this.tab?.destroy();
      this.list?.destroy();
      this.cap = cells;
      this.tab = this.device.createBuffer({ label: 'cliff table', size: cells * REC * 4, usage: GPUBufferUsage.STORAGE });
      this.list = this.device.createBuffer({ label: 'cliff box list', size: cells * 4, usage: GPUBufferUsage.STORAGE });
      this.drawBg = null;
    }
    this.device.queue.writeBuffer(this.ubuf, 0, new Int32Array([w.gx, w.gy, w.n, 0]));
    this.device.queue.writeBuffer(this.args, 0, new Uint32Array([36, 0, 0, 0]));
    // (the segments can be replaced by a grow: the build's bind group is made for each build)
    const bg = this.device.createBindGroup({
      label: 'cliff table build',
      layout: this.buildLayout,
      entries: [
        { binding: 0, resource: { buffer: this.ubuf } },
        { binding: 1, resource: { buffer: this.nest.tab } },
        { binding: 2, resource: { buffer: this.tab! } },
        { binding: 3, resource: { buffer: this.list! } },
        { binding: 4, resource: { buffer: this.args } },
        ...this.nest.segBuffers().map((buffer, j) => ({ binding: SEG_BASE + j, resource: { buffer } })),
      ],
    });
    const p = enc.beginComputePass({ label: 'cliff table build' });
    p.setPipeline(this.buildPipe);
    p.setBindGroup(0, bg);
    const groups = Math.ceil(cells / 64);
    const gx = Math.min(groups, 65535);
    p.dispatchWorkgroups(gx, Math.ceil(groups / gx));
    p.end();
    this.built = { ...w };
    this.key = key;
    this.dirty = false;
    this.builds++;
  }
  /** group 1 of the variant's draws */
  drawGroup(): GPUBindGroup | null {
    if (!this.tab || !this.list) return null;
    this.drawBg ??= this.device.createBindGroup({
      label: 'cliff box draw',
      layout: this.drawLayout,
      entries: [
        { binding: 0, resource: { buffer: this.tab } },
        { binding: 1, resource: { buffer: this.list } },
      ],
    });
    return this.drawBg;
  }
}
