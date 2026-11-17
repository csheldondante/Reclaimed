// (board) The board's own words: short, plain, concrete. The cards' words are the model's (table/game.ts).
import { POOL_NAME } from '../season/words';
import type { Pool } from '../season/ledger';

export const NEXT = 'Next season';
export const REGION = 'Region';
export const TOWN = 'Town';
export const SKIP = 'Skip';
export const COMMIT = 'Commit';
export const PASS = 'Turn down';
export const DEFEND = 'Defend the town now';
export const RESOLVE = 'Settle it now';
export const NEW_RUN = (n: number): string => `Start run ${n}`;
export const COST = 'Costs';
export const GIVES = 'Gives';
export const IF_LEFT = 'If left';
export const POST = 'Post';
export const RECALL = 'Recall';
export const CREW = 'Crew';
export const SOLDIER = 'Soldier';
export const pieceWord = (k: 'crew' | 'soldier', n: number): string => `${n} ${k}${n === 1 ? '' : 's'}`;
export const armedHint = (k: 'crew' | 'soldier'): string => `Tap a lit place to post a ${k}. Tap the ${k} again to stop.`;
export const noRoom = (k: 'crew' | 'soldier'): string => `No place has room for a ${k} now.`;
export const seasonOf = (s: number, of: number): string => `Season ${s}`;
export const seasonSub = (s: number, of: number, run: number): string => `of ${of} · run ${run}`;
export const leftWord = (n: number): string => (n <= 1 ? 'last season' : `${n} seasons`);
export const raidNeed = (raiders: number, meet: number, left: number, military: boolean): string =>
  `${raiders} raiders in ${leftWord(left)}; you would meet them with ${meet}${military ? '' : ' (soldiers need a keep or walls)'}`;
export const raidChip = (raiders: number, meet: number, left: number): string => `${raiders} raiders · ${leftWord(left)} · you ${meet}`;
export const slotLine = (k: 'crew' | 'soldier', posted: number, n: number): string => `${k === 'crew' ? 'Crews' : 'Soldiers'} here: ${posted} of ${n}`;
export const usesLeft = (n: number): string => (n <= 0 ? 'used this season' : n === 1 ? 'once more this season' : `${n} more this season`);
export const tiedLine = (k: 'crew' | 'soldier', n: number, back: number): string => `${pieceWord(k, n)} busy until season ${back}`;
export const raisingLine = (title: string, left: number): string => `Being built: ${title}. Done in ${leftWord(left)}.`;
export const poolName = (k: Pool): string => (k === 'labor' ? 'Free crews' : k === 'might' ? 'Free soldiers' : POOL_NAME[k]);
export const raidCount = (standing: number, secs: number): string => `${standing} raiders standing · ${secs} s`;
export const fightLine = (raiders: number, soldiers: number): string => `${raiders} raiders. You meet them with ${soldiers} soldiers.`;
export const PREDICT = 'As it stands';
export const NO_MUSTER = 'Your soldiers do not fight: they need a keep or town walls to gather at.';
export const NOTHING_HERE = 'Nothing to do here this season.';
export const RUN_CHANGED = 'The town and the region as the last run left them.';
export const AWAY = 'away from the town';
// ---- (draft 11, docs/design/FACTORY.md) the factory ----
export const NEEDS = 'Needs';
export const forSeasons = (turns: number, crews: number, soldiers: number): string =>
  crews || soldiers ? `(the ${[crews ? pieceWord('crew', crews) : '', soldiers ? pieceWord('soldier', soldiers) : ''].filter((x) => x).join(' and ')} busy for ${turns === 1 ? '1 season' : `${turns} seasons`})` : '';
export const CAN_MAKE = 'You can make it this season';
export const CANNOT_MAKE = 'You cannot make it this season with what you have.';
export const clicksLine = (left: number, of: number): string => (of === 0 ? 'No crew here: no clicks this season' : `Clicks this season: ${left} of ${of}`);
export const eatsLine = (what: string, per: number, crews: number): string => (per ? `Eats ${what} each season for every ${per} crews: ${Math.ceil(crews / per)} now (${crews} crews). Short: Unrest +1.` : `Eats ${what} each season. Short: Unrest +1.`);
export const NO_CREW = 'post a crew here first';
export const NO_CLICKS = 'no clicks left this season';
export const shortOf = (what: string): string => `short ${what}`;
export const ateLine = (n: number, good: string): string => `The houses eat ${n} ${good}`;
export const HUNGRY = 'The houses go hungry';
