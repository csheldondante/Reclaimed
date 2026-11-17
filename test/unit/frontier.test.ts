// (card-table; packs/frontier.json "Charters and Corsairs") The frontier pack alone and with every other pack, and the
// pirates' road played by hand: a sea lane, strange sails (the Reavers found their cove), the toll paid (a truce), a
// standing deal, the Reavers pointed at a town (it changes hands; their cut pays), the news says who holds what.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkPack, checkTogether, type Pack } from '../../src/packs/check';
import { stanceOf } from '../../src/packs/load';
import { grant } from '../../src/season/ledger';
import { Table } from '../../src/table/game';

const read = (f: string): Pack => JSON.parse(fs.readFileSync(`packs/${f}.json`, 'utf8')) as Pack;
const FRONTIER = read('frontier');

/** seasons until a card of one of these templates is on the table and taken (rich enough to pay); its season ends */
function take(t: Table, ids: string[], max = 8): string | null {
  for (let s = 0; s < max && !t.over; s++) {
    t.realm.ledger = grant(t.realm.ledger, { materials: 12, intel: 4 });
    const c = t.cards().find((x) => ids.includes(x.template));
    const ok = !!c && t.take(c.id);
    t.endSeason();
    if (ok) return c!.title;
  }
  return null;
}

describe('the frontier pack', () => {
  it('passes the validator alone and together with every other pack', () => {
    expect(checkPack(FRONTIER).filter((x) => x.level === 'error')).toEqual([]);
    const all = ['sample', 'arena', 'laws', 'glitter', 'cross-a', 'cross-b'].map(read);
    expect(checkTogether([FRONTIER, ...all]).filter((x) => x.level === 'error')).toEqual([]);
    // (it loads with all of them at the table)
    expect(() => new Table({ seed: 7, leader: 'ysolt', seasons: 16, packs: [FRONTIER, ...all] })).not.toThrow();
  });

  it('the pirates\' road: a sea lane, their cove found, a truce, a deal, a town handed to them, and their cut', () => {
    const t = new Table({ seed: 7, leader: 'dunstan', seasons: 40, packs: [FRONTIER] });
    const r = t.realm;
    expect(take(t, ['frontier-sea-lane'])).toBe('Open a sea lane');
    expect(take(t, ['frontier-sails'])).toBe('Strange sails off the point');
    expect(r.selectTowns('far:frontier-gullcove')).toEqual(['frontier-gullcove']);
    expect(r.things().find((x) => x.id === 'frontier-gullcove')!.tags).toContain('frontier-reavers');
    expect(take(t, ['frontier-toll'])).toBe('The Gull Reavers want a toll');
    expect(stanceOf(r.w, 'frontier-reavers', 'player')).toBe('truce');
    expect(take(t, ['frontier-deal'])).toBe('Make a standing deal with the Reavers');

    expect(stanceOf(r.w, 'frontier-reavers', 'frontier-league')).toBe('hostile');
    const pointed = take(t, ['frontier-point']);
    expect(pointed).toMatch(/^Point the Reavers at /);
    const town = pointed!.replace('Point the Reavers at ', '');
    const id = r.selectTowns('far:all').find((x) => r.w.name(x) === town)!;
    expect(r.things().find((x) => x.id === id)!.tags).toEqual(expect.arrayContaining(['occupied', 'frontier-reavers']));
    t.endSeason();
    expect(t.hits.some((h) => h.hit.rule === 'frontier-pirate-cut' && h.hit.delta >= 4)).toBe(true);
    const n = t.farNews();
    expect(n.places.find((p) => p.name === town)!.line).toMatch(/held by the Gull Reavers/);
    expect(n.stances).toContain('The Gull Reavers and you: keep a truce.');
    expect(n.changes.some((x) => x.includes(`Because of "${pointed}"`))).toBe(true);
  }, 30000);
});
