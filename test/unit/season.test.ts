// (trackA-opps, the season loop) The ledger on the six pools, the hand from the one dealer, and the player's lines.
import { describe, expect, it } from 'vitest';
import { CATALOG, card, START_INCOME, START_POOLS } from '../../src/season/catalog';
import { dealHand, HAND, hasLand } from '../../src/season/deal';
import { commit, laborIncome, newLedger, nextSeason, POOLS, uncommit, type SeasonLedger } from '../../src/season/ledger';
import { costLine, givesLine, poolsLine, REASON, seasonsLine, summaryLine } from '../../src/season/words';
import { OPP_TUNE } from '../../src/opps/tune';
import { lint } from '../support/writing';
import { SeasonLoop, type SeasonHost } from '../../src/season/loop';

const start = () => newLedger(START_POOLS, START_INCOME);
const hand = (l: SeasonLedger, left: number | null = 7) => dealHand({ ledger: l, districtsLeft: left, recent: [], tune: { ...OPP_TUNE.dealer } });

describe('season ledger', () => {
  it('commit pays, uncommit refunds, only before the season ends', () => {
    const l0 = start();
    const l1 = commit(l0, card('houses'));
    expect(l1.pools.labor).toBe(l0.pools.labor - 2);
    expect(l1.pools.resources).toBe(l0.pools.resources - 1);
    expect(l0.projects).toHaveLength(0);
    const back = uncommit(l1, l1.projects[0].id);
    expect(back.pools).toEqual(l0.pools);
    const l2 = nextSeason(l1).ledger;
    expect(() => uncommit(l2, l2.projects[0].id)).toThrow(/under way/);
    expect(() => commit(newLedger({ labor: 1 }), card('houses'))).toThrow(/can't be paid/);
  });

  it('a project moves k/n → (k+1)/n a season and pays its income when built', () => {
    let l = commit(start(), card('workshops'));
    const stages: [number, number][] = [];
    for (let s = 0; s < 3; s++) {
      const r = nextSeason(l);
      stages.push([r.changes[0].from, r.changes[0].to]);
      expect(r.changes[0].first).toBe(s === 0);
      expect(r.changes[0].done).toBe(s === 2);
      l = r.ledger;
    }
    expect(stages.map(([a, b]) => [+a.toFixed(3), +b.toFixed(3)])).toEqual([
      [0, 0.333],
      [0.333, 0.667],
      [0.667, 1],
    ]);
    expect(l.projects).toHaveLength(0);
    expect(l.built).toEqual(['workshops']);
    expect(l.income.resources).toBe((START_INCOME.resources ?? 0) + 2);
  });

  it('unrest lowers the Labor a season brings, and calming cards lower it', () => {
    let l = commit(start(), card('walls'));
    expect(l.pools.unrest).toBe(1);
    expect(laborIncome(l)).toBe((START_INCOME.labor ?? 0) - 1);
    const before = l.pools.labor;
    l = nextSeason(l).ledger;
    expect(l.pools.labor).toBe(before + (START_INCOME.labor ?? 0) - 1);
    l = { ...l, pools: { ...l.pools, labor: 9, resources: 9 } };
    l = commit(l, card('farms'));
    const r = nextSeason(l);
    expect(r.finished).toContain('farms');
    expect(r.ledger.pools.unrest).toBe(0);
  });

  it('is pure: the same ledger gives the same season', () => {
    const l = commit(commit(start(), card('houses')), card('farms'));
    expect(nextSeason(l)).toEqual(nextSeason(l));
    expect(nextSeason(l).changes.map((c) => c.at)).toEqual([0, 0.5]);
  });
});

describe('season hand (the one dealer)', () => {
  it('deals at most HAND affordable cards and one goal, gated by what is built', () => {
    const { offers } = hand(start());
    expect(offers.filter((o) => o.affordable).length).toBeLessThanOrEqual(HAND);
    expect(offers.filter((o) => !o.affordable).length).toBeLessThanOrEqual(1);
    const ids = offers.map((o) => o.card.id);
    expect(ids).not.toContain('market');
    expect(ids).not.toContain('keep');
    expect(ids).toContain('houses');
  });

  it('opens the market once houses stand, and a one-off card is not dealt twice', () => {
    const l: SeasonLedger = { ...start(), built: ['houses'] };
    expect(hand(l).offers.map((o) => o.card.id)).toContain('market');
    const l2 = commit({ ...l, pools: { ...l.pools, labor: 9, resources: 9 } }, card('market'));
    expect(hand(l2).offers.map((o) => o.card.id)).not.toContain('market');
  });

  it('no district cards without free land', () => {
    expect(hasLand(start(), 0)).toBe(false);
    const ids = hand(start(), 0).offers.map((o) => o.card);
    expect(ids.every((c) => c.work.kind === 'stub')).toBe(true);
    const one = commit(start(), card('houses'));
    expect(hasLand(one, 1)).toBe(false);
    expect(hasLand(one, 2)).toBe(true);
  });

  it('says why: unrest, then what it opens', () => {
    const l = { ...start(), pools: { ...start().pools, unrest: 2 } };
    const farms = hand(l).offers.find((o) => o.card.id === 'farms');
    expect(farms?.reason).toBe(REASON.calm(2));
    const houses = hand(start()).offers.find((o) => o.card.id === 'houses');
    expect(houses?.reason).toMatch(/before you can/);
  });
});

describe('season words', () => {
  it('every card line reads plainly (docs/WRITING.md)', () => {
    const lines: string[] = [];
    for (const c of CATALOG) lines.push(c.title, c.pitch, costLine(c), seasonsLine(c.seasons), givesLine(c));
    for (const c of CATALOG) lines.push(REASON.opens(c), REASON.ready(c));
    lines.push(REASON.calm(3), REASON.workers, poolsLine({ labor: 2, resources: -1 }, true));
    let l = commit(commit(start(), card('farms')), card('houses'));
    const r = nextSeason(l);
    lines.push(summaryLine(r, card));
    l = r.ledger;
    lines.push(summaryLine(nextSeason(l), card), summaryLine(nextSeason(newLedger()), card));
    const bad = lines.flatMap((t) => lint(t).map((p) => `${p} — ${t}`));
    expect(bad).toEqual([]);
    expect(summaryLine(r, card)).toBe('Season 1 is over. The farms are finished. One building is still going up.');
  });

  it('every pool is named', () => {
    expect(POOLS).toEqual(['magic', 'might', 'labor', 'resources', 'intel', 'unrest']);
  });
});

describe('season loop (fake town, fake showcase)', () => {
  // (the town's district API and the showcase as fakes: what the GPU would be told, in order)
  const fake = () => {
    const told: string[] = [];
    let n = 7;
    const steps: { at: number; apply(): void }[][] = [];
    const host: SeasonHost = {
      districts: {
        claimDistrict: async (kind) => ({ town: 't', id: n > 0 ? 10 + --n : -1, at: [0, 0], left: n }),
        districtsLeft: async () => ({ town: 't', left: n }),
        stageDistrict: (town, id, from, to, atOnce) => (told.push(`${id} ${from.toFixed(2)}>${to.toFixed(2)}${atOnce ? ' now' : ''}`), true),
        inWindow: (_t, at) => [at[0], at[1]],
      },
      tiers: {
        showcase: (s) => {
          steps.push([...s]);
          let playing = true;
          let done!: () => void;
          const p = new Promise<void>((r) => (done = r));
          return {
            get playing() { return playing; },
            progress: 0,
            skip() {
              for (const x of s) x.apply();
              playing = false;
              done();
            },
            done: p,
          };
        },
      },
      tune: { ...OPP_TUNE.dealer },
      seconds: 1,
    };
    return { host, told, steps };
  };

  it('claims land for a new district card, stages it each season, and Skip lands each stage at once', async () => {
    const { host, told } = fake();
    const loop = new SeasonLoop(host);
    await loop.init();
    expect(loop.left).toBe(7);
    const i = loop.hand.findIndex((o) => o.card.id === 'houses');
    loop.start(i);
    expect(loop.canStart(i).ok).toBe(false);
    await loop.next();
    expect(loop.left).toBe(6);
    expect(loop.playing).toBe(true);
    loop.skip();
    expect(loop.playing).toBe(false);
    await loop.next();
    loop.skip();
    expect(told).toEqual(['16 0.00>0.50', '16 0.00>0.50 now', '16 0.50>1.00', '16 0.50>1.00 now']);
    expect(loop.ledger.built).toEqual(['houses']);
  });
});
