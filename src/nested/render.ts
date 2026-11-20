// Nested scales lab: the draw (gpu/draw.wgsl). Every level draws its columns as boxes: one indirect, instanced draw a
// level over the face pages the GPU baked when the columns changed (nest.wgsl faceBake; the arguments and the page list
// are the nest's). A frame runs no compute here: it only draws. Finest first, composed by depth (reverse Z, each level's
// view-projection in its own units). A second target carries per-pixel info for the measurements.
import storeWgsl from './gpu/store.wgsl?raw';
import drawWgsl from './gpu/draw.wgsl?raw';
import detailWgsl from './gpu/detail.wgsl?raw';
import shadeWgsl from './gpu/shade.wgsl?raw';
import fieldDrawWgsl from './gpu/fielddraw.wgsl?raw';
import texWgsl from './gpu/tex.wgsl?raw';
import texDrawWgsl from './gpu/texdraw.wgsl?raw';
import cliffRuleWgsl from './gpu/cliffrule.wgsl?raw';
import cliff4Wgsl from './gpu/cliff4.wgsl?raw';
import { MAX_LEVELS, SEG_BASE, TCAP, TPP, segWgsl, type GpuNest } from './gpu/nest';
import { TexGen, TEX_TILE_M } from './texgen';
import { CLIFF_AMP_B2, CliffBox } from './cliffbox';

/** the draw module's source (the page and the compile gate): the pages' segments, the store, (round 20) the detail
 *  bands and the textured shading, then the draws; (round 27) the tiling textures and their entry points (?tex=2) */
export function drawModuleCode(S: number, segP: number): string {
  return `const TCAP: u32 = ${TCAP}u;\n${segWgsl(S, segP, true)}\n${storeWgsl}\n${detailWgsl}\n${shadeWgsl}\n${drawWgsl}\n${texWgsl}\n${texDrawWgsl}`;
}
/** (round 32 step B1, ?cliff=4) the module variant with the cliff rule (gpu/cliffrule.wgsl) painted on the textured
 *  sheets (gpu/cliff4.wgsl fsST4): the draw module plus those two files, so the default module's source is unchanged.
 *  lv: the depth of the 16 m level; upl: 1/64 m units per local unit of it */
export function cliffRuleCode(S: number, segP: number, lv: number, upl: number, ampL: number[] = CLIFF_AMP_DEFAULT, tail = cliff4Wgsl): string {
  return `${drawModuleCode(S, segP)}\n${cliffRulePrefix(lv, upl, ampL)}\n${cliffRuleWgsl}\n${tail}`;
}
/** step A's default per-level amplitudes (cliffrule.ts defaultParams().ampL) */
export const CLIFF_AMP_DEFAULT = [0, 256, 256, 256, 24, 16, 8];
/** (step B2) the constants every cliff rule module is given: the 16 m level, units a local unit, the amplitudes */
export function cliffRulePrefix(lv: number, upl: number, ampL: number[]): string {
  if (ampL.length !== 7 || ampL.some((v) => !Number.isInteger(v) || v < 0 || v > 256)) throw new Error(`the cliff amplitudes need 7 integers 0..256: ${ampL.join(',')}`);
  return `const CR_LV: u32 = ${lv}u;\nconst CR_UPL: f32 = ${upl.toFixed(1)};\nconst CR_AMPL = array<i32, 7>(${ampL.join(', ')});`;
}
/** the depth of the 16 m level (the rule's coarse cells) for root columns of mpu metres and k children an axis */
export function cliffRuleLevel(mpu: number, k: number): number {
  const lv = Math.round(Math.log2(mpu / 16) / Math.log2(k));
  if (lv < 0 || mpu / k ** lv !== 16) throw new Error(`?cliff=4 needs a 16 m level (root ${mpu} m, k ${k}): the cliff rule's cells are 16 m`);
  return lv;
}
/** (round 27) the draw layouts' texture entries (?tex=2: tex.wgsl bindings 6-8, the fragment stage) */
function texEntries(): GPUBindGroupLayoutEntry[] {
  const F = GPUShaderStage.FRAGMENT;
  return [
    { binding: 6, visibility: F, texture: { sampleType: 'float', viewDimension: '2d-array' } },
    { binding: 7, visibility: F, texture: { sampleType: 'float', viewDimension: '2d-array' } },
    { binding: 8, visibility: F, sampler: { type: 'filtering' } },
  ];
}

