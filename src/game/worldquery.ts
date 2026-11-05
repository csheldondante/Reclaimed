// (round 128n, phonefix; the user: "I find CPU round trips are stupidly expensive on mobile") The game's questions of
// the world's GPU data, answered by pages read back on demand: the one place in game code that reads the world back
// for a query (test/unit/readers.test.ts holds the others to a list).
//
// Before, the level's world API (api/world.ts) mirrored the window on a timer: 35 MB mapped every 250 ms once the
// fortress's Build attached it (the layers, the levels, the plants, water, fire …), for a few heights and the trees
// near a lumber camp. Now a question names the pages it needs — a 16 × 16 column page of the levels (the open sky's
// floor), the layers (the columns' intervals) or the plants' succession field — and gets its answer from a page read
// since the land there last changed, or null until one is: the page is wanted, and the next `frame()` reads every
// wanted page in one submit and one map (a few KB). A page is stale when an edit, a strike or a column apply touched
// its chunk after it was read (`touch`), or the window slid or warped (`epoch`).
//
// API: QSrc, PageReader, WorldQueryIO, WorldQuery, GpuPages.
import type { Layer } from '../api/terrain';
import { planTree, type Tree } from '../api/plants';
import { materialName, materialState } from '../api/common';
import { cellAt } from '../world/lattice';
import { SLOT_WORDS } from '../world/layout';

/** what a page is of: the levels (the open sky's floor, rgba32float a column), the layers (the columns' intervals), the plants (veg f32) */
export type QSrc = 'levels' | 'layers' | 'veg';

const PAGE = 16;
const PAGE_COLS = PAGE * PAGE;

/** a page asked for: its source and window chunk */
export interface PageAsk {
  src: QSrc;
  cx: number;
  cy: number;
}

/** reads pages back (the GPU's: GpuPages; a test's own) — the bytes of each, in the order asked */
export interface PageReader {
  read(asks: PageAsk[]): Promise<ArrayBuffer[] | null>;
}

export interface WorldQueryIO {
  /** the window's columns */
  dims: { w: number; h: number };
  /** slides and warps: answers read before another epoch are dropped */
  epoch(): number;
  /** a layers chunk's slots a column (its K) */
  kOf(cx: number, cy: number): number;
  /** the world origin (columns) — the trees' layout is the world's (planTree) */
  origin(): [number, number];
  reader: PageReader;
}

interface Page {
  data: ArrayBuffer;
  /** the touch count when it was asked for */
  at: number;
  epoch: number;
}

export class WorldQuery {
  private pages = new Map<string, Page>();
  /** per chunk: the touch count when the land there last changed */
  private dirty = new Map<number, number>();
  private touches = 1;
  private wanted = new Map<string, PageAsk>();
  private inFlight = false;
  /** reads completed (the quarry's "a read since": groundRead) */
  gen = 0;
  readonly stats = { reads: 0, pages: 0, bytes: 0, dropped: 0 };

  constructor(private io: WorldQueryIO) {}

  private key(src: QSrc, cx: number, cy: number): string {
    return `${src}:${cx},${cy}`;
  }

