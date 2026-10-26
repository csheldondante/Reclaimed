// Dialog — trees as data, played by the dialog system (round 83, docs/SYSTEMS.md system 10). The GM writes
// them into a SessionStory; a game opens one when the player talks to someone.

import type { Condition, Outcome } from './story';

export interface DialogTree {
  id: string;
  /** the cast member speaking (story.ts StoryCharacter id) */
  speaker: string;
  start: string;
  nodes: Record<string, DialogNode>;
}

export interface DialogNode {
  /** what the speaker says */
  text: string;
  /** the player's answers; none: the talk ends after this */
  choices: DialogChoice[];
  /** what saying this does (an attitude shift, a flag, an item given) */
  effects?: Outcome;
}

export interface DialogChoice {
  text: string;
  /** the next node; none: the talk ends */
  to?: string;
  /** shown only when these hold (a skill, an item, a past choice) */
  requires?: Condition[];
  effects?: Outcome;
}

/** The dialog system as a game uses it. */
export interface Dialog {
  /** open a tree: at `at`, else its most recently unlocked node (Outcome.unlock), else its start; resolves
   *  when the talk ends, with the path taken */
  open(tree: DialogTree, at?: string): Promise<{ node: string; choice: number }[]>;
  /** is a talk open (the game pauses its controls) */
  readonly isOpen: boolean;
  /** told each choice made: the run checks its conditions, applies effects */
  onChoice: ((tree: DialogTree, node: string, choice: number) => void)[];
  /** told each node reached (its effects apply, `talked { node }` holds) */
  onNode: ((tree: DialogTree, node: string) => void)[];
}
