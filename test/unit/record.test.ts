// (card-table; the owner: "Just keep the history of resolved cards.") The world's memory is the record of resolved and
// lapsed cards (Realm.record: one fact event a card, saved with the world) and the things cards put in play, standing
// or in remains. Run 1 raises the glitter spire and lets it overload: an ending card ends the run, burns the tower and
// leaves a law for every later run. Run 2, a new leader in the same world: the record is listed, the law stands from
// season 1, the salvage card comes up only because of the spire's remains, and its hoverbikes carry the knights.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Pack } from '../../src/packs/check';
import { thingEntity } from '../../src/packs/load';
import { grant } from '../../src/season/ledger';
import { Table } from '../../src/table/game';

const GLITTER = JSON.parse(fs.readFileSync('packs/glitter.json', 'utf8')) as Pack;
const OPTS = { seed: 7, leader: 'ilveth', seasons: 16, packs: [GLITTER] };
const rich = (t: Table) => (t.realm.ledger = grant(t.realm.ledger, { magic: 10, materials: 20 }));

describe('the record of resolved cards, across runs', () => {
  // (run 1: raise the spire, then leave the overload to run out)
  const t = new Table(OPTS);
  for (let i = 0; i < 15 && !t.over; i++) {
    rich(t);
    const spire = t.cards().find((c) => c.template === 'glitter-raise-the-spire');
    if (spire && !Object.keys(spire.short).length) t.take(spire.id);
    t.endSeason();
  }

  it('run 1 ends by the ending card: an instant loss, said on the end screen', () => {
    expect(t.over).toBe(true);
    expect(t.result?.title).toBe('The run is lost: The glitter spire burned the valley to glass.');
    expect(t.result?.lines).toEqual(['It was ended by "The spire hums too loud".']);
    const lines = t.record().flatMap((p) => p.lines);
    expect(lines).toContain('Run 1, Sister Ilveth: Raise the glitter spire. Done.');
    expect(lines).toContain('Run 1, Sister Ilveth: The spire hums too loud. Left to run out.');
  });

  it('run 2, a new leader in the same world: the record, the law it left, the card found only on the ruins, the knights on hoverbikes; saved and taken up across the boundary', () => {
    const u = t.next('dunstan');
    expect(u.run).toBe(2);
    // (the record is the world's: it is listed in the next run, and the remains stand)
    expect(u.record().flatMap((p) => p.lines)).toContain('Run 1, Sister Ilveth: The spire hums too loud. Left to run out.');
    const spire = u.realm.things().find((x) => x.id === thingEntity('glitter-spire'))!;
    expect(spire.tags).toEqual(expect.arrayContaining(['ruined', 'remains-of-glitter-tech']));
    // (the law the ending left: in force from season 1)
    expect(u.laws()).toEqual([expect.objectContaining({ name: 'The glass sky', from: '"The spire hums too loud" (run 1)', until: 'In every run after the one that made it.' })]);
    // (Master Dunstan's own +1 Magic a season, and the glass sky's +1)
    expect(u.poolViews().find((p) => p.pool === 'magic')!.income).toBe(2);
    // (saved in run 2 and taken up: the same laws and the same record)
    const v = new Table({ ...OPTS, leader: 'dunstan', resume: u.save() });
    expect(v.laws()).toEqual(u.laws());
    expect(v.record()).toEqual(u.record());
    // (the salvage card, there only because of the remains; and a card there because of a card done in run 1)
    let salvage = u.cards().find((c) => c.template === 'glitter-salvage-hoverbikes');
    for (let i = 0; i < 6 && !salvage; i++) {
      u.endSeason();
      salvage = u.cards().find((c) => c.template === 'glitter-salvage-hoverbikes');
    }
    expect(salvage?.because).toBe('Here because of what came before: the remains of Glitter spire.');
    const seekers = [...u.cards(), ...v.cards()].find((c) => c.template === 'glitter-glass-seekers');
    if (seekers) expect(seekers.because).toBe('Here because of what came before: "Raise the glitter spire" in run 1, under Sister Ilveth.');
    rich(u);
    expect(u.take(salvage!.id)).toBe(true);
    u.endSeason();
    expect(u.realm.w.facts.entity(thingEntity('glitter-hoverbikes'))).toBeTruthy();
    // (hoverbikes and a garrison: the knights' rule fires — an ordinary rule on ordinary tags)
    u.realm.ledger = { ...u.realm.ledger, built: [...u.realm.ledger.built, 'walls', 'keep'] };
    u.endSeason();
    expect(u.hits.some((h) => h.hit.rule === 'glitter-sky-knights')).toBe(true);
    // (the glass-seekers came too, because the spire was raised in run 1; never in run 1 itself)
    expect(seekers).toBeDefined();
    expect(t.seen.has('glitter-glass-seekers')).toBe(false);
  });
});
