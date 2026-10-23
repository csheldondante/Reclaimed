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
export function columnAt(w: number, h: number, x: number, y: number): number {
  const [cx, cy] = cellAt(x, y);
  if (cx < 0 || cy < 0 || cx >= w || cy >= h) return -1;
  return cy * w + cx;
}
