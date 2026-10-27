// The land beyond the window (round 73, far.wgsl): the atlas's macro ground
// (heights and colours at half its resolution: a texel 16 cells) and the
// coarse world's changes, drawn as one grid round the camera with the world —
// so past the window's columns there's the rest of the world, its mountains
// and cliffs whatever their height, fading into the sky.

import { MATERIALS } from '../world/materials';
import { KINDS, warmth } from './regions';
import { GIANT_FLOATS, type Atlas } from './atlas';
import farW from './far.wgsl?raw';
import meshStateW from '../shaders/meshstate.wgsl?raw';
import { LOD_UNI_BYTES, LodRings } from './lod';
import { ROW_H } from '../world/lattice';

const UNI_BYTES = 96 + 10 * 16;
/** vertices a side, and world units between them */
const G = 161;
const SPACING = 32;

/** (round 93) the window's light and look (the Globals' — render.wgsl lighting), for the rings to be lit as it is */
export interface FarLight {
  /** the sun's way (Globals.sun) and its colour (Globals.sunCol: rgb × intensity) */
  sun: readonly number[];
  sunCol: readonly number[];
  /** the sky's ambient rgb and the night 0..1 (Globals.sky) */
  sky: readonly number[];
  /** the window's first cell (Globals.origin) */
  origin: readonly number[];
  season: number;
  pollution: number;
}

export interface FarTargets {
  /** (round 83) the window's field mesh: its state (which chunks are built) and chunks across and down — the
   *  rings fill the chunks not built yet; absent: the rings never draw in the window */
  mesh?: { state: GPUBuffer; grid: [number, number, number] };
  format: GPUTextureFormat;
  pickFormat: GPUTextureFormat;
  depthFormat: GPUTextureFormat;
  camera: GPUBuffer;
}

export class FarLand {
  private pipe: GPURenderPipeline;
  private group: GPUBindGroup;
  private uni: GPUBuffer;
  private index: GPUBuffer;
  private textures: GPUTexture[];
  private count: number;
  /** the rings of less detail between the window and this (round 83, lod.ts); none: ?lod=0 */
  readonly lod: LodRings | null;
  private lodPipe?: GPURenderPipeline;
  private lodIndex?: GPUBuffer;
  private lodCount = 0;
  private lodLast = performance.now();
  /** the giants (Atlas.giants): their pipeline, their buffer, how many */
  private gPipe?: GPURenderPipeline;
  private gGroup?: GPUBindGroup;
  private gBuf?: GPUBuffer;
  private gCount = 0;
  /** where the window is (world units and its oz), its size, the grid's middle (window coordinates), the fog */
  org: [number, number, number] = [0, 0, 0];
  win: [number, number] = [256, 256];
  mid: [number, number] = [128, 128];
  /** the window's height (what's above it is drawn here, over the window too) */
  zMax = 248;
  /** (round 83) what the view is on (window coordinates; the camera's target): the land on the eye's side of
   *  it is kept under it (far.wgsl underFocus); null: none (flying) */
  focus: [number, number, number] | null = null;
  /** (round 86) the storms (window coordinates; far.wgsl farStorm): drawn on the land the rings draw */
  storms: { x: number; y: number; radius: number; intensity: number }[] = [];
  /** (round 93) the window's light (the level sets it a frame); null: the rings' own look */
  light: FarLight | null = null;
  /** (round 93, ?fd=0: off) the rings drawn with the window's look — its ground colour, plants, ways, trees, light */
  windowLook = new URLSearchParams(location.search).get('fd') !== '0';
  /** (round 93, ?fdveg=) the plants the window's sim has grown on soil and silt by now — the rings draw at least this
   *  there (its columns start barer; the window greens over in play) */
  grownVeg = Number(new URLSearchParams(location.search).get('fdveg') ?? 1.6);

