// ---- townplace.wgsl: a town's named places, resolved on the GPU (contract: src/api/contracts/townplaces.ts) ----------
// For any system that sends units somewhere in a town (Track B's orders: go, muster, man, march …) by intent, without
// knowing how the town is made. One read-only storage binding, PLACE_BINDING, holding every town slot's table
// (towncontracts/places.wgsl writes it from citygen's records when they change; nothing passes through the CPU).
//
// An order carries indices only: the town (its slot: TownContracts.townIndex on the CPU), a name (PLACE_*), or a district
// id, a lot kind and a rank. The GPU resolves them here:
//   place(town, name) / placeApproach(town, name)   where it is in the window (x, y, z: on the walkable ground — a
//                                                   building's door, open land's middle, a gate on its road, a bridge
//                                                   deck at its height) and the point to come to it from (a door's
//                                                   street, a gate's inside, a spawn's way in)
//   placeStatus / placeValid                        PLACE_OK only is valid: a place not built (no keep card, no ring), a
//                                                   building still rising, a gate not up or over water is not, and the
//                                                   unit's order fails (Track B's orderFailed)
//   gatePlace(k), spawnPlace(k)                     names of gate slot k (routeread.wgsl gateRoute(k)'s indexing: the
//                                                   arterial's index, filler gates after) and arterial k's spawn point
//   districtPurpose(town, d)                        a district's purpose (citygen P_*: 0 homes, 1 market, 2 harbour,
//                                                   3 workshops, 4 farms, 5 keep; PLACE_NONE_U none)
//   lotCount(town, d, kind) / lotAt(town, d, kind, rank) / houseAt(town, d, rank)
//                                                   the plural things: district d's lots of a kind (LOT_KIND: 1 a
//                                                   building, 2 a park, 3 a plaza, 4 a landmark, 5 a field) ranked by their
//                                                   growth key then their seed (the order the district fills in; never
//                                                   the record's index, which follows the GPU's thread order). A handle
//                                                   for the lot* functions; houseAt is the building kind's.
//   townLive(town), townKey(town), townGeneration(town)  a slot with a town; its site id's hash; moves on when the slot
//                                                   gets another town (an order holding a town index compares it)
// The layout behind these functions may change; read only through them.

const PLACE_BINDING: u32 = 57u;
@group(0) @binding(57) var<storage, read> placeBuf: array<u32>;

/** the names (api/contracts/townplaces.ts PLACE) */
const PLACE_MUSTER: u32 = 0u;
const PLACE_STORES: u32 = 1u;
const PLACE_BARRACKS: u32 = 2u;
const PLACE_MARKET: u32 = 3u;
const PLACE_KEEP: u32 = 4u;
const PLACE_GATE0: u32 = 5u;
const PLACE_SPAWN0: u32 = 15u;
const PLACE_NAMED: u32 = 23u;
/** statuses (PLACE_STATUS) */
const PLACE_OK: u32 = 0u;
const PLACE_NONE: u32 = 1u;
const PLACE_RISING: u32 = 2u;
const PLACE_WATER: u32 = 3u;
const PLACE_NO_TOWN: u32 = 4u;
const PLACE_NONE_U: u32 = 0xffffffffu;
const PLACE_TOWNS: u32 = 4u;

// (the layout: towncontracts/places.wgsl TP_* — keep in step)
const PLT_WORDS: u32 = 42240u;
const PLT_ENTRY: u32 = 8u;
const PLT_NAMED_AT: u32 = 16u;
const PLT_DIX_AT: u32 = 200u;
const PLT_DPUR_AT: u32 = 3272u;
const PLT_LOTS_AT: u32 = 3528u;
const PLT_DISTRICTS: u32 = 256u;
const PLT_KINDS: u32 = 6u;

fn plBase(town: u32) -> u32 { return min(town, PLACE_TOWNS - 1u) * PLT_WORDS; }
fn townLive(town: u32) -> bool { return town < PLACE_TOWNS && placeBuf[plBase(town)] == 1u; }
fn townKey(town: u32) -> u32 { return placeBuf[plBase(town) + 1u]; }
fn townGeneration(town: u32) -> u32 { return placeBuf[plBase(town) + 2u]; }
fn plOffset(town: u32) -> vec3<f32> { let o = plBase(town); return bitcast<vec3<f32>>(vec3<u32>(placeBuf[o + 4u], placeBuf[o + 5u], placeBuf[o + 6u])); }
fn plWord(town: u32, at: u32, w: u32) -> u32 { return placeBuf[plBase(town) + at + w]; }
fn plPoint(town: u32, at: u32, w: u32) -> vec3<f32> {
  let o = plBase(town) + at + w;
  return bitcast<vec3<f32>>(vec3<u32>(placeBuf[o], placeBuf[o + 1u], placeBuf[o + 2u])) + plOffset(town);
}
fn plNamedAt(name: u32) -> u32 { return PLT_NAMED_AT + min(name, PLACE_NAMED - 1u) * PLT_ENTRY; }

