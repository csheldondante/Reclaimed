// The pixel-art look as one post pass over the whole picture (pixelpost.wgsl): the world is rendered small (an art pixel
// `px` CSS pixels: the renderer's targets that size), then drawn to the screen in blocks with a dark outline at depth
// steps, the colours brought to a palette with ordered dither, the darks lifted to a cold blue. Shared, not per asset:
// the terrain, the structures, the props and the people all go through it. `?pixel=<css px>` (0: off).
import postWgsl from '../shaders/pixelpost.wgsl?raw';
import type { Renderer } from './renderer';

/** the palette (sRGB): dark cold shadows, stone, woods, cloth, moss, candle and sun (the Rain World's few colours) */
export const PIXEL_PALETTE = [
  '#0b0b10', '#14131a', '#1d1b22', '#272329', '#2c3340', '#3d4757', '#566273', '#7c8896',
  '#3a3530', '#514a42', '#6b6258', '#8c8276', '#b9b2a4', '#ded6c4',
  '#2a1a10', '#3e2615', '#5a361b', '#7a4c26', '#9c6a3a',
  '#4a1714', '#6e2420', '#932f25',
  '#1f2a1a', '#33442a', '#4e6338', '#6f8548',
  '#b88a4a', '#d9a95a', '#f2cf86', '#fff0c0', '#e8d2a0', '#c9b38a',
];

export interface PixelLook {
  /** CSS pixels an art pixel */
  px: number;
  outline: number;
  /** the depth step (clip depth) that makes an outline */
  edge: number;
  dither: number;
  lift: number;
  warmth: number;
  on: boolean;
}

export class PixelPost {
  look: PixelLook = { px: 2, outline: 0.85, edge: 0.0004, dither: 0.3, lift: 0.35, warmth: 1, on: true };
  private tex?: GPUTexture;
  private view?: GPUTextureView;
  private pipe?: GPURenderPipeline;
  private layout: GPUBindGroupLayout;
  private params: GPUBuffer;
  private pal: GPUBuffer;
  private group?: GPUBindGroup;
  private size = { w: 1, h: 1, sw: 1, sh: 1 };
  private groupFor?: GPUTexture;

  constructor(private device: GPUDevice, private renderer: Renderer, private format: GPUTextureFormat) {
    renderer.keepDepth = true;
    this.layout = device.createBindGroupLayout({
      label: 'pixelpost',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });
    const module = device.createShaderModule({ label: 'pixelpost', code: postWgsl });
    this.pipe = device.createRenderPipeline({
      label: 'pixelpost',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      vertex: { module, entryPoint: 'vsPost' },
      fragment: { module, entryPoint: 'fsPost', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    this.params = device.createBuffer({ label: 'pixelpost-params', size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const pal = new Float32Array(PIXEL_PALETTE.length * 4);
    PIXEL_PALETTE.forEach((h, i) => pal.set([parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255, 1], i * 4));
    this.pal = device.createBuffer({ label: 'pixelpost-palette', size: pal.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.pal, 0, pal);
  }

  /** the renderer's size for a screen of (sw, sh) render px and (cssW) CSS px: an art pixel `px` CSS px */
  lowSize(sw: number, sh: number, cssW: number): [number, number] {
    const k = Math.max(1, (this.look.px * sw) / Math.max(1, cssW));
    return [Math.max(1, Math.round(sw / k)), Math.max(1, Math.round(sh / k))];
  }

  resize(sw: number, sh: number, w: number, h: number): void {
    this.size = { w, h, sw, sh };
    this.tex?.destroy();
    this.tex = this.device.createTexture({ label: 'pixelpost-src', size: [w, h], format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.view = this.tex.createView();
    this.group = undefined;
  }

  /** where the world is drawn this frame */
  target(): GPUTextureView {
    return this.view!;
  }

  encode(enc: GPUCommandEncoder, out: GPUTextureView): void {
    const depth = this.renderer.depthTexture;
    if (!this.group || this.groupFor !== depth) {
      this.groupFor = depth;
      this.group = this.device.createBindGroup({
        label: 'pixelpost',
        layout: this.layout,
        entries: [
          { binding: 0, resource: this.view! },
          { binding: 1, resource: depth.createView() },
          { binding: 2, resource: { buffer: this.params } },
          { binding: 3, resource: { buffer: this.pal } },
        ],
      });
    }
    const L = this.look;
    this.device.queue.writeBuffer(this.params, 0, new Float32Array([this.size.w, this.size.h, this.size.sw, this.size.sh, L.outline, L.edge, L.dither, PIXEL_PALETTE.length, L.on ? 1 : 0, L.lift, L.warmth, 0]));
    const pass = enc.beginRenderPass({ label: 'pixelpost', colorAttachments: [{ view: out, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    pass.setPipeline(this.pipe!);
    pass.setBindGroup(0, this.group);
    pass.draw(3);
    pass.end();
  }
}
