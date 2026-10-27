// Diplomacy — memories and agreements (round 85, docs/SYSTEMS.md systems 1, 6, 9 and 10). The user: diplomacy
// "should work by holding the history of factions and individual interactions like rimworld so they can come
// up in dialog. It should also have more than peace or war it should have land and mineral rights and trade
// agreements."
//
// Two records, and what's read off them:
//   - Interactions: what one party did to another (a faction or a person, the player too), each with how much
//     it counts and how fast it fades. Opinion is their faded sum; dialog and the GM quote them.
//   - Agreements: standing terms between parties — peace, war, truce, alliance, trade, land rights, mineral
//     rights, passage, tribute, vassalage — with their places, resources and flows. Rights are what units read
//     (may they mine here, farm there, pass through); a broken agreement is itself an interaction.
// A party's stance toward another (at war, hostile, wary, neutral, friendly, allied) is derived, never stored.

import type { FactionId, RegionId } from './world';
import type { InstanceId, MaterialId, Tag } from './recipe';

/** Who can act or be acted on: a faction, a person (a character, a named unit, a hero), or the player. */
export type Party = { faction: FactionId } | { who: string; faction?: FactionId | null } | { player: true };

export interface Interaction {
  id: string;
  run: number;
  /** seconds into the run (the order within a run) */
  t?: number;
  by: Party;
  to: Party;
  /** what happened: gift, trade, insult, threat, rescue, spared, killed, killed-kin, stole, raided, defended,
   *  healed, betrayed, kept-word, broke-word, trespassed, freed, enslaved, converted, honoured … (open: new kinds are
   *  data, the weight says how much they count) */
  kind: string;
  /** how much it moves `to`'s opinion of `by` (−1..1); a faction's own members take a share of it */
  weight: number;
  /** how long it's remembered: runs for its weight to halve (Infinity: never forgotten, a grudge or a debt) */
  halfLife: number;
  /** who saw it (they remember it too, at half the weight) */
  witnesses?: Party[];
  /** where, and what about: a region, a thing (a stolen sword), an agreement */
  region?: RegionId;
  thing?: InstanceId;
  agreement?: string;
  /** a line dialog and the wiki can use: "burned the granary at Oltmere" */
  note: string;
}

/** Terms between parties. The kinds beyond peace and war are what the user asked for: rights and trade. */
export type AgreementKind =
  | 'war'
  | 'truce'
  | 'peace'
  | 'alliance'
  /** goods flow between them on a schedule (flows) */
  | 'trade'
  /** a party may hold, settle, farm or build on land (a region, or an area in it) */
  | 'land-rights'
  /** a party may dig a resource there and keeps a share of it */
  | 'mineral-rights'
  /** a party may pass through (and with what: caravans, armies) */
  | 'passage'
  /** one pays another a flow, for protection or as a defeated party */
  | 'tribute'
  | 'vassalage';

export interface Agreement {
  id: string;
  kind: AgreementKind;
  /** for rights and tribute, the first party is the one granted or paying */
  parties: Party[];
  /** where it holds (rights, passage): regions, or an area of one (world cells) */
  where?: { regions: RegionId[]; area?: { at: [number, number]; radius: number } };
  /** what it covers (mineral rights: copper, iron; land rights: farm, settle, build, hunt, fell) */
  covers?: (MaterialId | Tag)[];
  /** the granted party's share of what's taken (mineral rights), the rest to the land's holder */
  share?: number;
  /** goods moving (trade, tribute): from whom to whom, what (a resource or a kind), how much a day */
  flows?: { from: number; to: number; what: MaterialId | Tag; perDay: number }[];
  since: { run: number; t?: number };
  /** when it ends on its own (a run), and what ended it */
  until?: number;
  status: 'proposed' | 'active' | 'expired' | 'broken' | 'ended';
  /** who broke it, and the interaction that recorded it */
  broken?: { by: Party; interaction: string };
  /** how it came about: a story, a talk, a war's end */
  cause?: { by: 'story' | 'player' | 'world'; ref?: string };
}

/** What a party thinks of another, read off the record. */
export interface Opinion {
  /** −1..1, the faded sum of interactions (and the agreements' standing terms) */
  value: number;
  stance: 'war' | 'hostile' | 'wary' | 'neutral' | 'friendly' | 'allied';
  /** the interactions that count most, strongest first (what dialog brings up) */
  because: Interaction[];
  agreements: Agreement[];
}

/** Diplomacy as other systems use it. The world state keeps it between runs; play adds to it. */
export interface Diplomacy {
  /** remember something one party did to another */
  note(i: Interaction): void;
  /** make, change or end an agreement (breaking one notes a broke-word interaction too) */
  agree(a: Agreement): void;
  end(id: string, how: 'expired' | 'ended' | { brokenBy: Party; note: string }): void;
  /** what `of` thinks of `about` at the start of `run` (the current run when absent) */
  opinion(of: Party, about: Party, run?: number): Opinion;
  /** what `who` remembers about `about`, strongest first: for dialog ("You're the one who spared my brother") */
  memories(who: Party, about?: Party, limit?: number): Interaction[];
  /** the agreements a party is in */
  agreements(of: Party): Agreement[];
  /** who may do what here: the rights holding at a place (units ask before they mine or settle) */
  rights(region: RegionId, at?: [number, number]): Agreement[];
}
