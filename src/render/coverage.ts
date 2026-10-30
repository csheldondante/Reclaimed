// Round 113 (`tilesfirst`; the user: "Why can't we just compute the orthographic visible area and see if any tiles
// that are not loaded cover it? It seems cheap"). The geometric coverage check: from the camera's orthographic view,
// the land it can see — the window's mesh chunks (32 x 32 cells) and, past the window, the world's regions (64²) —
// each asked "is it DRAWN this frame?" (the window's own drawing of it ready and drawn: its grid's, or its voxel mesh
// built and in view; or a tile drawn of it), never "is it loaded" or "written". A piece counts as seen when its box
// (its footprint, its lowest to highest column top) meets the screen; its share of the screen is its footprint's quad at
// its middle height, clipped to the screen. CPU work over a few hundred pieces, nothing read back, no per-pixel stores:
// the pan bench and the tile gate run it every frame. The pixel check (render/bgcheck.ts, ?bgcheck=1) is the ground
// truth it's validated against (scripts/holediag.mjs: the two agree on the same frames).
//
// (Why the old "out of detail" — perf/bench.ts writtenShare, missingWhere, the gate's measure — missed the close-zoom
// holes: inside the window it counted a point as detailed once its region was written, and the window's land then
// drew nothing till its grid was ready or its mesh built; and it put the point on the ground at the focus's height.)

import { ROW_H } from '../world/lattice';

/** what the check reads: the caller's views of the window and the tiles this frame (all window units: x cells,
 *  y world units = rows · ROW_H, z window z) */
export interface CoverView {
  /** the camera's view-projection (column-major) */
  viewProj: Float32Array;
  /** the window: cells across, rows down */
  W: number;
  H: number;
  /** mesh chunks across, down, a chunk's cells (rows the same) */
  nx: number;
  ny: number;
  side: number;
  /** per chunk its lowest and highest column top (window z), or null (unknown: the window's whole z) */
  lo: Float32Array | null;
  hi: Float32Array | null;
  zMax: number;
  /** per chunk 1 or 2: the window draws it this frame for sure (Renderer.windowDrawn) */
  drawn: Uint8Array;
  /** the window's cell (0, 0) in the world (cells, rows); a region's cells (rows the same) */
  origin: [number, number];
  R: number;
  /** a tile drawn of world region (rx, ry) this frame */
  tile: (rx: number, ry: number) => boolean;
  /** (optional) world region (rx, ry)'s land is known to lie off the screen: its tile's own extent, as baked, is (the
   *  CPU's box from the macro heights can be taller than the land) */
  offScreen?: (rx: number, ry: number) => boolean;
  /** world region (rx, ry)'s heights (window z), or null (unknown) */
  zRange: (rx: number, ry: number) => [number, number] | null;
  /** regions past the window this far round the window looked at (regions) */
  reach?: number;
}

export interface Coverage {
  /** chunks of the window seen, and of them undrawn (neither the window's nor a tile's) */
  chunks: number;
  chunksUndrawn: number;
  /** regions past the window seen, and of them undrawn (no tile) */
  regions: number;
  regionsUndrawn: number;
  /** the screen's share (0..1) the undrawn pieces' footprints cover */
  share: number;
  /** the undrawn pieces: 'c<i>,<j>' window chunks, 'r<rx>,<ry>' world regions */
  undrawn: string[];
}

/** (window z) the lowest land the footprint looks for, and how far over the window's top */
const Z_LO = -64;
const Z_HI = 128;

/** the clip-space quad of a box's footprint at height z, and whether the box (z0..z1) meets the screen */
function project(m: Float32Array, x0: number, y0: number, x1: number, y1: number, z0: number, z1: number): { seen: boolean; quad: [number, number][] } {
  let lx = Infinity;
  let ly = Infinity;
  let hx = -Infinity;
  let hy = -Infinity;
  for (let k = 0; k < 8; k++) {
    const x = k & 1 ? x1 : x0;
    const y = k & 2 ? y1 : y0;
    const z = k & 4 ? z1 : z0;
    const px = m[0] * x + m[4] * y + m[8] * z + m[12];
    const py = m[1] * x + m[5] * y + m[9] * z + m[13];
    lx = Math.min(lx, px);
    ly = Math.min(ly, py);
    hx = Math.max(hx, px);
    hy = Math.max(hy, py);
  }
  const seen = hx >= -1 && lx <= 1 && hy >= -1 && ly <= 1;
  const zm = (z0 + z1) / 2;
  const at = (x: number, y: number): [number, number] => [m[0] * x + m[4] * y + m[8] * zm + m[12], m[1] * x + m[5] * y + m[9] * zm + m[13]];
  return { seen, quad: [at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1)] };
}

