// Freed pieces as rigid rows of the physics engine (`?solver=engine`; docs/design/PHYSICS_ENGINE.md "Terrain pieces
// are rows", step 4: the judge feeds rows). API: spawnRow.
//
// The judge has the piece's cells on the CPU at hand-over (it read the columns to judge them), and apply or wakeMetal
// cuts them out of the columns; here they become one row: a model made from the cells (Engine.add: content-keyed, its
// distance field baked through the store at the next tick), at the cells' own place, at rest. From then on it is any
// other row: terrain contacts, body against body, sleep. Its mesh is the engine's body mesh of its cells
// (engine/modelmesh.ts) — not the ground's surface it was a part of: PT2.
import { record } from '../../gpu/cpustat';
import type { Integrity } from '../integrity';

/** a freed piece (its cells: storage column, row, cell z — already out of the columns, or about to be) as a row */
export function spawnRow(ig: Integrity, cells: { x: number; y: number; z: number; mat: number }[], vel: [number, number, number] = [0, 0, 0]): boolean {
  const kit = ig.engine;
  if (!kit || !cells.length) return false;
  const t0 = performance.now();
  const body = kit.drop(cells, vel);
  // (the release's CPU cost: the model's bake of samples and records, its mesh, their uploads — PT3)
  const ms = performance.now() - t0;
  record('engine.release', ms);
  ig.stats.rowMs = Math.max(ig.stats.rowMs, ms);
  if (!body) return false;
  ig.stats.bodies++;
  ig.stats.rows = ig.stats.rows + 1;
  ig.stats.rowCells = ig.stats.rowCells + cells.length;
  return true;
}
