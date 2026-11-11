// (archgen, docs/design/ARCHGEN.md) The building generator on the GPU: citygen's lot records in (24 words a lot), parts
// out (arch.wgsl: PPL parts a lot in the lot's own slot), compacted into a draw list a kind with its instance count
// written on the GPU (no readback), drawn by one instanced indirect draw a kind (draw.wgsl). The CPU encodes the
// dispatches: a lot range to (re)make (a town's lots made in slices over frames), the compaction, the draws.

import archWgsl from './arch.wgsl?raw';
import drawWgsl from './draw.wgsl?raw';
import { STYLES, STYLE_VEC4S, styleWords, type Style } from './styles';

/** mirrors arch.wgsl */
export const PART_WORDS = 16;
export const PARTS_PER_LOT = 24;
export const KIND = { body: 1, roof: 2 } as const;
const NK = 3;
/** vertices a kind's instance (draw.wgsl vsBody, vsRoof) */
const VERTS: Record<number, number> = { [KIND.body]: 30, [KIND.roof]: 24 };

const GEN_MARK = '// ---- generation';
const COMPACT_MARK = '// ---- compaction';
const CONSTS = archWgsl.slice(0, archWgsl.indexOf(GEN_MARK));
const GEN = CONSTS + archWgsl.slice(archWgsl.indexOf(GEN_MARK), archWgsl.indexOf(COMPACT_MARK));
const COMPACT = CONSTS + archWgsl.slice(archWgsl.indexOf(COMPACT_MARK));
const DRAW = CONSTS + drawWgsl;

export interface ArchGenOpts {
  /** the lot slots (citygen's lot room) */
  lots: number;
  /** the colour target's format, the depth format */
  format: GPUTextureFormat;
  depthFormat: GPUTextureFormat;
  /** MSAA samples (1 none) */
  samples?: number;
  /** (lab) write each parcel as a ground body; its bottom z */
  ground?: { zmin: number };
}

export class ArchGen {
  readonly parts: GPUBuffer;
  readonly list: GPUBuffer;
  readonly args: GPUBuffer;
  readonly styles: GPUBuffer;
  readonly view: GPUBuffer;
  private genU: GPUBuffer;
  private compU: GPUBuffer;
  private genPipe: GPUComputePipeline;
  private resetPipe: GPUComputePipeline;
  private compactPipe: GPUComputePipeline;
  private drawPipes = new Map<number, GPURenderPipeline>();
  private genGroup: GPUBindGroup;
  private compactGroup: GPUBindGroup;
  private drawGroup: GPUBindGroup;
  /** the list's room a kind */
  readonly room: number;
  readonly slots: number;
  nstyles = STYLES.length;
  /** a style for every lot, or -1 the district's */
  style = -1;

