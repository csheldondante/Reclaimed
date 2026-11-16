// (card-table; docs/design/CARD_TABLE.md) The card table's driver in Node: a whole run by moves on the Realm itself,
// the same run from the same seed and moves, and every number on a card the model's own.
import { describe, expect, it } from 'vitest';
import { pools } from '../../src/season/ledger';
import { replay, Table } from '../../src/table/game';

const OPTS = { seed: 7, leader: 'ysolt', seasons: 8 };

/** take everything that can be paid for, threats first; then end the season */
function greedy(t: Table): void {
  while (!t.over) {
    for (const c of t.cards().sort((a, b) => Number(b.threat) - Number(a.threat))) if (!Object.keys(c.short).length) t.take(c.id);
    t.endSeason();
  }
}

describe('the card table plays a run on the Realm', () => {
  it('a card shows the model\'s own cost, and taking it pays that cost', () => {
    const t = new Table(OPTS);
    const cards = t.cards();
    expect(cards.length).toBeGreaterThan(0);
    const c = cards.find((x) => !Object.keys(x.short).length)!;
    const before = pools(t.realm.ledger);
    expect(t.take(c.id)).toBe(true);
    const after = pools(t.realm.ledger);
    for (const [k, n] of Object.entries(c.locks)) expect(before[k as 'labor'] - after[k as 'labor'], `${c.template} locks ${k}`).toBe(n);
    for (const [k, n] of Object.entries(c.costs)) expect(before[k as 'materials'] - after[k as 'materials'], `${c.template} spends ${k}`).toBe(n);
    expect(t.cards().some((x) => x.id === c.id)).toBe(false);
    expect(t.working().some((x) => x.id === c.id)).toBe(true);
  });

  it('a whole run ends: the threat comes in the last season and the run is over', () => {
    const t = new Table(OPTS);
    greedy(t);
    expect(t.over).toBe(true);
    expect(t.realm.fight !== null || t.realm.averted).toBe(true);
    expect(t.curve.length).toBe(OPTS.seasons - 1);
    expect(t.story().length).toBeGreaterThan(0);
  });

  it('the same seed and the same moves make the same run', () => {
    const a = new Table(OPTS);
    greedy(a);
    const b = replay(OPTS, a.moves);
    expect(b.log).toEqual(a.log);
    expect(b.curve).toEqual(a.curve);
    expect(b.realm.runState().engine.past.map((o) => [o.template, o.status])).toEqual(a.realm.runState().engine.past.map((o) => [o.template, o.status]));
  });

  it('the next run keeps what was built and the world\'s history', () => {
    const a = new Table(OPTS);
    greedy(a);
    const b = a.next('dunstan');
    expect(b.run).toBe(2);
    expect(b.built()).toEqual(a.built());
    expect(b.season).toBe(1);
    expect(b.realm.history(true).length).toBeGreaterThan(b.realm.history().length);
  });
});