/** a convex polygon's area inside the clip square (-1..1)², as a share of the square */
function clippedShare(poly: [number, number][]): number {
  let p = poly;
  const edges: [(q: [number, number]) => number][] = [[(q) => q[0] + 1], [(q) => 1 - q[0]], [(q) => q[1] + 1], [(q) => 1 - q[1]]];
  for (const [f] of edges) {
    const out: [number, number][] = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i];
      const b = p[(i + 1) % p.length];
      const fa = f(a);
      const fb = f(b);
      if (fa >= 0) out.push(a);
      if (fa >= 0 !== fb >= 0) {
        const t = fa / (fa - fb);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    p = out;
    if (!p.length) return 0;
  }
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2 / 4;
}

/** The check: the window's chunks, then the regions past it within `reach` of the window, seen and undrawn. */
export function coverage(v: CoverView): Coverage {
  const m = v.viewProj;
  const out: Coverage = { chunks: 0, chunksUndrawn: 0, regions: 0, regionsUndrawn: 0, share: 0, undrawn: [] };
  const cw = v.side;
  const ch = v.side * ROW_H;
  const R = v.R;
  const w0 = Math.floor(v.origin[0] / R);
  const h0 = Math.floor(v.origin[1] / R);
  for (let cy = 0; cy < v.ny; cy++)
    for (let cx = 0; cx < v.nx; cx++) {
      const c = cy * v.nx + cx;
      const known = v.lo && v.hi && v.hi[c] > v.lo[c] - 1e-3 && v.hi[c] !== 0;
      const z0 = known ? v.lo![c] : 0;
      const z1 = known ? v.hi![c] : v.zMax;
      const pr = project(m, cx * cw, cy * ch, (cx + 1) * cw, (cy + 1) * ch, z0, z1);
      if (!pr.seen) continue;
      out.chunks++;
      if (v.drawn[c] === 1 || v.drawn[c] === 2) continue;
      // (a tile drawn of its region covers it: tiles.wgsl draws a window region's tile where the window doesn't)
      const rx = w0 + Math.floor((cx * cw) / R);
      const ry = h0 + Math.floor((cy * v.side) / R);
      if (v.tile(rx, ry)) continue;
      out.chunksUndrawn++;
      out.share += clippedShare(pr.quad);
      out.undrawn.push(`c${cx},${cy}`);
    }
  const reach = v.reach ?? 6;
  const rw = Math.ceil(v.W / R);
  const rh = Math.ceil(v.H / R);
  // (only the regions under the screen's corners' footprint at the land's lowest and highest — the view's ground
  // between Z_LO and the window's top past Z_HI: a few dozen boxes, not the reach's few hundred)
  let fx0 = Infinity;
  let fy0 = Infinity;
  let fx1 = -Infinity;
  let fy1 = -Infinity;
  const det = m[0] * m[5] - m[4] * m[1];
  for (const z of [Z_LO, v.zMax + Z_HI])
    for (const [cx, cy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const rx = cx - m[8] * z - m[12];
      const ry = cy - m[9] * z - m[13];
      const x = (m[5] * rx - m[4] * ry) / det;
      const y = (m[0] * ry - m[1] * rx) / det;
      fx0 = Math.min(fx0, x);
      fx1 = Math.max(fx1, x);
      fy0 = Math.min(fy0, y);
      fy1 = Math.max(fy1, y);
    }
  const i0 = Math.max(-reach, Math.floor(fx0 / R));
  const i1 = Math.min(rw + reach - 1, Math.floor(fx1 / R));
  const j0 = Math.max(-reach, Math.floor(fy0 / (R * ROW_H)));
  const j1 = Math.min(rh + reach - 1, Math.floor(fy1 / (R * ROW_H)));
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      if (i >= 0 && j >= 0 && i < rw && j < rh) continue;
      const rx = w0 + i;
      const ry = h0 + j;
      const zr = v.zRange(rx, ry) ?? [0, v.zMax];
      const x0 = i * R;
      const y0 = j * R * ROW_H;
      const pr = project(m, x0, y0, x0 + R, y0 + R * ROW_H, zr[0], zr[1]);
      if (!pr.seen || v.offScreen?.(rx, ry)) continue;
      out.regions++;
      if (v.tile(rx, ry)) continue;
      out.regionsUndrawn++;
      out.share += clippedShare(pr.quad);
      out.undrawn.push(`r${rx},${ry}`);
    }
  out.share = Math.min(1, out.share);
  return out;
}
