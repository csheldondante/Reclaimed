// A CPU mirror of some world buffers and textures (docs/WORLD_API.md): the world modules answer their queries from
// it, so a game never reads a GPU buffer or decodes a packed format itself.
//
// (round 128o, DA-B1 — the user: "performance on mobile was abysmal and could not be played"; DESIGN.md §24: no timed
// GPU→CPU readback in play, small async reads only after edits or events) It is read by pages, on demand. A query names
// the column it reads; the 16 × 16 page holding it is
//   - unread: the query gets nothing (null: "not read yet", never "nothing there"), and the page is wanted;
//   - current: read since its chunk last changed;
//   - stale: read, but its chunk has changed since: the query gets the page as last read, and the page is wanted.
// The pages wanted are read together a frame later: one submit, one map, the bytes of those pages (a few KB). A chunk
// changes while the sim runs it, awake or drowsy (sim/sleep.ts is the one place that knows; told each tick: `tick`),
// and when a column apply writes the columns (claims, stamps: `touchAll`). A slide or a warp (the window's epoch) makes
// every page unread. Before (round 128n), the level's mirror read everything on a 250 ms timer once anything used the
// world API: 35 MB mapped every 250 ms, 139 MB/s, from the fortress's first Build or first painted cell.
//
// `refresh()` reads every page now (a tool or a test that wants the whole window as it is); `start(ms)` does that on a
// timer, only for a world made by createSim (api/world.ts).
//
// API: Mirror, MirrorIO, PageReader, PageAsk, SourceKind, GpuPageReader, RingPages.

import { ignoreTeardown } from '../gpu/pipeline';

/** columns a page side (sim/pages.ts COLS_PAGE, world/layout.ts CHUNK) */
const P = 16;
const PAGE_COLS = P * P;
/** bytes a texel of an rgba32float texture */
const TEXEL = 16;

/** (Terrain.keepFresh) how far round a kept point its pages are read before anything asks (cells): a hero's next steps */
const KEEP_R = 48;

/** the window's page table (sim/pages.ts Pages): where each window chunk's data lies */
export interface RingPages {
  readonly nx: number;
  readonly ny: number;
  slot(cx: number, cy: number): number;
  texPage(s: number): [number, number];
}

/**
 * How a source lies:
 *   cols   a per-column buffer, page-major (sim/pages.ts): a page is `stride` bytes a column, at its slot
 *   slots  the layers: a chunk's columns' slots, `slotBytes` each, K a column (the chunk table: [first slot, K])
 *   tex    an rgba32float texture, a texel a column: a page is the 16 × 16 texels at its slot's place (texPage)
 *   whole  a texture of its own layout (the wind's, a texel per 2 × 2 columns): read whole whenever it's asked; it
 *          changes everywhere every tick (the wind runs in sleeping chunks too)
 */
export type SourceKind =
  | { kind: 'cols'; stride: number }
  | { kind: 'slots'; slotBytes: number; chunkTable: Uint32Array; chunksX: number }
  | { kind: 'tex' }
  | { kind: 'whole' };

interface Source {
  name: string;
  layout: SourceKind;
  gpu: () => GPUBuffer | GPUTexture;
  /** the CPU copy, laid out as the GPU's (a texture's: rows of its width, unpadded) */
  data: ArrayBuffer;
  f32: Float32Array;
  u32: Uint32Array;
  /** per window chunk (cy * nx + cx; one entry for `whole`): the clock it was read at, and the window's epoch then (-1: unread) */
  readStamp: Float64Array;
  readEpoch: Float64Array;
}

/** a page to read: its source and window chunk (0, 0 for a `whole` source) */
export interface PageAsk {
  name: string;
  layout: SourceKind;
  gpu: () => GPUBuffer | GPUTexture;
  cx: number;
  cy: number;
}

