// ---- hero/fill.ts ---------------------------------------------------------------
// (round 112, herosandbox; the user: "or to instantly fill up a vessel with a sand or liquid") Fill a vessel: from a
// tapped cell, the enclosed basin it lies in and the level it would spill at (its rim's lowest point), then that
// volume poured in through the world API — water or oil (world.water.flood / oil), sand or any loose ground
// (world.terrain.deposit) — one column a command, each its exact share (the edit pass: a radius under a cell's
// spacing touches only its own column, at full strength). Not enclosed within `limit` cells (a slope, a plain, a
// vessel bigger than the limit), it says so and pours nothing.
//
//   const b = findBasin((cx, cy) => terrain.heightAt(...cellPos(cx, cy)), cellAt(x, y), { limit: 3000 })
//   if ('error' in b) say(b.error) else pour(api, b, 'water')

import { cellPos, nbr, NDIR } from '../world/lattice';

export interface Basin {
  /** the level it spills at (world z) */
  level: number;
  /** the level it's filled to: the spill level less `margin` */
  fillTo: number;
  /** the cells under fillTo: [cell x, cell y, ground z] */
  cells: [number, number, number][];
  /** cells³ to fill it (the ground's deficit; less water already standing, for a liquid) */
  volume: number;
  /** the cell it spills over (the rim's lowest) */
  spill: [number, number];
  /** its bottom: the deepest cell (world x, y) */
  bottom: [number, number];
}

export interface BasinOpts {
  /** the most cells a basin may hold (default 3000): past it, "not enclosed" */
  limit?: number;
  /** cells under the rim it's filled to (default 0.25) */
  margin?: number;
  /** the least drop past a rim that counts as spilling over it (default 0.6 cells: a floor's ripples are no rim) */
  spill?: number;
}

/** a binary heap of cells by height */
class Heap {
  private h: number[] = [];
  private k: number[] = [];
  get size(): number {
    return this.h.length;
  }
  push(z: number, key: number): void {
    const { h, k } = this;
    h.push(z);
    k.push(key);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p] <= h[i]) break;
      [h[p], h[i]] = [h[i], h[p]];
      [k[p], k[i]] = [k[i], k[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const { h, k } = this;
    const top: [number, number] = [h[0], k[0]];
    const lz = h.pop()!;
    const lk = k.pop()!;
    if (h.length) {
      h[0] = lz;
      k[0] = lk;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && h[l] < h[m]) m = l;
        if (r < h.length && h[r] < h[m]) m = r;
        if (m === i) break;
        [h[m], h[i]] = [h[i], h[m]];
        [k[m], k[i]] = [k[i], k[m]];
        i = m;
      }
    }
    return top;
  }
}

const KEY = 1 << 16;
const key = (x: number, y: number) => (y + 4096) * KEY + (x + 4096);
const unkey = (k: number): [number, number] => [(k % KEY) - 4096, Math.floor(k / KEY) - 4096];

/**
 * The basin the cell `seed` lies in, by a priority flood: down to its bottom first, then outward lowest first —
 * the level rising as the walls are climbed — until a cell lower than the level is reached (over the rim: it
 * spills there) or the window's edge (`top` null: open). `top(cx, cy)` is the ground's height at a cell.
 */
