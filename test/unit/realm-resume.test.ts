// (loop-skeleton round 4, BACKLOG LS-8 and LS-29) A run saved in the middle and taken up again plays on exactly as the
// run that was never interrupted: the same offers, pools, spells and raid, season by season. And the save is what
// differs from the world as the atlas makes it (api/snapshot-delta.ts), not the world whole.
import { describe, expect, it } from 'vitest';
import { applyDelta, delta } from '../../src/api/snapshot-delta';
import { briarWorld } from '../../src/living/briar';
import { newLedger, nextSeason, pools, type SeasonLedger } from '../../src/season/ledger';
import { Realm, type Leader, type RunState } from '../../src/season/realm';

const LEADER: Leader = { id: 'ysolt', name: 'Marshal Ysolt', line: 'A soldier.', pools: { magic: 1, might: 3, labor: 4, materials: 6, intel: 1 }, income: { materials: 2, magic: 1 } };
const WANT = ['build:walls', 'tower-lens', 'build:quarry', 'mining-outpost', 'build:lumber', 'mend-dam', 'build:houses', 'house-refugees'];
const SEASONS = 16;
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const fresh = () => new Realm({ world: briarWorld().ws.snapshot(), home: 'briar-hollow', seed: 7, leader: LEADER, ledger: newLedger(LEADER.pools, LEADER.income), land: () => ({ left: 14, open: [] }), seasons: SEASONS });

/** one season played the same way every time: what is wanted and can be paid is agreed, then the season ends */
function season(r: Realm): string {
  for (const t of WANT) {
    const o = r.offers().find((x) => x.status === 'offered' && x.template === t);
    if (o && !Object.keys(r.short(o)).length) r.commit(o.id);
  }
  const news = r.endSeason();
  r.afterSeason(nextSeason(r.ledger).ledger);
  return line(r, news);
}
const line = (r: Realm, news: string[] = []): string =>
  JSON.stringify({ season: r.season, offers: r.offers().map((o) => `${o.id}:${o.status}:${o.expires}`), pools: pools(r.ledger), built: r.ledger.built, spells: r.spells, raid: r.raid, threat: r.standingThreat(), events: r.history(true).length, news });

describe('a run saved in the middle and taken up again', () => {
  it('plays on as the run that was never interrupted', () => {
    const a = fresh();
    const b = fresh();
    for (let k = 0; k < 8; k++) expect(season(b)).toBe(season(a));
    // (the save, as the loop writes it: the world, the run's state, the ledger — through JSON)
    const saved = json({ world: b.snapshot(), run: b.runState(), ledger: b.ledger }) as { world: ReturnType<Realm['snapshot']>; run: RunState; ledger: SeasonLedger };
    const c = new Realm({ world: saved.world, home: 'briar-hollow', seed: 7, leader: LEADER, ledger: saved.ledger, land: () => ({ left: 14, open: [] }), seasons: saved.run.seasons, resume: saved.run });
    expect(line(c)).toBe(line(a));
    expect(c.season).toBe(9);
    let n = 0;
    while (a.raid === null && !a.over && a.season <= SEASONS) {
      const [x, y] = [season(c), season(a)];
      expect(x).toBe(y);
      n++;
    }
    expect(n).toBeGreaterThan(5);
    expect(c.raid).toBe(a.raid);
  });

  it('a save made after a card was agreed mid-season keeps it under way', () => {
    const a = fresh();
    const o = a.offers().find((x) => x.status === 'offered' && !Object.keys(a.short(x)).length)!;
    a.commit(o.id);
    const saved = json({ world: a.snapshot(), run: a.runState(), ledger: a.ledger });
    const c = new Realm({ world: saved.world, home: 'briar-hollow', seed: 7, leader: LEADER, ledger: saved.ledger as SeasonLedger, land: () => ({ left: 14, open: [] }), seasons: SEASONS, resume: saved.run as RunState });
    expect(c.engine.offers.find((x) => x.id === o.id)!.status).toBe('committed');
    expect(line(c)).toBe(line(a));
  });
});

describe('the save as what differs from the world as made (snapshot-delta)', () => {
  it('gives the same world back, and is a small part of it', () => {
    const base = json(briarWorld().ws.snapshot());
    const r = fresh();
    for (let k = 0; k < 9; k++) season(r);
    const cur = json(r.snapshot());
    const d = delta(base as never, cur as never);
    const back = applyDelta(base as never, json(d));
    expect(back).toEqual(cur);
    const whole = JSON.stringify(cur).length;
    const part = JSON.stringify(d).length;
    const run = JSON.stringify(r.runState()).length;
    console.log(`[save] briar world whole ${whole} B; the delta after 9 seasons ${part} B; the run's own state ${run} B`);
    expect(part).toBeLessThan(whole);
  });

  it('nothing changed: nothing saved', () => {
    const base = json(briarWorld().ws.snapshot());
    expect(delta(base as never, json(base) as never)).toBeNull();
  });

  it('arrays by id: an item changed, one gone, one added, and a reorder', () => {
    const base = { list: [{ id: 'a', n: 1 }, { id: 'b', n: 2 }, { id: 'c', n: 3 }], keep: { x: 1 }, gone: 2 };
    for (const cur of [
      { list: [{ id: 'a', n: 1 }, { id: 'b', n: 9 }, { id: 'c', n: 3 }, { id: 'd', n: 4 }], keep: { x: 1 } },
      { list: [{ id: 'a', n: 1 }, { id: 'c', n: 3 }], keep: { x: 2, y: [1, 2] }, gone: 2 },
      { list: [{ id: 'c', n: 3 }, { id: 'a', n: 1 }, { id: 'b', n: 2 }], keep: { x: 1 }, gone: 2 },
      { list: [], keep: { x: 1 }, gone: null },
    ]) {
      const d = delta(base as never, cur as never);
      expect(applyDelta(base as never, json(d))).toEqual(cur);
    }
    // (an append costs the new item and its id, not the list)
    const d = delta(base as never, { ...base, list: [...base.list, { id: 'd', n: 4 }] } as never);
    expect(JSON.stringify(d)).toBe('{"$o":{"list":{"$a":{"set":[{"id":"d","n":4}],"app":["d"]}}}}');
  });
});
