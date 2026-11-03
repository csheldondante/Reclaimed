// Dialog — trees as data, played by the dialog system (round 83, docs/SYSTEMS.md system 10). The GM writes
// them into a SessionStory; a game opens one when the player talks to someone.
// (dialog2) Petitions are dialogs too: a character asks, the player asks back and answers (src/dialog/petition.ts
// builds the tree from a card's template and the character's persona). A node can carry narration (`aside`) and a
// summary panel (`facts`); a choice can carry an `act`, which the dialog system passes on unread to whoever opened the
// talk (a petition's commit or refuse).

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
  /** (dialog2) narration shown with the line, in the present tense: "Shesha counts the stones twice." */
  aside?: string;
  /** (dialog2) a short summary panel under the line: rows of a label and plain text (a petition's Needs, Takes,
   *  You get, If you refuse) */
  facts?: { label: string; text: string; tone?: 'good' | 'bad' | 'plain' }[];
}

export interface DialogChoice {
  text: string;
  /** the next node; none: the talk ends */
  to?: string;
  /** shown only when these hold (a skill, an item, a past choice) */
  requires?: Condition[];
  effects?: Outcome;
  /** (dialog2) what choosing this means to whoever opened the talk ('commit', 'refuse', 'haggle' …); the dialog
   *  system never reads it */
  act?: string;
  /** (dialog2) shown greyed out with this reason, not chosen (a commit the player can't afford) */
  disabled?: string;
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
  /** told each node reached (its effects apply, `talked` { node } holds) */
  onNode: ((tree: DialogTree, node: string) => void)[];
}

/**
 * (dialog2) How a contested answer is settled: the player asks a character for more (a haggle) and this decides
 * whether they agree. The default reads the character's traits (src/dialog/petition.ts traitPersuasion). The user
 * has ideas for a game built around dialog: that minigame plugs in here, deciding the same question by play.
 */
export interface Persuasion {
  /** does the speaker agree to what the player asks */
  settle(ask: { speaker: string; traits: readonly string[]; feeling: number; what: string }): Promise<{ agreed: boolean }> | { agreed: boolean };
}
