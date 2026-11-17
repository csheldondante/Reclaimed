// (card-table, PACK_FORMAT draft 8) Between runs. The owner: "At least during the run it being gamified is good.
// Between runs is another lever for balance." DURING a run only cards change the world (a faction acts when a card is
// taken or runs out). BETWEEN two runs years pass, and this one deterministic step moves the world on its own: a list of
// entries, each a condition on the world and the record, effects in the cards' own vocabulary, and a line the next run
// reads ("While you were gone: …"). The base game's entries are here; a pack adds its own (`between_runs`).
//
// It runs once, when a new run of a world begins (season/realm.ts, before the `run-began` event), never during a run
// and never when a saved run is taken up again. Each entry that applies is written to the record as a `between-runs`
// event: the world's memory is the record of what happened, and nothing else is kept. Every number here is a first
// guess, to tune.
import type { Effect, Pred } from '../living/dsl';
import { RAIDERS_CAMP } from './realm-templates';

/** one entry of the step: when it applies, what it does, and the line the next run reads */
export interface BetweenDef {
  id: string;
  /** every test must hold (the cards' own conditions: the Realm's helpers and the packs') */
  when: Pred[];
  /** what it does (the cards' own effects; `$town` is the home town of the run about to begin) */
  do: Effect[];
  /** the line "The world now" shows: plain and concrete */
  say: string;
}

/**
 * The base game's entries, in order (tunable, each one line of data):
 * 1. A truce bought with tribute lasts the run it was paid in: the raiders come back to the road.
 * 2. A world with no far town standing has nothing to rob: the raiders' camp is abandoned (CT-50: no raid in an ash
 *    world).
 * 3. Signs a run left on the towns (ash, darkness, thieves, the walking dead) fade, unless an ending set them for good.
 * 4. Ruined far towns grow over.
 */
export const BASE_BETWEEN: readonly BetweenDef[] = [
  {
    id: 'raiders-truce-ends',
    when: [{ helper: 'raidersAre', args: ['truce'] }],
    do: [{ helper: 'raidersStance', args: ['hostile'] }],
    say: 'The raiders spent your tribute. They are camped on the road again.',
  },
  {
    id: 'raiders-leave',
    // (a far town stands: any state but destroyed or abandoned — sworn, taken or founded towns are still there to rob.
    // Found by the run-start screenshot: `far:nearest:1` names only towns nobody holds, so a world of sworn towns read as
    // empty and the raiders left it)
    when: [{ helper: 'raidersCamp' }, { not: { helper: 'farStands' } }],
    do: [{ setTag: [RAIDERS_CAMP, 'condition', 'abandoned', true] }],
    say: 'No far town was left to rob. The raiders broke camp and went away.',
  },
  {
    id: 'signs-fade',
    when: [{ helper: 'signsLinger' }],
    do: [{ helper: 'fadeSigns' }],
    say: 'Years passed. The ash, the dark and the thieves of the last run are gone.',
  },
  {
    id: 'ruins-overgrow',
    when: [{ helper: 'ruinsBare' }],
    do: [{ helper: 'eachTown', args: ['far:where:destroyed', 'mutate', 'greened', '$each'] }, { helper: 'eachTown', args: ['far:where:abandoned', 'mutate', 'greened', '$each'] }],
    say: 'Grass and young trees grew over the ruined towns.',
  },
];

/** the fact event a between-runs entry leaves in the record (`about.thing`: its id, the note its line) */
export const BETWEEN = 'between-runs';
/** the fact event that ends a law a card left for later runs (`about.thing`: the law's id): from the next run on, the
 *  law stands no more unless the card is done again (season/realm.ts refreshLaws) */
export const LAW_ENDED = 'law-ended';
