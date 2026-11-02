// The CC prop set as the game reads it: data/props/props.json, made by scripts/props/voxelise.mjs from CC0 models
// (CREDITS.md). Each prop a voxel grid at VOX voxels a metre (a sixteenth of a cell), each voxel a PROP_PALETTE index.
import propSet from '../../data/props/props.json';
import type { V3 } from '../api/contracts/interiors';

export interface PropVoxels {
  id: string;
  /** grid size (voxels): x along its front, y across, z up */
  dims: V3;
  /** x, y, z, palette index — four numbers a voxel */
  vox: number[];
  credit: string;
}

interface PropSet {
  vox: number;
  palette: { name: string; rgb: number[] }[];
  props: PropVoxels[];
}

const SET = propSet as unknown as PropSet;
export const VOX = SET.vox;
const BY_ID = new Map(SET.props.map((p) => [p.id, p]));

export function prop(id: string): PropVoxels {
  const p = BY_ID.get(id);
  if (!p) throw new Error(`interiors: no prop '${id}' in data/props/props.json (scripts/props/voxelise.mjs)`);
  return p;
}

/** a prop's size in metres: along its front, across, up */
export function propSize(id: string): V3 {
  const d = prop(id).dims;
  return [d[0] / VOX, d[1] / VOX, d[2] / VOX];
}

export function propIds(): string[] {
  return [...BY_ID.keys()];
}
