// A CPU mirror of some world buffers and textures (docs/WORLD_API.md): one
// staging buffer, one copy of everything registered, one map, refreshed on
// a timer. The world modules answer their queries from it, so a game never
// reads a GPU buffer or decodes a packed format itself.

import { ignoreTeardown } from '../gpu/pipeline';

/**
 * (perfopt, round 83 audit: ?mirror=near) A paged buffer (the layers: 16 MB in the atlas's window, read whole every
 * 250 ms while a game's API is on) is read whole only every NEAR_FULL reads, and after a slide; between, only its
 * pages within NEAR_R of the focus (the camera's target) are read and written into the copy. Elsewhere a query sees
 * the world as it was up to NEAR_FULL reads ago.
 */
/**
 * (round 100, hitchrec — main's call: near by default, `?mirror=full` the old whole reads) The whole read was 34 MB
 * copied and mapped every 250 ms in the atlas (the layers 25 of it), the hitch recorder's top long-frame cause: the
 * latency-sensitive readbacks (the judge's, the mesh's) waited 200–320 ms behind it. Round the camera's target (and
 * any focus a caller keeps fresh: Paged.focus) the layers are as fresh as before; elsewhere up to NEAR_FULL reads old
 * (2 s) — `refresh(true)` reads everything now for a caller that needs far columns as they are.
 */
const MIRROR_NEAR = typeof location !== 'undefined' && new URLSearchParams(location.search).get('mirror') !== 'full';
const NEAR_R = 48;
const NEAR_FULL = 8;

/** a paged buffer's layout (render/layout PackedWorld's): per chunk its first slot and slots a column, cells a side */
export interface Paged {
  chunksX: number;
  chunksY: number;
  chunkTable: Uint32Array;
  /** bytes a slot */
  slotBytes: number;
  /** columns a chunk side */
  chunk: number;
  /** world units a row (hex rows: √3/2) */
  rowH: number;
  /** (round 100: the points kept fresh — the camera's target, and what callers keep: Terrain.keepFresh) */
  focus: () => [number, number][];
}

interface Source {
  name: string;
  buffer?: GPUBuffer;
  texture?: GPUTexture;
  offset: number;
  bytes: number;
  /** a texture's padded row (copyTextureToBuffer wants 256-byte rows) */
  rowBytes: number;
  /** (mirror=near) read by pages near the focus between whole reads */
  paged?: Paged;
}

export class Mirror {
  private sources: Source[] = [];
  private size = 0;
  private data = new Map<string, ArrayBuffer>();
  /** typed views of the last read, made once a read (queries run hundreds of times a frame) */
  private f32s = new Map<string, Float32Array>();
  private u32s = new Map<string, Uint32Array>();
  /** bumped every read: a module's own caches of derived values key on it */
  gen = 0;
  private timer = 0;
  private inFlight: Promise<void> | null = null;
  /** performance.now() of the last completed read (0: never) */
  readAt = 0;
  /** ms between reads while started */
  every = 250;

  /**
   * The window's epoch (round 80: a streamed window, WorldCore.windowEpoch): a read that straddles a slide
   * is dropped and made again; while the last read is an older window's, the queries return nothing.
   */
  private dataEpoch = -1;

  constructor(
    private device: GPUDevice,
    private epoch?: () => number,
  ) {}

  /** the last read is the window's as it is now */
  fresh(): boolean {
    return !this.epoch || this.epoch() === this.dataEpoch;
  }

  private staleNow(): boolean {
    if (this.fresh()) return false;
    // (a read for the window as it is now, at once)
    if (!this.inFlight) void this.refresh();
    return true;
  }

  /** Mirror a buffer (all of it) under `name`; `paged` (a layers buffer): with ?mirror=near, read by pages near a focus between whole reads. */
  addBuffer(name: string, buffer: GPUBuffer, paged?: Paged): void {
    if (this.sources.some((s) => s.name === name)) return;
    this.sources.push({ name, buffer, offset: this.size, bytes: buffer.size, rowBytes: 0, paged: MIRROR_NEAR ? paged : undefined });
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
    if (this.staleNow()) return undefined;
    return this.data.get(name);
  }

  /** The last read of `name` as f32s (one view a read). */
  f32(name: string): Float32Array | undefined {
    if (this.staleNow()) return undefined;
    let v = this.f32s.get(name);
    if (!v) {
      const b = this.data.get(name);
      if (!b) return undefined;
      v = new Float32Array(b);
      this.f32s.set(name, v);
    }
    return v;
  }

  /** The last read of `name` as u32s (one view a read). */
  u32(name: string): Uint32Array | undefined {
    if (this.staleNow()) return undefined;
    let v = this.u32s.get(name);
    if (!v) {
      const b = this.data.get(name);
      if (!b) return undefined;
      v = new Uint32Array(b);
      this.u32s.set(name, v);
    }
    return v;
  }

