// (PA11) A lot's building as blocks of lattice cells: what the town hands the physics engine when a house is knocked
// down (scenes/level/housefall.ts). The footprint is the lot record's quad (streets.wgsl putRec, words 8..15), its
// columns chosen as claimLots chooses them (a column whose centre is inside the quad), its height the record's ×
// progress from its base. The cells are cut into a few blocks by the footprint's box, so the house comes apart; every
// cell is in exactly one block. Pure: the unit test holds the volume.
import { cellPos, ROW_H } from '../world/lattice';

export interface LotBox {
  /** the building's footprint, window world units, in the record's winding */
  quad: readonly (readonly [number, number])[];
  /** its base and its height (window z, cells) */
  base: number;
  height: number;
  /** the record's seed (its colours) */
  hash: number;
}

export interface LotCell {
  x: number;
  y: number;
  z: number;
  mat: number;
}

/** the window columns whose centres are inside the quad (either winding) */
export function lotColumns(quad: LotBox['quad']): [number, number][] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of quad) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const out: [number, number][] = [];
  for (let cy = Math.floor(y0 / ROW_H) - 1; cy <= Math.ceil(y1 / ROW_H) + 1; cy++)
    for (let cx = Math.floor(x0) - 1; cx <= Math.ceil(x1) + 1; cx++) {
      const [px, py] = cellPos(cx, cy);
      let pos = 0;
      let neg = 0;
      for (let k = 0; k < 4; k++) {
        const a = quad[k];
        const b = quad[(k + 1) % 4];
        const c = (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]);
        if (c < 0) neg++;
        else if (c > 0) pos++;
      }
      // (on an edge counts as inside, as claimLots has it; a quad of no area has no columns)
      if ((pos === 0 || neg === 0) && pos + neg > 0) out.push([cx, cy]);
    }
  return out;
}

/** the whole layers a building of this base and height fills, none of them reaching under its base (a block made
 *  inside the ground under it would be pushed out): from the first layer at or over the base to the last under its
 *  top, at least one. Up to a layer of its height is lost to the rounding. */
export function lotLayers(base: number, height: number): { z0: number; n: number } {
  const z0 = Math.ceil(base - 1e-3);
  return { z0, n: Math.max(1, Math.floor(base + height + 1e-3) - z0) };
}

/**
 * The building as blocks of `mat`: its columns split in two along each side of the footprint's box that is `split`
 * columns or longer (one to four blocks a layer), and in two layers when it is `split` or more high.
 */
export function lotBlocks(lot: LotBox, mat: number, split = 6): LotCell[][] {
  const cols = lotColumns(lot.quad);
  if (!cols.length) return [];
  const { z0, n } = lotLayers(lot.base, lot.height);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of cols) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const nx = x1 - x0 + 1 >= split ? 2 : 1;
  const ny = y1 - y0 + 1 >= split ? 2 : 1;
  const nz = n >= split ? 2 : 1;
  const blocks: LotCell[][] = Array.from({ length: nx * ny * nz }, () => []);
  for (const [x, y] of cols) {
    const bx = Math.min(nx - 1, Math.floor(((x - x0) * nx) / (x1 - x0 + 1)));
    const by = Math.min(ny - 1, Math.floor(((y - y0) * ny) / (y1 - y0 + 1)));
    for (let k = 0; k < n; k++) {
      const bz = Math.min(nz - 1, Math.floor((k * nz) / n));
      blocks[(bz * ny + by) * nx + bx].push({ x, y, z: z0 + k, mat });
    }
  }
  return blocks.filter((b) => b.length);
}
