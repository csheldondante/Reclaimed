// The session story — what the GM writes, offline, before a run (round 83, docs/SYSTEMS.md system 9).
// The user: "have a GM (for now we can use a subagent with GM context and tools) take the world state wiki
// and offline create a session story as data that we can use to create the locations, dialogues,
// objectives and world effects."
// A SessionStory is plain data (JSON): the region generator builds its locations, the dialog system plays
// its trees, the run tracks its objectives, and its outcomes are AtlasEvents for the world state.

import type { AtlasEvent, FactionId, RegionId } from './world';
import type { DialogTree } from './dialog';

export interface SessionStory {
  id: string;
  title: string;
  /** a paragraph: what this run is about */
  premise: string;
  /** what it was written from */
  from: { worldVersion: number; run: number; seed: number };
  locations: StoryLocation[];
  cast: StoryCharacter[];
  dialogs: DialogTree[];
  objectives: Objective[];
  /** world effects that happen on their own as the run goes (a storm rolls in at a time, a city falls); each
   *  fires once */
  happenings: { when: Condition[]; effects: Outcome }[];
}

/** A place the story needs: the region generator realises it (a brief) in that region. */
export interface StoryLocation {
  id: string;
  name: string;
  region: RegionId;
  /** settlement, ruin, camp, cave, shrine, battlefield, wreck, lair … */
  kind: string;
  /** a settlement's id (settlement.ts) when it's one */
  settlement?: string;
  /** what the generator should make there: rooms and connections (the first room is the way in), locks and
   *  their keys, landmarks */
  brief: {
    rooms?: { id: string; kind: string; size?: 'small' | 'medium' | 'large' }[];
    connections?: { from: string; to: string; lock?: string }[];
    /** a lock's key: an item, a character to persuade, a deed */
    keys?: { lock: string; key: { item?: string; character?: string; objective?: string } }[];
    landmarks?: string[];
    hazards?: string[];
  };
}

/** Someone the story needs. */
export interface StoryCharacter {
  id: string;
  name: string;
  /** what they are (a smith, a warlord, a lost child, a lich) — the unit generator's role */
  role: string;
  faction: FactionId | null;
  location: string;
  /** the room of its location they're found in (its brief's first room, the way in, when absent) */
  room?: string;
  /** −1 hostile .. 1 friendly toward the player, to start */
  disposition: number;
  /** how they speak (for dialog and voice) */
  voice: string;
  wants: string;
  knows: string[];
}

/** Something for the player to do: shown when its `when` holds, done when its `done` does. */
export interface Objective {
  id: string;
  text: string;
  /** (round 97, heroapi) a few words for the objective list ("Warn Mebe's reeve"); `text` stays the full brief */
  short?: string;
  location?: string;
  when: Condition[];
  done: Condition[];
  /** what doing it changes — and what failing it does, if it can be failed */
  outcome: Outcome;
  failed?: { when: Condition[]; outcome: Outcome };
}

/**
 * What the run checks: things the player and the world do (the sim's and the units' events). A list of
 * conditions holds when all of them do (AND); `any` holds when one of its own does (OR). `time.after` is
 * seconds into the run; a `flag` with `value: false` holds while the flag is unset.
 */
export type Condition =
  | { kind: 'any'; of: Condition[] }
  | { kind: 'talked'; character: string; node?: string }
  | { kind: 'chose'; dialog: string; node: string; choice: number }
  | { kind: 'has'; item: string; count?: number }
  | { kind: 'reached'; location: string; room?: string }
  | { kind: 'killed'; character?: string; unitKind?: string; count?: number }
  | { kind: 'event'; event: 'collapsed' | 'flooded' | 'burned' | 'built' | 'dug'; location?: string }
  | { kind: 'objective'; id: string; state: 'done' | 'failed' }
  | { kind: 'flag'; flag: string; value?: boolean }
  | { kind: 'time'; after: number }
  /**
   * (round 97, heroapi) the hero first came within sight of a cast member (alive) or a place: noted once each by
   * the game (StoryPlay: within SIGHT cells), so a happening can fire a bark or a dialog on a sighting
   */
  | { kind: 'saw'; character?: string; location?: string };

/**
 * (round 97, heroapi) A bark: a line said in the world, over its speaker (a cast member) or as the narrator's
 * when `by` is absent. The user: dialog should be "trigger/predicate driven and tied to events like deaths and
 * have dialogs just be such an event" — so a bark is an Outcome, fired by a happening's conditions.
 */
export interface Bark {
  line: string;
  /** the cast member saying it (story.ts StoryCharacter id); none: the narrator */
  by?: string;
  /** how long it shows (default 4 s) */
  seconds?: number;
}

/** What happens: the world changes (AtlasEvents), people change their minds, things are given or appear. */
export interface Outcome {
  atlas?: Omit<AtlasEvent, 'id' | 'run'>[];
  attitude?: { faction?: FactionId; character?: string; delta: number }[];
  flags?: Record<string, boolean>;
  give?: { item: string; count?: number }[];
  /** units appear there (`hostile`: they fight the player — round 88) */
  spawn?: {
    role: string;
    faction: FactionId | null;
    location: string;
    count?: number;
    hostile?: boolean;
    /** (round 97, heroapi) they set off for this location (a `go` job) instead of standing where they appear */
    toward?: string;
  }[];
  /** (round 88) these cast members turn on the player (a talk gone to a fight): their units fight */
  hostile?: string[];
  /** dialog nodes it opens */
  unlock?: { dialog: string; node: string }[];
  /** the run ends (a win, a fall) */
  endRun?: 'won' | 'lost';
  /** (round 97, heroapi) lines said in the world (a bark over a speaker, or the narrator's) */
  say?: Bark[];
  /** (round 97, heroapi) a talk opens: this cast member's dialog (at `node`, else where it would open) — a dialog as an event */
  talk?: { character: string; node?: string };
}
