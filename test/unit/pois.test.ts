// (loop round 14, PACK_FORMAT draft 9; season/pois.ts) Points of interest on the model side: the raiders' camp is a
// place on the map; a pack card puts a lair, a crash site, a temple on the map near a fitting place (the same place
// every time); a card bound to a POI clears it; a cleared camp ends the raiders' threat; the rules read POIs as things;
// "far:free:<n>" names only towns nobody holds (LS-107: frontier's league-grows).
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkPack, type Pack } from '../../src/packs/check';
import { effectsText } from '../../src/packs/load';
import { grant } from '../../src/season/ledger';
import { poi, poiCell, pois } from '../../src/season/pois';
import { RAIDERS_CAMP } from '../../src/season/realm-templates';
import { Table } from '../../src/table/game';
import { ROW_H } from '../../src/world/lattice';

const read = (f: string): Pack => JSON.parse(fs.readFileSync(`packs/${f}.json`, 'utf8')) as Pack;
const FRONTIER = read('frontier');
const AGES = read('ages');

/** seasons until a card of one of these templates is on the table and taken (rich enough to pay); its season ends */
function take(t: Table, ids: string[], max = 12): string | null {
  for (let s = 0; s < max && !t.over; s++) {
    t.realm.ledger = grant(t.realm.ledger, { materials: 12, intel: 4, might: 4 });
    const c = t.cards().find((x) => ids.includes(x.template));
    const ok = !!c && t.take(c.id);
    t.endSeason();
    if (ok) return c!.title;
  }
  return null;
}

