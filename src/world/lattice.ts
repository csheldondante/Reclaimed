// The hex lattice of the nature grid (docs/GRIDS.md), mirrored from
// common.wgsl: pointy-top hexes, centre to centre 1, rows ROW_H apart, odd
// rows shifted half a cell right ("odd-r" offset). Storage is a w × h array
// indexed (x, y) = (column, row); world positions are cellPos(). The CPU only
// needs this for uniforms and events (where a tap lands, where a storm is):
// the grid math itself runs on the GPU.

export const ROW_H = Math.sqrt(3) / 2;
export const NDIR = 6;
/** bytes of one per-direction value set (common.wgsl `Dirs`: array<f32, 6>) */
export const DIRS_BYTES = NDIR * 4;

/** unit vectors of the six directions, in opposite pairs: E, W, NE, SW, NW, SE */
export const DIRV: readonly (readonly [number, number])[] = [
  [1, 0], [-1, 0], [0.5, ROW_H], [-0.5, -ROW_H], [-0.5, ROW_H], [0.5, -ROW_H],
];
const DOFF_E = [[1, 0], [-1, 0], [0, 1], [-1, -1], [-1, 1], [0, -1]] as const;
const DOFF_O = [[1, 0], [-1, 0], [1, 1], [0, -1], [0, 1], [1, -1]] as const;

/** the neighbour of cell (x, y) in direction k */
export function nbr(x: number, y: number, k: number): [number, number] {
  const o = (y & 1) === 0 ? DOFF_E[k] : DOFF_O[k];
  return [x + o[0], y + o[1]];
}

/** world (x, y) of a cell's centre */
export function cellPos(x: number, y: number): [number, number] {
  return [x + 0.5 + 0.5 * (y & 1), (y + 0.5) * ROW_H];
}

/** the cell whose hexagon contains world point (wx, wy) */
export function cellAt(wx: number, wy: number): [number, number] {
  const r = (wy - 0.5 * ROW_H) / ROW_H;
  const q = wx - 0.5 - 0.5 * r;
  const s = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  const rs = Math.round(s);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return [rq + (rr - (rr & 1)) / 2, rr];
}

/** world extent of a w × h nature grid */
export function worldSize(w: number, h: number): [number, number] {
  return [w + 0.5, h * ROW_H];
}

/** A point of interest authored in grid cells (levels, the kit) → the world. */
export function poiWorld(p: readonly [number, number]): [number, number] {
  return cellPos(Math.floor(p[0]), Math.floor(p[1]));
}
