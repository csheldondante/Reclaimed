// The land beyond the window (round 73, far.wgsl): the atlas's macro ground
// (heights and colours at half its resolution: a texel 16 cells) and the
// coarse world's changes, drawn as one grid round the camera with the world —
// so past the window's columns there's the rest of the world, its mountains
// and cliffs whatever their height, fading into the sky.

import { MATERIALS } from '../world/materials';
import { KINDS, warmth } from './regions';
import type { Atlas } from './atlas';
import farW from './far.wgsl?raw';

const UNI_BYTES = 80;
/** vertices a side, and world units between them */
const G = 161;
const SPACING = 32;

export interface FarTargets {
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
  /** where the window is (world units and its oz), its size, the grid's middle (window coordinates), the fog */
  org: [number, number, number] = [0, 0, 0];
  win: [number, number] = [256, 256];
  mid: [number, number] = [128, 128];

  constructor(
    private device: GPUDevice,
    private atlas: Atlas,
    t: FarTargets,
  ) {
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
        const temp = warmth((y + 0.5) / m) * 34 - 8 - (h - atlas.p.sea) * 0.12;
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
      ],
    });
    this.group = device.createBindGroup({
      label: 'far',
      layout,
      entries: [
        { binding: 10, resource: { buffer: t.camera } },
        { binding: 40, resource: { buffer: this.uni } },
        { binding: 41, resource: ht.createView() },
        { binding: 42, resource: ct.createView() },
        { binding: 43, resource: { buffer: atlas.coarse.cells } },
      ],
    });
    const module = device.createShaderModule({ label: 'far', code: farW });
    this.pipe = device.createRenderPipeline({
      label: 'far',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: 'vsFar' },
      fragment: { module, entryPoint: 'fsFar', targets: [{ format: t.format }, { format: t.pickFormat }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: t.depthFormat, depthWriteEnabled: true, depthCompare: 'less' },
    });
  }

  /** Draw it (the world pass), the fog the sky's colour. */
  draw(pass: GPURenderPassEncoder, fog: [number, number, number]): void {
    const a = this.atlas;
    const f = new Float32Array(UNI_BYTES / 4);
    f.set([this.org[0], this.org[1], this.org[2], 0], 0);
    f.set([this.win[0], this.win[1], SPACING, 0], 4);
    f.set([this.mid[0], this.mid[1], G, a.p.sea], 8);
    f.set([fog[0], fog[1], fog[2], 1], 12);
    f.set([a.worldW, a.worldH, a.p.n / 2, a.coarse.cn], 16);
    this.device.queue.writeBuffer(this.uni, 0, f);
    pass.setPipeline(this.pipe);
    pass.setBindGroup(0, this.group);
    pass.setIndexBuffer(this.index, 'uint32');
    pass.drawIndexed(this.count);
  }

  dispose(): void {
    for (const t of this.textures) t.destroy();
    this.index.destroy();
    this.uni.destroy();
  }
}
