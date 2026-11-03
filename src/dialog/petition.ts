// ---- dialog/petition.ts -------------------------------------------------------------------------------------------
// (dialog2) A petition as a dialog. The user (DECISIONS round 125): "Introduce characters as needed and have them
// deliver the petition but you can't do that with cards you need to do that with dialogs."
//
// petitionTree builds a DialogTree from data: the petition (what is asked, in the template's plain words, and the
// summary panel's rows) and the speaker (their persona: voice, quirks, traits; whether the player has met them and how
// they feel about the player). No tree is written by hand for any quest. The character greets in their voice, makes the
// ask, and answers "What's in it for me?" and "What if I say no?". The player's answers carry an `act` the caller reads:
//   commit   agree (the talk ends on their thanks and what it means: the relationship signal)
//   refuse   say no (the talk ends on their reaction and the signal)
//   later    not now (nothing changes)
//   haggle   ask for more: the talk ends, the caller settles it (a Persuasion: traitPersuasion by default, a dialog
//            minigame later) and opens the tree built with `haggled` at the node 'haggle'.
// Pure: no DOM, no world. Text rules: docs/WRITING.md.

import type { Persona, Trait } from '../api/contracts/cast';
import type { DialogChoice, DialogNode, DialogTree, Persuasion } from '../api/contracts/dialog';
import { VOICES } from '../living/cast';
import { capitalise } from '../living/plain';
import { hashStr } from '../runplan/rng';

export type PetitionAct = 'commit' | 'refuse' | 'later' | 'haggle';

/** what is asked: every line in plain words (docs/WRITING.md) */
export interface Petition {
  id: string;
  title: string;
  /** the ask, the template's line filled */
  ask: string;
  /** their answer to "What's in it for me?" (none: they say the reward plainly) */
  gain?: string;
  /** their answer to "What if I say no?" (none: they say the consequence plainly) */
  refuse?: string;
  /** the summary panel */
  needs: string;
  takes: string;
  get: string;
  ifRefuse: string;
  /** what the player says to agree ("I'll go.", "Send the soldiers.") */
  agree: string;
  /** true, or why the player can't agree now */
  canAgree: true | string;
  /** saying no is no slight (a way not taken): the refusal reads as going another way */
  passable: boolean;
  /** it must be played now: no "not now", no "no" */
  forced: boolean;
  /** what asking for more would add, in words ("2 more supplies"); none: no haggling */
  haggle?: string;
  /** what agreeing does to the relationship, and what refusing does: plain signals */
  signalYes: string;
  signalNo: string;
}

export interface PetitionSpeaker {
  id: string;
  name: string;
  role: string;
  /** who they speak for, as the player would say it: "the gnolls of the Warrens" */
  group: string;
  persona: Persona;
  /** the player has met them before */
  met: boolean;
  /** −1..1: how they feel about the player */
  feeling: number;
}

export interface PetitionState {
  /** a haggle settled: what they said */
  haggled?: 'yes' | 'no';
}

const pickOf = <T>(xs: readonly T[], key: string): T => xs[hashStr(key) % xs.length];


function fill(s: string, sp: PetitionSpeaker, hero: string): string {
  return capitalise(s.replace(/\{name\}/g, sp.name).replace(/\{role\}/g, sp.role).replace(/\{group\}/g, sp.group).replace(/\{hero\}/g, hero));
}

/** the greeting: who they are the first time, then how they feel about the player */
export function greeting(sp: PetitionSpeaker, hero: string, key: string): string {
  const v = VOICES[sp.persona.voice];
  const lines = !sp.met ? v.intro : sp.feeling > 0.15 ? v.fond : sp.feeling < -0.15 ? v.cold : v.again;
  return fill(pickOf(lines, `${sp.persona.seed}:${key}:greet`), sp, hero);
}

/**
 * The petition's tree. Nodes: 'start' (the greeting and the ask), 'gain', 'ifno', 'haggle' (with `state.haggled`),
 * 'thanks' and 'refused' (the end: their reaction and the signal). The summary panel is on every node that asks.
 */