// (whole runs at the table: seconds each, more when the unit tier runs every file at once)
describe('points of interest', { timeout: 60000 }, () => {
  it("the raiders' camp is a place on the map, out in the wilds, the same place every time", () => {
    const a = new Table({ seed: 7, leader: 'ysolt', seasons: 16 });
    const b = new Table({ seed: 7, leader: 'ysolt', seasons: 16 });
    const camp = poi(a.realm.w, RAIDERS_CAMP)!;
    expect(camp).toMatchObject({ kind: 'camp', state: 'standing', holder: 'raiders' });
    expect(poi(b.realm.w, RAIDERS_CAMP)!.cell).toEqual(camp.cell);
    const home = a.realm.w.settlement(a.realm.home)!;
    const d = Math.hypot(camp.cell[0] - home.at[0], camp.cell[1] * ROW_H - home.at[1]);
    expect(d).toBeGreaterThanOrEqual(85);
    expect(d).toBeLessThanOrEqual(165);
    // (out of every town: farther from each than the least of the camp's ring)
    for (const s of a.realm.w.ws.settlements) if (s.id !== a.realm.home) expect(Math.hypot(camp.cell[0] - s.at[0], camp.cell[1] * ROW_H - s.at[1])).toBeGreaterThan(10);
    expect(a.realm.pois().map((p) => p.id)).toContain(RAIDERS_CAMP);
    // (the rules read it as a thing)
    expect(a.realm.things().find((x) => x.id === RAIDERS_CAMP)?.tags).toEqual(expect.arrayContaining(['poi', 'camp', 'standing', 'raiders']));
  });

  it("a card bound to the camp clears it; a cleared camp ends the raiders' threat", () => {
    const t = new Table({ seed: 7, leader: 'ysolt', seasons: 40, packs: [FRONTIER] });
    expect(t.realm.raidersThreaten()).toBe(true);
    expect(take(t, ['frontier-break-camp'], 20)).toBe("Break the raiders' camp");
    expect(poi(t.realm.w, RAIDERS_CAMP)!.state).toBe('cleared');
    expect(t.realm.raidersThreaten()).toBe(false);
    // (the record keeps it)
    expect(t.realm.w.facts.events({ kind: 'poi-cleared' }).length).toBe(1);
  });

  it('a template card puts a lair on the map near the place it bound; another card clears it', () => {
    const t = new Table({ seed: 7, leader: 'ysolt', seasons: 40, packs: [FRONTIER] });
    const title = take(t, ['frontier-wolf-lair'], 20);
    expect(title).toMatch(/^Wolves den up near /);
    const lair = poi(t.realm.w, 'frontier-greyden')!;
    expect(lair).toMatchObject({ kind: 'lair', state: 'standing', name: 'the Grey Den' });
    // (near the town the card was bound to, on the kind's ring)
    const town = t.realm.w.ws.settlements.find((s) => title === `Wolves den up near ${s.name}`)!;
    const d = Math.hypot(lair.cell[0] - town.at[0], lair.cell[1] * ROW_H - town.at[1]);
    expect(d).toBeGreaterThanOrEqual(95);
    expect(d).toBeLessThanOrEqual(205);
    expect(take(t, ['frontier-clear-lair'], 20)).toBe('Clear the Grey Den');
    expect(poi(t.realm.w, 'frontier-greyden')!.state).toBe('cleared');
  });

  it('the dealer puts a POI at a fitting place: the farthest from every settlement on the ring, the same every time', () => {
    const t = new Table({ seed: 11, leader: 'ysolt', seasons: 16 });
    const w = t.realm.w;
    const a = poiCell(w, 'crash', t.realm.home, 'x-ship');
    expect(poiCell(w, 'crash', t.realm.home, 'x-ship')).toEqual(a);
    expect(poiCell(w, 'crash', t.realm.home, 'y-ship')).not.toEqual(a);
    expect(pois(w).length).toBe(1);
  });

  it('the words: a POI made, a POI cleared; the validator knows the words', () => {
    expect(effectsText([{ poi: 'lair', id: 'frontier-greyden', name: 'the Grey Den', near: 'town' } as never], FRONTIER)).toBe('the Grey Den, a lair, is marked on the map near the town.');
    expect(effectsText([{ poi_state: 'cleared', where: 'poi:raiders-camp' } as never], FRONTIER)).toBe("The raiders' camp is cleared.");
    expect(checkPack(FRONTIER).filter((x) => x.level === 'error')).toEqual([]);
    expect(checkPack(AGES).filter((x) => x.level === 'error')).toEqual([]);
    const bad = (f: (p: Pack) => void) => {
      const p = JSON.parse(JSON.stringify(FRONTIER)) as Pack;
      f(p);
      return checkPack(p).filter((x) => x.level === 'error').map((x) => x.text).join(' | ');
    };
    const card = (p: Pack) => p.cards!.find((c) => c.id === 'frontier-wolf-lair')!;
    expect(bad((p) => ((card(p).if_taken![0] as { poi: string }).poi = 'castle'))).toMatch(/Unknown kind of point of interest "castle"/);
    expect(bad((p) => (card(p).if_taken = [{ poi_state: 'cleared', where: 'poi:frontier-nowhere' } as never]))).toMatch(/is no point of interest/);
    expect(bad((p) => (card(p).if_taken = [{ poi_state: 'burned', where: 'poi:raiders-camp' } as never]))).toMatch(/"poi_state" is standing, cleared, gone/);
  });

  it('far:free:1 names the nearest standing town nobody holds (LS-107)', () => {
    const t = new Table({ seed: 7, leader: 'ysolt', seasons: 16, packs: [FRONTIER] });
    const r = t.realm;
    const nearest = r.selectTowns('far:nearest:1')[0];
    expect(r.selectTowns('far:free:1')).toEqual([nearest]);
    // (the nearest made yours: it is no longer free; the next one is)
    r.w.facts.relate({ type: 'controls', from: 'player', to: nearest, cause: 'test' });
    expect(r.selectTowns('far:nearest:1')).toEqual([nearest]);
    expect(r.selectTowns('far:free:1')).not.toContain(nearest);
    expect(r.selectTowns('far:free:1').length).toBe(1);
    expect(effectsText([{ far: 'vassal', where: 'far:free:1', by: 'frontier-league' } as never], FRONTIER)).toMatch(/the nearest town nobody holds/i);
  });
});
