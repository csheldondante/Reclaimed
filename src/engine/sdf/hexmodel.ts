// A body's cells (the world's hex-prism lattice, where they stand) as a model for the store (models.ts), whose grid
// is cubes. Pure (test/unit/sdf-hexmodel.test.ts).
//
// The lattice's rows are ROW_H (0.866) apart and its odd rows sit half a cell right; the store's voxels are cubes,
// here of half a cell (HEX_SDF_VOXEL). The cubes are laid over the cells' bounds, centred on them, z exact (a layer is
// two layers of cubes), and a cube is matter when a cell holds its centre.
// Why half a cell and not one: the fine pass's samples are points on a voxel's open face, edge or corner, and a face
// needs samples inside it to carry a body resting on it. At one cube a cell a block two cells wide is corners only,
// and two such blocks stacked square on each other had every sample of one on an edge of the other, where the field
// is zero and its normal sideways: they fell through each other (test/gpu/engine-pairs.test.ts, the dropped stack).
// Cost: eight times the field and the bake of one cube a cell (a 16-cell cube 185 KB, not 29 KB).
// Limit, logged (BACKLOG PJ4): the collision shape's sides are off by up to a quarter cell in x and y (the odd rows'
// zigzag is averaged, a body's width rounded to whole cubes). Tops and bottoms are exact, which is what a stack
// stands on.

import { cellAt, cellPos, ROW_H } from '../../world/lattice';
import type { SdfModelSpec } from './models';

export interface HexCell {
  x: number;
  y: number;
  z: number;
}

/** the store's spec for these cells: the grid, its occupancy, and `com` (the body's centre of mass, world, where the cells stand) in the grid's own voxel coordinates */
export const HEX_SDF_VOXEL = 0.5;

export function hexSdfSpec(cells: readonly HexCell[], com: readonly [number, number, number], voxel = HEX_SDF_VOXEL): SdfModelSpec & { origin: [number, number, number] } {
  const at = new Set<string>();
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const c of cells) {
    at.add(`${c.x},${c.y},${c.z}`);
    const [wx] = cellPos(c.x, c.y);
    x0 = Math.min(x0, wx - 0.5);
    x1 = Math.max(x1, wx + 0.5);
    y0 = Math.min(y0, c.y * ROW_H);
    y1 = Math.max(y1, (c.y + 1) * ROW_H);
    z0 = Math.min(z0, c.z);
    z1 = Math.max(z1, c.z + 1);
  }
  // (two rows of different parity overhang each other by half a cell: the grid takes the middle)
  const nx = Math.max(1, Math.round((x1 - x0 - 0.25) / voxel));
  const ny = Math.max(1, Math.round((y1 - y0) / voxel));
  const nz = Math.round((z1 - z0) / voxel);
  const origin: [number, number, number] = [(x0 + x1) / 2 - (nx * voxel) / 2, (y0 + y1) / 2 - (ny * voxel) / 2, z0];
  const vox = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const [cx, cy] = cellAt(origin[0] + (i + 0.5) * voxel, origin[1] + (j + 0.5) * voxel);
        if (at.has(`${cx},${cy},${Math.floor(z0 + (k + 0.5) * voxel)}`)) vox[i + nx * (j + ny * k)] = 1;
      }
  return { size: [nx, ny, nz], vox, voxel, com: [(com[0] - origin[0]) / voxel, (com[1] - origin[1]) / voxel, (com[2] - origin[2]) / voxel], origin };
}
