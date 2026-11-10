// (trackA-opps, the season loop) Every line the player reads in the season loop (docs/WRITING.md: plain words, one
// idea a sentence, concrete numbers; no "commit", "stage" or "tier" on screen). Linted whole as a words module
// (test/unit/writing-sources.test.ts) and as produced (test/unit/season.test.ts).
import { POOLS, type Pool, type Pools, type SeasonCard, type SeasonResult } from './ledger';

export const POOL_NAME: Record<Pool, string> = { magic: 'Magic', might: 'Might', labor: 'Labor', resources: 'Resources', intel: 'Intel', unrest: 'Unrest' };
export const POOL_ICON: Record<Pool, string> = { magic: '✦', might: '⚔', labor: '⚒', resources: '▣', intel: '👁', unrest: '✊' };

export const NEXT_SEASON = 'Next season';
export const SKIP = 'Skip';
export const START = 'Start';
export const UNDO = 'Undo';
export const BUILDING_NOW = 'Building now';
export const NOTHING_BUILDING = 'Nothing is being built. Pick a card and tap Start.';
export const HAND_TITLE = 'This season you can';
export const BUILDING_SEASON = 'The town is building…';

export function seasonTitle(n: number): string {
  return `Season ${n}`;
}

/** "2 Labor, 1 Resources" (the pools in their order) */
export function poolsLine(p: Partial<Pools>, sign = false): string {
  const parts = POOLS.filter((k) => (p[k] ?? 0) !== 0).map((k) => `${sign && p[k]! > 0 ? '+' : ''}${p[k]} ${POOL_NAME[k]}`);
  return parts.join(', ');
}

export function costLine(c: SeasonCard): string {
  const cost = poolsLine(c.cost);
  return `Costs ${cost || 'nothing'}.`;
}

export function seasonsLine(n: number): string {
  return n === 1 ? 'Takes 1 season.' : `Takes ${n} seasons.`;
}

/** what it gives once built: "When built: +1 Labor each season." and its Unrest once */
export function givesLine(c: SeasonCard): string {
  const each = poolsLine(c.income, true);
  const out: string[] = [];
  if (each) out.push(`When built: ${each} each season.`);
  if (c.unrestOnDone) out.push(`Unrest ${c.unrestOnDone > 0 ? '+' : ''}${c.unrestOnDone} when built.`);
  if (c.unrestOnStart) out.push(`Unrest ${c.unrestOnStart > 0 ? '+' : ''}${c.unrestOnStart} when you start.`);
  return out.join(' ');
}

export function shortLine(miss: Partial<Pools>): string {
  return `You need ${poolsLine(miss)} more.`;
}

export const NO_ROOM = 'There is no free land left in town.';

export function seasonsLeftLine(left: number): string {
  return left === 1 ? '1 season left' : `${left} seasons left`;
}

export function incomeLine(n: number): string {
  return n === 0 ? '' : `${n > 0 ? '+' : ''}${n}`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** "the houses are", "the market is" */
const be = (name: string) => `${cap(name)} ${name.endsWith('s') ? 'are' : 'is'}`;

/** why the dealer put it in your hand, in plain words */
export const REASON = {
  calm: (unrest: number) => `Unrest is ${unrest}. This will calm the town.`,
  workers: 'You are short of Labor. This brings more workers.',
  opens: (next: SeasonCard) => `You need this before you can ${next.title.charAt(0).toLowerCase()}${next.title.slice(1)}.`,
  ready: (built: SeasonCard) => `${be(built.name)} built. This is next.`,
};

/** the line after a season: what was built and what changed */
export function summaryLine(r: SeasonResult, name: (id: string) => SeasonCard): string {
  const out: string[] = [`Season ${r.ledger.season - 1} is over.`];
  for (const id of r.finished) {
    out.push(`${be(name(id).name)} finished.`);
  }
  const going = r.changes.filter((c) => !c.done).length;
  if (going) out.push(going === 1 ? 'One building is still going up.' : `${going} buildings are still going up.`);
  if (!r.changes.length) out.push('Nothing was built.');
  return out.join(' ');
}
