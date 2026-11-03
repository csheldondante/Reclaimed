// The cast: who a character is, as the dialog and the map show them (dialog2; docs/ARCHITECTURE.md "The cast").
// The user (DECISIONS round 125): "I want a cast of characters with interesting personality quirks and rolled for
// traits to make them likable. Introduce characters as needed and have them deliver the petition."
//
// A Persona is rolled once, deterministically from the world's seed and the character's id (src/living/cast.ts), and
// kept on their CharacterRecord (run.ts), so a later run meets the same person with the same quirks. It says nothing
// about what they want from a particular card: the card's template supplies that, and the persona supplies how
// they say it.

import type { Palette } from './inhabitants';

/** A personality quirk: something small and specific that makes a character memorable. */
export interface Quirk {
  id: string;
  /** what it is, as a short description: "counts everything twice" */
  text: string;
  /** narration shown beside their line, present tense, {name} filled: "{name} counts the stones twice." */
  aside: string;
  /** something they say now and then, in their own words (optional) */
  saying?: string;
}

/** How a character speaks: the lines a voice adds round the content a template supplies. */
export type VoiceId = 'warm' | 'blunt' | 'formal' | 'nervous' | 'grand' | 'dry' | 'cheerful';

/** A likable trait, rolled. Some change how a character answers (a generous one gives a little more). */
export type Trait = 'kind' | 'brave' | 'honest' | 'generous' | 'funny' | 'loyal' | 'patient' | 'curious' | 'proud' | 'stubborn';

/** What the portrait is drawn from: the creature generator's look (inhabitants SpeciesSpec), per character. */
export interface PortraitSpec {
  /** the species preset it starts from (inhabitants/species.ts SPECIES) */
  species: string;
  palette: Palette;
  /** head size and girth, multipliers of the preset's (1 = the preset's) */
  head: number;
  girth: number;
  /** 0 bare .. 1 full mane */
  fur: number;
  fur_colour?: string;
  /** what they wear on top, by role: a hood, a helm, a cap, a circlet, nothing */
  hat: 'none' | 'hood' | 'helm' | 'cap' | 'circlet' | 'scarf';
  hat_colour: string;
  /** cloak or tunic colour over the shoulders */
  cloth: string;
  /** body variation */
  seed: number;
}

export interface Persona {
  /** 2-3, distinct */
  quirks: Quirk[];
  voice: VoiceId;
  /** 2, distinct */
  traits: Trait[];
  /** what they want from life, in plain words: "to see the young ones grow up safe" */
  want: string;
  portrait: PortraitSpec;
  /** the roll's seed (a re-roll with the same seed gives the same persona) */
  seed: number;
}