/**
 * Reads pages back: the bytes of each, in the order asked, laid out as a page of the source is (cols and slots: the
 * page's bytes; tex: 16 rows of 16 texels; whole: the texture's rows padded to 256 bytes). Null: the device went.
 */
export interface PageReader {
  read(asks: PageAsk[], ring: RingPages): Promise<ArrayBuffer[] | null>;
  destroy?(): void;
}

export interface MirrorIO {
  reader: PageReader;
  ring: RingPages;
  /** the window's columns */
  dims: { w: number; h: number };
  /** slides and warps (WorldCore.windowEpoch): pages read before another epoch are unread */
  epoch?: () => number;
  /** how a read is set going once pages are wanted (default: the next animation frame) */
  schedule?: (fn: () => void) => void;
}

/** a source's CPU copy's bytes */
function sourceBytes(layout: SourceKind, gpu: GPUBuffer | GPUTexture, dims: { w: number; h: number }): number {
  if (layout.kind === 'cols' || layout.kind === 'slots') return (gpu as GPUBuffer).size;
  if (layout.kind === 'tex') return dims.w * dims.h * TEXEL;
  const t = gpu as GPUTexture;
  return t.width * t.height * TEXEL;
}

export class Mirror {
  private sources = new Map<string, Source>();
  /** per slot: the clock at the last tick its chunk ran (awake or drowsy), or the last column apply */
  private live: Float64Array;
  /** bumped every tick and every column apply; a page read is stamped with it */
  private clock = 1;
  private wanted = new Map<string, PageAsk>();
  private scheduled = false;
  private inFlight: Promise<void> | null = null;
  /** points whose pages are read before anything asks (Terrain.keepFresh) */
  private kept: (() => readonly number[] | null)[] = [];
  /** bumped every read: a module's own caches of derived values key on it */
  gen = 0;
  /** performance.now() of the last completed read (0: never) */
  readAt = 0;
  /** reads made, pages and bytes read back, reads dropped by a slide (scripts and tests read them) */
  readonly stats = { reads: 0, pages: 0, bytes: 0, dropped: 0 };
  private timer = 0;

  constructor(private io: MirrorIO) {
    this.live = new Float64Array(io.ring.nx * io.ring.ny);
  }

  private get epoch(): number {
    return this.io.epoch?.() ?? 0;
  }

  /** the window's epoch at the last read placed (-1: none) */
  private lastEpoch = -1;

  /** a read has been placed since the window last slid or warped (scripts wait on it) */
  fresh(): boolean {
    return this.lastEpoch === this.epoch;
  }

  /** Mirror a per-column buffer, page-major (sim/pages.ts COLUMN_BUFS: `stride` bytes a column). */
  addColumns(name: string, gpu: () => GPUBuffer, stride: number): void {
    this.add(name, { kind: 'cols', stride }, gpu);
  }

  /** Mirror the layers (render/layout PackedWorld: its chunk table, `slotBytes` a slot). */
  addSlots(name: string, gpu: () => GPUBuffer, slotBytes: number, chunkTable: Uint32Array, chunksX: number): void {
    this.add(name, { kind: 'slots', slotBytes, chunkTable, chunksX }, gpu);
  }

  /** Mirror an rgba32float texture, a texel a column on the window's pages (levels, drift). */
  addTexture(name: string, gpu: () => GPUTexture): void {
    this.add(name, { kind: 'tex' }, gpu);
  }

  /** Mirror an rgba32float texture of its own layout, read whole when asked (the wind field). */
  addWhole(name: string, gpu: () => GPUTexture): void {
    this.add(name, { kind: 'whole' }, gpu);
  }

  private add(name: string, layout: SourceKind, gpu: () => GPUBuffer | GPUTexture): void {
    if (this.sources.has(name)) return;
    const n = layout.kind === 'whole' ? 1 : this.io.ring.nx * this.io.ring.ny;
    const s = { name, layout, gpu, readStamp: new Float64Array(n), readEpoch: new Float64Array(n) } as Source;
    this.alloc(s);
    this.sources.set(name, s);
  }