  /** the next read is whole (round 100: refresh(true)) */
  private wantWhole = false;

  /**
   * Read everything back; resolves with data read after the call (a read in flight finishes first). `whole`
   * (round 100): every page of the paged sources too — for a caller that needs far columns as they are now.
   */
  async refresh(whole = false): Promise<void> {
    if (whole) this.wantWhole = true;
    while (this.inFlight) await this.inFlight;
    if (!this.size) return;
    this.inFlight = this.read();
    await this.inFlight;
    this.inFlight = null;
  }

  /** (mirror=near) reads since the last whole one, and the staging buffer kept between reads */
  private reads = 0;
  private staging?: GPUBuffer;
  /** bytes copied back so far (scripts read it) */
  readBytes = 0;

  /** a paged source's pages near its focus this read: [byte offset, bytes]; null: the whole of it */
  private pagesNear(s: Source, whole: boolean): [number, number][] | null {
    const p = s.paged;
    if (!p || whole || !this.data.has(s.name)) return null;
    const fs = p.focus();
    if (!fs.length) return null;
    const out: [number, number][] = [];
    const seen = new Set<number>();
    for (const f of fs) {
      const cx0 = Math.max(0, Math.floor((f[0] - NEAR_R) / p.chunk));
      const cx1 = Math.min(p.chunksX - 1, Math.floor((f[0] + NEAR_R) / p.chunk));
      const cy0 = Math.max(0, Math.floor((f[1] - NEAR_R) / p.rowH / p.chunk));
      const cy1 = Math.min(p.chunksY - 1, Math.floor((f[1] + NEAR_R) / p.rowH / p.chunk));
      for (let cy = cy0; cy <= cy1; cy++)
        for (let cx = cx0; cx <= cx1; cx++) {
          const ci = cy * p.chunksX + cx;
          if (seen.has(ci)) continue;
          seen.add(ci);
          out.push([p.chunkTable[ci * 2] * p.slotBytes, p.chunk * p.chunk * p.chunkTable[ci * 2 + 1] * p.slotBytes]);
        }
    }
    return out;
  }

  private async read(): Promise<void> {
    const e0 = this.epoch?.() ?? 0;
    // (the staging buffer kept: a 20 MB buffer made and destroyed every 250 ms otherwise)
    if (!this.staging || this.staging.size < this.size) {
      this.staging?.destroy();
      this.staging = this.device.createBuffer({ label: 'mirror', size: this.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    }
    const tmp = this.staging;
    // (mirror=near: whole every NEAR_FULL reads and after a slide; else the paged sources' near pages)
    const whole = this.reads++ % NEAR_FULL === 0 || !this.fresh() || this.wantWhole;
    if (whole) this.wantWhole = false;
    const near = new Map<Source, [number, number][]>();
    const enc = this.device.createCommandEncoder({ label: 'mirror' });
    for (const s of this.sources) {
      const pages = s.buffer ? this.pagesNear(s, whole) : null;
      if (pages) {
        near.set(s, pages);
        for (const [at, n] of pages) enc.copyBufferToBuffer(s.buffer!, at, tmp, s.offset + at, n);
        this.readBytes += pages.reduce((a, [, n]) => a + n, 0);
        continue;
      }
      this.readBytes += s.bytes;
      if (s.buffer) enc.copyBufferToBuffer(s.buffer, 0, tmp, s.offset, s.bytes);
      else if (s.texture) enc.copyTextureToBuffer({ texture: s.texture }, { buffer: tmp, offset: s.offset, bytesPerRow: s.rowBytes }, [s.texture.width, s.texture.height]);
    }
    this.device.queue.submit([enc.finish()]);
    let straddled = false;
    await tmp.mapAsync(GPUMapMode.READ).then(() => {
      // (the window slid while this was read: its data is part one window's, part another's)
      if (this.epoch && this.epoch() !== e0) {
        straddled = true;
        tmp.unmap();
        return;
      }
      const all = tmp.getMappedRange();
      for (const s of this.sources) {
        const pages = near.get(s);
        if (pages) {
          // (into the copy as it is: its views stay good)
          const dst = new Uint8Array(this.data.get(s.name)!);
          for (const [at, n] of pages) dst.set(new Uint8Array(all, s.offset + at, n), at);
          continue;
        }
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
      // (a paged read keeps its views: they're of the same copy)
      for (const s of this.sources) {
        if (near.has(s)) continue;
        this.f32s.delete(s.name);
        this.u32s.delete(s.name);
      }
      this.gen++;
      this.readAt = performance.now();
      this.dataEpoch = e0;
    }, ignoreTeardown);
    // (once more, for the window as it is now)
    if (straddled) await this.read();
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

  /** the staging buffer let go (the world's gone) */
  destroy(): void {
    this.stop();
    this.staging?.destroy();
    this.staging = undefined;
  }
}
