// A CPU mirror of some world buffers and textures (docs/WORLD_API.md): one
// staging buffer, one copy of everything registered, one map, refreshed on
// a timer. The world modules answer their queries from it, so a game never
// reads a GPU buffer or decodes a packed format itself.

import { ignoreTeardown } from '../gpu/pipeline';

interface Source {
  name: string;
  buffer?: GPUBuffer;
  texture?: GPUTexture;
  offset: number;
  bytes: number;
  /** a texture's padded row (copyTextureToBuffer wants 256-byte rows) */
  rowBytes: number;
}

export class Mirror {
  private sources: Source[] = [];
  private size = 0;
  private data = new Map<string, ArrayBuffer>();
  private timer = 0;
  private inFlight: Promise<void> | null = null;
  /** performance.now() of the last completed read (0: never) */
  readAt = 0;
  /** ms between reads while started */
  every = 250;

  constructor(private device: GPUDevice) {}

  /** Mirror a buffer (all of it) under `name`. */
  addBuffer(name: string, buffer: GPUBuffer): void {
    if (this.sources.some((s) => s.name === name)) return;
    this.sources.push({ name, buffer, offset: this.size, bytes: buffer.size, rowBytes: 0 });
    this.size += Math.ceil(buffer.size / 256) * 256;
  }

  /** Mirror an rgba32float texture under `name` (rows unpadded in the copy: 4 floats a texel). */
  addTexture(name: string, texture: GPUTexture): void {
    if (this.sources.some((s) => s.name === name)) return;
    const rowBytes = Math.ceil((texture.width * 16) / 256) * 256;
    this.sources.push({ name, texture, offset: this.size, bytes: rowBytes * texture.height, rowBytes });
    this.size += rowBytes * texture.height;
  }

  /** The last read of `name` (undefined before the first refresh). */
  get(name: string): ArrayBuffer | undefined {
    return this.data.get(name);
  }

  /** Read everything back; resolves with data read after the call (a read in flight finishes first). */
  async refresh(): Promise<void> {
    while (this.inFlight) await this.inFlight;
    if (!this.size) return;
    this.inFlight = this.read();
    await this.inFlight;
    this.inFlight = null;
  }

  private async read(): Promise<void> {
    const tmp = this.device.createBuffer({ label: 'mirror', size: this.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder({ label: 'mirror' });
    for (const s of this.sources) {
      if (s.buffer) enc.copyBufferToBuffer(s.buffer, 0, tmp, s.offset, s.bytes);
      else if (s.texture) enc.copyTextureToBuffer({ texture: s.texture }, { buffer: tmp, offset: s.offset, bytesPerRow: s.rowBytes }, [s.texture.width, s.texture.height]);
    }
    this.device.queue.submit([enc.finish()]);
    await tmp.mapAsync(GPUMapMode.READ).then(() => {
      const all = tmp.getMappedRange();
      for (const s of this.sources) {
        if (s.buffer) {
          this.data.set(s.name, all.slice(s.offset, s.offset + s.bytes));
          continue;
        }
        const t = s.texture!;
        const w4 = t.width * 4;
        const out = new Float32Array(w4 * t.height);
        const raw = new Float32Array(all, s.offset, s.bytes / 4);
        const rowF = s.rowBytes / 4;
        for (let y = 0; y < t.height; y++) out.set(raw.subarray(y * rowF, y * rowF + w4), y * w4);
        this.data.set(s.name, out.buffer);
      }
      tmp.unmap();
      this.readAt = performance.now();
    }, ignoreTeardown);
    tmp.destroy();
  }

  /** Refresh every `ms` (default `every`) until stop(). */
  start(ms = this.every): this {
    this.stop();
    this.every = ms;
    void this.refresh();
    // (a timed read skips while another is in flight)
    this.timer = window.setInterval(() => {
      if (!this.inFlight) void this.refresh();
    }, ms);
    return this;
  }

  stop(): void {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = 0;
  }
}