  /** the CPU copy made (again: the GPU's buffer grew — a repack): every page unread */
  private alloc(s: Source): void {
    s.data = new ArrayBuffer(sourceBytes(s.layout, s.gpu(), this.io.dims));
    s.f32 = new Float32Array(s.data);
    s.u32 = new Uint32Array(s.data);
    s.readEpoch.fill(-1);
  }

  /**
   * A sim tick ran: every chunk it ran (not asleep, or drowsy: Globals.sleep / Globals.drowse, a bit a slot, set:
   * asleep / just fallen asleep) may have changed. No mask: every chunk ran.
   */
  tick(asleep?: Uint32Array, drowse?: Uint32Array, settling?: Uint32Array): void {
    const c = ++this.clock;
    for (let s = 0; s < this.live.length; s++) {
      const sleeping = asleep !== undefined && (asleep[s >> 5] & (1 << (s & 31))) !== 0;
      const drowsy = drowse !== undefined && (drowse[s >> 5] & (1 << (s & 31))) !== 0;
      // (round 128o: maybe still settling its water — the GPU decides whether it ran: counted as run)
      const held = settling !== undefined && (settling[s >> 5] & (1 << (s & 31))) !== 0;
      if (!sleeping || drowsy || held) this.live[s] = c;
    }
  }

  /** The columns were written outside a tick (game/colapply.ts: claims, stamps): every page may have changed. */
  touchAll(): void {
    this.live.fill(++this.clock);
  }

  /**
   * The CPU copy of `name` as f32s if window column (cx, cy)'s page has been read in this window (stale or not), else
   * undefined. Asks for the page when it's unread or stale. (A `whole` source ignores the column.)
   */
  f32(name: string, cx: number, cy: number): Float32Array | undefined {
    return this.at(name, cx, cy)?.f32;
  }

  /** The same, as u32s. */
  u32(name: string, cx: number, cy: number): Uint32Array | undefined {
    return this.at(name, cx, cy)?.u32;
  }

