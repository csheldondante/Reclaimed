// ---- encounters/talk.ts ---------------------------------------------------------------------------------------------
// (round 126, `encounters`) How a scene speaks: one line from a speaker and the player's answers, the answer picked
// back. Behind this interface so the dialog system can be swapped (another agent builds a new one on branch `dialog2`):
// today's is src/dialog's DialogBox through the Dialog contract (contracts/dialog.ts), a one-node tree a line.

import type { DialogTree } from '../api/contracts/dialog';
import { DialogBox, type Speaker } from '../dialog/dialog';

export interface Talk {
  /** the speaker says `line`; resolves with the index of the answer picked (null: the talk was closed unanswered) */
  ask(speaker: Speaker, line: string, answers: string[]): Promise<number | null>;
  /** the speaker's last word (no answers: it closes after a moment or a tap) */
  tell(speaker: Speaker, line: string): Promise<void>;
  readonly isOpen: boolean;
  dispose(): void;
}

/** a Talk on src/dialog's DialogBox */
export class DialogTalk implements Talk {
  private box: DialogBox;
  private who: Speaker = { name: '', colour: '#888' };
  private n = 0;

  constructor(ui: HTMLElement) {
    this.box = new DialogBox(ui, { speaker: () => this.who, check: () => true });
  }

  get isOpen(): boolean {
    return this.box.isOpen;
  }

  async ask(speaker: Speaker, line: string, answers: string[]): Promise<number | null> {
    this.who = speaker;
    const tree: DialogTree = { id: `encounter-${this.n++}`, speaker: 'speaker', start: 'say', nodes: { say: { text: line, choices: answers.map((text) => ({ text })) } } };
    const path = await this.box.open(tree);
    return path.length ? path[path.length - 1].choice : null;
  }

  async tell(speaker: Speaker, line: string): Promise<void> {
    this.who = speaker;
    const tree: DialogTree = { id: `encounter-${this.n++}`, speaker: 'speaker', start: 'say', nodes: { say: { text: line, choices: [{ text: 'On.' }] } } };
    await this.box.open(tree);
  }

  dispose(): void {
    this.box.dispose();
  }
}
