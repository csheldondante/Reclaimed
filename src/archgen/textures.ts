// (archgen, AG19; the user: "we should be … working with better ground and building textures"; CC0 sets in the repo:
// yes) The building generator's material textures: 15 CC0 sets from ambientCG (src/archgen/tex, packed by
// scripts/packtex.py: <key>_c.jpg colour with its occlusion folded in, <key>_n.jpg normal xy + roughness), in two
// texture arrays with mips, one sampler (anisotropic), and a uniform saying they're loaded. One per device, shared by
// every town's draw and the lab's: bind group 1 of the arch pipelines (draw.wgsl ARCH_TEX). Until the images arrive
// (or with ?archtex=0, which loads nothing — the phone bench's toggle) the shader draws its procedural look.

const files = import.meta.glob('./tex/*.jpg', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

/** the layers, in order (draw.wgsl TX_*) */
export const ARCH_TEX_KEYS = ['brick', 'rubble', 'ashlar', 'plaster', 'siding', 'wood', 'deck', 'tile', 'slate', 'thatch', 'flag', 'cobble', 'dirt', 'grass', 'canvas', 'sand', 'rock', 'gravel', 'snow', 'moss'] as const;

const MIP_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
struct V { @builtin(position) p: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  let uv = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  var o: V;
  o.p = vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), 0.0, 1.0);
  o.uv = uv;
  return o;
}
@fragment fn fs(v: V) -> @location(0) vec4<f32> { return textureSample(src, smp, v.uv); }
`;

export class ArchTextures {
  readonly layout: GPUBindGroupLayout;
  group: GPUBindGroup;
  readonly ready: Promise<void>;
  private sampler: GPUSampler;
  private u: GPUBuffer;
  private made: GPUTexture[] = [];

  constructor(private device: GPUDevice, size: number, on: boolean) {
    const d = device;
    this.layout = d.createBindGroupLayout({
      label: 'arch textures',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        // (Synty plants, local only: the meshes for the vertex stage, their colour atlas)
        // (a texture, not a storage buffer: the game's draw stage already holds the 8 storage buffers it may)
        { binding: 4, visibility: GPUShaderStage.VERTEX, texture: { sampleType: 'unfilterable-float' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    this.sampler = d.createSampler({ addressModeU: 'repeat', addressModeV: 'repeat', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy: 8 });
    this.u = d.createBuffer({ label: 'arch textures on', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const dummy = d.createTexture({ size: [1, 1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING });
    this.made.push(dummy);
    this.texC = dummy;
    this.texN = dummy;
    this.pal = dummy;
    this.plants = d.createTexture({ label: 'arch plants (none)', size: [1, 1], format: 'rgba32float', usage: GPUTextureUsage.TEXTURE_BINDING });
    this.group = this.bind(dummy, dummy);
    this.ready = on ? this.load(size) : Promise.resolve();
    this.loadPlants();
  }

  private texC: GPUTexture;
  private texN: GPUTexture;
  private pal: GPUTexture;
  private plants: GPUTexture;
  /** how many plant meshes are loaded (0: none — the generator draws its own) */
  plantCount = 0;
  private plantWaiters: (() => void)[] = [];
  /** cb once the plants are in (towns and the lab make their lots again then) */
  whenPlants(cb: () => void): void {
    this.plantWaiters.push(cb);
  }

  /** (Synty, the user's own: local/synty from scripts/synty.mjs, gitignored; absent in a public build) */
  private async loadPlants(): Promise<void> {
    const d = this.device;
    const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
    try {
      const r = await fetch(`${base}local/synty/plants.bin`);
      if (!r.ok) return;
      const ab = await r.arrayBuffer();
      const head = new Uint32Array(ab, 0, 4);
      // (a dev server answers a missing file with its page: the magic tells)
      if (head[0] !== 0x544e4c50) return;
      const pr = await fetch(`${base}local/synty/palette.png`);
      if (!pr.ok) return;
      const bmp = await createImageBitmap(await pr.blob(), { colorSpaceConversion: 'none' });
      const pal = d.createTexture({ label: 'arch plant palette', size: [bmp.width, bmp.height], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
      d.queue.copyExternalImageToTexture({ source: bmp }, { texture: pal }, [bmp.width, bmp.height]);
      bmp.close();
      // texels (vec4 each, PW_TEX wide): 0 (1, n, 0, 0); 1 + i mesh i's (first, count, 0, 0); then two a vertex —
      // (x, y, z, nx), (ny, nz, u, v) — all as floats (counts exact to 2^24; no raw bits a GPU might flush)
      const n = head[1];
      const mh = new Uint32Array(ab, 16, n * 4);
      const vf = new Float32Array(ab, 16 + n * 16);
      const nv = vf.length / 8;
      const texels = 1 + n + nv * 2;
      const W = 2048;
      const H = Math.ceil(texels / W);
      const data = new Float32Array(W * H * 4);
      data.set([1, n, 0, 0], 0);
      for (let i = 0; i < n; i++) data.set([mh[i * 4], mh[i * 4 + 1], 0, 0], (1 + i) * 4);
      data.set(vf, (1 + n) * 4);
      const tex = d.createTexture({ label: 'arch plants', size: [W, H], format: 'rgba32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      d.queue.writeTexture({ texture: tex }, data, { bytesPerRow: W * 16 }, [W, H]);
      this.plants.destroy();
      this.plants = tex;
      this.pal = pal;
      this.made.push(pal);
      this.group = this.bind(this.texC, this.texN);
      this.plantCount = head[1];
      for (const cb of this.plantWaiters) cb();
    } catch {
      // (no local conversion: the generator's own plants)
    }
  }

  private bind(c: GPUTexture, n: GPUTexture): GPUBindGroup {
    this.texC = c;
    this.texN = n;
    return this.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: c.createView({ dimension: '2d-array' }) },
        { binding: 1, resource: n.createView({ dimension: '2d-array' }) },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: { buffer: this.u } },
        { binding: 4, resource: this.plants.createView() },
        { binding: 5, resource: this.pal.createView() },
      ],
    });
  }

  private async load(size: number): Promise<void> {
    const d = this.device;
    const levels = Math.floor(Math.log2(size)) + 1;
    const mk = (label: string) =>
      d.createTexture({
        label,
        size: [size, size, ARCH_TEX_KEYS.length],
        format: 'rgba8unorm',
        mipLevelCount: levels,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
    const c = mk('arch colour');
    const n = mk('arch normal');
    this.made.push(c, n);
    const url = (k: string) => {
      const u = files[`./tex/${k}.jpg`];
      if (!u) throw new Error(`archgen textures: no ${k}.jpg`);
      return u;
    };
    await Promise.all(
      ARCH_TEX_KEYS.flatMap((k, layer) =>
        ([[c, `${k}_c`], [n, `${k}_n`]] as const).map(async ([tex, name]) => {
          const blob = await (await fetch(url(name))).blob();
          const bmp = await createImageBitmap(blob, { resizeWidth: size, resizeHeight: size, resizeQuality: 'high', colorSpaceConversion: 'none' });
          d.queue.copyExternalImageToTexture({ source: bmp }, { texture: tex, origin: [0, 0, layer] }, [size, size]);
          bmp.close();
        }),
      ),
    );
    this.mips(c, levels);
    this.mips(n, levels);
    this.group = this.bind(c, n);
    d.queue.writeBuffer(this.u, 0, new Float32Array([1, size, 0, 0]));
  }

  /** each layer's mips, a level from the one above (linear: a box filter) */
  private mips(tex: GPUTexture, levels: number): void {
    const d = this.device;
    const m = d.createShaderModule({ label: 'arch mips', code: MIP_WGSL });
    const pipe = d.createRenderPipeline({ label: 'arch mips', layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] } });
    const smp = d.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    const e = d.createCommandEncoder({ label: 'arch mips' });
    for (let layer = 0; layer < tex.depthOrArrayLayers; layer++) {
      for (let lv = 1; lv < levels; lv++) {
        const view = (level: number) => tex.createView({ dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1, baseMipLevel: level, mipLevelCount: 1 });
        const g = d.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: view(lv - 1) }, { binding: 1, resource: smp }] });
        const p = e.beginRenderPass({ colorAttachments: [{ view: view(lv), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
        p.setPipeline(pipe);
        p.setBindGroup(0, g);
        p.draw(3);
        p.end();
      }
    }
    d.queue.submit([e.finish()]);
  }

  destroy(): void {
    for (const t of this.made) t.destroy();
    this.u.destroy();
    this.plants.destroy();
  }
}

const shared = new WeakMap<GPUDevice, ArchTextures>();
/** the device's one set: 1024 a side on the PC, 512 on a phone (pointer: coarse); ?archtex=0 loads none */
export function archTextures(device: GPUDevice): ArchTextures {
  let t = shared.get(device);
  if (!t) {
    const q = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
    const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
    const size = Number(q.get('archtexsize') ?? (coarse ? 512 : 1024));
    t = new ArchTextures(device, size, q.get('archtex') !== '0');
    shared.set(device, t);
  }
  return t;
}