export function petitionTree(p: Petition, sp: PetitionSpeaker, hero: string, state: PetitionState = {}): DialogTree {
  const v = VOICES[sp.persona.voice];
  const key = `${sp.persona.seed}:${p.id}`;
  const quirk = pickOf(sp.persona.quirks, `${key}:aside`);
  const saying = sp.persona.quirks.find((q) => q.saying);
  const panel = (get = p.get): DialogNode['facts'] => [
    { label: 'Needs', text: p.needs },
    { label: 'Takes', text: p.takes },
    { label: 'You get', text: get, tone: 'good' },
    { label: 'If you refuse', text: p.ifRefuse, tone: 'bad' },
  ];
  const get = state.haggled === 'yes' && p.haggle ? `${p.get} ${capitalise(p.haggle)}.` : p.get;
  const ask = (here: string): DialogChoice[] => {
    const out: DialogChoice[] = [{ text: p.agree, to: 'thanks', act: 'commit', ...(p.canAgree === true ? {} : { disabled: p.canAgree }) }];
    if (here !== 'gain') out.push({ text: "What's in it for me?", to: 'gain' });
    if (here !== 'ifno') out.push({ text: 'What if I say no?', to: 'ifno' });
    if (p.haggle && !state.haggled && !p.forced) out.push({ text: 'Can you give a little more?', act: 'haggle' });
    if (!p.forced) {
      if (!p.passable) out.push({ text: 'No.', to: 'refused', act: 'refuse' });
      out.push({ text: p.passable ? "I'll think about another way." : 'Not now.', act: 'later' });
    }
    return out;
  };
  const nodes: Record<string, DialogNode> = {
    start: { text: `${greeting(sp, hero, p.id)} ${p.ask}`, aside: fill(quirk.aside, sp, hero), facts: panel(get), choices: ask('start') },
    gain: { text: `${p.gain ?? `Here is what you get. ${p.get}`}${saying && hashStr(`${key}:say`) % 2 === 0 ? ` ${saying.saying}` : ''}`, facts: panel(get), choices: ask('gain') },
    ifno: { text: p.refuse ?? (p.forced ? 'Then they catch you. Go!' : p.passable ? 'Then go another way. No hard feelings.' : p.ifRefuse), facts: panel(get), choices: ask('ifno') },
    thanks: { text: fill(pickOf(v.thanks, `${key}:thanks`), sp, hero), facts: [{ label: 'Now', text: p.signalYes, tone: 'good' }], choices: [] },
    refused: { text: fill(pickOf(v.hurt, `${key}:hurt`), sp, hero), facts: [{ label: 'Now', text: p.signalNo, tone: 'bad' }], choices: [] },
  };
  if (state.haggled) {
    const said = fill(pickOf(state.haggled === 'yes' ? v.yes : v.no, `${key}:haggle`), sp, hero);
    nodes.haggle = { text: state.haggled === 'yes' && p.haggle ? `${said} ${capitalise(p.haggle)}.` : said, facts: panel(get), choices: ask('haggle') };
  }
  return { id: `petition:${p.id}`, speaker: sp.id, start: 'start', nodes };
}

/** what the act of a choice is (the caller's switch) */
export function actOf(tree: DialogTree, node: string, choice: number): PetitionAct | undefined {
  return tree.nodes[node]?.choices[choice]?.act as PetitionAct | undefined;
}

/**
 * The default Persuasion: a character's traits decide whether they give a little more. Generous and kind people say
 * yes; proud and stubborn ones say no; others say yes when they like the player. A dialog minigame (later) replaces
 * this and decides the same question by play.
 */
export const traitPersuasion: Persuasion = {
  settle({ traits, feeling }) {
    const t = traits as readonly Trait[];
    if (t.includes('generous') || t.includes('kind')) return { agreed: true };
    if (t.includes('stubborn') || t.includes('proud')) return { agreed: false };
    return { agreed: feeling >= 0 };
  },
};
