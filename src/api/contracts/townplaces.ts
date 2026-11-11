// The town contracts for Track B's unit minds (U2/U3): a side map of each town's wall and a table of a town's named
// places, both resolved on the GPU from citygen's records (src/towncontracts/; docs/design/TOWN_CONTRACTS.md). The CPU
// authors orders by index only — a town's index (its slot here), a place's name (PLACE), a district id and a rank — and
// never reads either table: the GPU resolves an order's intent where it runs, and an invalid place there raises Track B's
// `orderFailed`.
//
// 1. The side map: Track B's own `agentSides` buffer (agents/notice.ts UnitNotice.sides; notice.wgsl `sides`), a u32 a
//    window column in window order (y * W + x): 0 open (outside every wall, or a wall breached / a gate open there), else
//    the side of the town whose sealed inside the column is in — the town's index + 1 (SIDE_OF). Written on the GPU when
//    a ring changes, a piece rises or is breached, the water moves, or the window slides; nothing on the CPU decides it.
// 2. The named-place table: one read-only storage buffer for every town slot (TownContractsApi.places), read only
//    through src/shaders/townplace.wgsl at PLACE_BINDING: `place(town, name)`, `placeApproach`, `placeStatus`,
//    `placeValid`, `houseAt(town, district, rank)`, `lotAt(town, district, kind, rank)`, … The layout behind them is
//    Track A's to change; the constants below are what the CPU authors orders with.

/** townplace.wgsl's binding */
export const PLACE_BINDING = 57;
/** town slots the tables hold (the static claims' arena's: the towns live at once) */
export const TOWN_ROOM = 4;
/** gate slots (routeread.wgsl gateSlots: the arterials' room, then the filler gates') and the arterials' room */
export const GATE_SLOTS = 10;
export const ARTERIAL_ROOM = 8;

/**
 * A named place (townplace.wgsl PLACE_*). A gate is `PLACE.gate0 + k` with k the gate slot — routeread.wgsl's
 * gateRoute(k) indexing: the arterial's index (the order of the atlas roads the town was given), filler gates after.
 * A spawn point is `PLACE.spawn0 + k`, arterial k's road where it leaves the town's limit (where a raid arrives).
 */
export const PLACE = {
  /** the muster yard: the open lot (plaza, park, an open landmark) inside the ring nearest its first gate — the walls
   *  card designates it; none before the ring is made */
  muster: 0,
  /** the stores: the begun building nearest the centre in a market district, else nearest the centre (the living
   *  town's own STORES rule) */
  stores: 1,
  /** the barracks: the keep district's biggest begun building other than the keep — the keep card raises it */
  barracks: 2,
  /** the market: the begun open lot (else building) of a market district nearest the centre */
  market: 3,
  /** the keep: the keep district's tallest begun building */
  keep: 4,
  gate0: 5,
  spawn0: 5 + GATE_SLOTS,
} as const;
export const NAMED_PLACES = PLACE.spawn0 + ARTERIAL_ROOM;
export type PlaceName = keyof typeof PLACE;

/** an entry's status (townplace.wgsl PLACE_OK …): only OK is valid for an order */
export const PLACE_STATUS = {
  ok: 0,
  /** it doesn't exist: no such card built (no keep district begun, no ring), no lot there, no gate on that arterial */
  none: 1,
  /** begun, not finished: a building still rising, a gate whose wall isn't up */
  rising: 2,
  /** a gate over water */
  water: 3,
  /** no live town in that slot */
  noTown: 4,
} as const;

/** a status's name (orderFailed's `why`) */
export type PlaceStatusName = keyof typeof PLACE_STATUS;

/**
 * (trackA-forces; the calls agreed with Track B for U2 round 5) Where a group is spawned or ordered to: a town's slot and
 * a named place, or a district's lot by purpose and rank — indices only, resolved on the GPU where the order runs.
 * `else`: the next place to try when this one isn't valid (PLACE_OK) — an authored preference ("a gate, else the keep"),
 * resolved in order where the order runs; an order whose last choice isn't valid fails (`orderFailed`, the status's
 * name). `also`: a second named place of the same town that must be valid too for this choice to be taken (a raid's
 * spawn point only where its arterial's gate stands, and that gate only where its spawn point is). (`else` and `also`
 * are Track A's additions to the agreed shape: for Track B's spawnAt / orderGroup to take, or the season
 * side issues the chain itself.)
 */
export type PlaceRef = ({ town: number; place: number; also?: number } | { town: number; district: number; purpose: number; rank: number }) & { else?: PlaceRef };

/** a group of units spawned together (spawnAt's) */
export type GroupId = number;

/** a town's side number in the side map (0 is open) */
export const SIDE_OPEN = 0;
export const SIDE_OF = (town: number): number => town + 1;

/** how a gate counts in the side map: a barrier (closed: its inside sealed while the wall stands — the default, until
 *  gates open and close as things of their own) or open (an open gate joins the inside to the outside) */
export type SideGates = 'closed' | 'open';

/** (src/towncontracts/contracts.ts TownContracts) what the CPU holds: indices, never contents */
export interface TownContractsApi {
  /** the table (STORAGE, read): bind it at PLACE_BINDING with townplace.wgsl */
  readonly places: GPUBuffer;
  /** a live town's index (slot) by its site id: what an order carries; −1 when it isn't live */
  townIndex(id: string): number;
  /** the side map's gate rule (an input: the map is solved again on the GPU) */
  gates: SideGates;
}
