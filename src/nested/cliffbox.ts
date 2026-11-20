// Nested scales lab, round 32 step B2 (docs/design/NESTED_SCALES.md "As built (round 32, step B2)"): ?cliff=5, the cliff
// rule drawn on real terrain. Owns the per-cell table of the 16 m window and the SPLIT cells' box list (one buffer: the
// list after the cells; built on the GPU by gpu/cliffbuild.wgsl when the window's contents change: a new window, or the
// store settling after an op; never per frame), and the module variant's two pipelines: the textured sheets with SPLIT
// cells discarded (fsST5) and the boxes marched inside (vsBox5 / fsBox5, gpu/cliff5.wgsl). Renderer calls update() before
// its passes and draws through it.
//
// Storage buffers per stage (WebGPU's default limit is 8; the page asks for the adapter's, and the pool takes
// S = min(4, limit - 6) segments, so the default draws use 4 + S in the vertex stage):
//   sheets: the default group 0 (vertex 4 + S, fragment 1 + S) + the table to the fragment stage only: vertex 4 + S,
//           fragment 2 + S (8 / 6 with S = 4; 6 / 4 on a device limited to 8, where S = 2);
//   boxes:  their own group 0 (the uniform, the camera, the registry: nothing else is read) + the table: vertex 3,
//           fragment 1.
import storeWgsl from './gpu/store.wgsl?raw';
import cliffRuleWgsl from './gpu/cliffrule.wgsl?raw';
import cliffBuildWgsl from './gpu/cliffbuild.wgsl?raw';
import cliff5Wgsl from './gpu/cliff5.wgsl?raw';
import { SEG_BASE, TCAP, segWgsl, type GpuNest, type Win } from './gpu/nest';
import { cliffRulePrefix, drawModuleCode } from './render';

