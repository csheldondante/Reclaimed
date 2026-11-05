// Region geometry in the window's ring: a region's slots, its columns' and textures' rectangles, which regions enter
// on a slide and in what order. API: regionSlots, regionIdx, regionOutside, regionOf, regionPut, regionRects,
// clearPages, texRegion, inWindow, enteringFor, nearFirst, strip. Pure reads of the streamer's layout; no GPU work
// beyond the encoder it's handed.
import { CHUNK, type Interval } from '../../world/layout';
import { ROW_H } from '../../world/lattice';
import { PAGE_COLS } from '../../sim/pages';
import { zeros } from './write';
import type { Streamer } from '../streamer';

/** (round 107, pages) the slots of the window's region at (lx, ly), page row by page row: where it lies, whatever slides after */
export function regionSlots(S: Streamer, lx: number, ly: number): Uint16Array {
  return S.core.ring.slots(lx, ly, S.R, S.R);
}

/** (round 107) region column (c, r)'s index in the CPU's per-column arrays, its region's slots `sl` */
export function regionIdx(S: Streamer, sl: Uint16Array, c: number, r: number): number {
  return sl[(r >> 4) * (S.R / CHUNK) + (c >> 4)] * PAGE_COLS + ((r & 15) << 4) + (c & 15);
}

/** Streamer.regionOutside (the class keeps the method, documented there) */
export function regionOutside(S: Streamer, sl: Uint16Array): Interval[][] {
  const { R } = S;
  const o: Interval[][] = new Array(R * R);
  for (let r = 0; r < R; r++) for (let c = 0; c < R; c++) o[r * R + c] = S.outside[regionIdx(S, sl, c, r)];
  return o;
}

/** (round 100) a CPU grid's region in slots `sl`, copied row-major (round 107: its pages' rows where they lie) */
export function regionOf<T extends Float32Array | Uint8Array>(S: Streamer, a: T, sl: Uint16Array): T {
  const { R } = S;
  const rc = R / CHUNK;
  const s = new (a.constructor as { new (n: number): T })(R * R);
  for (let j = 0; j < rc; j++)
    for (let i = 0; i < rc; i++) {
      const b = sl[j * rc + i] * PAGE_COLS;
      for (let r = 0; r < CHUNK; r++) s.set(a.subarray(b + r * CHUNK, b + (r + 1) * CHUNK), (j * CHUNK + r) * R + i * CHUNK);
    }
  return s;
}

/** (round 107) a row-major region grid written into a CPU grid where the region in slots `sl` lies */
export function regionPut<T extends Float32Array | Uint8Array>(S: Streamer, a: T, sl: Uint16Array, src: T): void {
  const { R } = S;
  const rc = R / CHUNK;
  for (let j = 0; j < rc; j++)
    for (let i = 0; i < rc; i++) {
      const b = sl[j * rc + i] * PAGE_COLS;
      for (let r = 0; r < CHUNK; r++) a.set(src.subarray((j * CHUNK + r) * R + i * CHUNK, (j * CHUNK + r) * R + i * CHUNK + CHUNK), b + r * CHUNK);
    }
}

/**
 * (round 107, pages: P2.2 — the region copier's page gather) A buffer's region between the window (page-major: the
 * region's pages at their slots) and a region's bytes (page-major, its pages one after another: world/region-record.ts),
 * as rectangles for the copier: one when the slots are a regular block (the identity's), else one a run of pages.
 * `reg` the region side's buffer and offset (words); `toWin` its direction; `zero`: the window side cleared instead.
 */
