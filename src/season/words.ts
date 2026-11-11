// (trackA-opps, the season loop) Every line the player reads in the season loop (docs/WRITING.md: plain words, one
// idea a sentence, concrete numbers; no "commit", "stage" or "tier" on screen). Linted whole as a words module
// (test/unit/writing-sources.test.ts) and as produced (test/unit/season.test.ts).
import { POOLS, type Pool, type Pools, type SeasonCard, type SeasonResult } from './ledger';

export const POOL_NAME: Record<Pool, string> = { magic: 'Magic', might: 'Might', labor: 'Labor', materials: 'Materials', intel: 'Intel', unrest: 'Unrest' };
export const POOL_ICON: Record<Pool, string> = { magic: '✦', might: '⚔', labor: '⚒', materials: '▣', intel: '👁', unrest: '✊' };

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

/** "2 Labor, 1 Materials" (the pools in their order) */
export function poolsLine(p: Partial<Pools>, sign = false): string {
  const parts = POOLS.filter((k) => (p[k] ?? 0) !== 0).map((k) => `${sign && p[k]! > 0 ? '+' : ''}${p[k]} ${POOL_NAME[k]}`);
  return parts.join(', ');
}

/** what it ties up and what it spends: "Takes 2 Labor for 2 seasons. Uses 2 Materials." */
export function costLine(c: SeasonCard): string {
  const out: string[] = [];
  const locks = poolsLine(c.locks);
  if (locks) out.push(`Takes ${locks} for ${c.seasons === 1 ? '1 season' : `${c.seasons} seasons`}.`);
  else out.push(seasonsLine(c.seasons));
  const costs = poolsLine(c.costs);
  if (costs) out.push(`Uses ${costs}.`);
  return out.join(' ');
}

/** a card in progress: "2 Labor back in season 4." or "Done in season 4." */
export function backLine(locks: Partial<Pools>, season: number): string {
  const p = poolsLine(locks);
  return p ? `${p} back in season ${season}.` : `Done in season ${season}.`;
}

export function seasonsLine(n: number): string {
  return n === 1 ? 'Takes 1 season.' : `Takes ${n} seasons.`;
}

/** what it gives once built: "When built: +2 Labor." "+1 Materials each season." and its Unrest once */
export function givesLine(c: SeasonCard): string {
  const once = poolsLine(c.gives ?? {}, true);
  const each = poolsLine(c.income ?? {}, true);
  const out: string[] = [];
  if (once) out.push(`When built: ${once}.`);
  if (each) out.push(`${once ? '' : 'When built: '}${each} each season.`);
  if (c.unrestOnDone) out.push(`Unrest ${c.unrestOnDone > 0 ? '+' : ''}${c.unrestOnDone} when built.`);
  if (c.unrestOnStart) out.push(`Unrest ${c.unrestOnStart > 0 ? '+' : ''}${c.unrestOnStart} when you start.`);
  return out.join(' ');
}

export function shortLine(miss: Partial<Pools>): string {
  return `Needs ${poolsLine(miss)} more.`;
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

// ---- (trackA-forces) soldiers and raiders: the line under the season's summary -----------------------------------

const count = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

export const SOLDIERS_NO_PLACE = 'Your soldiers have nowhere to gather. Build walls for a muster yard. Or raise a keep for a barracks.';
export const NO_SOLDIERS = 'You have no soldiers free. Each Might gives you 3.';

/** where the soldiers are: "6 soldiers guard the gates." */
export function soldiersLine(n: number, where: 'yard' | 'barracks' | 'gates' | 'walls' | 'patrol' | 'heart'): string {
  const who = count(n, 'soldier', 'soldiers');
  const verb = (one: string, many: string) => (n === 1 ? one : many);
  switch (where) {
    case 'gates':
      return `${who} ${verb('guards', 'guard')} the gates.`;
    case 'walls':
      return `${who} ${verb('stands', 'stand')} on the walls.`;
    case 'patrol':
      return `${who} ${verb('marches', 'march')} out on patrol.`;
    case 'heart':
      return `${who} ${verb('waits', 'wait')} for the raiders in the town centre.`;
    case 'yard':
      return `${who} ${verb('is', 'are')} drilling.`;
    default:
      return `${who} ${verb('waits', 'wait')} at the barracks.`;
  }
}

export function waveSoonLine(n: number): string {
  return `Raiders are coming next season. Scouts count ${n}.`;
}

export function waveNowLine(n: number, left: number, stage: 'coming' | 'there' | 'fighting'): string {
  if (left === 0) return `All ${n} raiders are dead.`;
  if (stage === 'fighting') return `Raiders are fighting your soldiers! ${left} of ${n} are left.`;
  return stage === 'there' ? `Raiders reached the town! ${left} of ${n} are left.` : `Raiders attack! ${left} of ${n} are on their way.`;
}

/** (trackA-forces2) an order or a spawn found no room: Track B's order groups or fields all taken */
export const FORCES_FULL = 'Too many groups are on the move at once. Some soldiers or raiders stay where they are.';

export const WAVE_NO_ROAD = 'Raiders were seen, but they found no road into town.';

/** after the fight, at the season's end */
export function fightLine(o: { raiders: number; left: number; fallen: number; might: number; materials: number; unrest: number }): string {
  const out: string[] = [];
  if (o.raiders) out.push(o.left ? `${count(o.left, 'raider', 'raiders')} got into town.` : 'You beat the raiders.');
  if (o.materials) out.push(`They took ${o.materials} Materials.`);
  if (o.unrest) out.push(`Unrest +${o.unrest}.`);
  if (o.fallen) out.push(`${count(o.fallen, 'soldier', 'soldiers')} died. You lost ${o.might} Might.`);
  return out.join(' ');
}