  private at(name: string, cx: number, cy: number): Source | undefined {
    const s = this.sources.get(name);
    if (!s) throw new Error(`mirror: no source "${name}"`);
    if (s.layout.kind === 'whole') return this.check(s, 0, 0, 0) ? s : undefined;
    const { w, h } = this.io.dims;
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) return undefined;
    const px = cx >> 4;
    const py = cy >> 4;
    return this.check(s, px, py, py * this.io.ring.nx + px) ? s : undefined;
  }

  /** page (px, py) of s (chunk index k): read in this window? Wanted when unread or stale. */
  private check(s: Source, px: number, py: number, k: number): boolean {
    const known = s.readEpoch[k] === this.epoch;
    const current = known && s.layout.kind !== 'whole' && this.live[this.io.ring.slot(px, py)] <= s.readStamp[k];
    if (!current) this.want(s, px, py);
    return known;
  }

  private want(s: Source, cx: number, cy: number): void {
    const key = `${s.name}:${cx},${cy}`;
    if (this.wanted.has(key)) return;
    this.wanted.set(key, { name: s.name, layout: s.layout, gpu: s.gpu, cx, cy });
    this.kick();
  }

  private kick(): void {
    if (this.scheduled || this.inFlight) return;
    this.scheduled = true;
    (this.io.schedule ?? ((fn) => requestAnimationFrame(fn)))(() => {
      this.scheduled = false;
      if (!this.inFlight && this.wanted.size) void this.launch();
    });
  }

  /** a read of the pages wanted now; once it's done, the next is set going for those wanted meanwhile */
  private launch(): Promise<void> {
    const p = this.read().finally(() => {
      this.inFlight = null;
      if (this.wanted.size) this.kick();
    });
    this.inFlight = p;
    return p;
  }

  /**
   * Keep the pages round `at()` (world units; rows `rowH` apart) read before anything asks: a hero's next steps known
   * as it walks. Not kept current: a query asks for that. Returns its removal.
   */
  keepKnown(at: () => readonly number[] | null, rowH: number): () => void {
    const f = () => {
      const p = at();
      return p ? [p[0], p[1] / rowH] : null;
    };
    this.kept.push(f);
    this.wantKept();
    return () => {
      const i = this.kept.indexOf(f);
      if (i >= 0) this.kept.splice(i, 1);
    };
  }

  /** the kept points' unread pages wanted */
  private wantKept(): void {
    const { w, h } = this.io.dims;
    for (const f of this.kept) {
      const p = f();
      if (!p) continue;
      const x0 = Math.max(0, Math.floor((p[0] - KEEP_R) / P));
      const x1 = Math.min((w >> 4) - 1, Math.floor((p[0] + KEEP_R) / P));
      const y0 = Math.max(0, Math.floor((p[1] - KEEP_R) / P));
      const y1 = Math.min((h >> 4) - 1, Math.floor((p[1] + KEEP_R) / P));
      for (const s of this.sources.values()) {
        if (s.layout.kind === 'whole') continue;
        for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) if (s.readEpoch[py * this.io.ring.nx + px] !== this.epoch) this.want(s, px, py);
      }
    }
  }

  /** Read every page of every source now; resolves once it's in (a read in flight finishes first). */
  async refresh(): Promise<void> {
    while (this.inFlight) await this.inFlight;
    const { w, h } = this.io.dims;
    for (const s of this.sources.values()) {
      if (s.layout.kind === 'whole') this.want(s, 0, 0);
      else for (let py = 0; py < h >> 4; py++) for (let px = 0; px < w >> 4; px++) this.want(s, px, py);
    }
    if (!this.wanted.size) return;
    await this.launch();
  }

  private async read(): Promise<void> {
    this.wantKept();
    // (a repack grew a buffer: its copy made again, its pages unread — and asked again below if they were wanted)
    for (const s of this.sources.values()) if (sourceBytes(s.layout, s.gpu(), this.io.dims) !== s.data.byteLength) this.alloc(s);
    const asks = [...this.wanted.values()];
    this.wanted.clear();
    const e0 = this.epoch;
    const stamp = this.clock;
    const datas = await this.io.reader.read(asks, this.io.ring);
    if (!datas) return;
    this.stats.reads++;
    // (the window slid while this was read: what came back is of the window that was; asked again when needed)
    if (this.epoch !== e0) {
      this.stats.dropped++;
      return;
    }
    asks.forEach((a, i) => this.place(this.sources.get(a.name)!, a, datas[i], stamp, e0));
    this.lastEpoch = e0;
    this.gen++;
    this.readAt = performance.now();
  }

  /** a page's bytes into the CPU copy, where the GPU holds them */
  private place(s: Source, a: PageAsk, d: ArrayBuffer, stamp: number, epoch: number): void {
    const dst = new Uint8Array(s.data);
    const src = new Uint8Array(d);
    const L = s.layout;
    if (L.kind === 'cols') dst.set(src, this.io.ring.slot(a.cx, a.cy) * PAGE_COLS * L.stride);
    else if (L.kind === 'slots') dst.set(src, L.chunkTable[(a.cy * L.chunksX + a.cx) * 2] * L.slotBytes);
    else if (L.kind === 'tex') {
      const [tx, ty] = this.io.ring.texPage(this.io.ring.slot(a.cx, a.cy));
      const W = this.io.dims.w;
      for (let r = 0; r < P; r++) dst.set(src.subarray(r * P * TEXEL, (r + 1) * P * TEXEL), ((ty + r) * W + tx) * TEXEL);
    } else {
      const t = s.gpu() as GPUTexture;
      const row = t.width * TEXEL;
      const padded = Math.ceil(row / 256) * 256;
      for (let r = 0; r < t.height; r++) dst.set(src.subarray(r * padded, r * padded + row), r * row);
    }
    const k = L.kind === 'whole' ? 0 : a.cy * this.io.ring.nx + a.cx;
    s.readStamp[k] = stamp;
    s.readEpoch[k] = epoch;
    this.stats.pages++;
    this.stats.bytes += d.byteLength;
  }

  /** (createSim's worlds: no level frame of their own) every page read again every `ms` until stop() */
  start(ms: number): this {
    this.stop();
    void this.refresh();
    this.timer = window.setInterval(() => {
      if (!this.inFlight) void this.refresh();
    }, ms);
    return this;
  }

  stop(): void {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = 0;
  }

  /** the reader's staging let go (the world's gone) */
  destroy(): void {
    this.stop();
    this.io.reader.destroy?.();
  }
}

