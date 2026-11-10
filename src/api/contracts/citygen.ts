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
  /** (farms) a field in a farm district or the farm belt: its footprint the field (its crop in the vegetation field —
   *  common.wgsl cropVeg — at its progress's stage), a hedge round it; words 19–21 a farmhouse at its first corner when
   *  its height is over 0 */
  field: 5,
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

/** (M4d hook) the kinds of opportunity that claim a town's district, and the district purpose each looks for
 *  (citygen/streets.wgsl P_*: 0 homes, 1 market, 2 harbour, 3 workshops, 4 farms, 5 keep) */
export type OpportunityKind = 'housing' | 'market' | 'harbour' | 'workshops' | 'farms' | 'keep';
export const OPPORTUNITY_PURPOSE: Record<OpportunityKind, number> = { housing: 0, market: 1, harbour: 2, workshops: 3, farms: 4, keep: 5 };

/** (M4d hook) a claim's answer: the town, the district (−1 none left), its centre in the town's frame (world units:
 *  CityDistricts.inWindow places it in the window as it is now — the window slides), the districts not begun after it */
export interface TownDistrict {
  town: string;
  id: number;
  at: [number, number];
  left: number;
}

/**
 * (season loop) A card's share of a district and its stage, all 0..1 of the district: its lots are taken in growth order
 * from the district's centre. A district holds two cards' shares at once (`slot` 0 or 1); a lot in a slot's [a, b]
 * rises with that slot's stage, from `from` to `to` (each lot a little after the last, so they're all up exactly at b);
 * any other lot stands if it's before `end` (the parts given out so far: earlier cards', all done) and isn't begun
 * after it.
 */
export interface DistrictStage {
  slot: 0 | 1;
  a: number;
  b: number;
  from: number;
  to: number;
  end: number;
}

/**
 * (M4d hook) A town's districts for the opportunity UI (citygen/towns.ts FieldTowns implements it; `window.citygen` in
 * the game with ?citygen=fields):
 *   claimDistrict(kind, town?) — the best district not begun for that kind's purpose in `town` (or the town nearest the
 *     view) — an argmax on the GPU; four words read back — starts building now: its lots rise over a few seconds of the
 *     town's clock, its roads appear, its claims follow. Resolves with the district (id −1 when none is left).
 *   districtsLeft(town?) — the districts not begun, counted on the GPU (four words back).
 *   inWindow(town, at) — a claim's centre (the town's frame) in the window as it is now.
 *   stageDistrict(town, id, stage, atOnce?) — (the season loop, docs/design/SEASON_LOOP.md) a card's share of the
 *     district built as far as its stage, eased over the build's span of the town's clock from now, or there at once
 *     (Skip). Its lots' progress (the per-lot progress buffer) follows on the GPU. 28 bytes up.
 *   timelapse(span) — every district not begun starts, the centre first, over `span` s (a debug view).
 * A town starts with its core built (districts within 0.35 of its growth key); the rest grows by claims.
 */
export interface CityDistricts {
  claimDistrict(kind: OpportunityKind, town?: string): Promise<TownDistrict>;
  districtsLeft(town?: string): Promise<{ town: string; left: number } | null>;
  stageDistrict(town: string, id: number, stage: DistrictStage, atOnce?: boolean): boolean;
  /**
   * (season life) The town wall: `wallStart` makes its ring round the lots begun (gates where the arterials cross) on
   * the GPU; `wallStage` its stage, from → to (0..1 of the ring: each piece rises in turn from the first gate), eased
   * over a build's span from now, or there at once (Skip). False: the town isn't live.
   */
  wallStart(town: string): boolean;
  wallStage(town: string, from: number, to: number, atOnce?: boolean): boolean;
  /** a point of a town's frame in the window now (null: the town isn't live) */
  inWindow(town: string, at: readonly [number, number]): [number, number] | null;
  timelapse(span?: number): boolean;
  /** the towns' clock (s) and its speed (×) */
  townTime: number;
  speed: number;
}

/**
 * (living town, docs/design/LIVING_TOWN.md) What a town's routes are made from — read only, in the grid's frame, a
 * word (or f32) a grid column (w × h, row-major) unless said:
 *   roads   the road raster: 0 none, 1 a road, 0x80000000 | z × 256 a bridge deck at world z (citygen streets.wgsl
 *           markRoad — every road the town draws: contours, cross, gap, grown streets, arterials, decks)
 *   heights the ground's world z (f32)
 *   wet     1.0 where water is (f32)
 *   pop     the population field, 4 f32 a column: density, wealth, purpose (streets.wgsl P_*), the arterials' distance
 *   art     the arterials: a count, then per arterial its points and its length to the town's limit (streets.wgsl ART)
 */
export interface CityRoutes {
  readonly roads: GPUBuffer;
  readonly heights: GPUBuffer;
  readonly wet: GPUBuffer;
  readonly pop: GPUBuffer;
  readonly art: GPUBuffer;
  /** (season life) the town wall's words (streets.wgsl WALL): the living town checks its posts' reach from them */
  readonly wall: GPUBuffer;
}
