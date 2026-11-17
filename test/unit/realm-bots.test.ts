// (loop-skeleton round 3, item 4) The long run as a deck builder, checked by bots in Node: each bot plays a whole
// home-town run on the realm itself (season/realm.ts: the living engine, the one dealer, the season's six pools) with a
// fixed order of preference, and the test reads what it built, what it let lapse and how many things a season asked
// of it. The card lab's own bots (opps/deck.ts) play the lab's deck and its three resources (labor, influence, power);
// the season's cards are not that deck, so these bots stand in for them here — how the two map is in
// docs/design/LOOP_SKELETON.md "The long run".
// "Holds" is a proxy until the fight itself runs in Node: the raid is held when the tribute was paid, or the town has
// somewhere for soldiers to gather (walls or a keep: season/war.ts SF-13) and Might enough (HOLD_MIGHT) — the walks
// calibrate it: walls and 4 Might (12 soldiers) held 6 raiders for 4 dead.
import { describe, expect, it } from 'vitest';
import { briarWorld } from '../../src/living/briar';
import { newLedger, nextSeason, pools, total } from '../../src/season/ledger';
import { Realm, RUN_SEASONS, type Leader } from '../../src/season/realm';

const LEADER: Leader = { id: 'ysolt', name: 'Marshal Ysolt', line: 'A soldier.', pools: { magic: 1, might: 3, labor: 4, materials: 6, intel: 1 }, income: { materials: 2, magic: 1 } };

interface Bot {
  name: string;
  /** templates in the order it wants them; '*': anything else it can pay for (threats first) */
  want: string[];
}
const BOTS: Bot[] = [
  { name: 'idle', want: [] },
  // (card-table tuning, CT-18: against 18 raiders the walls alone no longer hold; this bot also hires sellswords)
  { name: 'walls first', want: ['build:walls', 'hire-sellswords', 'build:quarry', 'build:lumber', 'mining-outpost', 'mend-dam', 'shore-hill'] },
  { name: 'keep engine', want: ['build:houses', 'build:workshops', 'build:keep', 'build:quarry', 'build:lumber', 'house-refugees', 'build:farms', 'mend-dam'] },
  // (card-table tuning, CT-18: the tribute is 15 Materials now, so the bot that means to pay it pays it first)
  // (draft 8: the raid is a card on the board from the run's fifth of the way: the tribute can be paid from then, and a
  // bot that builds everything first never saves 15. This bot builds only what pays income until it has paid)
  { name: 'trade and tribute', want: ['pay-raiders', 'build:quarry', 'build:lumber', 'mining-outpost'] },
  { name: 'save for the tribute', want: ['pay-raiders'] },
  { name: 'answer every threat', want: ['relieve-neighbour', 'mend-dam', 'fire-wards', 'feed-shrine', 'shore-hill', 'guard-camp', 'house-refugees', 'build:walls', 'build:quarry'] },
  { name: 'everything', want: ['*'] },
];

interface Played {
  bot: string;
  holds: boolean;
  how: string;
  might: number;
  built: string[];
  lapsed: string[];
  asked: number[];
  took: number[];
  income: number;
}

