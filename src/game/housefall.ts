// (PA11) A building knocked down: its lot's External spans let go to air and, in the same step, blocks of the
// physics engine made where it stood (citygen/lotblocks.ts: the footprint's columns × its layers, cut into a few
// blocks). A swap of what the house is, not a break of its mesh: the crude first version (docs/design/
// PHYSICS_ENGINE.md "Buildings on the engine"). Knows neither the town nor the level: the caller gives the lot, how
// spans are let go and how a body is added. test/gpu/engine-house.test.ts holds it on a tiny world.
import { lotBlocks, lotColumns, type LotBox, type LotCell } from '../citygen/lotblocks';
import type { ApplyStage } from './colapply';

export type Release = NonNullable<ApplyStage['release']>;

export interface FellLot {
  columns: [number, number][];
  blocks: LotCell[][];
  cells: number;
}

/**
 * The lot's spans let go (to air: the blocks take their place) and its blocks added. The spans are let go over the
 * building's whole height, the blocks fill its whole layers (lotLayers). Null: the footprint holds no column.
 */
export function fellLot(lot: LotBox, mat: number, io: { release(spans: Release): void; drop(cells: LotCell[]): void }): FellLot | null {
  const columns = lotColumns(lot.quad);
  if (!columns.length) return null;
  const blocks = lotBlocks(lot, mat);
  io.release(columns.map(([x, y]) => ({ x, y, z0: lot.base - 0.05, z1: lot.base + lot.height + 0.05, fallback: 0, toAir: true })));
  for (const b of blocks) io.drop(b);
  return { columns, blocks, cells: blocks.reduce((s, b) => s + b.length, 0) };
}