/** words a cell in the table (cliffrule.wgsl CR_REC) */
const REC = 12;
/** (B3) the box args buffer: the indirect arguments (4 words) and the sort's buckets (cliffbuild.wgsl CR_SB, 2 x CR_NB) */
const ARGS_BYTES = (4 + 2 * 2048) * 4;
/** (B3) the box pass's cost cuts (cliff5.wgsl overrides CR5_CULL / CR5_ORDER) */
export interface BoxOpt {
  cull: boolean;
  order: boolean;
}
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
  /** the steep threshold T, cell widths (?cliffT=, default 2; a change rebuilds the table) */
  T = 2;
  /** the pipelines' creation time, ms */
  compileMs = 0;
  ready = false;
  sheet!: GPURenderPipeline;
  box!: GPURenderPipeline;
  /** (step B3) the box pass's cost cuts (cliff5.wgsl overrides): back faces collapsed in the vertex stage; the box list
   *  read front to back. Both on by default; switchable at run time for measurement (a setting's pipeline is made the
   *  first time it is asked for, then kept) */
  opt: BoxOpt = { cull: true, order: true };
  /** (B3, measurement only) the box pass's overdraw counted into `countTex` (render.ts draws it before the boxes) */
  counting = false;
  countTex: GPUTexture | null = null;
  private variants = new Map<string, GPURenderPipeline | null>();
  private counts = new Map<string, { all: GPURenderPipeline; depth: GPURenderPipeline } | null>();
  private boxLayout!: GPUPipelineLayout;
  private md!: GPUShaderModule;
  private targets!: GPUColorTargetState[];
  private buildPipe!: GPUComputePipeline;
  private sortPipes!: GPUComputePipeline[];
  private buildLayout: GPUBindGroupLayout;
  private sheetG1: GPUBindGroupLayout;
  private boxG0: GPUBindGroupLayout;
  private boxG1: GPUBindGroupLayout;
  private tab: GPUBuffer | null = null;
  readonly args: GPUBuffer;
  private ubuf: GPUBuffer;
  private cap = 0;
  private dirty = true;
  private key = '';
  private bgs: { sheet1: GPUBindGroup; box0: GPUBindGroup; box1: GPUBindGroup } | null = null;
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
    /** the draw's uniform buffer and its binding size (the boxes' own group 0 binds it with the level's offset) */
    private drawU: { buffer: GPUBuffer; size: number },
  ) {
    const V = GPUShaderStage.VERTEX;
    const F = GPUShaderStage.FRAGMENT;
    const ro = { type: 'read-only-storage' as const };
    this.sheetG1 = device.createBindGroupLayout({ label: 'cliff sheets g1', entries: [{ binding: 0, visibility: F, buffer: ro }] });
    this.boxG1 = device.createBindGroupLayout({ label: 'cliff boxes g1', entries: [{ binding: 0, visibility: V | F, buffer: ro }] });
    this.boxG0 = device.createBindGroupLayout({
      label: 'cliff boxes g0',
      entries: [
        { binding: 0, visibility: V | F, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: drawU.size } },
        { binding: 3, visibility: V, buffer: ro },
        { binding: 4, visibility: V, buffer: ro },
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
        { binding: 4, visibility: C, buffer: rw },
        ...Array.from({ length: nest.S }, (_, j) => ({ binding: SEG_BASE + j, visibility: C, buffer: ro })),
      ],
    });
    // (the indirect arguments, then (B3) the sort's buckets: 2 x 2048 words, cliffbuild.wgsl CR_SB / CR_NB)
    this.args = device.createBuffer({ label: 'cliff box args', size: ARGS_BYTES, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    this.ubuf = device.createBuffer({ label: 'cliff build uniform', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const t0 = performance.now();
    const mb = device.createShaderModule({ label: 'cliff table build', code: cliffBuildCode(nest.S, nest.segP, lv, upl, ampL) });
    const md = device.createShaderModule({ label: 'nest draw (cliff boxes)', code: cliffBoxCode(nest.S, nest.segP, lv, upl, ampL) });
    const targets = [{ format }, { format: 'rgba8unorm' as GPUTextureFormat }];
    this.md = md;
    this.targets = targets;
    this.boxLayout = device.createPipelineLayout({ bindGroupLayouts: [this.boxG0, this.boxG1] });
    const bl = device.createPipelineLayout({ bindGroupLayouts: [this.buildLayout] });
    const key = this.optKey();
    this.variants.set(key, null);
    this.whenReady = Promise.all([
      device.createComputePipelineAsync({ label: 'cliff table build', layout: bl, compute: { module: mb, entryPoint: 'crBuild' } }),
      device.createRenderPipelineAsync({ ...sheetDesc, label: 'nest draw sheets (cliff boxes)', layout: device.createPipelineLayout({ bindGroupLayouts: [layout0, this.sheetG1] }), vertex: { module: md, entryPoint: 'vsSheet5' }, fragment: { module: md, entryPoint: 'fsST5', targets } }),
      this.makeVariant(this.opt),
      ...['crSortCount', 'crSortScan', 'crSortScatter'].map((entryPoint) => device.createComputePipelineAsync({ label: `cliff table ${entryPoint}`, layout: bl, compute: { module: mb, entryPoint } })),
    ]).then(([b, s, v, ...sp]) => {
      this.buildPipe = b;
      this.sheet = s;
      this.variants.set(key, v);
      this.box = v;
      this.sortPipes = sp;
      this.compileMs = performance.now() - t0;
      this.ready = true;
    });
  }
  private optKey(): string {
    return `${+this.opt.cull}${+this.opt.order}`;
  }
  private constants(o: BoxOpt): Record<string, number> {
    return { CR5_CULL: +o.cull, CR5_ORDER: +o.order };
  }
  /** (B3) the box pipeline of one setting of `opt` */
  private makeVariant(o: BoxOpt): Promise<GPURenderPipeline> {
    const c = this.constants(o);
    return this.device.createRenderPipelineAsync({
      label: 'nest draw cliff boxes',
      layout: this.boxLayout,
      vertex: { module: this.md, entryPoint: 'vsBox5', constants: c },
      fragment: { module: this.md, entryPoint: 'fsBox5', targets: this.targets, constants: c },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
    });
  }
  /** (B3) the current setting's box pipeline, or the default's while it is being made (measurement only changes it) */
  pipe(): GPURenderPipeline {
    const k = this.optKey();
    const v = this.variants.get(k);
    if (v === undefined) {
      this.variants.set(k, null);
      void this.makeVariant({ ...this.opt }).then((p) => this.variants.set(k, p));
    }
    return v ?? this.box;
  }
  /** (B3) whether the current setting's pipelines are made (measurement: wait for it before timing) */
  get optReady(): boolean {
    return !!this.variants.get(this.optKey()) && (!this.counting || !!this.counts.get(this.optKey()));
  }
  /** (B3, measurement only) the overdraw count pass, recorded between the sheets and the boxes: every box fragment and
   *  those past the front test with no depth test (r, g), the ones that march against the depth so far and their steps
   *  (b, a). Neither writes depth or the frame's targets: the frame's image is unchanged */
  drawCount(enc: GPUCommandEncoder, depth: GPUTexture, w: number, h: number, g: { box0: GPUBindGroup; box1: GPUBindGroup }, uOff: number): void {
    const k = this.optKey();
    let c = this.counts.get(k);
    if (c === undefined) {
      this.counts.set(k, null);
      const cs = this.constants(this.opt);
      const mk = (entryPoint: string, depthCompare: GPUCompareFunction) =>
        this.device.createRenderPipelineAsync({
          label: `cliff boxes count ${entryPoint}`,
          layout: this.boxLayout,
          vertex: { module: this.md, entryPoint: 'vsBox5', constants: cs },
          fragment: { module: this.md, entryPoint, constants: cs, targets: [{ format: 'rgba16float', blend: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } } }] },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare },
        });
      void Promise.all([mk('fsBox5CntAll', 'always'), mk('fsBox5CntDepth', 'greater')]).then(([all, depth]) => this.counts.set(k, { all, depth }));
      return;
    }
    const v = this.variants.get(k);
    if (!c || !v) return;
    if (!this.countTex || this.countTex.width !== w || this.countTex.height !== h) {
      this.countTex?.destroy();
      this.countTex = this.device.createTexture({ label: 'cliff box count', size: [w, h], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    }
    const p = enc.beginRenderPass({
      label: 'cliff boxes count',
      colorAttachments: [{ view: this.countTex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
      depthStencilAttachment: { view: depth.createView(), depthLoadOp: 'load', depthStoreOp: 'store' },
    });
    p.setBindGroup(0, g.box0, [uOff]);
    p.setBindGroup(1, g.box1);
    p.setPipeline(c.all);
    p.drawIndirect(this.args, 0);
    p.setPipeline(c.depth);
    p.drawIndirect(this.args, 0);
    p.end();
  }

  /** before the frame's passes: rebuild the table when the window changed or the store settled after a change */
  update(enc: GPUCommandEncoder): void {
    if (!this.ready) return;
    const w = this.nest.wins[this.lv];
    if (!w) return;
    const key = `${w.gx},${w.gy},${w.n},${this.T}`;
    if (key !== this.key || !this.nest.settled || this.nest.switching) this.dirty = true;
    if (!this.dirty || !this.nest.settled || this.nest.switching) return;
    const cells = w.n * w.n;
    if (cells > this.cap) {
      this.tab?.destroy();
      this.cap = cells;
      // (the cells' records, then the box list: one word a SPLIT cell at most; B3: the count and the two ordered lists)
      this.tab = this.device.createBuffer({ label: 'cliff table', size: cells * (REC + 3) * 4 + 4, usage: GPUBufferUsage.STORAGE });
      this.bgs = null;
    }
    this.device.queue.writeBuffer(this.ubuf, 0, new Int32Array([w.gx, w.gy, w.n, this.T]));
    // (the arguments, the sort's buckets zeroed: only when the table is built)
    const a = new Uint32Array(ARGS_BYTES / 4);
    a[0] = 36;
    this.device.queue.writeBuffer(this.args, 0, a);
    // (the segments can be replaced by a grow: the build's bind group is made for each build)
    const bg = this.device.createBindGroup({
      label: 'cliff table build',
      layout: this.buildLayout,
      entries: [
        { binding: 0, resource: { buffer: this.ubuf } },
        { binding: 1, resource: { buffer: this.nest.tab } },
        { binding: 2, resource: { buffer: this.tab! } },
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
    // (B3) the box list in its two diagonal orders: over every possible box (the count is on the GPU; the extra
    // invocations return at once)
    p.setPipeline(this.sortPipes[0]);
    p.dispatchWorkgroups(gx, Math.ceil(groups / gx));
    p.setPipeline(this.sortPipes[1]);
    p.dispatchWorkgroups(1);
    p.setPipeline(this.sortPipes[2]);
    p.dispatchWorkgroups(gx, Math.ceil(groups / gx));
    p.end();
    this.built = { ...w };
    this.key = key;
    this.dirty = false;
    this.builds++;
  }
  /** the variant's bind groups: group 1 of the sheets, groups 0 and 1 of the boxes */
  groups(): { sheet1: GPUBindGroup; box0: GPUBindGroup; box1: GPUBindGroup } | null {
    if (!this.tab) return null;
    const tab = this.tab;
    this.bgs ??= {
      sheet1: this.device.createBindGroup({ label: 'cliff sheets g1', layout: this.sheetG1, entries: [{ binding: 0, resource: { buffer: tab } }] }),
      box1: this.device.createBindGroup({ label: 'cliff boxes g1', layout: this.boxG1, entries: [{ binding: 0, resource: { buffer: tab } }] }),
      box0: this.device.createBindGroup({
        label: 'cliff boxes g0',
        layout: this.boxG0,
        entries: [
          { binding: 0, resource: { buffer: this.drawU.buffer, size: this.drawU.size } },
          { binding: 3, resource: { buffer: this.nest.cam } },
          { binding: 4, resource: { buffer: this.nest.reg } },
        ],
      }),
    };
    return this.bgs;
  }
}
