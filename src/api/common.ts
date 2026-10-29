// Shared bits of the world API (docs/WORLD_API.md): materials by name, and
// world points to columns.

import { cellAt } from '../world/lattice';
import { MAT, MATERIALS, MatState } from '../world/materials';

/** A material's name as the API speaks it ('sand', 'stone', 'leaflitter'…; 'air' for none). */
export type MaterialName = string;

const BY_NAME = new Map<string, number>(Object.entries(MAT).map(([k, v]) => [k.toLowerCase(), v as number]));

/** The id of a material named `name` (any case: 'Sand', 'sand'); throws on an unknown name. */
export function materialId(name: MaterialName): number {
  const id = BY_NAME.get(name.toLowerCase());
  if (id === undefined) throw new Error(`world: no material "${name}" (one of ${[...BY_NAME.keys()].join(', ')})`);
  return id;
}

/** The API name of material id `m`. */
export function materialName(m: number): MaterialName {
  for (const [k, v] of BY_NAME) if (v === m) return k;
  return MATERIALS[m]?.name ?? `material ${m}`;
}

/** 'solid' | 'loose' | 'liquid' | 'plant' | 'air' */
export function materialState(m: number): 'solid' | 'loose' | 'liquid' | 'plant' | 'air' {
  const s = MATERIALS[m]?.state ?? MatState.Empty;
  return s === MatState.Solid ? 'solid' : s === MatState.Granular ? 'loose' : s === MatState.Liquid ? 'liquid' : s === MatState.Vegetation ? 'plant' : 'air';
}

/** The column index under world (x, y), or -1 off the map. */
export function columnAt(w: number, h: number, x: number, y: number, ring?: { idx(x: number, y: number): number }): number {
  const [cx, cy] = cellAt(x, y);
  if (cx < 0 || cy < 0 || cx >= w || cy >= h) return -1;
  // (round 105, ringwin: a per-column buffer's index is the column's place on the window's ring)
  return ring ? ring.idx(cx, cy) : cy * w + cx;
}

/**
 * (round 112, herosandbox) The texel under world (x, y) in a texel-a-column texture's mirrored image (W wide), or -1
 * off the map. Not the per-column buffer's index: since round 107 (pages) a buffer is page-major and a texture holds
 * each page at its place, so the two differ for every window more than a page across (sim/pages.ts `t` / `i`).
 */
export function texelAt(w: number, h: number, x: number, y: number, ring: { t(x: number, y: number): number }): number {
  const [cx, cy] = cellAt(x, y);
  if (cx < 0 || cy < 0 || cx >= w || cy >= h) return -1;
  return ring.t(cx, cy);
}