  /** the page holding column (x, y) of `src` if it's as the land is now, else null (and wanted) */
  private page(src: QSrc, cx: number, cy: number): ArrayBuffer | null {
    const { w, h } = this.io.dims;
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) return null;
    const px = cx >> 4;
    const py = cy >> 4;
    const k = this.key(src, px, py);
    const p = this.pages.get(k);
    const changed = this.dirty.get(py * 65536 + px) ?? 0;
    if (p && p.epoch === this.io.epoch() && p.at >= changed) return p.data;
    this.wanted.set(k, { src, cx: px, cy: py });
    return null;
  }

  /**
   * The land changed within `r` of window world (x, y) (an edit, a strike), or everywhere (no arguments: a column
   * apply — claims, a stamp): the pages there are read again when next asked.
   */
  touch(x?: number, y?: number, r = 0): void {
    this.touches++;
    if (x === undefined || y === undefined) {
      // (everything: each page is older than this)
      for (const k of this.pages.keys()) {
        const [, xy] = k.split(':');
        const [px, py] = xy.split(',').map(Number);
        this.dirty.set(py * 65536 + px, this.touches);
      }
      return;
    }
    const [c0x, c0y] = cellAt(x - r, y - r);
    const [c1x, c1y] = cellAt(x + r, y + r);
    for (let py = Math.max(0, (Math.min(c0y, c1y) - 1) >> 4); py <= (Math.max(c0y, c1y) + 1) >> 4; py++)
      for (let px = Math.max(0, (Math.min(c0x, c1x) - 1) >> 4); px <= (Math.max(c0x, c1x) + 1) >> 4; px++) this.dirty.set(py * 65536 + px, this.touches);
  }

  /** The open sky's floor at window world (x, y) — the ground, loose ground on it, or a structure's top (api/terrain.ts heightAt) — or null until read. */
  heightAt(x: number, y: number): number | null {
    const [cx, cy] = cellAt(x, y);
    const d = this.page('levels', cx, cy);
    if (!d) return null;
    return new Float32Array(d)[((cy & 15) * PAGE + (cx & 15)) * 4];
  }

  /** The column's layers at window world (x, y), bottom up, or null until read. */
  layersAt(x: number, y: number): Layer[] | null {
    const [cx, cy] = cellAt(x, y);
    const d = this.page('layers', cx, cy);
    if (!d) return null;
    const K = this.io.kOf(cx >> 4, cy >> 4);
    const u = new Uint32Array(d);
    const f = new Float32Array(d);
    const out: Layer[] = [];
    const base = ((cy & 15) * PAGE + (cx & 15)) * K;
    for (let s = 0; s < K; s++) {
      const o = (base + s) * SLOT_WORDS;
      if (u[o + 1] === 0) break;
      const m = u[o + 2] & 0xff;
      out.push({ z0: f[o], z1: f[o + 1], material: materialName(m), state: materialState(m) });
    }
    return out;
  }

  /** The trees within `radius` of window world (x, y), nearest first (api/plants.ts treesNear), or null until every page round it is read. */
  treesNear(x: number, y: number, radius: number): Tree[] | null {
    const { w, h } = this.io.dims;
    const [c0x, c0y] = cellAt(x, y);
    const r = Math.ceil(radius * 1.2) + 1;
    const x0 = Math.max(0, c0x - r);
    const x1 = Math.min(w - 1, c0x + r);
    const y0 = Math.max(0, c0y - r);
    const y1 = Math.min(h - 1, c0y + r);
    // (every page first: all wanted together, one read)
    let missing = false;
    for (let py = y0 >> 4; py <= y1 >> 4; py++) for (let px = x0 >> 4; px <= x1 >> 4; px++) if (!this.page('veg', px << 4, py << 4)) missing = true;
    if (missing) return null;
    const org = this.io.origin();
    const out: (Tree & { d: number })[] = [];
    for (let cy = y0; cy <= y1; cy++)
      for (let cx = x0; cx <= x1; cx++) {
        const v = new Float32Array(this.page('veg', cx, cy)!)[(cy & 15) * PAGE + (cx & 15)];
        const t = planTree(cx, cy, v, w, h, org);
        if (!t) continue;
        const d = Math.hypot(t.x - x, t.y - y);
        if (d <= radius) out.push({ ...t, d });
      }
    return out.sort((a, b) => a.d - b.d).map(({ d: _d, ...t }) => t);
  }

  /** Each frame: the pages wanted since the last read, read in one go (one at a time in flight). */
  frame(): void {
    if (this.inFlight || !this.wanted.size) return;
    const asks = [...this.wanted.values()];
    const keys = [...this.wanted.keys()];
    this.wanted.clear();
    const epoch = this.io.epoch();
    const at = this.touches;
    this.inFlight = true;
    void this.io.reader.read(asks).then(
      (datas) => {
        this.inFlight = false;
        if (!datas) return;
        this.gen++;
        this.stats.reads++;
        // (the window slid while it was read: what came back is of the window that was)
        if (this.io.epoch() !== epoch) {
          this.stats.dropped++;
          return;
        }
        datas.forEach((data, i) => {
          this.pages.set(keys[i], { data, at, epoch });
          this.stats.pages++;
          this.stats.bytes += data.byteLength;
        });
      },
      (e) => {
        this.inFlight = false;
        throw e;
      },
    );
  }

  /** the pages kept (a slide makes them all stale; they're dropped as they're asked again) */
  get kept(): number {
    return this.pages.size;
  }
}

