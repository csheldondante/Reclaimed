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

import { urlFlags } from '../flags';
import archWgsl from './arch.wgsl?raw';
import drawWgsl from './draw.wgsl?raw';
import texbankWgsl from './texbank.wgsl?raw';
import labWgsl from './archlab.wgsl?raw';
import gameWgsl from './archgame.wgsl?raw';
import { STYLES, STYLE_VEC4S, styleWords, type Style } from './styles';
import { archTextures } from './textures';
import plantsJson from './plants.json';

/** the plant catalog for the generator (arch.wgsl plant()) */
const PL = plantsJson.plants;
const PLANT_WGSL = `const PLANT_N: u32 = ${PL.length}u;\nconst PLANT_CAT = array<u32, ${PL.length}>(${PL.map((p) => `${p.cat}u`).join(', ')});\nconst PLANT_H = array<f32, ${PL.length}>(${PL.map((p) => p.h.toFixed(2)).join(', ')});\nconst PLANT_CLS = array<u32, ${PL.length}>(${PL.map((p) => `${p.cls}u`).join(', ')});\n`;

/** mirrors arch.wgsl */
export const PART_WORDS = 16;
export const PARTS_PER_LOT = 96;
export const KIND = { body: 1, roof: 2, cren: 3, win: 4, cyl: 5, cone: 6, stair: 7, wheel: 8, bush: 9, plantS: 10, plantM: 11 } as const;
export const NK = 12;
/** vertices a kind's instance (draw.wgsl: the kinds' vertex stages; COURSES 12, ROUND_N 16, CONE_ROWS 10) */
const VERTS: Record<number, number> = {
  [KIND.body]: 30,
  [KIND.roof]: 4 * 12 * 12 + 6,
  [KIND.cren]: 4 * 9 * 30,
  [KIND.win]: 11 * 30,
  [KIND.cyl]: 16 * 6 + 16 * 3,
  [KIND.cone]: 16 * 10 * 12 + 16 * 3,
  [KIND.stair]: 16 * 30,
  [KIND.wheel]: (3 * 12 + 3) * 36,
  [KIND.bush]: 8 * 12,
  // (plants.json's classes: a mesh drawn with its class's count, the rest of its vertices gone)
  [KIND.plantS]: 1008,
  [KIND.plantM]: 1896,
};
/** each kind and its vertex stage (draw.wgsl) */
/** the lab's shadow map's side (texels) */
export const SHADOW_RES = 4096;

export const ARCH_DRAWS = [
  [KIND.body, 'vsArchBody'],
  [KIND.roof, 'vsArchRoof'],
  [KIND.cren, 'vsArchCren'],
  [KIND.win, 'vsArchWin'],
  [KIND.cyl, 'vsArchCyl'],
  [KIND.cone, 'vsArchCone'],
  [KIND.stair, 'vsArchStair'],
  [KIND.wheel, 'vsArchWheel'],
  [KIND.bush, 'vsArchBush'],
  [KIND.plantS, 'vsArchPlantS'],
  [KIND.plantM, 'vsArchPlantM'],
] as const;
const STYLE_ROOM = 64;

const GEN_MARK = '// ---- generation';
const COMPACT_MARK = '// ---- compaction';
const FS_MARK = '// ---- fragment';
/** arch.wgsl's constants and helpers: every module's head */
/** (?archnan=1) a vertex whose position came out not finite drawn magenta (the phone drew such triangles stretched) */
const NAN_DBG = urlFlags().get('archnan') === '1';
export const ARCH_CONSTS = archWgsl.slice(0, archWgsl.indexOf(GEN_MARK)) + PLANT_WGSL + `const ARCH_NANDBG: bool = ${NAN_DBG};\n`;
const GEN = ARCH_CONSTS + archWgsl.slice(archWgsl.indexOf(GEN_MARK), archWgsl.indexOf(COMPACT_MARK));
const COMPACT = ARCH_CONSTS + archWgsl.slice(archWgsl.indexOf(COMPACT_MARK));
/** the vertex stages and archSurface: a host's bindings and functions before, its fragment stage after */
export const ARCH_DRAW = drawWgsl;
const LAB = texbankWgsl + ARCH_CONSTS + labWgsl.slice(0, labWgsl.indexOf(FS_MARK)) + drawWgsl + labWgsl.slice(labWgsl.indexOf(FS_MARK));
/** the game's part of the renderer's draw module (after renderWgsl): vertex stages ARCH_DRAWS, fragment fsArch.
 *  detail: 0 the phone's flat colours … 1 the PC's patterns */