/** a named place's status (PLACE_*): PLACE_NO_TOWN for an empty slot, PLACE_NONE for a name past the table */
fn placeStatus(town: u32, name: u32) -> u32 {
  if (!townLive(town)) { return PLACE_NO_TOWN; }
  if (name >= PLACE_NAMED) { return PLACE_NONE; }
  return plWord(town, plNamedAt(name), 3u);
}
fn placeValid(town: u32, name: u32) -> bool { return placeStatus(town, name) == PLACE_OK; }
/** where it is, in the window (meaningless unless placeValid — or PLACE_RISING, where it will be) */
fn place(town: u32, name: u32) -> vec3<f32> { return plPoint(town, plNamedAt(name), 0u); }
fn placeApproach(town: u32, name: u32) -> vec3<f32> { return plPoint(town, plNamedAt(name), 4u); }
/** its record's seed (a lot), its ring segment (a gate), its arterial (a spawn point) */
fn placeAux(town: u32, name: u32) -> u32 { return plWord(town, plNamedAt(name), 7u); }
fn gatePlace(k: u32) -> u32 { return PLACE_GATE0 + k; }
fn spawnPlace(k: u32) -> u32 { return PLACE_SPAWN0 + k; }

// ---- the plural things: lots by (district, kind, rank) ----
fn districtPurpose(town: u32, d: u32) -> u32 {
  if (!townLive(town) || d >= PLT_DISTRICTS) { return PLACE_NONE_U; }
  return placeBuf[plBase(town) + PLT_DPUR_AT + d];
}
fn plBin(d: u32, kind: u32) -> u32 { return PLT_DIX_AT + 2u * (min(d, PLT_DISTRICTS - 1u) * PLT_KINDS + min(kind, PLT_KINDS - 1u)); }
/** district d's lots of this kind (begun or not) */
fn lotCount(town: u32, d: u32, kind: u32) -> u32 {
  if (!townLive(town) || d >= PLT_DISTRICTS || kind >= PLT_KINDS) { return 0u; }
  return placeBuf[plBase(town) + plBin(d, kind) + 1u];
}
/** a handle for the rank-th (0-based) lot of district d of this kind, or PLACE_NONE_U past the count */
fn lotAt(town: u32, d: u32, kind: u32, rank: u32) -> u32 {
  if (rank >= lotCount(town, d, kind)) { return PLACE_NONE_U; }
  return PLT_LOTS_AT + (placeBuf[plBase(town) + plBin(d, kind)] + rank) * PLT_ENTRY;
}
fn houseAt(town: u32, d: u32, rank: u32) -> u32 { return lotAt(town, d, 1u, rank); }
/** a lot handle's status: PLACE_OK built, PLACE_RISING going up, PLACE_NONE not begun (or no such lot) */
fn lotStatus(town: u32, h: u32) -> u32 {
  if (!townLive(town)) { return PLACE_NO_TOWN; }
  if (h == PLACE_NONE_U) { return PLACE_NONE; }
  return plWord(town, h, 3u);
}
fn lotValid(town: u32, h: u32) -> bool { return lotStatus(town, h) == PLACE_OK; }
/** a lot's door (a building) or middle (open land), and its street, in the window */
fn lotPlace(town: u32, h: u32) -> vec3<f32> {
  if (h == PLACE_NONE_U) { return vec3<f32>(0.0); }
  return plPoint(town, h, 0u);
}
fn lotApproach(town: u32, h: u32) -> vec3<f32> {
  if (h == PLACE_NONE_U) { return vec3<f32>(0.0); }
  return plPoint(town, h, 4u);
}
/** a lot's seed: its identity across the town being made again (citygen's record word 23) */
fn lotSeedOf(town: u32, h: u32) -> u32 {
  if (h == PLACE_NONE_U) { return 0u; }
  return plWord(town, h, 7u);
}
