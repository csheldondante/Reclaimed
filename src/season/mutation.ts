// (loop-skeleton; docs/design/LOOP_SKELETON.md "Mutations") The world mutators' contract as the main loop uses it.
// The mutators themselves are another branch's (`mutators`, src/mutate/index.ts — flooded, burned, melted, buried,
// then abandoned, undead, lockdown; a per-lot condition word; world places with owner, status and tribute). The user,
// 2026-11-15: "Try making instant mutators instead since a lot of opportunities will happen in other area of the world".
// Until that branch merges, this file is the loop's copy of the announced shape — list; apply, INSTANT: the end state
// written at once, also for a place that isn't loaded, with an optional short reveal to play if the camera is there;
// record; restore — and the scene wires a small stand-in behind it (scenes/level/loop-standin.ts). At the merge this
// interface is replaced by the import and the stand-in is deleted; nothing else in the loop names a mutator's insides.

/** how a place of the world stands */
export type PlaceStatus = 'founded' | 'destroyed' | 'abandoned' | 'captured' | 'vassal';

/** a change to a part of a place (the first four), or to a whole place of the world (its new status) */
export type MutationKind = 'flooded' | 'burned' | 'melted' | 'buried' | PlaceStatus;

export interface MutationAsk {
  kind: MutationKind;
  /** the world place it happens in: a town's name, or a far place's id */
  place: string;
  /** the part of the place: its centre (window x, y now) and radius (world units); absent: the whole place, or a
   *  place that isn't loaded */
  area?: { at: [number, number]; radius: number };
  /** 0..1 */
  strength: number;
  seed: number;
}

/** a reveal playing: 0..1, and done when it's over. The world's state doesn't wait for it */
export interface MutationReveal {
  readonly progress: number;
  readonly done: Promise<void>;
}

export interface Applied {
  /** a short reveal of the change, if it has one and its place is loaded */
  play?(): MutationReveal;
}

/** an ambient indicator in a place while a condition lasts (the user, 2026-11-15: "Darkness and ash raining down are a
 *  great way to indicate a distant eruption. Having random undead rise in the city or crime are all indicators") */
export type SignKind = 'ashfall' | 'darkness' | 'undead' | 'crime';

export interface Mutators {
  /** a sign set over a place until a season (announced on the `mutators` branch: `sign`, `world.signs(place)`) */
  sign?(ask: { kind: SignKind; place: string; strength: number; until: number }): void;
  list(): MutationKind[];
  apply(ask: MutationAsk): Applied;
  /** what was applied, as plain data for the world store; and put back (a reload, a later run) */
  record(): unknown;
  restore(record: unknown): void;
}