export function regionRects(S: Streamer, b: { buf: GPUBuffer; stride: number; planes: number }, sl: Uint16Array, toWin: boolean, reg: GPUBuffer | null, regOff: number, once = false): void {
  const { W, H, R } = S;
  const s = b.stride / 4;
  const pw = (PAGE_COLS * s) | 0;
  const rc = R / CHUNK;
  for (const run of S.core.ring.runs(sl, rc)) {
    const win = { buf: b.buf, off: run.slot * pw, row: run.rowSlots * pw, plane: W * H * s };
    const rowWords = run.n * pw;
    const rg = reg ? { buf: reg, off: regOff + run.k * pw, row: rc * pw, plane: R * R * s } : { buf: zeros(S, rowWords), off: 0, row: 0, plane: 0 };
    const [src, dst] = toWin || !reg ? [rg, win] : [win, rg];
    S.copier.rect({ src: src.buf, srcOff: src.off, srcRow: src.row, srcPlane: src.plane, dst: dst.buf, dstOff: dst.off, dstRow: dst.row, dstPlane: dst.plane, rowWords, rows: run.rows, planes: b.planes, once });
  }
}

/** (round 107) a buffer that isn't a storage buffer: the region's pages cleared where they lie, a clear a run of pages */
export function clearPages(S: Streamer, enc: GPUCommandEncoder, b: { buf: GPUBuffer; stride: number; planes: number }, sl: Uint16Array): void {
  const pb = PAGE_COLS * b.stride;
  for (const run of S.core.ring.runs(sl, S.R / CHUNK))
    for (let q = 0; q < b.planes; q++) for (let r = 0; r < run.rows; r++) enc.clearBuffer(b.buf, q * S.W * S.H * b.stride + (run.slot + r * run.rowSlots) * pb, run.n * pb);
}

/** (round 107) a texture's region where it lies in the atlas: the rectangles (one, the identity's) and their offsets in a region's texels */
export function texRegion(S: Streamer, lx: number, ly: number, t: { per: number; div: number }, rowBytes: number): { origin: [number, number]; off: number; size: [number, number] }[] {
  return S.core.ring.texRects(lx, ly, S.R, S.R).map((q) => ({
    origin: [((q.px * CHUNK) / t.div) * t.per, (q.py * CHUNK) / t.div],
    off: ((q.wy - ly) / t.div) * rowBytes + ((q.wx - lx) / t.div) * t.per * 16,
    size: [((q.pw * CHUNK) / t.div) * t.per, (q.ph * CHUNK) / t.div],
  }));
}

/** (round 100) whether world cell (wx, wy) — a region's corner — is in the window now */
export function inWindow(S: Streamer, wx: number, wy: number): boolean {
  const lx = wx - S.origin[0];
  const ly = wy - S.origin[1];
  return lx >= 0 && ly >= 0 && lx < S.W && ly < S.H;
}

/** the regions coming in with a slide of (dx, dy), as [local x, local y] corners in the window after it */
export function enteringFor(S: Streamer, dx: number, dy: number): [number, number][] {
  const { W, H } = S;
  return dx > 0 ? strip(S, W - dx, W, 0, H) : dx < 0 ? strip(S, 0, -dx, 0, H) : dy > 0 ? strip(S, 0, W, H - dy, H) : strip(S, 0, W, 0, -dy);
}

/**
 * (round 90, the user: "prioritize tiles close to the center of the screen but load others late") Regions
 * (local corners in the window after a slide of (dx, dy)) nearest the camera's target first: the land is made a
 * tile a frame in the order it's asked for (atlas.ts tileGate), so what's under the middle of the screen comes in
 * first and the strip's far ends later.
 */
export function nearFirst(S: Streamer, regions: [number, number][], dx: number, dy: number): [number, number][] {
  const [x, yw] = S.core.camera.target;
  const y = yw / ROW_H;
  const h = S.R / 2;
  const d = ([lx, ly]: [number, number]) => Math.hypot(lx + dx + h - x, ly + dy + h - y);
  return [...regions].sort((a, b) => d(a) - d(b));
}

/** the regions of a strip of the window (local cells x0..x1, y0..y1), as [local x, local y] corners */
export function strip(S: Streamer, x0: number, x1: number, y0: number, y1: number): [number, number][] {
  const out: [number, number][] = [];
  for (let y = y0; y < y1; y += S.R) for (let x = x0; x < x1; x += S.R) out.push([x, y]);
  return out;
}
