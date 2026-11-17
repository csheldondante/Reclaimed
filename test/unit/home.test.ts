// (card-table, PACK_FORMAT draft 8) The owner: "Leaders should be able to start in far cities." A pack leader's `home`
// names a far town by what it is (yours, sworn to you, a colony, held by a faction); the run is played FROM there: it is
// home (its sites, its things, its pools), and the old home is a far town with its record and its state.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Pack } from '../../src/packs/check';
import { farThings, thingEntity } from '../../src/packs/load';
import { grant } from '../../src/season/ledger';
import { siteId } from '../../src/season/realm-templates';
import { HOME, Table } from '../../src/table/game';

const FRONTIER = JSON.parse(fs.readFileSync('packs/frontier.json', 'utf8')) as Pack;

function play(t: Table, wanted: string[]): string[] {
  const took: string[] = [];
  while (!t.over) {
    t.realm.ledger = grant(t.realm.ledger, { materials: 6, intel: 2 });
    for (const c of t.cards().filter((x) => wanted.includes(x.template))) if (t.take(c.id)) took.push(c.template);
    t.endSeason();
  }
  return took;
}

describe('a run played from a far town', () => {
  it('run 1 makes a town yours; run 2 starts there; the record keeps both; the old home is a far town', () => {
    const t1 = new Table({ seed: 7, leader: 'ysolt', seasons: 8, packs: [FRONTIER] });
    // (the base card swears Millbrook to you; the League courts it, and the envoy keeps it)
    const took1 = play(t1, ['relieve-neighbour', 'frontier-league-courts', 'frontier-sea-lane', 'build:quarry']);
    expect(took1).toContain('relieve-neighbour');
    const sworn = t1.realm.selectTowns('far:where:vassal');
    expect(sworn.length).toBeGreaterThan(0);
    // (the steward is offered only while a far town is yours)
    expect(Table.leaders(undefined, [FRONTIER]).map((l) => l.id)).not.toContain('frontier-steward');
    expect(Table.leaders(t1.realm.snapshot(), [FRONTIER], t1.home).map((l) => l.id)).toContain('frontier-steward');

    const t2 = t1.next('frontier-steward');
    expect(t2.home).toBe(sworn[0]);
    expect(t2.movedFrom).toBe(HOME);
    expect(t2.realm.home).toBe(sworn[0]);
    // (the new home's own sites; the old home's sites stay in the world with what happened to them)
    expect(t2.realm.w.facts.entity(siteId(t2.home, 'fields'))?.at.settlement).toBe(t2.home);
    expect(t2.realm.w.facts.entity(siteId(HOME, 'fields'))).toBeTruthy();
    // (things stay where they were put: the sea charter is Briar Hollow's, not the steward's)
    expect(t2.realm.w.facts.entity(thingEntity('frontier-sea-charter'))?.at.settlement).toBe(HOME);
    expect(t2.things().some((x) => x.name === 'Sea charter')).toBe(false);
    // (the town's buildings: Briar Hollow's are written on it, the new home starts with its own — none)
    expect(t2.built()).toEqual([]);
    expect(t2.realm.w.facts.tag(HOME, 'condition', 'built:quarry')?.value).toBe(true);
    // (the old home is a far town now: yours, standing, named in "Far places" and "The world now")
    const far = farThings(t2.realm.w, [], t2.home).find((x) => x.id === HOME)!;
    expect(far.tags).toEqual(expect.arrayContaining(['far-town', 'standing', 'yours']));
    expect(t2.realm.selectTowns('far:all')).toContain(HOME);
    expect(t2.farNews().places.some((p) => p.name === 'Briar Hollow')).toBe(true);
    expect(t2.worldNow().some((l) => /^You rule from .+\. Briar Hollow is a far town now\.$/.test(l))).toBe(true);
    // (a card of run 2 binds the old home as a far town: a template over far towns that are yours)
    const n0 = t2.realm.record().length;
    play(t2, ['frontier-sea-lane', 'build:farms']);
    // (the record: run 1's cards at Briar Hollow, by name; run 2's at the town)
    const rec = t2.record();
    expect(rec.find((p) => p.place === 'Briar Hollow')!.lines.some((l) => l.startsWith('Run 1'))).toBe(true);
    expect(t2.realm.record().length).toBeGreaterThan(n0);
    expect(t2.realm.record().filter((e) => e.run === 2).some((e) => e.place === t2.home || e.about.includes(t2.home))).toBe(true);
    // (a card of run 2 was bound to the old home as a far place — dealt over it like any far town)
    const bound = [...t2.realm.engine.offers, ...t2.realm.engine.past].filter((o) => Object.entries(o.bind).some(([k, v]) => k !== 'town' && v === HOME));
    expect(bound.map((o) => o.template).length, 'a card bound to Briar Hollow').toBeGreaterThan(0);
  }, 180000);
});
