// (trackA-opps, the season loop) The ledger through the opportunity contract on the six pools, the hand from the one
// dealer, land in district shares, the player's lines, and a six-season run printed.
import { describe, expect, it } from 'vitest';
import { CATALOG, card, START_INCOME, START_POOLS } from '../../src/season/catalog';
import { allocate, dealHand, HAND, hasLand, type Land } from '../../src/season/deal';
import { commit, newLedger, nextSeason, pools, POOL_ROLE, POOLS, total, uncommit, type Pool, type SeasonLedger } from '../../src/season/ledger';
import { backLine, costLine, givesLine, poolsLine, REASON, seasonsLine, shortLine, summaryLine } from '../../src/season/words';
import { OPP_TUNE } from '../../src/opps/tune';
import { lint } from '../support/writing';
import { SeasonLoop, type SeasonHost } from '../../src/season/loop';
import type { DistrictStage } from '../../src/api/contracts/citygen';

const start = () => newLedger(START_POOLS, START_INCOME);
const land = (left: number | null = 7): Land => ({ left, open: [] });
const hand = (l: SeasonLedger, ld: Land = land()) => dealHand({ ledger: l, land: ld, recent: [], tune: { ...OPP_TUNE.dealer } });

describe('season ledger (the opportunity contract: people locked, goods spent)', () => {
  it('commit locks Labor and spends Materials; uncommit undoes it before the season ends', () => {
    const l0 = start();
    const l1 = commit(l0, card('houses'));
    expect(pools(l1).labor).toBe(pools(l0).labor - 2);
    expect(total(l1, 'labor')).toBe(total(l0, 'labor'));
    expect(pools(l1).materials).toBe(pools(l0).materials - 2);
    expect(l1.holdings.agents.filter((a) => a.committed).length).toBe(2);
    expect(pools(uncommit(l1, l1.projects[0].id))).toEqual(pools(l0));
    const l2 = nextSeason(l1).ledger;
    expect(() => uncommit(l2, l2.projects[0].id)).toThrow(/under way/);
  });

  it('nothing more is paid along the way; the people come back when the card finishes', () => {
    let l = commit(start(), card('workshops'));
    const locked = pools(l).labor;
    const stages: [number, number][] = [];
    for (let s = 0; s < 3; s++) {
      const r = nextSeason(l);
      stages.push([+r.changes[0].from.toFixed(3), +r.changes[0].to.toFixed(3)]);
      expect(r.changes[0].done).toBe(s === 2);
      if (s < 2) expect(pools(r.ledger).labor).toBe(locked);
      l = r.ledger;
    }
    expect(stages).toEqual([
      [0, 0.333],
      [0.333, 0.667],
      [0.667, 1],
    ]);
    expect(pools(l).labor).toBe(locked + 3);
    expect(l.built).toEqual(['workshops']);
    expect(l.income.materials).toBe((START_INCOME.materials ?? 0) + 2);
  });

  it("every card locks only people and spends only goods (the pools' roles)", () => {
    for (const c of CATALOG) {
      for (const k of Object.keys(c.locks)) expect(POOL_ROLE[k as Pool]).toBe('people');
      for (const k of Object.keys(c.costs)) expect(POOL_ROLE[k as Pool]).toBe('goods');
    }
  });

  it('unrest keeps workers away; houses add workers and crowding, farms calm it', () => {
    let l = commit(start(), card('houses'));
    l = nextSeason(nextSeason(l).ledger).ledger;
    expect(total(l, 'labor')).toBe(6);
    expect(pools(l).unrest).toBe(1);
    expect(pools(l).labor).toBe(5);
    l = commit(l, card('farms'));
    l = nextSeason(l).ledger;
    expect(pools(l).unrest).toBe(0);
    expect(pools(l).labor).toBe(6);
  });

  it('is pure: the same ledger gives the same season', () => {
    const l = commit(commit(start(), card('houses')), card('farms'));
    expect(nextSeason(l)).toEqual(nextSeason(l));
  });
});

describe('land in district shares', () => {
  it('a card goes on in an open district of its kind, two cards a district at a time', () => {
    const a = allocate(land(2), 'housing', 2)!;
    expect([a.key, a.slot, a.land.left]).toEqual([null, 0, 1]);
    // (the first still building: the second card takes the district's other slot)
    const b = allocate(a.land, 'housing', 2)!;
    expect([b.key, b.slot, b.land.left]).toEqual([a.land.open[0].key, 1, 1]);
    // (both slots busy: a third opens another district)
    const c = allocate(b.land, 'housing', 2)!;
    expect([c.key, c.land.left]).toEqual([null, 0]);
    // (once the first is done, its slot is free for the last part)
    const done: Land = { ...b.land, open: b.land.open.map((d) => ({ ...d, busy: [false, true] })) };
    const d = allocate(done, 'housing', 2)!;
    expect([d.key, d.slot, d.land.open[0].room]).toEqual([done.open[0].key, 0, 0]);
    expect(allocate(land(0), 'housing', 2)).toBeNull();
  });
});

describe('season hand (the one dealer)', () => {
  it('deals at most HAND cards you can start and one goal, gated by what is built', () => {
    const { offers } = hand(start());
    expect(offers.filter((o) => o.affordable).length).toBeLessThanOrEqual(HAND);
    expect(offers.filter((o) => !o.affordable).length).toBeLessThanOrEqual(1);
    const ids = offers.map((o) => o.card.id);
    expect(ids).not.toContain('market');
    expect(ids).toContain('houses');
  });

  it('no district cards without land', () => {
    expect(hasLand(start(), land(0), card('houses'))).toBe(false);
    expect(hand(start(), land(0)).offers.every((o) => o.card.work.kind === 'stub')).toBe(true);
  });
});

