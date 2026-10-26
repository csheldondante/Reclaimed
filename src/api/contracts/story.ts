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
  /** world effects that happen on their own as the run goes (a storm rolls in at a time, a city falls) */
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
  /** what the generator should make there: rooms and connections, locks and their keys, landmarks */
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
  location?: string;
  when: Condition[];
  done: Condition[];
  /** what doing it changes — and what failing it does, if it can be failed */
  outcome: Outcome;
  failed?: { when: Condition[]; outcome: Outcome };
}

/** What the run checks: things the player and the world do (the sim's and the units' events). */
export type Condition =
  | { kind: 'talked'; character: string; node?: string }
  | { kind: 'chose'; dialog: string; node: string; choice: number }
  | { kind: 'has'; item: string; count?: number }
  | { kind: 'reached'; location: string; room?: string }
  | { kind: 'killed'; character?: string; unitKind?: string; count?: number }
  | { kind: 'event'; event: 'collapsed' | 'flooded' | 'burned' | 'built' | 'dug'; location?: string }
  | { kind: 'objective'; id: string; state: 'done' | 'failed' }
  | { kind: 'flag'; flag: string; value?: boolean }
  | { kind: 'time'; after: number };

/** What happens: the world changes (AtlasEvents), people change their minds, things are given or appear. */
export interface Outcome {
  atlas?: Omit<AtlasEvent, 'id' | 'run'>[];
  attitude?: { faction?: FactionId; character?: string; delta: number }[];
  flags?: Record<string, boolean>;
  give?: { item: string; count?: number }[];
  spawn?: { role: string; faction: FactionId | null; location: string; count?: number }[];
  /** dialog nodes it opens */
  unlock?: { dialog: string; node: string }[];
  /** the run ends (a win, a fall) */
  endRun?: 'won' | 'lost';
}