  constructor(
    private device: GPUDevice,
    private atlas: Atlas,
    t: FarTargets,
    /** the rings' spacings (finest first) and vertices a side; null: none */
    lod: { spacings: number[]; n: number } | null = { spacings: [2, 4, 8, 16], n: 193 },
    /** ?ceiling=1 (the perf ceiling): the rings and the far land alone, into the colour target only (no pick
     *  target, no window cut out of them, no giants) — Renderer.encodeCeiling's pass */
    readonly ceiling = false,
  ) {
    if (ceiling && !lod) throw new Error('FarLand: ?ceiling=1 draws the rings — not with ?lod=0');
    const n = atlas.p.n;
    const m = n / 2;
    // heights (averaged 2 × 2) and colours (each region kind's ground: its top's colour, green where
    // it grows, white where it's below freezing)
    const hgt = new Float32Array(m * m);
    const col = new Uint8Array(m * m * 4);
    const albedo = (mat: number) => MATERIALS[mat]?.albedo ?? [0.5, 0.5, 0.5];
    const green: [number, number, number] = [0.3, 0.46, 0.2];
    for (let y = 0; y < m; y++)
      for (let x = 0; x < m; x++) {
        let h = 0;
        for (let k = 0; k < 4; k++) h += atlas.hmac[(y * 2 + (k >> 1)) * n + x * 2 + (k & 1)];
        h /= 4;
        hgt[y * m + x] = h;
        const d = atlas.defs[atlas.regionOf[y * 2 * n + x * 2]];
        const k = KINDS[d.kind];
        let c = albedo(k.top) as number[];
        if (k.veg > 0.5) c = c.map((v, i) => v * 0.35 + green[i] * 0.65);
        const temp = warmth((y + 0.5) / m) * 34 - 8 - (h - atlas.p.sea) * 0.05; // (compose.wgsl LAPSE)
        if (temp < 0 && d.stat.land) c = [0.86, 0.88, 0.92];
        col.set([Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255), 255], (y * m + x) * 4);
      }
    const mk = (format: GPUTextureFormat, data: ArrayBufferView & { buffer: ArrayBuffer }, bpp: number) => {
      const tex = device.createTexture({ label: 'far', size: [m, m], format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      device.queue.writeTexture({ texture: tex }, data, { bytesPerRow: m * bpp }, [m, m]);
      return tex;
    };
    const ht = mk('r32float', hgt, 4);
    const ct = mk('rgba8unorm', col, 4);
    this.textures = [ht, ct];
    // the grid's triangles
    const idx = new Uint32Array((G - 1) * (G - 1) * 6);
    let o = 0;
    for (let j = 0; j < G - 1; j++)
      for (let i = 0; i < G - 1; i++) {
        const a = j * G + i;
        idx.set([a, a + 1, a + G, a + 1, a + G + 1, a + G], o);
        o += 6;
      }
    this.count = idx.length;
    this.index = device.createBuffer({ label: 'far index', size: idx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.index, 0, idx);
    this.uni = device.createBuffer({ label: 'far params', size: UNI_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const layout = device.createBindGroupLayout({
      label: 'far',
      entries: [
        { binding: 10, visibility: VF, buffer: { type: 'uniform' } },
        { binding: 40, visibility: VF, buffer: { type: 'uniform' } },
        { binding: 41, visibility: GPUShaderStage.VERTEX, texture: { sampleType: 'unfilterable-float' } },
        { binding: 42, visibility: GPUShaderStage.VERTEX, texture: { sampleType: 'float' } },
        { binding: 43, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 45, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 46, visibility: VF, buffer: { type: 'uniform' } },
        { binding: 47, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 48, visibility: VF, buffer: { type: 'uniform' } },
      ],
    });
    this.lod = lod ? new LodRings(device, atlas, lod.spacings, lod.n) : null;
    if (this.lod && t.mesh) this.lod.meshGrid = [t.mesh.grid[2], t.mesh.grid[2] * ROW_H, t.mesh.grid[0], t.mesh.grid[1]];
    const meshState = t.mesh?.state ?? device.createBuffer({ label: 'lod no mesh', size: 16, usage: GPUBufferUsage.STORAGE });
    // (no rings: an empty LodD, its count 0)
    const lodData = this.lod?.data ?? device.createBuffer({ label: 'lod none', size: 16, usage: GPUBufferUsage.STORAGE });
    const lodUni = this.lod?.uni ?? device.createBuffer({ label: 'lod none', size: LOD_UNI_BYTES, usage: GPUBufferUsage.UNIFORM });
    const albedoU = this.lod?.albedo ?? device.createBuffer({ label: 'far no albedo', size: 64 * 16, usage: GPUBufferUsage.UNIFORM });
    this.group = device.createBindGroup({
      label: 'far',
      layout,
      entries: [
        { binding: 10, resource: { buffer: t.camera } },
        { binding: 40, resource: { buffer: this.uni } },
        { binding: 41, resource: ht.createView() },
        { binding: 42, resource: ct.createView() },
        { binding: 43, resource: { buffer: atlas.coarse.cells } },
        { binding: 45, resource: { buffer: lodData } },
        { binding: 46, resource: { buffer: lodUni } },
        { binding: 47, resource: { buffer: meshState } },
        { binding: 48, resource: { buffer: albedoU } },
      ],
    });
    const module = device.createShaderModule({ label: 'far', code: meshStateW + '\n' + farW });
    this.pipe = device.createRenderPipeline({
      label: 'far',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: 'vsFar' },
      fragment: { module, entryPoint: ceiling ? 'fsCeilFar' : 'fsFar', targets: ceiling ? [{ format: t.format }] : [{ format: t.format }, { format: t.pickFormat }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: t.depthFormat, depthWriteEnabled: true, depthCompare: 'less' },
    });
    if (lod) {
      const m = lod.n;
      const li = new Uint32Array((m - 1) * (m - 1) * 6);
      let q = 0;
      for (let j = 0; j < m - 1; j++)
        for (let i = 0; i < m - 1; i++) {
          const a = j * m + i;
          li.set([a, a + 1, a + m, a + 1, a + m + 1, a + m], q);
          q += 6;
        }
      this.lodCount = li.length;
      this.lodIndex = device.createBuffer({ label: 'lod index', size: li.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(this.lodIndex, 0, li);
      this.lodPipe = device.createRenderPipeline({
        label: 'lod',
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        vertex: { module, entryPoint: 'vsLod' },
        fragment: { module, entryPoint: ceiling ? 'fsCeilLod' : 'fsLod', targets: ceiling ? [{ format: t.format }] : [{ format: t.format }, { format: t.pickFormat }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: t.depthFormat, depthWriteEnabled: true, depthCompare: 'less' },
      });
    }
    // the giants beyond the window (round 75)
    this.gCount = ceiling ? 0 : atlas.giants.length / GIANT_FLOATS;
    if (this.gCount) {
      this.gBuf = device.createBuffer({ label: 'far giants', size: atlas.giants.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(this.gBuf, 0, atlas.giants);
      const gl = device.createBindGroupLayout({
        label: 'far giants',
        entries: [
          { binding: 10, visibility: VF, buffer: { type: 'uniform' } },
          { binding: 40, visibility: VF, buffer: { type: 'uniform' } },
          { binding: 44, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        ],
      });
      this.gGroup = device.createBindGroup({
        label: 'far giants',
        layout: gl,
        entries: [
          { binding: 10, resource: { buffer: t.camera } },
          { binding: 40, resource: { buffer: this.uni } },
          { binding: 44, resource: { buffer: this.gBuf } },
        ],
      });
      this.gPipe = device.createRenderPipeline({
        label: 'far giants',
        layout: device.createPipelineLayout({ bindGroupLayouts: [gl] }),
        vertex: { module, entryPoint: 'vsGiant' },
        fragment: { module, entryPoint: 'fsGiant', targets: [{ format: t.format }, { format: t.pickFormat }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: t.depthFormat, depthWriteEnabled: true, depthCompare: 'less' },
      });
    }
  }

  /** (round 86, the hybrid) the window's mesh chunks its grid draws (a bit each): the rings leave them to it */
  setGrid(bits: Uint32Array): void {
    this.lod?.gridBits.set(bits);
  }

  /** Draw it (the world pass), the fog the sky's colour. */
  draw(pass: GPURenderPassEncoder, fog: [number, number, number]): void {
    const a = this.atlas;
    const f = new Float32Array(UNI_BYTES / 4);
    f.set([this.org[0], this.org[1], this.org[2], 0], 0);
    f.set([this.win[0], this.win[1], SPACING, this.zMax], 4);
    f.set([this.mid[0], this.mid[1], G, a.p.sea], 8);
    f.set([fog[0], fog[1], fog[2], 1], 12);
    f.set([a.worldW, a.worldH, a.p.n / 2, a.coarse.cn], 16);
    if (this.focus) f.set([...this.focus, 1], 20);
    const ns = Math.min(4, this.storms.length);
    for (let i = 0; i < ns; i++) f.set([this.storms[i].x, this.storms[i].y, this.storms[i].radius, Math.min(1, this.storms[i].intensity)], 24 + i * 4);
    f.set([ns, (performance.now() / 1000) % 1000, 0, 0], 40);
    const L = this.light;
    if (L) {
      f.set([L.sun[0], L.sun[1], L.sun[2], 1 - L.sky[3]], 44);
      f.set([L.sunCol[0], L.sunCol[1], L.sunCol[2], 0], 48);
      f.set([L.sky[0], L.sky[1], L.sky[2], L.sky[3]], 52);
      f.set([L.origin[0], L.origin[1] * ROW_H, L.origin[0], L.origin[1]], 56);
      f.set([L.season, L.pollution, this.windowLook ? 1 : 0, this.grownVeg], 60);
    }
    this.device.queue.writeBuffer(this.uni, 0, f);
    const now = performance.now();
    if (this.lod) {
      this.lod.update(this.mid, this.org, (now - this.lodLast) / 1000);
      if (this.lod.ready) {
        pass.setPipeline(this.lodPipe!);
        pass.setBindGroup(0, this.group);
        pass.setIndexBuffer(this.lodIndex!, 'uint32');
        pass.drawIndexed(this.lodCount, this.lod.spacings.length);
      }
    }
    this.lodLast = now;
    pass.setPipeline(this.pipe);
    pass.setBindGroup(0, this.group);
    pass.setIndexBuffer(this.index, 'uint32');
    pass.drawIndexed(this.count);
    if (this.gPipe) {
      pass.setPipeline(this.gPipe);
      pass.setBindGroup(0, this.gGroup!);
      pass.draw(54, this.gCount);
    }
  }

  dispose(): void {
    for (const t of this.textures) t.destroy();
    this.index.destroy();
    this.uni.destroy();
    this.lod?.dispose();
    this.lodIndex?.destroy();
    this.gBuf?.destroy();
  }
}