  constructor(
    private device: GPUDevice,
    records: GPUBuffer,
    counts: GPUBuffer,
    private o: ArchGenOpts,
  ) {
    const d = device;
    this.slots = o.lots * PARTS_PER_LOT;
    this.room = this.slots;
    const S = GPUBufferUsage.STORAGE;
    this.parts = d.createBuffer({ label: 'arch parts', size: this.slots * PART_WORDS * 4, usage: S });
    this.list = d.createBuffer({ label: 'arch draw list', size: NK * this.room * 4, usage: S });
    this.args = d.createBuffer({ label: 'arch draw args', size: NK * 16, usage: S | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
    const a = new Uint32Array(NK * 4);
    for (const k of [KIND.body, KIND.roof]) a[k * 4] = VERTS[k];
    d.queue.writeBuffer(this.args, 0, a);
    this.styles = d.createBuffer({ label: 'arch styles', size: 64 * STYLE_VEC4S * 16, usage: S | GPUBufferUsage.COPY_DST });
    this.setStyles(STYLES);
    this.genU = d.createBuffer({ label: 'arch gen', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.compU = d.createBuffer({ label: 'arch compact', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(this.compU, 0, new Uint32Array([this.slots, this.room, 0, 0]));
    this.view = d.createBuffer({ label: 'arch view', size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    const gm = d.createShaderModule({ label: 'arch gen', code: GEN });
    const cm = d.createShaderModule({ label: 'arch compact', code: COMPACT });
    const dm = d.createShaderModule({ label: 'arch draw', code: DRAW });
    this.genPipe = d.createComputePipeline({ label: 'arch gen', layout: 'auto', compute: { module: gm, entryPoint: 'gen' } });
    this.genGroup = d.createBindGroup({
      layout: this.genPipe.getBindGroupLayout(0),
      entries: [this.genU, records, counts, this.parts, this.styles].map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
    // (reset and compact share one explicit layout: 'auto' layouts differ per entry point)
    const cl = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const cpl = d.createPipelineLayout({ bindGroupLayouts: [cl] });
    this.resetPipe = d.createComputePipeline({ label: 'arch reset', layout: cpl, compute: { module: cm, entryPoint: 'reset' } });
    this.compactPipe = d.createComputePipeline({ label: 'arch compact', layout: cpl, compute: { module: cm, entryPoint: 'compact' } });
    this.compactGroup = d.createBindGroup({
      layout: cl,
      entries: [this.compU, this.parts, this.list, this.args].map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
    const dl = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });
    const layout = d.createPipelineLayout({ bindGroupLayouts: [dl] });
    for (const [k, vs] of [[KIND.body, 'vsBody'], [KIND.roof, 'vsRoof']] as const) {
      this.drawPipes.set(
        k,
        d.createRenderPipeline({
          label: `arch ${vs}`,
          layout,
          vertex: { module: dm, entryPoint: vs },
          fragment: { module: dm, entryPoint: 'fsArch', targets: [{ format: o.format }] },
          // (cull off: the construction shader's clipped walls show their inside; the parts are closed shells)
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          depthStencil: { format: o.depthFormat, depthWriteEnabled: true, depthCompare: 'less' },
          multisample: { count: o.samples ?? 1 },
        }),
      );
    }
    this.drawGroup = d.createBindGroup({
      layout: dl,
      entries: [this.view, this.parts, this.list, this.styles].map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
  }

  setStyles(styles: Style[]): void {
    this.nstyles = styles.length;
    this.device.queue.writeBuffer(this.styles, 0, styleWords(styles));
  }

  /** (re)make lots [first, first + count): their parts written into their slots. Then compact() before drawing. */
  generate(enc: GPUCommandEncoder, first: number, count: number, ts?: GPUComputePassTimestampWrites): void {
    const u = new ArrayBuffer(32);
    const w = new Uint32Array(u);
    const f = new Float32Array(u);
    w[0] = first;
    w[1] = count;
    w[2] = this.style < 0 ? 0xffffffff : this.style;
    w[3] = this.o.ground ? 1 : 0;
    f[4] = this.o.ground?.zmin ?? 0;
    w[5] = this.nstyles;
    // (a uniform per call would need its own buffer; one generate a submit — the caller's slicing goes frame by frame)
    this.device.queue.writeBuffer(this.genU, 0, u);
    const p = enc.beginComputePass({ label: 'arch gen', timestampWrites: ts });
    p.setPipeline(this.genPipe);
    p.setBindGroup(0, this.genGroup);
    p.dispatchWorkgroups(Math.ceil(count / 64));
    p.end();
  }

  compact(enc: GPUCommandEncoder, ts?: GPUComputePassTimestampWrites): void {
    const p = enc.beginComputePass({ label: 'arch compact', timestampWrites: ts });
    p.setBindGroup(0, this.compactGroup);
    p.setPipeline(this.resetPipe);
    p.dispatchWorkgroups(1);
    p.setPipeline(this.compactPipe);
    p.dispatchWorkgroups(Math.ceil(this.slots / 64));
    p.end();
  }

  /** the view: viewProj (column-major), towards the sun + strength, towards the eye + units a pixel, time/night/detail */
  setView(viewProj: Float32Array, sun: number[], eye: number[], time: number, night: number, detail: number): void {
    const f = new Float32Array(28);
    f.set(viewProj, 0);
    f.set(sun, 16);
    f.set(eye, 20);
    f.set([time, night, detail, this.room], 24);
    this.device.queue.writeBuffer(this.view, 0, f);
  }

  draw(pass: GPURenderPassEncoder): void {
    pass.setBindGroup(0, this.drawGroup);
    for (const [k, pipe] of this.drawPipes) {
      pass.setPipeline(pipe);
      pass.drawIndirect(this.args, k * 16);
    }
  }

  destroy(): void {
    for (const b of [this.parts, this.list, this.args, this.styles, this.view, this.genU, this.compU]) b.destroy();
  }
}
