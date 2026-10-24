// The streamed world (round 66, BACKLOG Q28): the live world is a window of
// W × H columns onto land without an edge. When the camera nears the
// window's edge the window slides a region (REGION columns) that way:
//  - the regions leaving it are frozen: everything the world keeps per column
//    (the layers' chunk pages and every field that isn't derived each tick)
//    is copied out to a staging buffer and read back into `frozen`;
//  - everything per column on the GPU moves a region over (copies through a
//    scratch buffer; the textures through a scratch texture), and so does
//    what the CPU keeps in window coordinates (the camera, the weather, the
//    map's surface heights; the level shifts its own through onSlide);
//  - the layers don't move: every chunk has the same depth K, so the chunk
//    table is a page table — the chunks that left give their pages to the
//    ones coming in;
//  - the regions coming in are thawed from `frozen` exactly as they were
//    left, or generated the first time they're seen, by the level's
//    LandSource (world/streamgen.ts's noise, or the atlas: round 67), all of
//    a slide's asked for at once.
// Frozen regions don't tick (deferred or coarse ticks are the next step).
// The sim waits while a slide is `busy` (only when a region coming in is
// still being read back from its last visit).

import { CHUNK, SLOT_WORDS, packColumn } from '../world/layout';
import { ROW_H } from '../world/lattice';
import { PROJ_K } from '../grids/structures';
import { generateRegion, type RegionLand } from '../world/streamgen';
import type { WorldCore } from './world-core';

/** columns a side of a region: what the window slides by (whole chunks, an even number of rows) */
export const REGION = 64;

/** Where new land comes from: a region of w × h world cells from (x0, y0), y0 even. */
export interface LandSource {
  region(x0: number, y0: number, w: number, h: number, zMax: number): Promise<RegionLand>;
  /** the world's size in cells when it wraps (a torus: frozen regions are kept by where they are on it) */
  wrap?: [number, number];
}

/** round 66's land: noise of world position (world/streamgen.ts), without an edge */
export const noiseLand = (seed = 1): LandSource => ({
  region: async (x0, y0, w, h, zMax) => generateRegion(x0, y0, w, h, zMax, seed),
});

/** a per-column buffer: `stride` bytes a column, in `planes` w × h arrays; kept = frozen with its region */
interface ColBuf {
  name: string;
  buf: GPUBuffer;
  stride: number;
  planes: number;
  keep: boolean;
}

/** a per-column texture: `per` texels across a column (proj), or one texel per `div` × `div` columns (the wind) */
interface ColTex {
  name: string;
  tex: GPUTexture;
  per: number;
  div: number;
  keep: boolean;
  /** what a column coming in starts with (default 0) */
  fill?: [number, number, number, number];
}

/** a region as it was left */
interface Frozen {
  /** (generated only) the box (region cells) round what the structural system should judge */
  judge?: [number, number, number, number];
  /** its chunks' pages, chunk by chunk (row-major in the region) */
  layers: Uint32Array;
  /** each kept buffer's columns: per plane, REGION rows of REGION × stride bytes */
  bufs: Record<string, Uint8Array>;
  /** each kept texture's texels, rows of the region's width (rgba32float) */
  texs: Record<string, Float32Array>;
  surface: Float32Array;
}

export interface SlideStats {
  slides: number;
  frozen: number;
  generated: number;
  thawed: number;
  /** of those generated, how many were ready before the slide (prefetch) */
  prefetched: number;
  /** the last slide: ms from start to the regions coming in written */
  lastMs: number;
}

export class Streamer {
  readonly W: number;
  readonly H: number;
  readonly R = REGION;
  /** the world cell of window column 0, row 0 */
  readonly origin: [number, number] = [0, 0];
  /** regions out of the window, as they were left ("rx,ry" in regions) */
  readonly frozen = new Map<string, Frozen | Promise<Frozen>>();
  busy = false;
  /** slide on its own as the camera nears the edge (tests turn it off to slide by hand) */
  auto = true;
  readonly stats: SlideStats = { slides: 0, frozen: 0, generated: 0, thawed: 0, prefetched: 0, lastMs: 0 };
  /** called after each slide with the shift in columns (the window moved by dx, dy: content moved by −dx, −dy) */
  readonly onSlide: ((dx: number, dy: number) => void)[] = [];
  /** called when land comes into the window that the structural system should judge: the box (window cells) round it */
  readonly onArrive: ((x0: number, y0: number, x1: number, y1: number) => void)[] = [];
  private bufs: ColBuf[];
  private texs: ColTex[];
  private scratch: GPUBuffer;
  private scratchTex = new Map<string, GPUTexture>();
  /** slots a chunk page holds (every chunk has the same K) */
  private pageSlots: number;
  private K: number;

