// World mutators (docs/design/MUTATORS.md): big, visible, persistent changes to a place and its land, applied as the
// outcome of the player's choices. The user (2026-11-15): "I want melted, flooded, buried, burned etc"; "see the
// mutations from all your choices … Strategy loop is just preparing for the opportunity and mutating the world."
// And the mechanism (2026-11-15): "Try making instant mutators instead since a lot of opportunities will happen in other
// area of the world like new mining settlements or other cities being captured or destroyed or occupied or made into
// vassala that have to pay tribute or invoke negative opportunities".
//
// A mutator is an INSTANT, DETERMINISTIC operation: (kind, place, area, strength, seed) → the end state written directly,
// in a few GPU dispatches of interval edits and record writes. No simulation runs, no sim is woken, nothing waits, and
// nothing is read back. Every op is a pure function of a column (or a lot record) and the modifier's own record, so it
// gives the same result whether its land is in the window now or streams in next week, a region at a time.
//
// THE CONTRACT (the loop branch codes against this file; keep it small):
//
//   import { mutators } from '../mutate';
//   mutators.list()                                    // the kinds: [{ kind, name, description, group }]
//   const m = mutators.apply({ kind: 'flooded', place: 'kaudru' });            // a whole place, by its atlas id
//   const m = mutators.apply({ kind: 'burned', at: [12304, 5457], radius: 24, strength: 1, seed: 7 });  // an area
//   const m = mutators.apply({ kind: 'vassal', place: 'kaudru', by: 'player', tribute: 3 });            // a record
//   m.resident                 // true: its land was in the window and was written now; false: it waits for arrival
//   mutators.play(m)           // optional: a short reveal if the camera is there (presentation only; same end state)
//   mutators.places()          // every place the list has touched: owner, status, tribute, conditions — for the dealer
//   mutators.place(id)         // one place (any atlas place: untouched ones answer 'standing', their own owner)
//   mutators.record()          // the world modifier list, JSON, for the save and the "what changed" screen
//   mutators.restore(record)   // a reloaded world: the list back; land and lots are mutated again as they arrive
//
// The list is the persistent truth. Applying appends to it (the same modifier twice is one entry). Land in the window is
// written at once; land that is not is written right after it is generated or streamed in, every modifier that touches
// it, in list order. The ops are idempotent, so land saved after it was mutated takes them again unchanged.
//
// Coordinates: world cells [x, row] — the atlas's own, the same wherever the window is. `place` names an atlas place
// (a settlement's id): its centre and its extent are the area.

/** physical: the land and the lots on it are rewritten */
export type PhysicalKind = 'flooded' | 'burned' | 'melted' | 'buried';
/** world state: a record changes and the place shows it (the map's mark, its lots' condition) */
export type StateKind = 'founded' | 'destroyed' | 'abandoned' | 'captured' | 'vassal';
export type MutatorKind = PhysicalKind | StateKind;

export interface MutatorInfo {
  kind: MutatorKind;
  group: 'land' | 'state';
  /** a short name for a button or a list */
  name: string;
  /** one plain line: what the player will see */
  description: string;
}

export interface MutationSpec {
  kind: MutatorKind;
  /** an atlas place (a settlement id). Its centre is the area's, its extent the radius, unless `at` / `radius` say */
  place?: string;
  /** the centre in world cells [x, row]; needed when there is no `place` (and for 'founded': where the new place is) */
  at?: readonly [number, number];
  /** cells. Nothing beyond it is written */
  radius?: number;
  /** 0..1: how far it goes (the water's height, how much burns, how far the lava runs, the burial's depth). Default 1 */
  strength?: number;
  /** which lots are spared, where the vent opens, the dunes' shape: the same seed, the same result. Default 1 */
  seed?: number;
  /** 'captured', 'vassal': who holds it now. 'founded': who founded it */
  by?: string;
  /** 'vassal': what it pays each season */
  tribute?: number;
  /** 'founded': the new place's name and kind */
  name?: string;
  size?: 'camp' | 'village' | 'town';
}

/** One entry of the world modifier list: everything an op needs, so it can run on any column at any time. JSON. */
export interface Mutation {
  /** its identity: kind, place or cell, radius, strength, seed (and by / tribute) — the same again is the same entry */
  id: string;
  kind: MutatorKind;
  place: string | null;
  /** world cells [x, row] */
  cell: [number, number];
  radius: number;
  strength: number;
  seed: number;
  /** the op's own numbers, fixed when it was applied (from the atlas's ground, never from the window): 'flooded' the
   *  water's level (world z), 'melted' the vent's cell and height, 'buried' the base depth */
  params: number[];
  by?: string;
  tribute?: number;
  name?: string;
  size?: 'camp' | 'village' | 'town';
  /** its place in the list (the order ops are applied in) */
  seq: number;
}

