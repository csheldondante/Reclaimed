// (archgen, docs/design/ARCHGEN.md) The building generator on the GPU: citygen's lot records in (24 words a lot), parts
// out (arch.wgsl: PPL parts a lot in the lot's own slot), compacted into a draw list a kind with its instance count
// written on the GPU (no readback), drawn by one instanced indirect draw a kind (draw.wgsl). The CPU encodes the
// dispatches: a lot range to (re)make, the compaction, the draws.
//
// One buffer holds it all (`arch`), so a draw needs one storage binding (the game's renderer gives a mesh source one:
// render.wgsl `instances`). Its layout, u32 words:
//   0–7   the header: the styles' first word, the draw lists', the parts', the list room a kind, the progress's, the
//         lot room, the lots' grounds', 0
//   8…    the styles (STYLE_ROOM × STYLE_VEC4S vec4 f32)
//   …     the draw lists (NK × room u32: a part's index)
//   …     the parts (lots × PARTS_PER_LOT × PART_WORDS)
//   …     each lot's construction progress (f32, 0–1: copied each frame from citygen's progress — copyProgress)
//   …     each lot's ground z (f32: written by the generator; the rise's floor)
// Drawn by a host: the lab's (archlab.wgsl, drawLab) or the game's (archgame.wgsl, through Renderer.addArch).

import archWgsl from './arch.wgsl?raw';
import drawWgsl from './draw.wgsl?raw';
import labWgsl from './archlab.wgsl?raw';
import gameWgsl from './archgame.wgsl?raw';
import { STYLES, STYLE_VEC4S, styleWords, type Style } from './styles';

/** mirrors arch.wgsl */
export const PART_WORDS = 16;
export const PARTS_PER_LOT = 96;
export const KIND = { body: 1, roof: 2, cren: 3, win: 4, cyl: 5, cone: 6, stair: 7 } as const;
export const NK = 8;
/** vertices a kind's instance (draw.wgsl: the kinds' vertex stages; COURSES 12, ROUND_N 16, CONE_ROWS 10) */
const VERTS: Record<number, number> = {
  [KIND.body]: 30,
  [KIND.roof]: 4 * 12 * 12 + 6,
  [KIND.cren]: 4 * 9 * 30,
  [KIND.win]: 11 * 30,
  [KIND.cyl]: 16 * 6 + 16 * 3,
  [KIND.cone]: 16 * 10 * 12 + 16 * 3,
  [KIND.stair]: 16 * 30,
};
/** each kind and its vertex stage (draw.wgsl) */
export const ARCH_DRAWS = [
  [KIND.body, 'vsArchBody'],
  [KIND.roof, 'vsArchRoof'],
  [KIND.cren, 'vsArchCren'],
  [KIND.win, 'vsArchWin'],
  [KIND.cyl, 'vsArchCyl'],
  [KIND.cone, 'vsArchCone'],
  [KIND.stair, 'vsArchStair'],
] as const;
const STYLE_ROOM = 64;

const GEN_MARK = '// ---- generation';
const COMPACT_MARK = '// ---- compaction';
const FS_MARK = '// ---- fragment';
/** arch.wgsl's constants and helpers: every module's head */
export const ARCH_CONSTS = archWgsl.slice(0, archWgsl.indexOf(GEN_MARK));
const GEN = ARCH_CONSTS + archWgsl.slice(archWgsl.indexOf(GEN_MARK), archWgsl.indexOf(COMPACT_MARK));
const COMPACT = ARCH_CONSTS + archWgsl.slice(archWgsl.indexOf(COMPACT_MARK));
/** the vertex stages and archSurface: a host's bindings and functions before, its fragment stage after */
export const ARCH_DRAW = drawWgsl;
const LAB = ARCH_CONSTS + labWgsl.slice(0, labWgsl.indexOf(FS_MARK)) + drawWgsl + labWgsl.slice(labWgsl.indexOf(FS_MARK));
/** the game's part of the renderer's draw module (after renderWgsl): vertex stages ARCH_DRAWS, fragment fsArch.
 *  detail: 0 the phone's flat colours … 1 the PC's patterns */
export const archGameWgsl = (detail: number): string =>
  `const ARCH_DETAIL: f32 = ${detail.toFixed(2)};\n` + ARCH_CONSTS + gameWgsl.slice(0, gameWgsl.indexOf(FS_MARK)) + drawWgsl + gameWgsl.slice(gameWgsl.indexOf(FS_MARK));

export interface ArchGenOpts {
  /** the lot slots (citygen's lot room) */
  lots: number;
  /** (lab) write each parcel as a ground body; its bottom z */
  ground?: { zmin: number };
}