  constructor(
    private core: WorldCore,
    private source: LandSource = noiseLand(),
    origin: [number, number] = [0, 0],
  ) {
    const { w, h } = core.dims;
    if (origin[0] % REGION || origin[1] % REGION) throw new Error(`the window's origin must be whole regions of ${REGION}`);
    this.origin[0] = origin[0];
    this.origin[1] = origin[1];
    core.globals.origin = [origin[0], origin[1]];
    const R = this.R;
    if (w % R || h % R) throw new Error(`the window (${w} × ${h}) must be whole regions of ${R}`);
    this.W = w;
    this.H = h;
    const t = core.packed.chunkTable;
    this.K = t[1];
    for (let c = 0; c < t.length / 2; c++) if (t[c * 2 + 1] !== this.K) throw new Error('a streamed world needs the same K in every chunk');
    this.pageSlots = this.K * CHUNK * CHUNK;
    const wg = core.world;
    const b = (name: keyof typeof wg, stride: number, keep: boolean, planes = 1): ColBuf => ({ name, buf: wg[name] as GPUBuffer, stride, planes, keep });
    this.bufs = [
      // the world's state: frozen with its region
      b('water', 4, true),
      b('waterSource', 4, true),
      b('oil', 4, true),
      b('oilStored', 8, true),
      b('lava', 16, true),
      b('contam', 8, true),
      b('moisture', 4, true),
      b('veg', 4, true),
      b('fire', 4, true),
      b('petals', 4, true),
      b('wilt', 16, true),
      b('bend', 16, true),
      // in flight or derived: moved with the window so nothing jumps for a tick
      b('surface', 4, false),
      b('waterNext', 4, false),
      b('waterPrev', 4, false),
      b('flux', 24, false),
      b('oilNext', 4, false),
      b('oilFlux', 24, false),
      b('lavaNext', 16, false),
      b('lavaFlux', 24, false),
      b('contamNext', 8, false),
      b('moistureNext', 4, false),
      b('vegNext', 4, false),
      b('fireNext', 4, false),
      b('renderFields', 16, false),
      b('deposit', 16, false),
      b('contamDelta', 4, false, 2),
      b('physCols', 32, false),
      b('places', 4, false),
    ];
    const tx = (name: keyof typeof wg, keep: boolean, per = 1, div = 1, fill?: ColTex['fill']): ColTex => ({ name, tex: wg[name] as GPUTexture, per, div, keep, fill });
    const none: ColTex['fill'] = [-1, 0, 0, 0];
    this.texs = [
      tx('shake', true),
      tx('lavaSpring', true),
      tx('drift', false),
      tx('air', false),
      tx('strata', false),
      tx('levels', false),
      tx('bodyProj', false, 1, 1, none),
      tx('bodyCpu', false, 1, 1, none),
      tx('foreign', false),
      tx('proj', false, PROJ_K),
      tx('sparkTex', false),
      tx('editState', false),
      tx('editStateNext', false),
      tx('windField', false, 1, 2),
      tx('windFieldNext', false, 1, 2),
    ];
    for (const x of this.bufs) if (x.buf.size < w * h * x.stride * x.planes) throw new Error(`${x.name}: ${x.buf.size} bytes, not ${x.stride} a column`);
    const big = Math.max(...this.bufs.map((x) => x.buf.size));
    this.scratch = wg.buf('streamScratch', big, GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
  }

  /** The world cell under window cell (x, y). */
  toWorld(x: number, y: number): [number, number] {
    return [x + this.origin[0], y + this.origin[1]];
  }

  /** land asked for ahead of a slide, by region key */
  private pending = new Map<string, Promise<Frozen>>();

  /** Slide when the camera has come within 1¼ regions of the window's edge (one axis a call);
   *  ask for the land of the slide it's heading for once it's halfway there. */
  update(): Promise<void> | null {
    if (this.busy || !this.auto) return null;
    const [x, yw] = this.core.camera.target;
    const y = yw / ROW_H;
    const R = this.R;
    const reach = R * 0.75;
    const near = R * 0.4;
    if (x > this.W / 2 + near) this.prefetch(R, 0);
    if (x < this.W / 2 - near) this.prefetch(-R, 0);
    if (y > this.H / 2 + near) this.prefetch(0, R);
    if (y < this.H / 2 - near) this.prefetch(0, -R);
    if (x > this.W / 2 + reach) return this.slide(R, 0);
    if (x < this.W / 2 - reach) return this.slide(-R, 0);
    if (y > this.H / 2 + reach) return this.slide(0, R);
    if (y < this.H / 2 - reach) return this.slide(0, -R);
    return null;
  }

  /** Move the window by (dx, dy) columns (one of them ±REGION, the other 0). */
  async slide(dx: number, dy: number): Promise<void> {
    if ((dx !== 0) === (dy !== 0) || Math.abs(dx + dy) !== this.R) throw new Error('a slide is one region along one axis');
    this.busy = true;
    const t0 = performance.now();
    try {
      await this.slideNow(dx, dy);
    } finally {
      this.busy = false;
    }
    this.stats.slides++;
    this.stats.lastMs = +(performance.now() - t0).toFixed(1);
  }

  private key(rx: number, ry: number): string {
    const w = this.source.wrap;
    if (w) {
      const nx = w[0] / this.R;
      const ny = w[1] / this.R;
      rx = ((rx % nx) + nx) % nx;
      ry = ((ry % ny) + ny) % ny;
    }
    return `${rx},${ry}`;
  }

  /** the regions coming in with a slide of (dx, dy), as [local x, local y] corners in the window after it */
  private enteringFor(dx: number, dy: number): [number, number][] {
    const { W, H } = this;
    return dx > 0 ? this.strip(W - dx, W, 0, H) : dx < 0 ? this.strip(0, -dx, 0, H) : dy > 0 ? this.strip(0, W, H - dy, H) : this.strip(0, W, 0, -dy);
  }

  /** Start making the land a slide of (dx, dy) would bring in (what's frozen needs nothing). */
  prefetch(dx: number, dy: number): void {
    const R = this.R;
    for (const [lx, ly] of this.enteringFor(dx, dy)) {
      const wx = this.origin[0] + dx + lx;
      const wy = this.origin[1] + dy + ly;
      const key = this.key(wx / R, wy / R);
      if (this.frozen.has(key) || this.pending.has(key)) continue;
      const job = this.generate(wx, wy);
      job.catch(() => this.pending.delete(key));
      this.pending.set(key, job);
    }
  }

  /** the regions of a strip of the window (local cells x0..x1, y0..y1), as [local x, local y] corners */
  private strip(x0: number, x1: number, y0: number, y1: number): [number, number][] {
    const out: [number, number][] = [];
    for (let y = y0; y < y1; y += this.R) for (let x = x0; x < x1; x += this.R) out.push([x, y]);
    return out;
  }

  private async slideNow(dx: number, dy: number): Promise<void> {
    const { core, W, H, R } = this;
    const dev = core.host.gpu.device;
    const wg = core.world;
    const table = core.packed.chunkTable;
    const cx = W / CHUNK;
    const cy = H / CHUNK;
    const rc = R / CHUNK;
    // what leaves (old window cells) and what comes in (new window cells)
    const leaving = dx > 0 ? this.strip(0, dx, 0, H) : dx < 0 ? this.strip(W + dx, W, 0, H) : dy > 0 ? this.strip(0, W, 0, dy) : this.strip(0, W, H + dy, H);
    const entering = this.enteringFor(dx, dy);

    // ---- 1. freeze what leaves: copies into one staging buffer ---------------
    const enc = dev.createCommandEncoder({ label: 'stream slide' });
    const kept = this.bufs.filter((b) => b.keep);
    const keptT = this.texs.filter((t) => t.keep);
    const pageBytes = this.pageSlots * SLOT_WORDS * 4;
    const regionBytes = rc * rc * pageBytes + kept.reduce((s, b) => s + R * R * b.stride * b.planes, 0) + keptT.reduce((s, t) => s + align256((R / t.div) * t.per * 16) * (R / t.div), 0);
    const staging = dev.createBuffer({ label: 'stream freeze', size: regionBytes * leaving.length, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    let off = 0;
    for (const [lx, ly] of leaving) {
      for (let j = 0; j < rc; j++)
        for (let i = 0; i < rc; i++) {
          const ci = (ly / CHUNK + j) * cx + lx / CHUNK + i;
          enc.copyBufferToBuffer(wg.layers, table[ci * 2] * SLOT_WORDS * 4, staging, off, pageBytes);
          off += pageBytes;
        }
      for (const b of kept)
        for (let p = 0; p < b.planes; p++)
          for (let r = 0; r < R; r++) {
            enc.copyBufferToBuffer(b.buf, p * W * H * b.stride + ((ly + r) * W + lx) * b.stride, staging, off, R * b.stride);
            off += R * b.stride;
          }
      for (const t of keptT) {
        const tw = (R / t.div) * t.per;
        const th = R / t.div;
        const row = align256(tw * 16);
        enc.copyTextureToBuffer({ texture: t.tex, origin: [(lx / t.div) * t.per, ly / t.div] }, { buffer: staging, offset: off, bytesPerRow: row }, [tw, th]);
        off += row * th;
      }
    }

    // ---- 2. everything per column moves a region over ------------------------
    for (const b of this.bufs) this.shiftBuf(enc, b, dx, dy);
    for (const t of this.texs) this.shiftTex(enc, t, dx, dy);
    // (particles in the air: dropped — Q28 follow-up: move them with a kernel)
    enc.clearBuffer(wg.particles);
    // what comes in starts empty where nothing is frozen for it
    for (const [lx, ly] of entering)
      for (const b of this.bufs) {
        if (b.keep) continue;
        for (let p = 0; p < b.planes; p++) for (let r = 0; r < R; r++) enc.clearBuffer(b.buf, p * W * H * b.stride + ((ly + r) * W + lx) * b.stride, R * b.stride);
      }
    dev.queue.submit([enc.finish()]);
    const leftKeys = leaving.map(([lx, ly]) => this.key((this.origin[0] + lx) / R, (this.origin[1] + ly) / R));
    const read = staging.mapAsync(GPUMapMode.READ).then(() => {
      const all = new Uint8Array(staging.getMappedRange()).slice();
      staging.unmap();
      staging.destroy();
      const out: Frozen[] = [];
      let o = 0;
      for (let k = 0; k < leaving.length; k++) {
        const f: Frozen = { layers: new Uint32Array(all.buffer, o, (rc * rc * pageBytes) / 4).slice(), bufs: {}, texs: {}, surface: new Float32Array(R * R) };
        o += rc * rc * pageBytes;
        for (const b of kept) {
          const n = R * R * b.stride * b.planes;
          f.bufs[b.name] = all.slice(o, o + n);
          o += n;
        }
        for (const t of keptT) {
          const tw = (R / t.div) * t.per;
          const th = R / t.div;
          const row = align256(tw * 16);
          const d = new Float32Array(tw * th * 4);
          for (let r = 0; r < th; r++) d.set(new Float32Array(all.buffer, o + r * row, tw * 4), r * tw * 4);
          f.texs[t.name] = d;
          o += row * th;
        }
        out.push(f);
      }
      return out;
    });
    // the CPU's surface heights for what leaves (the weather's, the level's cache)
    const surf = core.map.surface;
    const leftSurf = leaving.map(([lx, ly]) => {
      const s = new Float32Array(R * R);
      for (let r = 0; r < R; r++) s.set(surf.subarray((ly + r) * W + lx, (ly + r) * W + lx + R), r * R);
      return s;
    });
    leftKeys.forEach((k, i) =>
      this.frozen.set(
        k,
        read.then((fs) => {
          const f = fs[i];
          f.surface = leftSurf[i];
          this.frozen.set(k, f);
          return f;
        }),
      ),
    );
    this.stats.frozen += leaving.length;

    // ---- 3. the chunk table: pages move, the leaving chunks' pages are reused --
    const old = table.slice();
    const dcx = dx / CHUNK;
    const dcy = dy / CHUNK;
    const free: number[] = [];
    for (let j = 0; j < cy; j++)
      for (let i = 0; i < cx; i++) {
        const ni = i - dcx;
        const nj = j - dcy;
        if (ni < 0 || nj < 0 || ni >= cx || nj >= cy) free.push(old[(j * cx + i) * 2]);
      }
    for (let j = 0; j < cy; j++)
      for (let i = 0; i < cx; i++) {
        const si = i + dcx;
        const sj = j + dcy;
        table[(j * cx + i) * 2] = si >= 0 && sj >= 0 && si < cx && sj < cy ? old[(sj * cx + si) * 2] : free.pop()!;
      }
    dev.queue.writeBuffer(wg.chunks, 0, table);

    // ---- 4. the CPU's window coordinates move too ------------------------------
    this.origin[0] += dx;
    this.origin[1] += dy;
    core.globals.origin = [this.origin[0], this.origin[1]];
    shiftGrid(surf, W, H, 1, dx, dy);
    core.camera.target[0] -= dx;
    core.camera.target[1] -= dy * ROW_H;
    core.weather.shift(dx, dy * ROW_H);
    core.clearUndo();
    for (const f of this.onSlide) f(dx, dy);

    // ---- 5. what comes in: thawed, or generated (all of them asked for at once) ----
    const coming = entering.map(([lx, ly]) => {
      const key = this.key((this.origin[0] + lx) / R, (this.origin[1] + ly) / R);
      const got = this.frozen.get(key);
      if (got) {
        this.frozen.delete(key);
        this.stats.thawed++;
        return got;
      }
      this.stats.generated++;
      const ahead = this.pending.get(key);
      if (ahead) {
        this.pending.delete(key);
        this.stats.prefetched++;
        return ahead;
      }
      return this.generate(this.origin[0] + lx, this.origin[1] + ly);
    });
    for (let k = 0; k < entering.length; k++) this.write(await coming[k], entering[k][0], entering[k][1]);
  }

  /** a region's land the first time it is seen, in the frozen form */
  private async generate(x0: number, y0: number): Promise<Frozen> {
    const { R, K } = this;
    const zMax = this.core.dims.zMax;
    const land = await this.source.region(x0, y0, R, R, zMax);
    const rc = R / CHUNK;
    const layers = new Uint32Array(rc * rc * this.pageSlots * SLOT_WORDS);
    for (let y = 0; y < R; y++)
      for (let x = 0; x < R; x++) {
        const col = land.cols[y * R + x];
        if (col.length > K) throw new Error(`streamed column ${x0 + x},${y0 + y} has ${col.length} intervals (K ${K})`);
        for (const iv of col) if (iv.z1 > zMax) throw new Error(`streamed column ${x0 + x},${y0 + y} is above zMax`);
        const page = Math.floor(y / CHUNK) * rc + Math.floor(x / CHUNK);
        const slot = page * this.pageSlots + ((y % CHUNK) * CHUNK + (x % CHUNK)) * K;
        layers.set(packColumn(col, K), slot * SLOT_WORDS);
      }
    const bytes = (a: Float32Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const bufs: Record<string, Uint8Array> = {
      water: bytes(land.water),
      moisture: bytes(land.moisture),
      veg: bytes(land.vegetation),
      contam: bytes(land.contam),
      petals: bytes(new Float32Array(R * R).fill(1)),
    };
    if (land.lava) bufs.lava = bytes(land.lava);
    const texs: Record<string, Float32Array> = {};
    const judge = land.structural ? boxOf(land.structural, R) : undefined;
    if (land.lavaSpring) {
      const t = new Float32Array(R * R * 4);
      for (let k = 0; k < R * R; k++) t[k * 4] = land.lavaSpring[k];
      texs.lavaSpring = t;
    }
    return { layers, bufs, texs, surface: land.surface, judge };
  }

  /** write a region into the window at local cell (lx, ly) */
  private write(f: Frozen, lx: number, ly: number): void {
    const { core, W, H, R } = this;
    const dev = core.host.gpu.device;
    const wg = core.world;
    const table = core.packed.chunkTable;
    const cx = W / CHUNK;
    const rc = R / CHUNK;
    const pageWords = this.pageSlots * SLOT_WORDS;
    for (let j = 0; j < rc; j++)
      for (let i = 0; i < rc; i++) {
        const ci = (ly / CHUNK + j) * cx + lx / CHUNK + i;
        const page = f.layers.subarray((j * rc + i) * pageWords, (j * rc + i + 1) * pageWords);
        // (both: the passes that write layersNext copy all of it back over the layers)
        dev.queue.writeBuffer(wg.layers, table[ci * 2] * SLOT_WORDS * 4, page);
        dev.queue.writeBuffer(wg.layersNext, table[ci * 2] * SLOT_WORDS * 4, page);
      }
    for (const b of this.bufs) {
      if (!b.keep) continue;
      const d = f.bufs[b.name];
      for (let p = 0; p < b.planes; p++)
        for (let r = 0; r < R; r++) {
          const dst = p * W * H * b.stride + ((ly + r) * W + lx) * b.stride;
          if (d) dev.queue.writeBuffer(b.buf, dst, d, (p * R + r) * R * b.stride, R * b.stride);
          else dev.queue.writeBuffer(b.buf, dst, new Uint8Array(R * b.stride));
        }
    }
    for (const t of this.texs) {
      const tw = (R / t.div) * t.per;
      const th = R / t.div;
      let d = t.keep ? f.texs[t.name] : undefined;
      if (!d) {
        d = new Float32Array(tw * th * 4);
        if (t.fill) for (let k = 0; k < tw * th; k++) d.set(t.fill, k * 4);
      }
      dev.queue.writeTexture({ texture: t.tex, origin: [(lx / t.div) * t.per, ly / t.div] }, d, { bytesPerRow: tw * 16 }, [tw, th]);
    }
    const surf = core.map.surface;
    for (let r = 0; r < R; r++) surf.set(f.surface.subarray(r * R, (r + 1) * R), (ly + r) * W + lx);
    if (f.judge) for (const cb of this.onArrive) cb(lx + f.judge[0], ly + f.judge[1], lx + f.judge[2], ly + f.judge[3]);
  }

  /** new(x, y) = old(x + dx, y + dy), per plane */
  private shiftBuf(enc: GPUCommandEncoder, b: ColBuf, dx: number, dy: number): void {
    const { W, H } = this;
    const s = b.stride;
    enc.copyBufferToBuffer(b.buf, 0, this.scratch, 0, b.buf.size);
    const x0 = Math.max(0, -dx);
    const x1 = Math.min(W, W - dx);
    const y0 = Math.max(0, -dy);
    const y1 = Math.min(H, H - dy);
    const plane = W * H * s;
    for (let p = 0; p < b.planes; p++) {
      if (dx === 0) enc.copyBufferToBuffer(this.scratch, p * plane + (y0 + dy) * W * s, b.buf, p * plane + y0 * W * s, (y1 - y0) * W * s);
      else for (let y = y0; y < y1; y++) enc.copyBufferToBuffer(this.scratch, p * plane + ((y + dy) * W + x0 + dx) * s, b.buf, p * plane + (y * W + x0) * s, (x1 - x0) * s);
    }
  }

  private shiftTex(enc: GPUCommandEncoder, t: ColTex, dx: number, dy: number): void {
    const tex = t.tex;
    const k = `${tex.format}:${tex.width}x${tex.height}`;
    let tmp = this.scratchTex.get(k);
    if (!tmp) {
      tmp = this.core.world.texture(`streamScratch:${k}`, tex);
      this.scratchTex.set(k, tmp);
    }
    enc.copyTextureToTexture({ texture: tex }, { texture: tmp }, [tex.width, tex.height]);
    const sx = (dx / t.div) * t.per;
    const sy = dy / t.div;
    enc.copyTextureToTexture(
      { texture: tmp, origin: [Math.max(0, sx), Math.max(0, sy)] },
      { texture: tex, origin: [Math.max(0, -sx), Math.max(0, -sy)] },
      [tex.width - Math.abs(sx), tex.height - Math.abs(sy)],
    );
  }
}

const align256 = (n: number) => Math.ceil(n / 256) * 256;

/** the box (cells, x1 y1 past the end) round the set cells of a w-wide mask, with a margin of 2; none if none */
export function boxOf(mask: Uint8Array, w: number, x0 = 0, y0 = 0, bw = w, bh = mask.length / w): [number, number, number, number] | undefined {
  let lx = 1e9;
  let ly = 1e9;
  let hx = -1;
  let hy = -1;
  for (let y = y0; y < y0 + bh; y++)
    for (let x = x0; x < x0 + bw; x++)
      if (mask[y * w + x]) {
        lx = Math.min(lx, x);
        ly = Math.min(ly, y);
        hx = Math.max(hx, x);
        hy = Math.max(hy, y);
      }
  return hx < 0 ? undefined : [lx - 2, ly - 2, hx + 3, hy + 3];
}

/** new(x, y) = old(x + dx, y + dy) on a CPU w × h array with `per` values a cell (what comes in keeps the old values) */
export function shiftGrid(a: { copyWithin(t: number, s: number, e: number): unknown }, w: number, h: number, per: number, dx: number, dy: number): void {
  if (dy > 0) a.copyWithin(0, dy * w * per, h * w * per);
  else if (dy < 0) a.copyWithin(-dy * w * per, 0, (h + dy) * w * per);
  if (dx > 0) for (let y = 0; y < h; y++) a.copyWithin(y * w * per, (y * w + dx) * per, (y + 1) * w * per);
  else if (dx < 0) for (let y = 0; y < h; y++) a.copyWithin((y * w - dx) * per, y * w * per, (y * w + w + dx) * per);
}