export const archGameWgsl = (detail: number): string =>
  `const ARCH_DETAIL: f32 = ${detail.toFixed(2)};\n` + ARCH_CONSTS + gameWgsl.slice(0, gameWgsl.indexOf(FS_MARK)) + drawWgsl + gameWgsl.slice(gameWgsl.indexOf(FS_MARK));

export interface ArchGenOpts {
  /** the lot slots (citygen's lot room) */
  lots: number;
  /** (lab) write each parcel as a ground body; its bottom z */
  ground?: { zmin: number };
  /** (gridlab) the chunks gridLab may show at once */
  gridChunks?: number;
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
  /** (word offsets in `arch`; public for ?archdump's test-only read) */
  readonly base: { styles: number; list: number; parts: number; progress: number };
  private genU: GPUBuffer;
  private compU: GPUBuffer;
  /** the generator's passes, one a family of lots (arch.wgsl genHouses …: a pipeline each, small enough for a phone) */
  private genPipes: GPUComputePipeline[];
  private resetPipe: GPUComputePipeline;
  private compactPipe: GPUComputePipeline;
  private genGroup: GPUBindGroup;
  private tg: GPUBuffer;
  /** (gridlab) the grid's cells: word 0 the count, then 10 words a cell (corners, its lot, how it sits on the lots) */
  readonly gridCells: GPUBuffer;
  private tgSlots: number;
  private tgPipes: GPUComputePipeline[];
  /** the grid's relaxation steps a chunk (?relax=N; 0 the lattice as nudged) */
  relaxSteps = Number(urlFlags().get('relax') ?? 20);
  private compactGroup: GPUBindGroup;
  private lab?: { pipes: GPURenderPipeline[]; group: GPUBindGroup; view: GPUBuffer; shadowPipes: GPURenderPipeline[]; shadowGroup: GPUBindGroup; shadowView: GPUBuffer; shadowMap: GPUTexture };
  nstyles = STYLES.length;
  /** a style for every lot, or -1 the district's */
  style = -1;
  /** (lab) the built windows drawn (off: the phone's look, the painted ones) */
  windows = true;

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
    this.arch = d.createBuffer({ label: 'arch', size: this.bytes, usage: S | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    d.queue.writeBuffer(this.arch, 0, new Uint32Array([styles, list, parts, this.room, progress, o.lots, ground, 0]));
    // (built until a progress is copied in: the lab's)
    d.queue.writeBuffer(this.arch, progress * 4, new Float32Array(o.lots).fill(1));
    this.setStyles(STYLES);
    this.args = d.createBuffer({ label: 'arch draw args', size: NK * 16, usage: S | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    const a = new Uint32Array(NK * 4);
    for (const [k] of ARCH_DRAWS) a[k * 4] = VERTS[k];
    d.queue.writeBuffer(this.args, 0, a);
    this.genU = d.createBuffer({ label: 'arch gen', size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.compU = d.createBuffer({ label: 'arch compact', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(this.compU, 0, new Uint32Array([this.slots, 0, 0, 0]));

    const gm = d.createShaderModule({ label: 'arch gen', code: GEN });
    const cm = d.createShaderModule({ label: 'arch compact', code: COMPACT });
    const gl = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const gpl = d.createPipelineLayout({ bindGroupLayouts: [gl] });
    // the grid's chunks (arch.wgsl tgRegister, tgRelax): a table sized by the lots (a lot asks for 1–4 chunks of ~43 m,
    // neighbours share them), so no cap tied to the town's area; 384 vertices a chunk
    let slots = 64;
    while (slots < o.lots) slots *= 2;
    this.tgSlots = slots;
    this.tg = d.createBuffer({ label: 'arch grid chunks', size: (8 + slots + slots * 384 * 2 + slots * 1176 * 2) * 4, usage: S | GPUBufferUsage.COPY_DST });
    // (gridlab) the grid's cells out: room for o.gridChunks chunks (a chunk ~300 cells)
    this.gridCells = d.createBuffer({ label: 'arch grid cells', size: (4 + Math.max(1, (o.gridChunks ?? 0) * 320) * 10) * 4, usage: S | GPUBufferUsage.COPY_DST });
    this.tgPipes = ['tgRegisterLots', 'tgRelax', 'tgRegisterArea', 'tgEmit'].map((entryPoint) => d.createComputePipeline({ label: `arch ${entryPoint}`, layout: gpl, compute: { module: gm, entryPoint } }));
    this.genPipes = ['genHouses', 'genKeeps', 'genShanties', 'genGrid'].map((entryPoint) => d.createComputePipeline({ label: `arch ${entryPoint}`, layout: gpl, compute: { module: gm, entryPoint } }));
    this.genGroup = d.createBindGroup({
      layout: gl,
      entries: [this.genU, records, counts, this.arch, this.tg, this.gridCells].map((buffer, binding) => ({ binding, resource: { buffer } })),
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
    // (the header's word 7: the plant meshes there are — arch.wgsl plant(); 0 until the local Synty conversion loads)
    this.device.queue.writeBuffer(this.arch, 28, new Uint32Array([archTextures(this.device).plantCount]));
    const u = new ArrayBuffer(48);
    const w = new Uint32Array(u);
    const f = new Float32Array(u);
    w[0] = first;
    w[1] = count;
    w[2] = this.style < 0 ? 0xffffffff : this.style;
    w[3] = this.o.ground ? 1 : 0;
    f[4] = this.o.ground?.zmin ?? 0;
    w[5] = this.nstyles;
    w[6] = this.o.lots;
    w[7] = this.tgSlots;
    w[8] = this.relaxSteps;
    w[9] = Number(urlFlags().get('gridview') ?? 0);
    // (one uniform: one generate a submit — a caller slicing a town's lots goes frame by frame)
    this.device.queue.writeBuffer(this.genU, 0, u);
    // the grid's chunks, on a whole town's run: the ones the lots ask for, each relaxed by a workgroup
    if (first === 0) {
      enc.clearBuffer(this.tg);
      const g = enc.beginComputePass({ label: 'arch grid chunks' });
      g.setBindGroup(0, this.genGroup);
      g.setPipeline(this.tgPipes[0]);
      g.dispatchWorkgroups(Math.ceil(count / 64));
      g.setPipeline(this.tgPipes[1]);
      g.dispatchWorkgroups(this.tgSlots);
      g.end();
    }
    const p = enc.beginComputePass({ label: 'arch gen', timestampWrites: ts });
    p.setBindGroup(0, this.genGroup);
    for (const pipe of this.genPipes) {
      p.setPipeline(pipe);
      p.dispatchWorkgroups(Math.ceil(count / 64));
    }
    p.end();
  }

  /** (gridlab) the grid alone, lots aside: the chunks [x0, x0 + w) × [y0, y0 + h) relaxed (with a ring round them for
   *  their vertices' owners) and their cells written to gridCells */
  gridLab(enc: GPUCommandEncoder, x0: number, y0: number, w: number, h: number, ts?: GPUComputePassTimestampWrites): void {
    const u = new Uint32Array(12);
    u[6] = this.o.lots;
    u[7] = this.tgSlots;
    u[8] = this.relaxSteps;
    u[10] = ((x0 + 2048) & 0xffff) | (((y0 + 2048) & 0xffff) << 16);
    u[11] = w | (h << 16);
    this.device.queue.writeBuffer(this.genU, 0, u);
    enc.clearBuffer(this.tg);
    enc.clearBuffer(this.gridCells, 0, 16);
    const g = enc.beginComputePass({ label: 'arch grid lab', timestampWrites: ts });
    g.setBindGroup(0, this.genGroup);
    g.setPipeline(this.tgPipes[2]);
    g.dispatchWorkgroups(Math.ceil(((w + 2) * (h + 2)) / 64));
    g.setPipeline(this.tgPipes[1]);
    g.dispatchWorkgroups(this.tgSlots);
    g.setPipeline(this.tgPipes[3]);
    g.dispatchWorkgroups(w * h);
    g.end();
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
    const view = d.createBuffer({ label: 'arch lab view', size: 176, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // the sun's shadow map: the same draws from the sun (their view's viewProj the sun's), every lab draw casting
    const shadowView = d.createBuffer({ label: 'arch lab sun view', size: 176, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const shadowMap = d.createTexture({ label: 'arch lab shadow map', size: [SHADOW_RES, SHADOW_RES], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    // (the shadow pass binds a stand-in: a pass cannot sample the map it writes)
    const noShadow = d.createTexture({ size: [1, 1], format: 'depth32float', usage: GPUTextureUsage.TEXTURE_BINDING });
    const cmp = d.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' });
    const dl = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
      ],
    });
    // (group 1: the material textures, shared by the device's draws — textures.ts)
    const layout = d.createPipelineLayout({ bindGroupLayouts: [dl, archTextures(d).layout] });
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
    const shadowPipes = ARCH_DRAWS.map(([, vs]) =>
      d.createRenderPipeline({
        label: 'arch shadow ' + vs,
        layout,
        vertex: { module: dm, entryPoint: vs },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2.5 },
      }),
    );
    const groupOf = (v: GPUBuffer, map: GPUTexture) =>
      d.createBindGroup({
        layout: dl,
        entries: [
          { binding: 0, resource: { buffer: v } },
          { binding: 1, resource: { buffer: this.arch } },
          { binding: 2, resource: map.createView() },
          { binding: 3, resource: cmp },
        ],
      });
    this.lab = { pipes, group: groupOf(view, shadowMap), view, shadowPipes, shadowGroup: groupOf(shadowView, noShadow), shadowView, shadowMap };
  }

  /** the lab's view: viewProj (column-major), towards the sun + strength, towards the eye + units a pixel, time/night/detail */
  setView(viewProj: Float32Array, sun: number[], eye: number[], time: number, night: number, detail: number, oldLight = 0, sunVP?: Float32Array): void {
    const f = new Float32Array(44);
    f.set(viewProj, 0);
    f.set(sun, 16);
    f.set(eye, 20);
    f.set([time, night, detail, oldLight], 24);
    // (no sun's view: the map never drawn, every point lit — a zero matrix's clip w is 0, see shadowAt)
    if (sunVP) f.set(sunVP, 28);
    this.device.queue.writeBuffer(this.lab!.view, 0, f);
    if (sunVP) {
      const g = f.slice();
      g.set(sunVP, 0);
      this.device.queue.writeBuffer(this.lab!.shadowView, 0, g);
    }
  }

  /** the sun's shadow map, drawn from the sun's view (setView's sunVP) */
  drawLabShadow(e: GPUCommandEncoder): void {
    const lab = this.lab!;
    const pass = e.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: lab.shadowMap.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } });
    pass.setBindGroup(0, lab.shadowGroup);
    pass.setBindGroup(1, archTextures(this.device).group);
    ARCH_DRAWS.forEach(([k], i) => {
      if (k === KIND.win) return;
      pass.setPipeline(lab.shadowPipes[i]);
      pass.drawIndirect(this.args, k * 16);
    });
    pass.end();
  }

  drawLab(pass: GPURenderPassEncoder): void {
    const lab = this.lab!;
    pass.setBindGroup(0, lab.group);
    pass.setBindGroup(1, archTextures(this.device).group);
    ARCH_DRAWS.forEach(([k], i) => {
      if (k === KIND.win && !this.windows) return;
      pass.setPipeline(lab.pipes[i]);
      pass.drawIndirect(this.args, k * 16);
    });
  }

  destroy(): void {
    for (const b of [this.arch, this.args, this.genU, this.compU, this.tg, this.lab?.view, this.lab?.shadowView]) b?.destroy();
    this.lab?.shadowMap.destroy();
  }
}
