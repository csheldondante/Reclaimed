// (card-table; docs/design/CARD_TABLE.md) The card table's own lines (docs/WRITING.md: plain words, one idea a
// sentence, concrete numbers). The opportunities' words are their templates'; the pools' names and the fight's lines
// are the season's (season/words.ts, season/run-words.ts). Linted whole as a words module
// (test/unit/writing-sources.test.ts).
import { POOLS, type Pools } from '../season/ledger';
import { POOL_NAME } from '../season/words';

export const PAGE_TITLE = 'Card table';
export const OPPS_TITLE = 'Asked of you this season';
export const OPPS_NONE = 'Nobody is asking for anything this season.';
export const WORK_TITLE = 'Under way';
export const PLAY_TITLE = 'In play';
export const PLAY_NONE = 'Nothing is built yet.';
export const ABILITIES_TITLE = 'Abilities';
export const EVENTS_TITLE = 'Happening now';
export const LOG_TITLE = 'What happened';
export const LOG_NONE = 'Nothing has happened yet.';
export const RULES_TITLE = 'Rules';
export const TAKE = 'Take';
export const PASS = 'Pass';
export const END_SEASON = 'End the season';
export const NEW_RUN = 'Start the next run in this world';
export const RESTART = 'Start again';
export const SETUP = 'Seed, leader and length';
export const SEED = 'Seed';
export const LEADER = 'Leader';
export const LENGTH = 'Seasons';
export const RUN_OVER = 'The run is over.';
export const CARRY = 'The next run keeps what you built. The world keeps what happened.';
export const COST = 'Cost';
export const IF_TAKEN = 'If you take it';
export const IF_LEFT = 'If you leave it';
export const NO_LAPSE = 'Nothing. The offer goes away.';
export const STORY_TITLE = 'What happened this run';
export const BUILT_TITLE = 'Built';

export const header = (name: string, season: number, of: number, run: number): string => `${name}. Season ${season} of ${of}. Run ${run}.`;
export const runBegan = (name: string, run: number, seasons: number): string => `Run ${run} begins. ${name} leads the town for ${seasons} seasons.`;
export const took = (title: string): string => `You took "${title}".`;
export const passed = (title: string): string => `You passed on "${title}".`;
export const builtLine = (name: string): string => `Built: ${name}.`;
export const leftLine = (left: number): string => (left <= 1 ? 'This is its last season.' : `It stays ${left} seasons.`);
export const doneIn = (left: number): string => (left <= 1 ? 'Done next season.' : `Done in ${left} seasons.`);
export const needLine = (miss: string): string => `You need ${miss} more.`;
export const incomeText = (n: number): string => (n > 0 ? `+${n} a season` : n < 0 ? `${n} a season` : '');
export const freeOf = (have: number, of: number): string => `${have} of ${of} free`;
export const storyLine = (season: number, note: string): string => `Season ${season}. ${note.charAt(0).toUpperCase()}${note.slice(1)}${/[.!?]$/.test(note) ? '' : '.'}`;

/** the pools' change over a season: "Materials +2, Magic +1" (empty: nothing changed) */
export function deltaLine(before: Pools, after: Pools): string {
  const parts = POOLS.filter((k) => after[k] !== before[k]).map((k) => `${POOL_NAME[k]} ${after[k] > before[k] ? '+' : ''}${after[k] - before[k]}`);
  return parts.length ? `The season changed your pools. ${parts.join(', ')}.` : '';
}