export class ArchGen {
  /** the arch buffer (layout above) */
  readonly arch: GPUBuffer;
  /** the kinds' indirect draw args (drawIndirect's 4 u32 a kind, kind k at k × 16 bytes) */
  readonly args: GPUBuffer;
  readonly slots: number;
  /** the list's room a kind */
  readonly room: number;
  readonly bytes: number;
  private base: { styles: number; list: number; parts: number; progress: number };
  private genU: GPUBuffer;
  private compU: GPUBuffer;
  private genPipe: GPUComputePipeline;
  private resetPipe: GPUComputePipeline;
  private compactPipe: GPUComputePipeline;
  private genGroup: GPUBindGroup;
  private compactGroup: GPUBindGroup;
  private lab?: { pipes: GPURenderPipeline[]; group: GPUBindGroup; view: GPUBuffer };
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
    const styles = 8;
    const list = styles + STYLE_ROOM * STYLE_VEC4S * 4;
    const parts = list + Math.ceil((NK * this.room) / 4) * 4;
    const progress = parts + this.slots * PART_WORDS;
    this.base = { styles, list, parts, progress };
    const ground = progress + o.lots;
    this.bytes = (ground + o.lots) * 4;
    const S = GPUBufferUsage.STORAGE;
    this.arch = d.createBuffer({ label: 'arch', size: this.bytes, usage: S | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(this.arch, 0, new Uint32Array([styles, list, parts, this.room, progress, o.lots, ground, 0]));
    // (built until a progress is copied in: the lab's)
    d.queue.writeBuffer(this.arch, progress * 4, new Float32Array(o.lots).fill(1));
    this.setStyles(STYLES);
    this.args = d.createBuffer({ label: 'arch draw args', size: NK * 16, usage: S | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
    const a = new Uint32Array(NK * 4);
    for (const [k] of ARCH_DRAWS) a[k * 4] = VERTS[k];
    d.queue.writeBuffer(this.args, 0, a);
    this.genU = d.createBuffer({ label: 'arch gen', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.compU = d.createBuffer({ label: 'arch compact', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(this.compU, 0, new Uint32Array([this.slots, 0, 0, 0]));

    const gm = d.createShaderModule({ label: 'arch gen', code: GEN });
    const cm = d.createShaderModule({ label: 'arch compact', code: COMPACT });
    this.genPipe = d.createComputePipeline({ label: 'arch gen', layout: 'auto', compute: { module: gm, entryPoint: 'gen' } });
    this.genGroup = d.createBindGroup({
      layout: this.genPipe.getBindGroupLayout(0),
      entries: [this.genU, records, counts, this.arch].map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
    // (reset and compact share one explicit layout: 'auto' layouts differ per entry point)
    const cl = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const cpl = d.createPipelineLayout({ bindGroupLayouts: [cl] });
    this.resetPipe = d.createComputePipeline({ label: 'arch reset', layout: cpl, compute: { module: cm, entryPoint: 'reset' } });
    this.compactPipe = d.createComputePipeline({ label: 'arch compact', layout: cpl, compute: { module: cm, entryPoint: 'compact' } });
    this.compactGroup = d.createBindGroup({
      layout: cl,
      entries: [this.compU, this.arch, this.args].map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
  }

  setStyles(styles: Style[]): void {
    if (styles.length > STYLE_ROOM) throw new Error(`archgen: ${styles.length} styles, room for ${STYLE_ROOM}`);
    this.nstyles = styles.length;
    this.device.queue.writeBuffer(this.arch, this.base.styles * 4, styleWords(styles));
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
    w[6] = this.o.lots;
    // (one uniform: one generate a submit — a caller slicing a town's lots goes frame by frame)
    this.device.queue.writeBuffer(this.genU, 0, u);
    const p = enc.beginComputePass({ label: 'arch gen', timestampWrites: ts });
    p.setPipeline(this.genPipe);
    p.setBindGroup(0, this.genGroup);
    p.dispatchWorkgroups(Math.ceil(count / 64));
    p.end();
  }

  /** (each frame) citygen's per-lot progress (f32 a record, lots first) into the arch buffer, for the vertex stages */
  copyProgress(enc: GPUCommandEncoder, progress: GPUBuffer): void {
    enc.copyBufferToBuffer(progress, 0, this.arch, this.base.progress * 4, this.o.lots * 4);
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

  // ---- the lab's draw (archlab.wgsl) ----

  /** the lab's pipelines for a colour target (MSAA samples) */
  labDraw(format: GPUTextureFormat, depthFormat: GPUTextureFormat, samples = 1): void {
    const d = this.device;
    const view = d.createBuffer({ label: 'arch lab view', size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const dl = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });
    const layout = d.createPipelineLayout({ bindGroupLayouts: [dl] });
    const dm = d.createShaderModule({ label: 'arch lab draw', code: LAB });
    const pipes = ARCH_DRAWS.map(([, vs]) =>
      d.createRenderPipeline({
        label: `arch ${vs}`,
        layout,
        vertex: { module: dm, entryPoint: vs },
        fragment: { module: dm, entryPoint: 'fsLab', targets: [{ format }] },
        // (cull off: the construction shader's clipped walls show their inside; the parts are closed shells)
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less' },
        multisample: { count: samples },
      }),
    );
    const group = d.createBindGroup({ layout: dl, entries: [view, this.arch].map((buffer, binding) => ({ binding, resource: { buffer } })) });
    this.lab = { pipes, group, view };
  }

  /** the lab's view: viewProj (column-major), towards the sun + strength, towards the eye + units a pixel, time/night/detail */
  setView(viewProj: Float32Array, sun: number[], eye: number[], time: number, night: number, detail: number): void {
    const f = new Float32Array(28);
    f.set(viewProj, 0);
    f.set(sun, 16);
    f.set(eye, 20);
    f.set([time, night, detail, 0], 24);
    this.device.queue.writeBuffer(this.lab!.view, 0, f);
  }

  drawLab(pass: GPURenderPassEncoder): void {
    const lab = this.lab!;
    pass.setBindGroup(0, lab.group);
    ARCH_DRAWS.forEach(([k], i) => {
      pass.setPipeline(lab.pipes[i]);
      pass.drawIndirect(this.args, k * 16);
    });
  }

  destroy(): void {
    for (const b of [this.arch, this.args, this.genU, this.compU, this.lab?.view]) b?.destroy();
  }
}