const DU = 256;
const DU_SIZE = 224;
/** a grid's model matrix: one root grid at the world origin today (identity); another grid would carry its rigid frame */
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** (round 20) the sky: a full-screen triangle at depth 0 (reverse Z's clear value), drawn after the levels where the depth
 *  is still 0; the info target untouched (write mask 0) */
export function skyDesc(layout: GPUPipelineLayout | 'auto', module: GPUShaderModule, format: GPUTextureFormat): GPURenderPipelineDescriptor {
  return {
    label: 'nest draw sky',
    layout,
    vertex: { module, entryPoint: 'vsSky' },
    fragment: { module, entryPoint: 'fsSky', targets: [{ format }, { format: 'rgba8unorm', writeMask: 0 }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'equal' },
  };
}

/** (round 26) the field mesh's draw: vsField and a fragment entry (fsField flat, fsFieldT textured) */
export function fieldDesc(layout: GPUPipelineLayout | 'auto', module: GPUShaderModule, format: GPUTextureFormat, fs: string, constants: Record<string, number> = {}): GPURenderPipelineDescriptor {
  return {
    label: `nest draw field (${fs})`,
    layout,
    vertex: { module, entryPoint: 'vsField' },
    fragment: { module, entryPoint: fs, constants, targets: [{ format }, { format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
  };
}
/** (round 26) the field draw's module source: the draw module and fielddraw.wgsl */
export function fieldDrawCode(S: number, segP: number): string {
  return `${drawModuleCode(S, segP)}\n${fieldDrawWgsl}`;
}

export interface DrawLevel {
  depth: number;
  /** (metrics) the distance from the eye, in this level's units, within which its child is wanted (0: none) */
  want: number;
}

export class Renderer {
  private pipe!: GPURenderPipeline;
  /** (round 19) the box draw's pipeline made */
  readonly ready: Promise<void>;
  private layout: GPUBindGroupLayout;
  private module: GPUShaderModule;
  private ubuf: GPUBuffer;
  private bg: GPUBindGroup | null = null;
  private bgFor: GPUBuffer[] = [];
  private depth: GPUTexture | null = null;
  info: GPUTexture | null = null;
  readonly format: GPUTextureFormat;
  tint = false;
  /** (diagnostics) 0 off, 1 colour by triangle parity, 2 by face kind */
  diag = 0;
  /** (round 14) the smooth draw's crease angle, degrees: shaded flat where vertex and face normals differ by more */
  crease = 50;

  constructor(
    private device: GPUDevice,
    private ctx: GPUCanvasContext,
    private nest: GpuNest,
  ) {
    this.format = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format: this.format, alphaMode: 'opaque', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    // (compute too: the watertight check's capture runs the vertex code in a compute pass)
    const V = GPUShaderStage.VERTEX | GPUShaderStage.COMPUTE;
    const ro = { type: 'read-only-storage' as const };
    // (round 27: the table and the pages in the fragment stage too: ?tex=2's border mix looks up the neighbouring
    // columns per pixel; 1 + S storage buffers there)
    const VF = V | GPUShaderStage.FRAGMENT;
    this.layout = device.createBindGroupLayout({
      label: 'nest draw',
      entries: [
        { binding: 0, visibility: VF, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: DU_SIZE } },
        ...[3, 4, 5].map((binding) => ({ binding, visibility: V, buffer: ro })),
        ...[1, ...Array.from({ length: nest.S }, (_, j) => SEG_BASE + j)].map((binding) => ({ binding, visibility: VF, buffer: ro })),
        ...texEntries(),
      ],
    });
    this.texgen = new TexGen(device);
    this.module = device.createShaderModule({ label: 'nest draw', code: drawModuleCode(nest.S, nest.segP) });
    this.pl = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    // (round 19, NS-141: asynchronous; the app draws once `ready` resolves)
    this.ready = device.createRenderPipelineAsync(this.boxDesc()).then((p) => {
      this.pipe = p;
    });
    this.ubuf = device.createBuffer({ label: 'nest draw uniforms', size: DU * MAX_LEVELS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }
  private pl!: GPUPipelineLayout;
  /** the smooth draw's pipeline (round 16: the sheets), made when it is first switched on */
  private smoothPipe: { sheet: GPURenderPipeline } | null = null;
  private sheetDesc(): GPURenderPipelineDescriptor {
    // (round 16) the owner's sheets: one draw a level, an instance a sheet of a chunk (nest.wgsl dirBuild)
    return {
      label: 'nest draw sheets',
      layout: this.pl,
      vertex: { module: this.module, entryPoint: 'vsSheet' },
      fragment: { module: this.module, entryPoint: 'fsS', targets: [{ format: this.format }, { format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
    };
  }
  private smoothPipes(): { sheet: GPURenderPipeline } {
    if (!this.smoothPipe) this.smoothPipe = { sheet: this.device.createRenderPipeline(this.sheetDesc()) };
    return this.smoothPipe;
  }
  private sheetCompile: Promise<void> | null = null;
  /** (round 18) the sheet draw's pipeline creation time (asynchronous; boxes drawn meanwhile) */
  compileMs = 0;
  /** (round 18) whether the sheet draw's pipeline is ready; starts its asynchronous creation when not */
  prepareSheets(): boolean {
    if (this.smoothPipe) return true;
    if (!this.sheetCompile) {
      const t0 = performance.now();
      this.sheetCompile = this.device.createRenderPipelineAsync(this.sheetDesc()).then((sheet) => {
        this.smoothPipe ??= { sheet };
        this.compileMs = performance.now() - t0;
      });
    }
    return false;
  }

  /** (round 20) the textured draw wanted (?tex=1, default; the "Textured" button). Drawn once its pipelines are made;
   *  the flat draw meanwhile */
  tex = true;
  /** (round 22) ?slide=0|1, the "Round edges" button: the sheets' vertices slide sideways onto the edge samples' lines
   *  (round 25: off by default) */
  slide = false;
  /** (round 20) ?bands=split: only the bands finer than 2 columns of the drawn level; else every band (the default) */
  bandsSplit = false;
  /** (round 20) ?texbands=N: the textured draw's band window (N + 1 band noises a pixel at most); 0 its default (6) */
  texBands = 0;
  /** (round 21) ?canopy=0|1: soil seen from afar shaded as forest canopy (default on) */
  canopy = true;
  /** (round 21) ?canopyfade=: the canopy's crossover footprint, world units a pixel (canopy over twice it, grass under
   *  half: with 2-unit crown cells, 0.1 puts the crossover at cells of 10-40 pixels) */
  canopyFade = 0.1;
  /** (round 25) metres a world unit (a root column: 128 with the generator, 3.2 the toy root) */
  mpu = 3.2;
  /** (round 25) ?fog=: the fog's distance, metres (full at about it); 0: round 21's haze (the toy root) */
  fogM = 0;
  /** (round 25) the textured shading's scale: its bands and materials in world units / 2^shadeS */
  shadeS = 0;
  /** (round 31, look experiment) ?cliff=1: steep ground in the textured draw shaded as stacked faceted blocks (shade.wgsl
   *  shCliff); ?cliffT= the slope, rise over run, past which it fades in (default 2) */
  cliff = false;
  cliffT = 2;
  /** ?cliffW= a block's width in metres (rounded to a power of two of the shading unit); 0: one column of the drawn level */
  cliffW = 0;
  /** ?cliffcut=1 at load: the textured pipelines made with the skyline cut compiled in (draw.wgsl CLIFF_CUT); then
   *  `cliffCut` turns the cut on and off at run time (on by default when compiled in) */
  cliffCutBuilt = false;
  cliffCut = false;
  /** (round 31) which look: 1 the shaded blocks (shCliff), 2 the ray-marched columns (shCol, ?cliff=2), 3 the nested
   *  columns (shCol3, ?cliff=3: only when the pipelines were made with it, cliffV3Built) */
  cliffV: 1 | 2 | 3 = 1;
  /** (version 3) ?cliff=3 at load: the textured pipelines made with version 3 compiled in (draw.wgsl CLIFF_V3) */
  cliffV3Built = false;
  /** (version 3, diagnostics) ?cliffDbg=N at load: the diagnostic colours compiled in (draw.wgsl CLIFF_DBG); cliffDbg the
   *  mode at run time (shade.wgsl shCol3: 1 finest level, 2 hit level, 3 hit kind, 4 level-0 top, 5 lighting only) */
  cliffDbgBuilt = false;
  cliffDbg = 0;
  /** (version 3) ?cliffDropF= the hashed drop's growth per level (level l: cliffDrop + cliffDropF x l of its own cells) */
  cliffDropF = 0;
  /** (version 3) ?cliffHN= horizontal noise: children split at 0.5 +- 0.2 x HN of their parent's width (0 off) */
  cliffHN = 0;
  /** (version 3) ?cliffSink= percent of fine columns (levels 1+) dropped 4 of their own cells deeper (0 off) */
  cliffSink = 0;
  /** (version 3) ?cliffPatch= the fine detail's mask along the wall, period in level-0 cells (default 4; 0 off) */
  cliffPatch = 4;
  /** (version 3) ?cliffGap= percent of segments below a fine column's top that are notches into the face (0 off) */
  cliffGap = 0;
  /** (version 3) ?cliffGapD= a notch's depth at most, fine cells (default 4) */
  cliffGapD = 4;
  /** (version 3) ?cliffPx= the finest level's cells at least, pixels (by distance; default 6) */
  cliffPx = 6;
  /** (version 3) a pixel's size per unit of distance from the eye (set by the app each frame from the field of view) */
  pxAng = 0.001;
  /** (version 2) ?cliffN= the march's cells at most (default 4, 1-15) */
  cliffN = 4;
  /** (version 2) ?cliffSmooth=1: neighbouring columns whose tops differ by at most cliffT cells joined by a smooth sheet */
  cliffSmooth = false;
  /** (version 2) ?cliffDrop= a column's hashed drop below the plane at most, cells (default 1, 0-15) */
  cliffDrop = 1;
  /** the fragment constants of the textured pipelines */
  private texConsts(): Record<string, number> {
    const c: Record<string, number> = {};
    if (this.cliffCutBuilt) c.CLIFF_CUT = 1;
    if (this.cliffV3Built) c.CLIFF_V3 = 1;
    if (this.cliffDbgBuilt) c.CLIFF_DBG = 1;
    return c;
  }
  /** (round 32 step B1) ?cliff=4 at load: the textured sheets' variant with the cliff rule made beside the default one
   *  (cliffRuleCode); `cliffRuleOn` picks it per frame (on by default when built) */
  cliffRuleBuilt = false;
  cliffRuleOn = false;
  /** the variant's pipeline creation time, ms (made in parallel with the default textured pipelines) */
  cliffRuleCompileMs = 0;
  private cliffRuleLv = 1;
  /** (round 32 step B2) ?cliff=5 at load: the cliff rule drawn (cliffbox.ts); `cliffBoxOn` switches it per frame */
  cliffBoxBuilt = false;
  cliffBoxOn = false;
  /** ?cliffAmp= the per-level amplitudes (7 integers /256; default amp8half) */
  cliffAmp = CLIFF_AMP_B2;
  cliffBox: CliffBox | null = null;
  /** (step B2) ?cliffStrata=0|1: strata on the column faces (default on; a uniform, switchable at run time) */
  cliffStrata = true;
  /** (step B2) ?cliffT= the steep threshold for ?cliff=5, cell widths (default 2; the table is rebuilt on a change) */
  cliffBoxT = 2;
  private texPipes: { box: GPURenderPipeline; sheet: GPURenderPipeline; sky: GPURenderPipeline; sheet4?: GPURenderPipeline } | null = null;
  private texCompile: Promise<void> | null = null;
  /** (round 20) the textured pipelines' creation time, ms (asynchronous, after the first frame) */
  texCompileMs = 0;
  private texAt = 0;
  /** whether the textured pipelines are made; starts their asynchronous creation when not */
  prepareTex(): boolean {
    if (this.texPipes) return true;
    if (!this.texCompile) {
      const t0 = (this.texAt = performance.now());
      const constants = this.texConsts();
      const box: GPURenderPipelineDescriptor = { ...this.boxDesc(), label: 'nest draw boxes (textured)', fragment: { module: this.module, entryPoint: 'fsT', constants, targets: [{ format: this.format }, { format: 'rgba8unorm' }] } };
      const sd = this.sheetDesc();
      const sheet: GPURenderPipelineDescriptor = { ...sd, label: 'nest draw sheets (textured)', fragment: { module: this.module, entryPoint: 'fsST', constants, targets: [{ format: this.format }, { format: 'rgba8unorm' }] } };
      let p4: Promise<GPURenderPipeline | undefined> = Promise.resolve(undefined);
      // (step B2, ?cliff=5: the table, the box list and the variant's pipelines, made beside these; drawn once ready)
      if (this.cliffBoxBuilt && !this.cliffBox) {
        this.cliffRuleLv = cliffRuleLevel(this.mpu, this.nest.k);
        this.cliffBox = new CliffBox(this.device, this.nest, this.cliffRuleLv, (64 * this.mpu) / this.nest.k ** this.cliffRuleLv, this.cliffAmp, this.layout, sd, this.format, { buffer: this.ubuf, size: DU_SIZE });
      }
      if (this.cliffRuleBuilt) {
        this.cliffRuleLv = cliffRuleLevel(this.mpu, this.nest.k);
        const m4 = this.device.createShaderModule({ label: 'nest draw (cliff rule)', code: cliffRuleCode(this.nest.S, this.nest.segP, this.cliffRuleLv, (64 * this.mpu) / this.nest.k ** this.cliffRuleLv) });
        p4 = this.device.createRenderPipelineAsync({ ...sd, label: 'nest draw sheets (cliff rule)', fragment: { module: m4, entryPoint: 'fsST4', targets: [{ format: this.format }, { format: 'rgba8unorm' }] } }).then((p) => {
          this.cliffRuleCompileMs = performance.now() - t0;
          return p;
        });
      }
      this.texCompile = Promise.all([this.device.createRenderPipelineAsync(box), this.device.createRenderPipelineAsync(sheet), this.device.createRenderPipelineAsync(skyDesc(this.pl, this.module, this.format)), p4]).then(([b, s, k, s4]) => {
        this.texPipes = { box: b, sheet: s, sky: k, sheet4: s4 };
        this.texCompileMs = performance.now() - t0;
      });
    }
    return false;
  }
  /** the HUD's line while the textured draw is wanted and not yet made */
  get texText(): string {
    if (this.tex && this.tex2 && this.texPipes && !this.texDrawn2) return `textured 2: ${this.texgen.ready ? 'compiling its draws' : `making the material textures, ${this.texgen.done} of 5`}; the function textures until then`;
    if (!this.tex || this.texPipes || !this.texCompile) return '';
    return `textured: compiling the textured draws (${(performance.now() - this.texAt).toFixed(0)} ms so far); flat until then`;
  }
  /** whether this frame draws textured */
  get texDrawn(): boolean {
    return this.tex && !!this.texPipes;
  }
  // ---- (round 27) ?tex=2: the tiling textures (texgen.ts, tex.wgsl) ----------------------------------------------------
  /** the material textures (made at once, generated a layer a frame after every boot pipeline: App.frame) */
  readonly texgen: TexGen;
  /** the textured draw with the tiling textures instead of the function stack (?tex=2; `tex` must be on too) */
  tex2 = false;
  private tex2Pipes: { box: GPURenderPipeline; sheet: GPURenderPipeline } | null = null;
  private tex2Compile: Promise<void> | null = null;
  /** the ?tex=2 draws' creation time, ms (asynchronous, when first wanted) */
  tex2CompileMs = 0;
  /** whether the ?tex=2 pipelines are made; starts their asynchronous creation when not */
  prepareTex2(): boolean {
    if (this.tex2Pipes) return true;
    if (!this.tex2Compile) {
      const t0 = performance.now();
      const box: GPURenderPipelineDescriptor = { ...this.boxDesc(), label: 'nest draw boxes (tex=2)', fragment: { module: this.module, entryPoint: 'fsT2', targets: [{ format: this.format }, { format: 'rgba8unorm' }] } };
      const sheet: GPURenderPipelineDescriptor = { ...this.sheetDesc(), label: 'nest draw sheets (tex=2)', fragment: { module: this.module, entryPoint: 'fsST2', targets: [{ format: this.format }, { format: 'rgba8unorm' }] } };
      this.tex2Compile = Promise.all([this.device.createRenderPipelineAsync(box), this.device.createRenderPipelineAsync(sheet)]).then(([b, s]) => {
        this.tex2Pipes = { box: b, sheet: s };
        this.tex2CompileMs = performance.now() - t0;
      });
    }
    return false;
  }
  /** whether this frame draws ?tex=2 (its pipelines and the textures ready; ?tex=1 until then) */
  get texDrawn2(): boolean {
    return this.texDrawn && this.tex2 && !!this.tex2Pipes && this.texgen.ready && (!this.field || !!this.field.tex2);
  }
  private boxDesc(): GPURenderPipelineDescriptor {
    return {
      label: 'nest draw boxes',
      layout: this.pl,
      vertex: { module: this.module, entryPoint: 'vs' },
      fragment: { module: this.module, entryPoint: 'fs', targets: [{ format: this.format }, { format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
    };
  }

  private targets(w: number, h: number): void {
    if (this.depth && this.depth.width === w && this.depth.height === h) return;
    this.depth?.destroy();
    this.info?.destroy();
    this.depth = this.device.createTexture({ size: [w, h], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.info = this.device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  }
  private texBinds(): GPUBindGroupEntry[] {
    return [
      { binding: 6, resource: this.texgen.viewA },
      { binding: 7, resource: this.texgen.viewN },
      { binding: 8, resource: this.texgen.sampler },
    ];
  }
  private bind(): void {
    const segs = this.nest.segBuffers();
    const want = [this.nest.dir, ...segs];
    if (want.length === this.bgFor.length && want.every((b, i) => b === this.bgFor[i])) return;
    this.bg = this.device.createBindGroup({
      label: 'nest draw',
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.ubuf, size: DU_SIZE } },
        { binding: 1, resource: { buffer: this.nest.tab } },
        { binding: 3, resource: { buffer: this.nest.cam } },
        { binding: 4, resource: { buffer: this.nest.reg } },
        { binding: 5, resource: { buffer: this.nest.dir } },
        ...segs.map((buffer, j) => ({ binding: SEG_BASE + j, resource: { buffer } })),
        ...this.texBinds(),
      ],
    });
    this.bgFor = want;
  }

  // ---- (round 26) the field mesh's draw (?field=): its own module, layout (the pages read in the fragment stage too: the
  // material per pixel) and pipelines, made only when a level is drawn by it --------------------------------------------
  private field: { layout: GPUBindGroupLayout; pl: GPUPipelineLayout; module: GPUShaderModule; ubuf: GPUBuffer; flat?: GPURenderPipeline; tex?: GPURenderPipeline; tex2?: GPURenderPipeline; ready: Promise<void> } | null = null;
  private fieldBg: GPUBindGroup | null = null;
  private fieldBgFor: GPUBuffer[] = [];
  /** (round 26) the field draw's dials: the lookup's warp and the material's jitter (columns), the skirt (columns) */
  fieldOpt = { warp: 0.45, jitter: 0.35, skirt: 3, dbg: 0 };
  /** (round 26) the field draw's pipelines' creation time, ms */
  fieldCompileMs = 0;
  /** (round 26) start making the field draw (its pipelines asynchronously, both flat and textured) */
  enableField(): Promise<void> {
    if (this.field) return this.field.ready;
    const FV = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const ro = { type: 'read-only-storage' as const };
    const layout = this.device.createBindGroupLayout({
      label: 'nest field draw',
      entries: [
        { binding: 0, visibility: FV, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: DU_SIZE } },
        { binding: 2, visibility: FV, buffer: { type: 'uniform' } },
        ...[1, 3, 4, 5, ...Array.from({ length: this.nest.S }, (_, j) => SEG_BASE + j)].map((binding) => ({ binding, visibility: FV, buffer: ro })),
        ...texEntries(),
      ],
    });
    const pl = this.device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const module = this.device.createShaderModule({ label: 'nest field draw', code: fieldDrawCode(this.nest.S, this.nest.segP) });
    const ubuf = this.device.createBuffer({ label: 'nest field draw uniforms', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const t0 = performance.now();
    const f: NonNullable<Renderer['field']> = { layout, pl, module, ubuf, ready: Promise.resolve() };
    f.ready = Promise.all([this.device.createRenderPipelineAsync(fieldDesc(pl, module, this.format, 'fsField')), this.device.createRenderPipelineAsync(fieldDesc(pl, module, this.format, 'fsFieldT', this.texConsts()))]).then(([a, b]) => {
      f.flat = a;
      f.tex = b;
      this.fieldCompileMs = performance.now() - t0;
    });
    // (round 27, ?tex=2: made beside them, not waited for: the field draws ?tex=1 until it is made)
    void this.device.createRenderPipelineAsync(fieldDesc(pl, module, this.format, 'fsFieldT2')).then((p) => (f.tex2 = p));
    this.field = f;
    return f.ready;
  }
  get fieldReady(): boolean {
    return !this.field || !!this.field.tex;
  }
  private fieldBind(): GPUBindGroup {
    const f = this.field!;
    const segs = this.nest.segBuffers();
    const want = [this.nest.fieldDir!, ...segs];
    if (!this.fieldBg || want.length !== this.fieldBgFor.length || !want.every((b, i) => b === this.fieldBgFor[i])) {
      this.fieldBg = this.device.createBindGroup({
        label: 'nest field draw',
        layout: f.layout,
        entries: [
          { binding: 0, resource: { buffer: this.ubuf, size: DU_SIZE } },
          { binding: 1, resource: { buffer: this.nest.tab } },
          { binding: 2, resource: { buffer: f.ubuf } },
          { binding: 3, resource: { buffer: this.nest.cam } },
          { binding: 4, resource: { buffer: this.nest.reg } },
          { binding: 5, resource: { buffer: this.nest.fieldDir! } },
          ...segs.map((buffer, j) => ({ binding: SEG_BASE + j, resource: { buffer } })),
          ...this.texBinds(),
        ],
      });
      this.fieldBgFor = want;
    }
    const o = this.fieldOpt;
    this.device.queue.writeBuffer(f.ubuf, 0, new Float32Array([o.warp, o.jitter, o.skirt, 0, o.dbg, 0, 0, 0]));
    return this.fieldBg;
  }

  draw(levels: DrawLevel[]): GPUTexture {
    const tex = this.ctx.getCurrentTexture();
    this.targets(tex.width, tex.height);
    this.bind();
    const enc = this.device.createCommandEncoder({ label: 'nest draw' });
    // (round 32 step B2, ?cliff=5: the table rebuilt first when the 16 m window changed; nothing otherwise. Before the
    // uniforms: they carry the window the table was built for)
    const cb = this.cliffBox && this.cliffBoxOn && this.texDrawn && !this.texDrawn2 ? this.cliffBox : null;
    if (cb) cb.T = this.cliffBoxT;
    cb?.update(enc);
    const cbg = cb?.ready ? cb.groups() : null;
    this.uniforms(levels);
    // (round 28, measurement: ?gputime=1) a render pass a level and one for the sky, each timed and its fragments counted;
    // otherwise one pass. The passes after the first load what it drew, so the image is the same.
    const gt = this.gpuT;
    let pass: GPURenderPassEncoder | null = null;
    let np = 0;
    const labels: string[] = [];
    const begin = (label: string) => {
      if (pass && !gt) return pass;
      if (pass) {
        pass.endOcclusionQuery();
        pass.end();
      }
      const first = np === 0;
      const i = np++;
      labels.push(label);
      pass = enc.beginRenderPass({
        colorAttachments: [
          { view: tex.createView(), loadOp: first ? 'clear' : 'load', storeOp: 'store', clearValue: { r: 0.62, g: 0.71, b: 0.78, a: 1 } },
          { view: this.info!.createView(), loadOp: first ? 'clear' : 'load', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
        ],
        depthStencilAttachment: { view: this.depth!.createView(), depthLoadOp: first ? 'clear' : 'load', depthStoreOp: 'store', depthClearValue: 0 },
        ...(gt ? { timestampWrites: { querySet: gt.qs, beginningOfPassWriteIndex: 2 * i, endOfPassWriteIndex: 2 * i + 1 }, occlusionQuerySet: gt.occ } : {}),
      });
      if (gt) pass.beginOcclusionQuery(i);
      return pass;
    };
    // finest first: the depth test then spares the coarse levels' fragments under it
    const order = [...levels].sort((a, b) => b.depth - a.depth);
    const tp = this.texDrawn ? this.texPipes : null;
    // (round 27) ?tex=2: the tiling textures' pipelines (the sky stays tp's)
    const t2 = this.texDrawn2 ? this.tex2Pipes : null;
    // (round 26) a field level is drawn by the field mesh (its own pipeline and bind group), every other one as before
    const fl = this.nest.fieldMask ? order.filter((lv) => this.nest.fieldOn(lv.depth)) : [];
    if (fl.length && this.field?.tex) {
      const bg = this.fieldBind();
      for (const lv of fl) {
        const p = begin(`L${lv.depth} field`);
        p.setPipeline(t2 && this.field.tex2 ? this.field.tex2 : tp ? this.field.tex : this.field.flat!);
        p.setBindGroup(0, bg, [lv.depth * DU]);
        p.setIndexBuffer(this.fieldIndex(), 'uint32');
        p.drawIndexedIndirect(this.nest.fieldArgs!, lv.depth * 32);
      }
    }
    const rest = fl.length ? order.filter((lv) => !this.nest.fieldOn(lv.depth)) : order;
    if (this.nest.smooth) {
      // (round 16) per level the sheets
      const sp = this.smoothPipes();
      for (const lv of rest) {
        const p = begin(`L${lv.depth} sheets`);
        if (cb && cbg && tp) {
          p.setPipeline(cb.sheet);
          p.setBindGroup(1, cbg.sheet1);
        } else p.setPipeline(t2 ? t2.sheet : tp ? (this.cliffRuleOn && tp.sheet4 ? tp.sheet4 : tp.sheet) : sp.sheet);
        p.setBindGroup(0, this.bg!, [lv.depth * DU]);
        p.drawIndirect(this.nest.drawArgs, (MAX_LEVELS + lv.depth) * 16);
      }
      // (step B2) the SPLIT cells' boxes, marched inside, with the 16 m level's uniforms
      if (cb && cbg && tp && levels.some((l) => l.depth === cb.lv)) {
        // (B3, measurement only, ?gputime=1: the overdraw count pass between the sheets and the boxes)
        if (cb.counting && gt && pass) {
          const pp = pass as GPURenderPassEncoder;
          pp.endOcclusionQuery();
          pp.end();
          pass = null;
          cb.drawCount(enc, this.depth!, tex.width, tex.height, cbg, cb.lv * DU);
        }
        const p = begin('cliff boxes');
        const cp = cb.pipes();
        // (the boxes' own group 0: the uniform, the camera and the registry only; vertex stage 3 storage buffers)
        p.setBindGroup(0, cbg.box0, [cb.lv * DU]);
        p.setBindGroup(1, cbg.box1);
        // (B3) the solid parts below L first: plain faces whose depth is written early, then the marched boxes from L
        if (cp.low) {
          p.setPipeline(cp.low);
          p.drawIndirect(cb.args, 0);
        }
        p.setPipeline(cp.box);
        p.drawIndirect(cb.args, 0);
      }
    } else {
      for (const lv of rest) {
        const p = begin(`L${lv.depth} boxes`);
        p.setPipeline(t2 ? t2.box : tp ? tp.box : this.pipe);
        p.setBindGroup(0, this.bg!, [lv.depth * DU]);
        p.drawIndirect(this.nest.drawArgs, lv.depth * 16);
      }
    }
    // (round 20) the sky where nothing was drawn, with level 0's uniforms (its view-projection and eye)
    if (tp && levels.some((l) => l.depth === 0)) {
      const p = begin('sky');
      p.setPipeline(tp.sky);
      p.setBindGroup(0, this.bg!, [0]);
      p.draw(3);
    }
    const last = begin('end') as GPURenderPassEncoder;
    if (gt) {
      // ('end' is an empty pass: the last real one is closed by it)
      last.endOcclusionQuery();
      last.end();
      labels.pop();
      np--;
      this.gpuResolve(enc, np, labels, tex.width * tex.height);
    } else last.end();
    this.device.queue.submit([enc.finish()]);
    this.gpuRead();
    return tex;
  }
  /** (round 28) the field draw's indices, shared by every instance (a quad page): quad slot q's two triangles over its
   *  corners 4q..4q+3, so a corner runs the vertex stage once (fielddraw.wgsl vsField reads the slot and corner) */
  private fieldIdx: GPUBuffer | null = null;
  private fieldIndex(): GPUBuffer {
    if (!this.fieldIdx) {
      const Q = 783;
      const a = new Uint32Array(Q * 6);
      for (let q = 0; q < Q; q++) a.set([4 * q, 4 * q + 1, 4 * q + 2, 4 * q, 4 * q + 2, 4 * q + 3], q * 6);
      this.fieldIdx = this.device.createBuffer({ label: 'nest field indices', size: a.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(this.fieldIdx, 0, a);
    }
    return this.fieldIdx;
  }
  // ---- (round 28, measurement only: ?gputime=1) GPU time and fragments a pass, read back asynchronously ----------------
  private gpuT: { qs: GPUQuerySet; occ: GPUQuerySet; res: GPUBuffer; ring: { b: GPUBuffer; busy: boolean; np: number; labels: string[]; px: number }[]; pending: { b: GPUBuffer; np: number; labels: string[]; px: number } | null } | null = null;
  /** the passes' last results: label -> rolling samples of ms and fragments (cleared by the reader) */
  readonly gpuSamples = new Map<string, { ms: number[]; frags: number[] }>();
  gpuPixels = 0;
  /** (measurement) time every pass of the draw (the device must have 'timestamp-query') */
  enableGpuTime(): void {
    if (this.gpuT || !this.device.features.has('timestamp-query')) return;
    const N = 32;
    this.gpuT = {
      qs: this.device.createQuerySet({ type: 'timestamp', count: 2 * N }),
      occ: this.device.createQuerySet({ type: 'occlusion', count: N }),
      res: this.device.createBuffer({ size: 3 * N * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
      ring: Array.from({ length: 3 }, () => ({ b: this.device.createBuffer({ size: 3 * N * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }), busy: false, np: 0, labels: [], px: 0 })),
      pending: null,
    };
  }
  private gpuResolve(enc: GPUCommandEncoder, np: number, labels: string[], px: number): void {
    const g = this.gpuT!;
    const r = g.ring.find((x) => !x.busy);
    if (!r || np === 0) return;
    enc.resolveQuerySet(g.qs, 0, 2 * np, g.res, 0);
    enc.resolveQuerySet(g.occ, 0, np, g.res, 2 * 32 * 8);
    enc.copyBufferToBuffer(g.res, 0, r.b, 0, 3 * 32 * 8);
    r.busy = true;
    r.np = np;
    r.labels = labels;
    r.px = px;
    g.pending = r;
  }
  private gpuRead(): void {
    const g = this.gpuT;
    if (!g?.pending) return;
    const r = g.pending as { b: GPUBuffer; busy: boolean; np: number; labels: string[]; px: number };
    g.pending = null;
    r.b.mapAsync(GPUMapMode.READ).then(
      () => {
        const v = new BigUint64Array(r.b.getMappedRange());
        for (let i = 0; i < r.np; i++) {
          const ms = Number(v[2 * i + 1] - v[2 * i]) / 1e6;
          let s = this.gpuSamples.get(r.labels[i]);
          if (!s) this.gpuSamples.set(r.labels[i], (s = { ms: [], frags: [] }));
          s.ms.push(ms);
          s.frags.push(Number(v[64 + i]));
        }
        this.gpuPixels = r.px;
        r.b.unmap();
        r.busy = false;
      },
      () => (r.busy = false),
    );
  }

  /** the per-level uniforms (pages: the capture's face pages a level) */
  private uniforms(levels: DrawLevel[], pages: number[] = []): void {
    const st = new ArrayBuffer(DU * MAX_LEVELS);
    for (const lv of levels) {
      const w = this.nest.wins[lv.depth];
      if (!w) continue;
      new Int32Array(st, lv.depth * DU, 4).set([w.gx, w.gy, w.n, lv.depth]);
      const f = new Float32Array(st, lv.depth * DU + 16, 12);
      // (misc.y, round 20: the textured draw's band cut-off, 1 = per level (?bands=split))
      f.set([this.diag, this.bandsSplit ? 1 : 0, this.tint ? 1 : 0, this.nest.k], 0);
      // (want.w: 1 / k, exact on the CPU, for the rim vertices: round 11)
      // (want.z, round 20: the textured draw's band window, 0 = its default)
      // (want.y, round 21: the forest canopy's crossover footprint, world units a pixel, 0 = no canopy)
      f.set([lv.want, this.canopy ? this.canopyFade : 0, this.texBands, 1 / this.nest.k], 4);
      // (sun.w, round 14: the smooth draw's crease angle as its cosine)
      // (round 20: the textured draw's sun is lower, about 38 degrees up, so the relief reads without shadows; the flat
      // draw keeps its own)
      f.set([...(this.texDrawn ? [0.55, -0.45, 0.62] : [0.45, -0.35, 0.82]), Math.cos((this.crease * Math.PI) / 180)], 8);
      // (misc2.y, round 22: the sheets' slide, ?slide= / "Round edges")
      // (misc2.z, round 31: ?cliff: bits 0-11 the slope threshold x 100, 0 off; 12-15 version 2's hashed drop, cells;
      // 16-23 the width code (0: a column of the level; else 128 + log2 of the width in shading units); 24-27 version 2's
      // steps; 28 its smooth tops; 29 version 3 (with 30); 30 version 2; 31 the cut: draw.wgsl texOut)
      let cliffBits = 0;
      if (this.cliff) {
        const shadeUnitM = this.mpu / 2 ** this.shadeS;
        // (version 2: fixed world cells, 4 m by default)
        // (version 3, bit 29 with bit 30: the nested columns, 16 m level 0 cells by default; only if compiled in)
        const v3 = this.cliffV === 3 && this.cliffV3Built;
        const wm = this.cliffW > 0 ? this.cliffW : this.cliffV === 2 ? 4 : v3 ? 16 : 0;
        const wc = wm > 0 ? 128 + Math.round(Math.log2(wm / shadeUnitM)) : 0;
        const drop = Math.min(15, Math.max(0, Math.round(this.cliffDrop))) << 12;
        const v2 = this.cliffV === 2 || v3 ? (0x40000000 | (Math.min(15, Math.max(1, this.cliffN)) << 24) | (this.cliffSmooth ? 0x10000000 : 0) | (v3 ? 0x20000000 : 0)) : 0;
        cliffBits = (Math.min(4095, Math.max(1, Math.round(this.cliffT * 100))) | drop | (wc << 16) | v2 | (this.cliffCut ? 0x80000000 : 0)) >>> 0;
      }
      new Uint32Array(st, lv.depth * DU + 64, 4).set([this.nest.cap, this.slide ? 1 : 0, cliffBits, pages[lv.depth] ?? 0]);
      new Float32Array(st, lv.depth * DU + 80, 16).set(IDENTITY);
      // (round 11, NS-97) the live child's window: the parent's rim vertices are placed in its units
      const c = this.nest.wins[lv.depth + 1];
      new Int32Array(st, lv.depth * DU + 144, 4).set(c ? [c.gx, c.gy, c.n, 1] : [0, 0, 0, 0]);
      // (round 25) metres a world unit, the fog's distance (metres), the shading's scale
      // (round 27) w: ?tex=2's fine tile, log2 tiles a world unit (2 m tiles: 6 with 128 m root columns)
      new Float32Array(st, lv.depth * DU + 160, 4).set([this.mpu, this.fogM, this.shadeS, Math.round(Math.log2(this.mpu / TEX_TILE_M))]);
      // (round 31, version 3) x a pixel's size per unit of distance (the level chosen by distance), y ?cliffPx=, z the
      // diagnostic mode (?cliffDbg=)
      // (cl2, cl3: the hashed split, sink share, mask period, gap share; the gap's depth: draw.wgsl DrawU)
      // (cl3.yzw, round 32 step B1, ?cliff=4: the 16 m level's window gx, gy, n; n 0 when it has none: cliff4.wgsl)
      // (step B2: the window the table was built for)
      const w16 = this.cliffBox ? this.cliffBox.built : this.cliffRuleBuilt ? this.nest.wins[this.cliffRuleLv] : null;
      // (cl3.x with ?cliff=5: the strata on the column faces, 1 on / 0 off; version 3's gap depth otherwise)
      const cl3x = this.cliffBox ? (this.cliffStrata ? 1 : 0) : this.cliffGapD;
      new Float32Array(st, lv.depth * DU + 176, 12).set([this.pxAng, this.cliffPx, this.cliffDbg, this.cliffDropF, this.cliffHN, this.cliffSink, this.cliffPatch, this.cliffGap, cl3x, w16 ? w16.gx : 0, w16 ? w16.gy : 0, w16 ? w16.n : 0]);
    }
    this.device.queue.writeBuffer(this.ubuf, 0, st);
  }

  private capPipe: { p: GPUComputePipeline; sb: GPUComputePipeline; layout: GPUBindGroupLayout } | null = null;
  /** (the watertight check, test only: a readback) every triangle the draw places for each level, local units: three
   *  vec4 a triangle slot (w = 0 for an empty slot). With the smooth draw on, the sheets' slots (`ex`: their count). */
  async capture(levels: DrawLevel[]): Promise<{ depth: number; n: number; tris: Float32Array; ex: number }[]> {
    if (!this.capPipe) {
      const layout = this.device.createBindGroupLayout({ label: 'nest capture', entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }] });
      const pl = this.device.createPipelineLayout({ bindGroupLayouts: [this.layout, layout] });
      this.capPipe = {
        p: this.device.createComputePipeline({ label: 'nest capture', layout: pl, compute: { module: this.module, entryPoint: 'capture' } }),
        sb: this.device.createComputePipeline({ label: 'nest capture (sheets)', layout: pl, compute: { module: this.module, entryPoint: 'captureSheet' } }),
        layout,
      };
    }
    const read = async (src: GPUBuffer, size: number) => {
      const tmp = this.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const e = this.device.createCommandEncoder();
      e.copyBufferToBuffer(src, 0, tmp, 0, size);
      this.device.queue.submit([e.finish()]);
      await tmp.mapAsync(GPUMapMode.READ);
      const out = tmp.getMappedRange().slice(0);
      tmp.destroy();
      return out;
    };
    const args = new Uint32Array(await read(this.nest.drawArgs, 2 * MAX_LEVELS * 16));
    const pages = levels.map(() => 0);
    const smooth = this.nest.smooth;
    // (the face pages, or with the smooth draw on the sheet instances: draw args L or MAX_LEVELS + L)
    for (const lv of levels) pages[lv.depth] = args[((smooth ? MAX_LEVELS : 0) + lv.depth) * 4 + 1];
    this.bind();
    const out = [];
    const one = async (pipe: GPUComputePipeline, depth: number, slots: number) => {
      const size = Math.max(16, slots * 48);
      const buf = this.device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const bg1 = this.device.createBindGroup({ layout: this.capPipe!.layout, entries: [{ binding: 0, resource: { buffer: buf } }] });
      this.uniforms(levels, pages);
      const e = this.device.createCommandEncoder();
      const p = e.beginComputePass();
      p.setPipeline(pipe);
      p.setBindGroup(0, this.bg!, [depth * DU]);
      p.setBindGroup(1, bg1);
      // (two dimensions: a level's slots can need more than 65,535 workgroups)
      const groups = Math.ceil(slots / 64);
      const gx = Math.min(groups, 65535);
      if (slots > 0) p.dispatchWorkgroups(gx, Math.ceil(groups / gx));
      p.end();
      this.device.queue.submit([e.finish()]);
      const r = new Float32Array(await read(buf, size));
      buf.destroy();
      return r.subarray(0, slots * 12);
    };
    for (const lv of levels) {
      // (a level demoted while this awaited: skipped)
      if (!this.nest.wins[lv.depth]) continue;
      // (round 16) with the smooth draw on: the sheets as vsSheet places them (544 slots an instance)
      const ex = smooth ? await one(this.capPipe.sb, lv.depth, pages[lv.depth] * 544) : await one(this.capPipe.p, lv.depth, pages[lv.depth] * TPP);
      const tris = ex;
      if (!this.nest.wins[lv.depth]) continue;
      out.push({ depth: lv.depth, n: this.nest.wins[lv.depth]!.n, tris, ex: ex.length / 12 });
    }
    return out;
  }
}
