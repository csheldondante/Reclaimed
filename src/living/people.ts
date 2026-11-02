// ---- living/people.ts ---------------------------------------------------------------------------------------------
// (round 125, `facts`; BACKLOG LW-F15) Cards are presented by named people. The user (round 125): "Named characters with
// charming dialogues are going to feel much more meaningful as a sacrifice or a reward than a random marsh. Even in the
// gnoll example having a named gnoll character petition to build barrows will make the steaks feel real and it becomes
// a relationship fact that can come up in future runs."
//
// Every card has a presenter: a person of the group the template names (a cohort's elder, a guild's master, a house's
// lord), taken from the cast when one is free, else made when the card is shown — a real person: a CharacterRecord in
// WorldState (so later runs meet them) and a fact entity with its species, its membership and its home. The presenter
// says one line. Committing, refusing or ignoring the card is a relationship fact between them and the player
// (owes_favor_to / grievance_against, an event with a weight that diplomacy's opinion reads, and the character record's
// feeling toward the player). Ready for dialogue as a resolution mechanic (to come: the user has a game in mind for it).

import type { EntityId } from '../api/contracts/facts';
import type { FactWorld } from './world';

/** who presents a template's card: a member of the group `of` (a bound ref), in a role, with a line */
export interface PresenterSpec {
  of: string;
  role: string;
  /** what they do: petitions, asks, claims, warns, offers */
  verb: string;
  line: string;
}

/** the names a made person draws from, by species (deterministic: the next unused) */
const NAMES: Record<string, string[]> = {
  human: ['Hal Brenning', 'Wenna Ashby', 'Osric Pell', 'Tilda Marsh', 'Bram Cotter', 'Elsa Wyck', 'Corin Hale', 'Maud Fenner',
    // (merge124: a run's cast and its petitioners draw from these too — more of them before the numbered fallback)
    'Aldo Venn', 'Brisa Hollow', 'Cade Merrow', 'Dorrit Lane', 'Edda Rook', 'Fenn Carver', 'Gilda Thorn', 'Hob Ashdown',
    'Ilse Brand', 'Jory Kettle', 'Kit Mallory', 'Lenna Frost', 'Mott Graves', 'Nell Harrow', 'Odo Pike', 'Perrin Shaw',
    'Quill Abney', 'Rosa Teague', 'Sim Barrow', 'Tamsa Wren', 'Ulf Ridley', 'Vera Coyle', 'Wat Fairley', 'Yara Dunne'],
  gnoll: ['Rukk', 'Shesha', 'Grawl', 'Ikka', 'Tarn', 'Vosk', 'Hessa', 'Brakka'],
};

/** the members of a group (stored or derived from their character records), alive */
export function membersOf(w: FactWorld, group: EntityId): EntityId[] {
  return w
    .relations({ type: 'member_of', to: group })
    .map((r) => r.from)
    .filter((id) => w.facts.entity(id)?.kind === 'person' && w.ws.character(id)?.alive !== false)
    .sort();
}

/** a free member of the group to present, or null (one must be made) */
export function pickPresenter(w: FactWorld, group: EntityId, busy: Set<EntityId>): EntityId | null {
  return membersOf(w, group).find((id) => !busy.has(id)) ?? null;
}

/** the species a group's people are (its biology tag, else its members', else human) */
function speciesOf(w: FactWorld, group: EntityId): string {
  const t = w.facts.tag(group, 'biology', 'species');
  if (typeof t?.value === 'string') return t.value;
  for (const m of membersOf(w, group)) {
    const s = w.facts.tag(m, 'biology', 'species');
    if (typeof s?.value === 'string') return s.value;
  }
  return 'human';
}

/** Make a person of a group (when the card is shown): a character the world remembers, and their fact entity. `opts`:
 *  where they live (default the group's settlement), and whether the player has met them (a run's cast is made before the
 *  player meets anyone: merge124) */
export function makePresenter(w: FactWorld, group: EntityId, role: string, cause: string, opts: { home?: EntityId; met?: boolean } = {}): EntityId {
  const species = speciesOf(w, group);
  const names = NAMES[species] ?? NAMES.human;
  const used = new Set(w.ws.characters().map((c) => c.name));
  const base = names.find((n) => !used.has(n)) ?? `${names[0]} ${w.ws.characters().length}`;
  const id = `person:${base.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const home = opts.home ? w.settlement(opts.home) : w.settlementOf(group);
  const g = w.facts.entity(group);
  const faction = g?.ref && 'faction' in g.ref ? g.ref.faction : null;
  w.ws.applyCharacter({ kind: 'meet', character: { id, name: base, role, faction, hero: false, alive: true, region: home?.region ?? null, motivation: `speak for ${w.name(group)}` } });
  w.facts.add({ id, kind: 'person', name: base, ref: { character: id }, at: home ? w.placeAt(home.id) : {}, tags: [{ scope: 'biology', key: 'species', value: species, since: w.turn }], cause });
  if (!faction) w.facts.relate({ type: 'member_of', from: id, to: group, cause });
  if (home) w.facts.relate({ type: 'resident_at', from: id, to: home.id, cause });
  if (opts.met ?? true) w.facts.record({ kind: 'met', by: ['player'], to: [id], about: { opp: cause }, note: `you met ${base}, ${role} of ${w.name(group)}` });
  return id;
}

export type Answer = 'committed' | 'refused' | 'ignored';
const ANSWER: Record<Answer, { rel: 'owes_favor_to' | 'grievance_against'; delta: number; kind: string; say: string }> = {
  committed: { rel: 'owes_favor_to', delta: 0.3, kind: 'kept-faith', say: 'you took up their cause' },
  refused: { rel: 'grievance_against', delta: 0.3, kind: 'refused', say: 'you turned them away' },
  ignored: { rel: 'grievance_against', delta: 0.15, kind: 'ignored', say: 'you let their plea lapse' },
};

/** The player's answer to a presenter, as relationship facts: the relation, the weighted event, the character record. */
export function answer(w: FactWorld, presenter: EntityId, how: Answer, card: string, cause: string): void {
  const a = ANSWER[how];
  const player = w.diplomacy.idOf({ player: true });
  const had = w.facts.relations({ type: a.rel, from: presenter, to: player })[0];
  w.facts.relate({ type: a.rel, from: presenter, to: player, strength: Math.min(1, +((had?.strength ?? 0) + a.delta).toFixed(3)), cause });
  const sign = how === 'committed' ? 1 : -1;
  w.facts.record({ kind: a.kind, by: [player], to: [presenter], weight: sign * a.delta, halfLife: 8, about: { opp: cause }, note: `${w.name(presenter)}: ${a.say} ("${card}")` });
  if (w.ws.character(presenter)) {
    w.ws.applyCharacter({ kind: 'relationship', id: presenter, toward: 'player', delta: sign * a.delta });
    w.ws.applyCharacter({ kind: 'history', id: presenter, text: `${a.say}: ${card}` });
  }
}
