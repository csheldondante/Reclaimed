// The town generator's contract (citygen M4a; docs/design/CITYGEN.md): what a town made by the GPU field generator
// (src/citygen/) hands to the systems that build on it — the building and architecture style generator, the
// construction animation shader, and later the claims (M4b), routes (M4c), the plan (M4d) and physics. Everything here
// is a GPU buffer; nothing is read back. Consumers read the buffers in their own passes; they never read the
// generator's internal buffers (its fields, seeds, blocks).
//
// The user (2026-11-10): buildings stay plain extruded lot shapes in citygen; facades, dressing, superstructures and
// the construction animation are other sessions' work, from these records.

/** a record's kind (word 17) */
export const LOT_KIND = {
  /** an empty slot: dropped (blocked, a landmark's, a ragged edge left open, past the lots' count) */
  none: 0,
  /** a building plot: the footprint extruded to the height */
  building: 1,
  /** open land: no street fronts it (a garden, a yard) */
  park: 2,
  /** paved: a plaza block, a junction's plaza, a sliver */
  plaza: 3,
  /** a landmark site: a round plot at a busy junction (a plaza or a big structure — storeys 0 for a plaza) */
  landmark: 4,
} as const;

/** u32 words of a record (citygen/streets.wgsl RECW) */
export const LOT_RECORD_WORDS = 24;

/**
 * One lot record, LOT_RECORD_WORDS u32 words (f32 by bitcast where noted). Positions are in the town grid's frame:
 * world units from the grid's first column's corner; z in window z as it was when the town was made. A consumer
 * places them in the window with `place` (add its xyz), exactly as the town's own mesh is placed.
 *
 *   0–7    parcel: 4 corners (x, y; f32), counter-clockwise — the plot as the streets cut it
 *   8–15   footprint: 4 corners (f32) — the parcel inset by its streets' half widths and the setback (what a
 *          building stands on); a park's or a plaza's own surface; a landmark's: a square inscribed in its circle
 *          (the landmark's centre is the corners' mean, its radius the distance to a corner, for both quads)
 *   16     frontage: the parcel's edge k → k+1 (0–3) on the widest street fronting it (major over minor); 255 none
 *   17     kind (LOT_KIND)
 *   18     district: the supercell id (0 with supercells off)
 *   19     storeys (u32; 0 for open land) — about 3 world units each
 *   20     height (f32): the base to the roof, world units — the height-to-plot rule's: no taller than the ratio ×
 *          the footprint's shortest side, never under a storey
 *   21     base z (f32): the building's bottom (half a unit under its lowest corner's ground)
 *   22     growth key (f32): the town shows a block once its growth passes this (the time-lapse's order)
 *   23     seed (u32): the lot's identity — its block and its place in its block's splits; stable while the
 *          layout's inputs are; a landmark's 0x40000000 | its site index
 *
 * Record i < counts[0] is lot slot i; record counts[3] + k (k < counts[1]) is landmark site k. An index is stable
 * until the town's lots are made again (a change at the 'lots' stage or before); the seed is the identity across that.
 */
/** the town's GPU buffers for what builds on it */
export interface CityLots {
  /** the lot records (STORAGE, read): LOT_RECORD_WORDS u32 a record, lots then landmark sites */
  readonly records: GPUBuffer;
  /**
   * the counts (STORAGE, read; 4 u32): 0 lots made (clamp to counts[3] — the lot room), 1 landmark sites (clamp to
   * 64), 2 words a record, 3 the first landmark record (the lot room)
   */
  readonly counts: GPUBuffer;
  /**
   * construction progress (STORAGE, read-write; f32 a record, 0–1): 1 when the lots are made (built). The owner of
   * construction writes it on the GPU; the town's own mesh scales each building's height by it on its next mesh run.
   * Its index is the record's.
   */
  readonly progress: GPUBuffer;
  /** where the grid's frame is in the window (UNIFORM; vec4 f32: xyz added to a position), rewritten on a slide */
  readonly place: GPUBuffer;
}

// (M4b, planned — the shape the claims must keep) The town claims its buildings' columns as External intervals naming
// the town's grid (DESIGN §3, §17), from these records on the GPU. A claim is per record (its index and seed in the
// interval's owner word), so a later step — physics integration (structural integrity, collapse, rigid bodies:
// DESIGN §9, §10) or the building generator — can take over a building's intervals by its record: release the town's
// claim on that record and write its own, with nothing else of the town's touched. Physics integration is a separate
// step, not citygen's (the user: "Physics integration is a must but can be a separate step as well. It may make sense
// to do as part of the improved building generators").