describe('season words', () => {
  it('every card line reads plainly (docs/WRITING.md)', () => {
    const lines: string[] = [];
    for (const c of CATALOG) lines.push(c.title, c.pitch, costLine(c), seasonsLine(c.seasons), givesLine(c), backLine(c.locks, 3));
    for (const c of CATALOG) lines.push(REASON.opens(c), REASON.ready(c));
    lines.push(REASON.calm(3), REASON.workers, poolsLine({ labor: 2, materials: -1 }, true), shortLine({ labor: 1, materials: 2 }));
    let l = commit(commit(start(), card('farms')), card('houses'));
    const r = nextSeason(l);
    lines.push(summaryLine(r, card));
    l = r.ledger;
    lines.push(summaryLine(nextSeason(l), card), summaryLine(nextSeason(newLedger()), card));
    const bad = lines.flatMap((t) => lint(t).map((p) => `${p} — ${t}`));
    expect(bad).toEqual([]);
    expect(costLine(card('houses'))).toBe('Takes 2 Labor for 2 seasons. Uses 2 Materials.');
    expect(summaryLine(r, card)).toBe('Season 1 is over. The farms are finished. One building is still going up.');
    expect(POOLS).toEqual(['magic', 'might', 'labor', 'materials', 'intel', 'unrest']);
  });
});

/** the town's district API and the showcase as fakes: what the GPU would be told, in order */
function fake(districts = 7) {
  const told: string[] = [];
  let n = districts;
  const host: SeasonHost = {
    districts: {
      claimDistrict: async () => ({ town: 't', id: n > 0 ? 10 + --n : -1, at: [0, 0], left: n }),
      districtsLeft: async () => ({ town: 't', left: n }),
      stageDistrict: (_t, id, s: DistrictStage, atOnce) => (told.push(`${id} ${s.slot} [${s.a.toFixed(2)},${s.b.toFixed(2)}] ${s.from.toFixed(2)}>${s.to.toFixed(2)} end ${s.end.toFixed(2)}${atOnce ? ' now' : ''}`), true),
      inWindow: (_t, at) => [at[0], at[1]],
    },
    tiers: {
      showcase: (s) => {
        let playing = true;
        let done!: () => void;
        const p = new Promise<void>((r) => (done = r));
        return {
          get playing() {
            return playing;
          },
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
  return { host, told, left: () => n };
}

describe('season loop (fake town, fake showcase)', () => {
  it('a card covers its share of a district, whole exactly when it finishes; the next of its kind goes on in it', async () => {
    const { host, told } = fake();
    const loop = new SeasonLoop(host);
    await loop.init();
    loop.start(loop.hand.findIndex((o) => o.card.id === 'houses'));
    for (let s = 0; s < 2; s++) {
      await loop.next();
      loop.skip();
    }
    loop.start(loop.hand.findIndex((o) => o.card.id === 'houses'));
    await loop.next();
    loop.skip();
    expect(told).toEqual([
      '16 0 [0.00,0.33] 0.00>0.17 end 0.33',
      '16 0 [0.00,0.33] 0.00>0.17 end 0.33 now',
      '16 0 [0.00,0.33] 0.17>0.33 end 0.33',
      '16 0 [0.00,0.33] 0.17>0.33 end 0.33 now',
      '16 0 [0.33,0.67] 0.33>0.50 end 0.67',
      '16 0 [0.33,0.67] 0.33>0.50 end 0.67 now',
    ]);
    expect(loop.left).toBe(6);
  });

  it('six seasons, two cards a season when they can be started (the balance, printed)', async () => {
    const { host, left } = fake();
    const loop = new SeasonLoop(host);
    await loop.init();
    const rows: string[] = [];
    const row = (what: string) => {
      const p = pools(loop.ledger);
      rows.push(`season ${loop.ledger.season} | Labor ${p.labor}/${total(loop.ledger, 'labor')} Materials ${p.materials} Magic ${p.magic} Might ${p.might}/${total(loop.ledger, 'might')} Intel ${p.intel} Unrest ${p.unrest} | districts left ${left()} | ${what}`);
    };
    let blockedByLabor = 0;
    let blockedByMaterials = 0;
    for (let s = 0; s < 6; s++) {
      const picked: string[] = [];
      for (let i = 0; i < loop.hand.length && picked.length < 2; i++) {
        const can = loop.canStart(i);
        if (can.ok) {
          loop.start(i);
          picked.push(loop.hand[i].card.id);
        } else if (!loop.started.has(i)) {
          if (can.short.labor) blockedByLabor++;
          if (can.short.materials) blockedByMaterials++;
        }
      }
      row(`started ${picked.join(', ') || 'nothing'}`);
      await loop.next();
      loop.skip();
    }
    row(`built ${loop.ledger.built.join(', ')}`);
    console.log(['six seasons (greedy: the first two cards that can be started):', ...rows, `cards held back: by Labor ${blockedByLabor}, by Materials ${blockedByMaterials}`].join('\n'));
    // (both limit choices; neither runs away; Muru's land lasts)
    expect(blockedByLabor).toBeGreaterThan(0);
    expect(blockedByMaterials).toBeGreaterThan(0);
    expect(pools(loop.ledger).labor).toBeLessThanOrEqual(8);
    expect(pools(loop.ledger).materials).toBeLessThanOrEqual(10);
    expect(left()).toBeGreaterThan(0);
  });
});