export function findBasin(top: (cx: number, cy: number) => number | null, seed: [number, number], o: BasinOpts = {}): Basin | { error: string } {
  const limit = o.limit ?? 3000;
  const margin = o.margin ?? 0.25;
  const EPS = 0.05;
  /** cells: the least drop past a rim that is a spill */
  const SPILL = o.spill ?? 0.6;
  let [sx, sy] = seed;
  let sz = top(sx, sy);
  if (sz === null) return { error: 'that point is outside the loaded world' };
  // (down to the bottom: steepest descent)
  for (let guard = 0; guard < 4096; guard++) {
    let best: [number, number, number] | null = null;
    for (let d = 0; d < NDIR; d++) {
      const [nx, ny] = nbr(sx, sy, d);
      const z = top(nx, ny);
      if (z !== null && z < sz - EPS && (!best || z < best[2])) best = [nx, ny, z];
    }
    if (!best) break;
    [sx, sy, sz] = best;
  }
  const heap = new Heap();
  const seen = new Set<number>([key(sx, sy)]);
  heap.push(sz, key(sx, sy));
  let level = -Infinity;
  const popped: [number, number, number][] = [];
  /** popped when the level last rose: what's popped since lies flat at the level */
  let rose = 0;
  const basin = (at: [number, number]): Basin | { error: string } => {
    const fillTo = level - margin;
    const cells = popped.filter((c) => c[2] < fillTo - 0.02);
    if (!cells.length) return { error: 'nothing to fill there: the rim is no higher than the floor' };
    const volume = cells.reduce((s, c) => s + (fillTo - c[2]), 0);
    return { level, fillTo, cells, volume, spill: at, bottom: cellPos(popped[0][0], popped[0][1]) };
  };
  // (round off a plain: a pit dug in flat ground has the plain round it for a rim — spreading flat at the level over
  // PLAIN cells, the level is its brim)
  const PLAIN = 48;
  const plain = () => popped.length - rose > PLAIN;
  while (heap.size) {
    const [z, k] = heap.pop();
    const [cx, cy] = unkey(k);
    if (z === -Infinity) {
      if (plain()) return basin([cx, cy]);
      return { error: 'it runs off the edge of the loaded world: not enclosed' };
    }
    // over the rim: it spills at `level` — a drop of at least SPILL beyond it (round 112: the ripples of loose ground on
    // a vessel's floor, a tenth of a cell, are no rim: the desktop run found "nothing to fill" in a walled ring, the
    // flood having stopped at the first ripple)
    if (z < level - SPILL) return basin([cx, cy]);
    if (z > level + EPS) rose = popped.length;
    level = Math.max(level, z);
    popped.push([cx, cy, z]);
    if (popped.length > limit) {
      if (plain()) return basin([cx, cy]);
      return { error: `not enclosed within ${limit} cells (it would spill above ${level.toFixed(1)}, still rising): build a rim, or fill a smaller vessel` };
    }
    for (let d = 0; d < NDIR; d++) {
      const [nx, ny] = nbr(cx, cy, d);
      const nk = key(nx, ny);
      if (seen.has(nk)) continue;
      seen.add(nk);
      const nz = top(nx, ny);
      heap.push(nz === null ? -Infinity : nz, nk);
    }
  }
  return { error: 'not enclosed' };
}

/** what a fill pours: a liquid, or a loose ground (sand, soil, …) */
export type FillWith = 'water' | 'oil' | 'sand' | 'soil' | 'snow' | 'rubble';

/** The world API's commands a fill needs (src/api/water.ts, terrain.ts). */
export interface FillApi {
  water: { flood(x: number, y: number, o: { radius?: number; depth?: number }): void; oil(x: number, y: number, o: { radius?: number; depth?: number }): void; depthAt(x: number, y: number): number | null };
  terrain: { deposit(x: number, y: number, material: 'sand' | 'soil' | 'snow' | 'rubble', o: { radius?: number; layers?: number }): void };
}

/** under a cell's spacing (1): an edit there touches only its own column, at the centre's full strength */
const ONE_COLUMN = 0.6;

/** Pour the basin full: one command a column, each its deficit. Returns the commands queued and the volume poured. */
export function pour(api: FillApi, b: Basin, what: FillWith): { commands: number; volume: number } {
  let n = 0;
  let vol = 0;
  for (const [cx, cy, z] of b.cells) {
    const [x, y] = cellPos(cx, cy);
    let d = b.fillTo - z;
    if (what === 'water' || what === 'oil') d -= api.water.depthAt(x, y) ?? 0;
    if (d < 0.05) continue;
    if (what === 'water') api.water.flood(x, y, { radius: ONE_COLUMN, depth: d });
    else if (what === 'oil') api.water.oil(x, y, { radius: ONE_COLUMN, depth: d });
    else api.terrain.deposit(x, y, what, { radius: ONE_COLUMN, layers: d });
    n++;
    vol += d;
  }
  return { commands: n, volume: vol };
}
