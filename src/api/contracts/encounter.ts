// Encounters — what a played opportunity is on the screen (round 126, `encounters`). The user, after playing the
// living-world run: "the actual hero missions are still the race with a flag and not actually any of the in world
// things we discussed like chases or fights or scenes with conversations and combat." And earlier (round 120): "Don't
// have races unless you have arenas with jumps and crowds. Have chases. Flee. Deliver a message before enemies arrive".
//
// An EncounterSpec is data: who is in it (bands of units, where they come in round the hero, how fast), how it is won,
// how it is lost, and (a scene) what is said. It is made from a situation's area by src/encounters/spec.ts — the one
// place that decides it, so the card that offers it (the opportunity's `Encounter`) and the live play can't disagree —
// judged by src/encounters/rules.ts (pure: Node-tested) and played live by src/encounters/live.ts through the Units,
// the play session and the Dialog contracts. Its EncounterResult goes back to the opportunity as a Tier.
//
// Rules every spec keeps (spec.ts checks them; a Node test holds them for every player template):
// - its enemies (or its quarry) come in within seconds and close to the hero: `range` is cells from the hero, a screen
//   or less;
// - it can be lost without the hero dying (`beaten`, `limit`, a quarry that escapes, people lost);
// - a race only with an arena (jumps and crowds); there are none yet, so no card is a race;
// - no goal flag is the objective: a place may be pointed at (the way to safety, the camp), the play is the units.

import type { FactionId } from './world';
import type { Tier } from './opportunity';

export type EncounterSpecKind = 'chase' | 'flee' | 'fight' | 'defend' | 'escort' | 'scene' | 'race';

/** A band of units in an encounter. */
export interface Band {
  /** what it is to the encounter: the hunters on the hero, the foes it fights, the quarry it runs down, a camp's guards,
   *  the people it leads */
  part: 'pursuers' | 'foes' | 'quarry' | 'guards' | 'people';
  role: string;
  faction: FactionId | null;
  count: number;
  /** where they come in: behind the hero (on its tail), ahead of it (running, or across the road), all round it, or at
   *  the camp (a point ahead the encounter holds) */
  from: 'behind' | 'ahead' | 'around' | 'camp';
  /** cells from the hero (or the camp) they come in at */
  range: [number, number];
  /** riders: their pace as a share of the hero's cruise (absent: on foot, the units' own walk) */
  pace?: number;
  health: number;
  /** goes for the hero (and its people) as it comes in; a quarry runs, people follow */
  hostile: boolean;
}

/** One answer in a scene, and what it leads to. */
export interface SceneAnswer {
  id: 'fight' | 'yield' | 'bargain';
  /** the player's words */
  text: string;
  /** the speaker's reply when it works */
  reply: string;
  /** a bargain: what it costs (held goods; shown only if held) */
  cost?: { goods: string; count: number };
  /** a yield: they back down only before this (renown held, or a hero they dread); otherwise they laugh and fight */
  needs?: { renown?: number; dread?: string[] };
  /** a yield refused: their reply, and the fight starts */
  refused?: string;
}

export interface SceneSpec {
  speaker: { name: string; title: string; colour: string };
  /** what they say as the hero comes up */
  line: string;
  answers: SceneAnswer[];
}

export interface EncounterSpec {
  kind: EncounterSpecKind;
  /** the card's name for it (the opportunity's ENCOUNTER), and the banner's line of what to do */
  title: string;
  goal: string;
  bands: Band[];
  /** seconds it can go on; past it, lost (they got away, held the road, ran the hero ragged) */
  limit: number;
  /** the hero is beaten at or under this share of its health: lost, the hero alive (their blows stop) */
  beaten: number;
  /** a fight: the share of the foes down that breaks the rest (they run: won) */
  morale?: number;
  /** a flee: cells clear of every pursuer, held this many seconds, that count as having lost them */
  clear?: { cells: number; seconds: number };
  /** a flee to a place (the word carried to a hall): reaching it, this many cells ahead, wins as losing them does —
   *  its gate's guards take what follows the hero in. Pointed at; the play is the riders on the hero's tail */
  haven?: number;
  /** a chase: a quarry this many cells from where it started has got away, or this far from the hero */
  escape?: { cells: number; far: number };
  /** an escort: of the people, the share that must reach safety, cells off where they're freed; pursuers come in when
   *  they're freed */
  escort?: { safeShare: number; safety: number; pursuers: Band };
  scene?: SceneSpec;
  /** cells ahead of the hero the camp is (a trader's stall, the captives' pen): bands `from: 'camp'` come in round it */
  camp?: number;
  /** a race's arena (jumps and crowds); a race without one is refused */
  arena?: { jumps: number; crowd: number };
  /** defend / evacuate: the town's finale, judged by runsit/finale.ts (fires, the fall) */
  finale?: 'defend' | 'evacuate';
}

/** How it came out (the live play's report, a test's) */
export interface EncounterResult {
  tier: Tier;
  won: boolean;
  heroDied: boolean;
  seconds: number;
  /** a line for the end of it */
  why: string;
  /** hunters still on the hero as it leaves (the run's pursuers) */
  pursuers: number;
  /** a scene: the answer given */
  answer?: SceneAnswer['id'];
}
