// World mutators (docs/design/MUTATORS.md): big, visible, persistent changes to a town and its land, applied as the
// outcome of the player's choices. The user (2026-11-15): "I want melted, flooded, buried, burned etc"; "see the
// mutations from all your choices … Strategy loop is just preparing for the opportunity and mutating the world."
//
// A mutator composes the engine's own sims — it queues the world's events (water, fire, lava vents, deposits) over its
// area in stages and marks the town's lots with a condition on the GPU. Nothing is read back; no CPU copy of the world.
// The sims it needs are awake only over its area and only while it plays (the events wake their chunks: sim/sleep.ts).
//
// THE CONTRACT (the loop branch codes against this file; keep it small):
//
//   import { mutators } from '../mutate';
//   mutators.list()                                   // the kinds: [{ kind, name, description }]
//   const h = mutators.apply({ kind: 'flooded', at: [x, y], radius: 24, strength: 1, seed: 7 });
//   h.progress   // 0..1      h.stage / h.stages   // the discrete visible stage      h.done   // boolean
//   await h.finished          // resolves when its last stage has settled and its sims are asleep again
//   h.skip()                  // the stages left applied at once (the world ends the same as if it had played)
//   mutators.record()         // what was applied, for the save and the "what changed" screen (JSON)
//   mutators.restore(record)  // a reloaded world: the applied list back, the lots' conditions made again from it
//
// The host (the level) binds a world once and pumps it: `mutators.bind(world)`, then `mutators.frame(dt)` each frame
// (world seconds; nothing runs when nothing is playing). Unbound, `apply` throws: there is no world to change.
//
// Coordinates: `at` is in the window as the world API's (x in cells, y in world units) at the time of the call — what
// `CityDistricts.inWindow(town, at)` returns. The record keeps world cells, so it survives the window sliding.

/** the mutators of round 1 (round 2: 'abandoned' | 'overgrown' | 'undead' | 'lockdown') */
export type MutatorKind = 'flooded' | 'burned' | 'melted' | 'buried';

export interface MutatorInfo {
  kind: MutatorKind;
  /** a short name for a button or a list */
  name: string;
  /** one plain line: what the player will see */
  description: string;
}

export interface MutationSpec {
  kind: MutatorKind;
  /** the centre in the window (x cells, y world units) */
  at: readonly [number, number];
  /** cells: nothing beyond it is written by the mutator itself (water and lava still run downhill as they do) */
  radius: number;
  /** 0..1: how far it goes (the water's depth, how much burns, the lava poured, the depth of the burial). Default 1 */
  strength?: number;
  /** which lots are spared and where the fires and vents start: the same seed, the same result. Default 1 */
  seed?: number;
}

export interface MutationHandle {
  /** the mutation's identity: kind, place (world cells), radius, strength and seed — applying the same one again
   *  returns the handle it already has and records nothing more */
  readonly id: string;
  readonly kind: MutatorKind;
  /** 0..1 over its whole time-lapse */
  readonly progress: number;
  /** the discrete visible stage it has reached (0: not begun … `stages`: the last one applied) */
  readonly stage: number;
  readonly stages: number;
  /** its last stage has settled; the sims it woke are left to sleep */
  readonly done: boolean;
  /** resolves when `done` */
  readonly finished: Promise<void>;
  /** the stages left applied now, in order */
  skip(): void;
}

/** one applied mutation as the save keeps it (world cells, not window: the window slides) */
export interface AppliedMutation {
  id: string;
  kind: MutatorKind;
  /** the centre in world cells (x, row) */
  cell: [number, number];
  radius: number;
  strength: number;
  seed: number;
  /** the stage it reached when recorded (a save mid time-lapse restores as finished: the columns are saved as they
   *  were, and the lots' conditions are made for the whole of it) */
  stage: number;
}

export interface MutationRecord {
  version: 1;
  applied: AppliedMutation[];
}

/**
 * A lot's visible condition: one u32 a lot record (the record's index), in a GPU buffer beside the town's progress
 * buffer (CityLots.condition). The low byte is the condition, the next byte how far it has gone (0..255: a burial's
 * depth over the building's height, a fire's stage). The town's mesh reads it when it rises (citygen/streets.wgsl
 * tlRise): a tint, the roof gone, the height cut. BACKLOG TM6's disrepair word will share this word (bits 16-23).
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
  // (round 2, reserved so saves and shaders agree)
  abandoned: 5,
  overgrown: 6,
  undead: 7,
  lockdown: 8,
} as const;
export type LotCondition = (typeof LOT_CONDITION)[keyof typeof LOT_CONDITION];

export interface Mutators {
  list(): readonly MutatorInfo[];
  apply(spec: MutationSpec): MutationHandle;
  record(): MutationRecord;
  restore(record: MutationRecord): void;
  /** the host's pump: world seconds since the last frame */
  frame(dt: number): void;
  /** the mutations playing now */
  readonly playing: readonly MutationHandle[];
}

export const MUTATORS: readonly MutatorInfo[] = [
  { kind: 'flooded', name: 'Flood', description: 'The water rises over the low ground. Houses it reaches are drowned and left empty.' },
  { kind: 'burned', name: 'Fire', description: 'Fire runs through the district. Roofs fall in, walls are left black, and the green burns off.' },
  { kind: 'melted', name: 'Magma', description: 'A vent opens and lava runs downhill. What it reaches is gone, and the ground sets as black rock.' },
  { kind: 'buried', name: 'Burial', description: 'Sand comes down over the district until the houses stand half under it.' },
];

/** what `mutators` drives once a world is bound (mutate/engine.ts makes it from a WorldCore and the town's lots) */
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
  record: () => (bound ? bound.record() : { version: 1, applied: [] }),
  restore: (record) => need().restore(record),
  frame: (dt) => bound?.frame(dt),
  get playing() {
    return bound ? bound.playing : [];
  },
};
