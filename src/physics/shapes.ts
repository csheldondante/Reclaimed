// Simple test shapes for the physics playground (docs/PHYSICS.md), in the
// models' own format (world/models.ts VoxelModel).

import type { VoxelModel } from '../world/models';

/** A solid box of one material. */
export function box(mat: number, w: number, d: number, h: number, id = `box-${mat}-${w}x${d}x${h}`): VoxelModel {
  const vox = new Uint8Array(w * d * h).fill(mat);
  return { id, name: id, size: [w, d, h], vox, sink: 0 };
}

/** A table: a slab on four legs (what loses a leg tips or sags). */
export function table(slab: number, legs: number, w = 10, d = 6, h = 6): VoxelModel {
  const vox = new Uint8Array(w * d * h);
  for (let z = 0; z < h; z++)
    for (let y = 0; y < d; y++)
      for (let x = 0; x < w; x++) {
        const leg = (x < 2 || x >= w - 2) && (y < 2 || y >= d - 2);
        if (z === h - 1) vox[x + w * (y + d * z)] = slab;
        else if (leg) vox[x + w * (y + d * z)] = legs;
      }
  return { id: `table-${slab}-${legs}`, name: 'table', size: [w, d, h], vox, sink: 0 };
}

/** The drop tool's catalogue: test shapes, then every model as a physics body. */
export interface BodyKind {
  id: string;
  name: string;
  make: () => VoxelModel;
}

export function bodyCatalogue(models: VoxelModel[], mat: Record<string, number>): BodyKind[] {
  const shapes: BodyKind[] = [
    { id: 'steel-beam', name: 'steel beam', make: () => box(mat.Steel, 18, 2, 2) },
    { id: 'steel-plate', name: 'steel plate', make: () => box(mat.Steel, 10, 10, 1) },
    { id: 'stone-block', name: 'stone block', make: () => box(mat.Stone, 5, 5, 5) },
    { id: 'stone-pillar', name: 'stone pillar', make: () => box(mat.Stone, 3, 3, 10) },
    { id: 'concrete-slab', name: 'concrete slab', make: () => box(mat.Concrete, 12, 6, 2) },
    { id: 'brick-wall', name: 'brick wall', make: () => box(mat.Brick, 10, 2, 8) },
    { id: 'table', name: 'concrete table, stone legs', make: () => table(mat.Concrete, mat.Stone) },
    { id: 'steel-table', name: 'steel table', make: () => table(mat.Steel, mat.Steel) },
    { id: 'rust-beam', name: 'rusted beam', make: () => box(mat.Rust, 18, 2, 2) },
    { id: 'wood-plank', name: 'wooden plank', make: () => box(mat.Wood, 14, 3, 1) },
  ];
  return [...shapes, ...models.map((m) => ({ id: `model:${m.id}`, name: m.name, make: () => m }))];
}