function play(bot: Bot, seasons: number, seed = 7): Played {
  const r = new Realm({ world: briarWorld().ws.snapshot(), home: 'briar-hollow', seed, leader: LEADER, ledger: newLedger(LEADER.pools, LEADER.income), land: () => ({ left: 14, open: [] }), seasons });
  const asked: number[] = [];
  const took: number[] = [];
  const lapsed: string[] = [];
  while (r.raid === null && !r.over && r.season <= seasons) {
    const offered = () => r.offers().filter((o) => o.status === 'offered');
    asked.push(offered().length);
    let n = 0;
    const order = bot.want.includes('*') ? offered().sort((a, b) => Number(!!r.engine.template(b.template).threat) - Number(!!r.engine.template(a.template).threat)).map((o) => o.template) : bot.want;
    for (const t of order) {
      const o = offered().find((x) => x.template === t);
      if (o && !Object.keys(r.short(o)).length) {
        r.commit(o.id);
        n++;
      }
    }
    took.push(n);
    const past = r.engine.past.length;
    r.endSeason();
    lapsed.push(...r.engine.past.slice(past).filter((o) => o.status === 'expired' && r.engine.template(o.template).threat).map((o) => o.template));
    r.afterSeason(nextSeason(r.ledger).ledger);
  }
  const might = total(r.ledger, 'might');
  const fort = r.ledger.built.includes('walls') || r.ledger.built.includes('keep');
  // (round 6: the raid is a live event resolved here as nobody played it — each soldier standing holds a raider, the
  // rules add what the town's tags earn: season/realm-events.ts, realm-rules.ts)
  r.playForced();
  // (the raid is a card: paid off is the tribute card done this run)
  const paid = r.history().some((e) => e.kind === 'tribute-paid');
  const holds = paid || !!r.fight?.held;
  return { bot: bot.name, holds, how: paid ? 'tribute paid' : fort ? `${r.ledger.built.includes('walls') ? 'walls' : 'keep'}, Might ${might}` : `nowhere to gather, Might ${might}`, might, built: r.ledger.built, lapsed, asked, took, income: Object.values(r.ledger.income).reduce((a, b) => a + (b ?? 0), 0) + 0 * pools(r.ledger).materials };
}

describe('a whole run played by bots (the season\'s cards on the realm)', () => {
  const runs = BOTS.map((b) => play(b, RUN_SEASONS));
  for (const p of runs) console.log(`[bots ${RUN_SEASONS}] ${p.bot}: ${p.holds ? 'HOLDS' : 'falls'} (${p.how}); built ${p.built.join(' ') || 'nothing'}; income ${p.income} a season; threats lapsed ${p.lapsed.join(' ') || 'none'}; asked ${p.asked.join(',')}; took ${p.took.join(',')}`);

  it('doing nothing loses the town', () => {
    expect(runs.find((p) => p.bot === 'idle')!.holds).toBe(false);
  });
  it('more than one way of playing holds the raid', () => {
    const ways = runs.filter((p) => p.holds).map((p) => p.how.split(',')[0]);
    expect(runs.filter((p) => p.holds).length, runs.map((p) => `${p.bot}: ${p.how}`).join('; ')).toBeGreaterThanOrEqual(2);
    // (card-table tuning, CT-18: 18 raiders. These bots cast no spell, and with no spell only the tribute holds:
    // walls and the Might a bot of these reaches stop 17. The second way — soldiers and spells together — is played
    // by the card table's bots, which cast: test/unit/table-bots.test.ts. Was: two ways here, at 6 raiders)
    expect(new Set(ways).size).toBeGreaterThanOrEqual(1);
  });
  it('a season never asks more than five things, late in the run as early', () => {
    for (const p of runs) {
      expect(Math.max(...p.asked), `${p.bot}: ${p.asked.join(',')}`).toBeLessThanOrEqual(5);
      const half = Math.floor(p.asked.length / 2);
      const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
      expect(mean(p.asked.slice(half)), `${p.bot} late`).toBeLessThanOrEqual(mean(p.asked.slice(0, half)) + 1);
    }
  });
  it('an engine can be built: a bot that builds ends with more income than it began with', () => {
    // (draft 8: the tribute bot now saves instead of building its market and trade road; the bot that takes everything
    // is the builder here)
    expect(runs.find((p) => p.bot === 'everything')!.income).toBeGreaterThan(3 + 2);
  });
  it('a four-season run is too short for any of them (why the run is long)', () => {
    const short = BOTS.map((b) => play(b, 4));
    console.log(`[bots 4] ${short.map((p) => `${p.bot}: ${p.holds ? 'HOLDS' : 'falls'} (${p.how})`).join('; ')}`);
    expect(short.filter((p) => p.holds).length).toBeLessThan(runs.filter((p) => p.holds).length);
  });
});
