// (card-table; packs/ages.json) The owner: "When my decisions turn the war torn plains into a peaceful kingdom with
// scheming wizards or when those wizards destroy the planet with volcanos that cover the world in ash and flame and the
// next run is as an ash tribe rebuilding civilization or when the Ash hordes encounter a fallen ship they deem an angel
// and the visitors from it establish a new strange city at the crash site around their ship". Four runs in one world,
// scripted: (a) peace and a crown; (b) the court wizards, whose working is left to run out — the world ends in ash;
// (c) the ash tribe, the only leader the world offers, with no building cards, digging the kingdom's ruins; (d) a
// fallen star, knelt to: the Star-Folk found a city round their ship, and the next run can be led by their speaker.
// At each run's start: the world's description, the leaders offered, the deck, the laws in force, the record.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Pack } from '../../src/packs/check';
import { stanceOf } from '../../src/packs/load';
import { grant } from '../../src/season/ledger';
import { Table } from '../../src/table/game';

const AGES = JSON.parse(fs.readFileSync('packs/ages.json', 'utf8')) as Pack;

/** a whole run: each season the wanted cards are taken when they are on the table (rich enough to pay), the rest left */
function play(t: Table, wanted: string[]): string[] {
  const took: string[] = [];
  while (!t.over) {
    t.realm.ledger = grant(t.realm.ledger, { materials: 10, intel: 3, magic: 2 });
    for (const c of t.cards().filter((x) => wanted.includes(x.template))) if (t.take(c.id)) took.push(c.title);
    t.endSeason();
  }
  return took;
}

describe('the ages of one world', () => {
  it('peace, a crown, the wizards, ash and flame, the ash tribe, the fallen star, the Star City', () => {
    // ---- run 1 (a): the war-torn plains made a kingdom ----
    const t1 = new Table({ seed: 7, leader: 'dunstan', seasons: 16, packs: [AGES] });
    expect(Table.leaders(undefined, [AGES]).map((l) => l.id)).toEqual(['ysolt', 'dunstan', 'ilveth']);
    expect(t1.worldNow()[0]).toMatch(/^Run 1 of this world\. Master Dunstan leads\./);
    const took1 = play(t1, ['ages-peace', 'ages-crown', 'relieve-neighbour']);
    // (the base game's "Send help to Millbrook" answered too: left alone, raiders take Millbrook in season 3)
    expect(took1.filter((x) => x.startsWith('Make peace with')).length).toBe(1);
    expect(t1.realm.selectTowns('far:where:vassal').length).toBe(2);
    expect(took1).toContain('Proclaim the Kingdom of the Vale');

    // ---- run 2 (b): the court wizards; their working runs out and the world burns ----
    const world2 = t1.realm.snapshot();
    expect(Table.leaders(world2, [AGES]).map((l) => l.id)).toEqual(['ysolt', 'dunstan', 'ilveth']);
    const t2 = t1.next('ilveth');
    expect(t2.things().some((x) => x.name === 'The royal court')).toBe(true);
    const took2 = play(t2, ['ages-invite-wizards']);
    expect(took2).toContain('Invite the court wizards');
    expect(t2.realm.ended?.name).toBe('Ash and flame: the wizards woke the mountain');
    // (the wizards' gifts stacked season after season; the list says what they make together)
    const gifts = t2.laws().find((l) => l.id === 'ages-ambition');
    expect(gifts && gifts.times).toBeGreaterThan(1);
    expect(gifts!.text).toContain(`+${gifts!.times} Magic`);

    // ---- run 3 (c): the ash tribe ----
    const world3 = t2.realm.snapshot();
    expect(Table.leaders(world3, [AGES]).map((l) => l.id)).toEqual(['ages-ash-chief']);
    const t3 = t2.next('ages-ash-chief');
    const now3 = t3.worldNow();
    expect(now3[0]).toMatch(/^Run 3 of this world\. Chief Cinder leads\. Chief of the ash tribe/);
    expect(now3.some((l) => /^Run 2 ended: Ash and flame/.test(l))).toBe(true);
    expect(now3.some((l) => /2 gone/.test(l) && /Ash lies over the town\./.test(l) && /places are ruins/.test(l))).toBe(true);
    expect(now3.some((l) => l.includes('Fields under ash') && l.includes('Ash-glass in the ruins'))).toBe(true);
    // (the deck of the new age: no building cards, no kingdom cards; the ash camp in play)
    const ids3 = t3.realm.engine.templates.map((x) => x.id);
    expect(ids3).not.toContain('build:houses');
    expect(ids3).not.toContain('ages-peace');
    expect(ids3).toContain('raid');
    expect(t3.things().some((x) => x.name === 'The ash camp')).toBe(true);
    expect(t3.record().map((p) => p.lines.join(' ')).join(' ')).toMatch(/Run 2, Sister Ilveth: The wizards' great working\./);
    // ---- (d) in the same run: the fallen star ----
    const took3 = play(t3, ['ages-falling-star', 'ages-kneel', 'ages-dig-ruins']);
    expect(took3).toEqual(expect.arrayContaining(['A fire falls from the sky', 'Kneel to the angel at the Fallen Star']));
    // (one dig card for each ruin: the template fits the ruins this world has)
    expect(took3.filter((x) => x.startsWith('Dig the ruins of')).length).toBeGreaterThan(1);
    expect(stanceOf(t3.realm.w, 'ages-visitors', 'player')).toBe('allied');
    expect(t3.farNews().places.find((p) => p.name === 'the Fallen Star')!.line).toMatch(/held by the Star-Folk/);

    // ---- run 4: the Star City's speaker can lead ----
    const world4 = t3.realm.snapshot();
    expect(Table.leaders(world4, [AGES]).map((l) => l.id).sort()).toEqual(['ages-ash-chief', 'ages-star-speaker']);
    const t4 = t3.next('ages-star-speaker');
    expect(t4.worldNow()[0]).toMatch(/^Run 4 of this world\. Speaker Oru leads\./);
    // (the world ended once: run 3 was the ash tribe's own, and the Star City stands)
    expect(t4.worldNow().filter((l) => /ended: Ash and flame/.test(l)).length).toBe(1);
    expect(t4.farNews().places.find((p) => p.name === 'the Fallen Star')!.line).toMatch(/held by the Star-Folk/);
    expect(t4.laws().map((l) => l.name)).toEqual(expect.arrayContaining(["The angel's gifts", 'Fields under ash']));
    expect(t4.poolViews().find((p) => p.pool === 'magic')!.income).toBeGreaterThanOrEqual(3);
  }, 120000);
});
