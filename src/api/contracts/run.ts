// A run — from setting out to its end, and what's left of it (round 83, docs/SYSTEMS.md system 11).

import type { AtlasEvent } from './world';
import type { SessionStory } from './story';

export interface RunRecord {
  run: number;
  hero: string;
  story: string;
  /** how it ended */
  end: 'won' | 'lost' | 'fled' | 'abandoned';
  /** what the player did that the world remembers (objectives done and failed, who they spared or killed) */
  deeds: string[];
  /** what it changed */
  events: AtlasEvent[];
}

/** Who's playing, as the GM reads them: the hero and what their past runs left (the GM's brief). */
export interface PlayerRecord {
  hero: string;
  /** past runs, newest last */
  runs: RunRecord[];
  /** standing with each faction (−1..1), from what they did */
  standing: Record<string, number>;
}

/** The run as the game drives it. */
export interface Run {
  readonly story: SessionStory;
  /** objectives shown, done, failed */
  objectives(): { id: string; state: 'hidden' | 'shown' | 'done' | 'failed' }[];
  /** something happened (a sim or unit event, a dialog choice, an item picked up): conditions checked */
  note(fact: import('./story').Condition): void;
  flag(name: string): boolean;
  /** does a condition hold now (the dialog asks it of a choice's `requires`) */
  holds(c: import('./story').Condition): boolean;
  /** the run's clock: `time` conditions, happenings (seconds) */
  update(dt: number): void;
  end(how: RunRecord['end']): RunRecord;
  onObjective: ((id: string, state: 'shown' | 'done' | 'failed') => void)[];
}