/** The pages read back from the GPU: one encoder, one staging buffer kept between reads, one map of the bytes asked. */
export class GpuPageReader implements PageReader {
  private staging?: GPUBuffer;

  constructor(private device: GPUDevice) {}

  async read(asks: PageAsk[], ring: RingPages): Promise<ArrayBuffer[] | null> {
    const sizes = asks.map((a) => this.bytes(a));
    const offs: number[] = [];
    let used = 0;
    for (const n of sizes) {
      offs.push(used);
      used += Math.ceil(n / 256) * 256;
    }
    if (!this.staging || this.staging.size < used) {
      this.staging?.destroy();
      this.staging = this.device.createBuffer({ label: 'mirror pages', size: Math.max(used, 64 * 1024), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    }
    const st = this.staging;
    const enc = this.device.createCommandEncoder({ label: 'mirror pages' });
    asks.forEach((a, i) => {
      const L = a.layout;
      if (L.kind === 'cols') enc.copyBufferToBuffer(a.gpu() as GPUBuffer, ring.slot(a.cx, a.cy) * PAGE_COLS * L.stride, st, offs[i], sizes[i]);
      else if (L.kind === 'slots') enc.copyBufferToBuffer(a.gpu() as GPUBuffer, L.chunkTable[(a.cy * L.chunksX + a.cx) * 2] * L.slotBytes, st, offs[i], sizes[i]);
      else if (L.kind === 'tex') {
        const [tx, ty] = ring.texPage(ring.slot(a.cx, a.cy));
        enc.copyTextureToBuffer({ texture: a.gpu() as GPUTexture, origin: [tx, ty] }, { buffer: st, offset: offs[i], bytesPerRow: P * TEXEL }, [P, P]);
      } else {
        const t = a.gpu() as GPUTexture;
        enc.copyTextureToBuffer({ texture: t }, { buffer: st, offset: offs[i], bytesPerRow: Math.ceil((t.width * TEXEL) / 256) * 256 }, [t.width, t.height]);
      }
    });
    this.device.queue.submit([enc.finish()]);
    try {
      await st.mapAsync(GPUMapMode.READ, 0, used);
    } catch (e) {
      // (the device or the buffer went: the scene is being torn down)
      ignoreTeardown(e);
      return null;
    }
    const all = st.getMappedRange(0, used);
    const out = asks.map((_, i) => all.slice(offs[i], offs[i] + sizes[i]));
    st.unmap();
    return out;
  }

  private bytes(a: PageAsk): number {
    const L = a.layout;
    if (L.kind === 'cols') return PAGE_COLS * L.stride;
    if (L.kind === 'slots') return PAGE_COLS * L.chunkTable[(a.cy * L.chunksX + a.cx) * 2 + 1] * L.slotBytes;
    if (L.kind === 'tex') return PAGE_COLS * TEXEL;
    const t = a.gpu() as GPUTexture;
    return Math.ceil((t.width * TEXEL) / 256) * 256 * t.height;
  }

  destroy(): void {
    this.staging?.destroy();
    this.staging = undefined;
  }
}