/** what `apply` hands back: the entry, and whether its land was written now */
export interface Applied extends Mutation {
  /** some of its area was in the window and was written at once */
  resident: boolean;
  /** false: this exact modifier was on the list already; nothing was added or written */
  fresh: boolean;
}

export type PlaceStatus = 'standing' | 'founded' | 'destroyed' | 'abandoned' | 'occupied' | 'vassal';

/** A place as the list has left it — what the loop's dealer reads to deal cards about other places. */
export interface PlaceState {
  id: string;
  name: string;
  /** world cells [x, row] */
  at: [number, number];
  /** the place's own kind (the atlas's size word, or a founded place's) */
  size: string;
  /** who holds it ('' the place's own people) */
  owner: string;
  status: PlaceStatus;
  /** what it pays its owner each season (0 unless a vassal) */
  tribute: number;
  /** 0..1: the people left (0 destroyed or abandoned) */
  population: number;
  /** the land mutators that touched it, in order */
  conditions: PhysicalKind[];
  /** true: something bad may come of it (a vassal resents, an occupied town may rise) — a source of negative cards */
  restless: boolean;
  /** the list entries about it, in order */
  history: string[];
}

export interface MutationRecord {
  version: 2;
  list: Mutation[];
}

/**
 * A lot's visible condition: one u32 a lot record (the record's index), in a GPU buffer beside the town's progress
 * buffer (CityGen.condition). The low byte is the condition, the next byte how far it has gone (0..255). The town's
 * mesh reads it when it rises (citygen/streets.wgsl tlRise): a tint, the roof gone, the height cut. BACKLOG TM6's
 * disrepair word will share this word (bits 16-23).
 */
export const LOT_CONDITION = {
  standing: 0,
  /** its ground is under water */
  drowned: 1,
  /** fire went through it: charred walls, the roof gone */
  burned: 2,
  /** lava reached it: a stump of dark rock, its claim released */
  destroyed: 3,
  /** sediment stands against it: it keeps its claim under the sand, to be dug out */
  buried: 4,
  /** nobody lives there: faded, the roof sagging */
  abandoned: 5,
  /** held by another: its roof in the holder's colour */
  occupied: 6,
  // (reserved so saves and shaders agree)
  overgrown: 7,
  undead: 8,
  lockdown: 9,
} as const;
export type LotCondition = (typeof LOT_CONDITION)[keyof typeof LOT_CONDITION];

export interface Mutators {
  list(): readonly MutatorInfo[];
  apply(spec: MutationSpec): Applied;
  /** presentation only, optional: a short reveal when the camera is there. Resolves when it ends (at once if it can't) */
  play(m: Mutation, opts?: { seconds?: number }): Promise<void>;
  places(): PlaceState[];
  place(id: string): PlaceState | null;
  record(): MutationRecord;
  restore(record: MutationRecord): void;
}

export const MUTATORS: readonly MutatorInfo[] = [
  { kind: 'flooded', group: 'land', name: 'Flood', description: 'The low ground goes under water. Houses in it are drowned and left empty.' },
  { kind: 'burned', group: 'land', name: 'Fire', description: 'Fire has gone through. Roofs are gone, walls are black, and the green is ash.' },
  { kind: 'melted', group: 'land', name: 'Magma', description: 'A vent opened and lava ran downhill. What it reached is gone under black rock.' },
  { kind: 'buried', group: 'land', name: 'Burial', description: 'Sand lies over the district. The houses stand half under it.' },
  { kind: 'founded', group: 'state', name: 'Found a place', description: 'A new camp or village stands here.' },
  { kind: 'destroyed', group: 'state', name: 'Destroy', description: 'The place is a burned ruin. Nobody is left.' },
  { kind: 'abandoned', group: 'state', name: 'Abandon', description: 'Its people have gone. The houses stand empty.' },
  { kind: 'captured', group: 'state', name: 'Capture', description: 'Another power holds the place now.' },
  { kind: 'vassal', group: 'state', name: 'Make a vassal', description: 'The place keeps its people but pays tribute each season.' },
];

/** what `mutators` drives once a world is bound (mutate/engine.ts makes it from the atlas and the level's world) */
let bound: Mutators | null = null;
const need = (): Mutators => {
  if (!bound) throw new Error('mutators: no world bound (the level calls mutators.bind first)');
  return bound;
};

/** The one entry point. `bind(null)` when the world is torn down. */
export const mutators: Mutators & { bind(impl: Mutators | null): void; readonly ready: boolean } = {
  bind: (impl) => void (bound = impl),
  get ready() {
    return bound !== null;
  },
  list: () => MUTATORS,
  apply: (spec) => need().apply(spec),
  play: (m, opts) => need().play(m, opts),
  places: () => (bound ? bound.places() : []),
  place: (id) => (bound ? bound.place(id) : null),
  record: () => (bound ? bound.record() : { version: 2, list: [] }),
  restore: (record) => need().restore(record),
};
