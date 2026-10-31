// A situation — a run as one unfolding situation on the live map (round 120, `runsit`; BACKLOG RS20-RS22).
// The user (round 120): "Have an objective to protect a city form zombies and have zombies assail the city. Let it burn
// down if the player fails. ... the missions should not be disjoint levels they should be objectives and situations
// spawned into the active map with real consequences. ... when the player reaches the boundary of an area they get the
// map and choices of where to go based on the actual situation. Deliver a message to the Red Hold to get them to send
// reinforcements or warn the town and lead the peoplen into the hills." And on who writes it: "This is what we want the
// gm to do possibly with templates. Look at world state and tell a story with meaningful decisions for the player run."
//
// A Situation is plain data (JSON), a sibling of the SessionStory (story.ts): a threat with a clock and a route on the
// real region graph, the place it comes for, the areas the hero plays (1-3 screens each, played live), the choices at
// each area's edge, the items on the way, and what each ending does to the world. Written by the GM from the world
// wiki (docs/GM.md "Situations"; data/situations/*.json) or filled from the template (src/runsit/fill.ts, deterministic
// from the seed — what tests and a run with no GM file use). src/gm/situationcheck.ts validates it.
// Why its own contract and not more SessionStory fields: a story is a kit of people and talks over places; a situation
// is a clock, a route and a few forks over the map. They share Outcome (what an ending does to the world) and can live
// side by side (a later story's people inside a situation's town).

import type { Bark, Outcome } from './story';
import type { FactionId, RegionId } from './world';
import type { ItemDef } from './items';
import type { Settlement } from './settlement';

export interface Situation {
  id: string;
  title: string;
  /** a paragraph: what's happening and what the hero can do about it */
  premise: string;
  /** the world it was written for */
  from: { worldVersion: number; run: number; seed: number };
  /** the hero it was written for, or 'any' */
  hero: string;
  threat: SituationThreat;
  /** what the threat comes for */
  target: { settlement: string; region: RegionId; name: string };
  /** where the target's people can be led if they're warned (the hills): a region at or next to the target's */
  refuge: { region: RegionId; name: string };
  /** the areas the hero plays; areas[0] is where the run starts, exactly one is the finale (play 'town') */
  areas: SituationArea[];
  /** the ways on at each area's edge (the player picks one on the map) */
  choices: SituationChoice[];
  /** the items the run offers (found, traded, given) */
  items: ItemDef[];
  /** how it can end, and what each does to the world */
  endings: Record<SituationEnd, SituationEnding>;
}

export interface SituationThreat {
  kind: 'horde';
  /** "the Hollow Host" */
  name: string;
  faction: FactionId;
  /** what its units are (the unit generator's role): "walking dead" */
  role: string;
  /** how many come at the target (the finale), before anything thins them */
  count: number;
  /** the regions it marches through, where it rises first, the target's region last (borders between neighbours) */
  route: RegionId[];
  /** run minutes until it reaches the target if nothing slows it (the clock) */
  arrives: number;
  /** its outriders, who hunt the hero from the start: how many, their role, and minutes behind the hero at the start */
  outriders?: { count: number; role: string; behind: number };
}

/** saved: the threat broken and the town standing; burned: the town fell and burned; evacuated: its people led to the
 *  refuge (the town may burn behind them); fell: the hero died */
export type SituationEnd = 'saved' | 'burned' | 'evacuated' | 'fell';
export const SITUATION_ENDS: readonly SituationEnd[] = ['saved', 'burned', 'evacuated', 'fell'];

export interface SituationEnding {
  /** a line for the end card */
  text: string;
  /** what it does to the world (AtlasEvents, attitudes: story.ts Outcome) */
  outcome: Outcome;
  /** the target settlement's condition after it (settlement.ts) */
  settlement?: Settlement['condition'];
}

export interface SituationArea {
  id: string;
  name: string;
  region: RegionId;
  /** a settlement the area is (the hold, the town): it stands at the settlement */
  settlement?: string;
  /** world units; default: the settlement's spot, else the region's centre */
  at?: [number, number];
  /** a line: what's here */
  brief: string;
  /** minutes it's planned to take (the clock's estimate for a choice; the played time is what counts) */
  minutes: number;
  play: AreaPlay;
  /** lines said on arrival (the narrator's, or a speaker's name in `by`) */
  say?: Bark[];
}

/** What the hero plays in an area. Each ends at the area's edge (the map and the choices), or in the finale. */
export type AreaPlay =
  /** the threat's outriders are on the hero: get to the area's edge (cut them down if you can) */
  | { kind: 'flee' }
  /** foes on the road: break through to the far edge, or cut them down */
  | { kind: 'ambush'; foes: number; role: string; faction: FactionId | null }
  /** carry the message to a settlement's hall before the clock: its force sets out for the target; it may give an item */
  | { kind: 'deliver'; settlement: string; sends: { faction: FactionId; role: string; count: number }; gives?: string[]; limit: number }
  /** someone on the road with things to trade: reach them, take one of their offers */
  | { kind: 'trader'; offers: string[] }
  /** the finale at the target: defend it, or (warned, choosing it) lead its people to the refuge */
  | { kind: 'town' };

export interface SituationChoice {
  id: string;
  /** the area whose edge it's taken at, and the area it goes to */
  from: string;
  to: string;
  /** a line in the player's words: "Ride to the Red Hold for its levy (late, but in force)" */
  text: string;
  effects: ChoiceEffect[];
}

export type ChoiceEffect =
  /** the hero carries the warning: the town arms and gathers when the hero gets there first */
  | { kind: 'warn' }
  /** the finale is a flight: the town's people led out to the refuge */
  | { kind: 'evacuate' }
  /** the threat is slowed (a bridge burned behind the hero, a ford fouled) */
  | { kind: 'delay'; minutes: number };