/** what GpuPages reads: the window's buffers and textures, and where a window chunk's page lies in each */
export interface GpuPagesIO {
  device: GPUDevice;
  levels: () => GPUTexture;
  layers: () => GPUBuffer;
  veg: () => GPUBuffer;
  /** a per-column buffer's / texel-a-column texture's slot for window chunk (cx, cy) (sim/pages.ts Pages.slot) */
  slot(cx: number, cy: number): number;
  /** that slot's first texel in the textures (Pages.texPage) */
  texPage(s: number): [number, number];
  /** a layers chunk's first slot and K (render/layout PackedWorld's chunk table) */
  chunk(cx: number, cy: number): [number, number];
}

/** The pages read back from the GPU: one encoder, one staging buffer kept between reads, one map of the bytes used. */
export class GpuPages implements PageReader {
  private staging?: GPUBuffer;

  constructor(private io: GpuPagesIO) {}

  async read(asks: PageAsk[]): Promise<ArrayBuffer[] | null> {
    const { device } = this.io;
    const sizes = asks.map((a) => this.bytes(a));
    const offs: number[] = [];
    let used = 0;
    for (const n of sizes) {
      offs.push(used);
      used += Math.ceil(n / 256) * 256;
    }
    if (!this.staging || this.staging.size < used) {
      this.staging?.destroy();
      this.staging = device.createBuffer({ label: 'worldquery', size: Math.max(used, 64 * 1024), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    }
    const st = this.staging;
    const enc = device.createCommandEncoder({ label: 'worldquery' });
    asks.forEach((a, i) => {
      const s = this.io.slot(a.cx, a.cy);
      if (a.src === 'veg') enc.copyBufferToBuffer(this.io.veg(), s * PAGE_COLS * 4, st, offs[i], sizes[i]);
      else if (a.src === 'layers') {
        const [first] = this.io.chunk(a.cx, a.cy);
        enc.copyBufferToBuffer(this.io.layers(), first * SLOT_WORDS * 4, st, offs[i], sizes[i]);
      } else {
        const [tx, ty] = this.io.texPage(s);
        enc.copyTextureToBuffer({ texture: this.io.levels(), origin: [tx, ty] }, { buffer: st, offset: offs[i], bytesPerRow: PAGE * 16 }, [PAGE, PAGE]);
      }
    });
    device.queue.submit([enc.finish()]);
    try {
      await st.mapAsync(GPUMapMode.READ, 0, used);
    } catch {
      // (the device or the buffer went: the scene is being torn down)
      return null;
    }
    const all = st.getMappedRange(0, used);
    const out = asks.map((_, i) => all.slice(offs[i], offs[i] + sizes[i]));
    st.unmap();
    return out;
  }

  private bytes(a: PageAsk): number {
    if (a.src === 'veg') return PAGE_COLS * 4;
    if (a.src === 'levels') return PAGE_COLS * 16;
    return PAGE_COLS * this.io.chunk(a.cx, a.cy)[1] * SLOT_WORDS * 4;
  }
}
