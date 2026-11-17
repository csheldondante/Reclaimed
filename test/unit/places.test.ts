// (card-table; the owner: "We have a whole world map. Can't we just add effects like darkness or add or delete towns or
// make trade routes via policies?") Place selectors over the test world's far towns (Millbrook, Vellford): nearest
// first, every far town, the n nearest, by state, the whole world; signs anywhere; a card whose selector names nothing
// does not appear; a trade route carried by a policy thing; the words a card shows.
import { describe, expect, it } from 'vitest';
import { checkPack, type Pack } from '../../src/packs/check';
import { effectsText } from '../../src/packs/load';
import { grant } from '../../src/season/ledger';
import { HOME, Table } from '../../src/table/game';

const card = (id: string, at: string, if_taken: unknown[], extra: Record<string, unknown> = {}) => ({ id, title: id, presenter: { role: 'clerk', at }, pitch: 'Do it.', weight: 5, cost: { materials: 1 }, if_taken: [...if_taken, { say: 'Done.' }], if_expires: [{ say: 'Gone.' }], ...extra });
const WORLD: Pack = {
  pack: { id: 'wide', name: 'The wide world', version: 1 },
  tags: [{ id: 'caravans', on: 'site', meaning: 'Caravans set out from here.', timed: false }],
  things: [{ id: 'wide-charter', name: 'Caravan charter', kind: 'policy', at: 'site:road', tags: ['caravans'], trade: 'far:all', text: 'Caravans go to every town.' }],
  cards: [
    card('wide-darkness', 'site:tower', [{ sign: 'darkness', where: 'far:all', seasons: 3 }]),
    card('wide-empty-nearest', 'site:gate', [{ far: 'abandoned', where: 'far:nearest:1' }]),
    card('wide-charter-card', 'site:road', [{ put: 'wide-charter', at: 'site:road' }]),
    card('wide-vassals-darken', 'site:shrine', [{ sign: 'darkness', where: 'far:where:vassal', seasons: 2 }]),
  ],
  rules: [{ id: 'wide-caravan-pay', name: 'Caravans pay', on: 'turn', a: { tags: ['trade-partner', 'standing'] }, effect: { pool: 'materials', n: 1 }, per: 'a', cap: 9, why: '{count} towns trade with you: +{n} Materials' }],
} as unknown as Pack;

describe('place selectors over the world map', () => {
  it('the validator takes the selectors and refuses an unknown one; the words say every town', () => {
    expect(checkPack(WORLD).filter((x) => x.level === 'error')).toEqual([]);
    const bad = { ...WORLD, cards: [card('wide-bad', 'site:tower', [{ sign: 'darkness', where: 'far:somewhere' }])] } as unknown as Pack;
    expect(checkPack(bad).some((x) => x.level === 'error' && /Unknown far place "far:somewhere"/.test(x.text))).toBe(true);
    expect(effectsText([{ sign: 'darkness', where: 'far:all', seasons: 3 } as never], WORLD)).toBe('Darkness falls over every far town for 3 seasons.');
    expect(effectsText([{ sign: 'darkness', where: 'world', seasons: 3 } as never], WORLD)).toBe('Darkness falls over every town, yours too for 3 seasons.');
    expect(effectsText([{ far: 'abandoned', where: 'far:nearest:2' } as never], WORLD)).toBe('Each of the 2 nearest standing towns is abandoned.');
  });

  it('selectors name towns nearest first; a card whose selector names nothing does not appear; effects reach every town named; a policy carries a trade route', () => {
    const t = new Table({ seed: 7, leader: 'ilveth', seasons: 16, packs: [WORLD] });
    const r = t.realm;
    const all = r.selectTowns('far:all');
    expect(all.length).toBe(2);
    expect(r.selectTowns('world')).toEqual([HOME, ...all]);
    expect(r.selectTowns('far:nearest:1')).toEqual([all[0]]);
    expect(r.selectTowns('far:neighbour')).toEqual([all[0]]);
    expect(r.selectTowns('far:where:standing')).toEqual(all);
    expect(r.selectTowns('far:where:vassal')).toEqual([]);
    const taken = new Set<string>();
    for (let s = 0; s < 6; s++) {
      t.realm.ledger = grant(t.realm.ledger, { materials: 20 });
      for (const c of t.cards().filter((x) => x.template.startsWith('wide-') && !taken.has(x.template))) if (t.take(c.id)) taken.add(c.template);
      t.endSeason();
    }
    // (no vassal: the card that darkens vassals never came up)
    expect(t.seen.has('wide-vassals-darken')).toBe(false);
    expect([...taken].sort()).toEqual(['wide-charter-card', 'wide-darkness', 'wide-empty-nearest']);
    // (the nearest town is abandoned, and only it; the other became the neighbour and the base raid arc took it)
    expect(r.selectTowns('far:where:abandoned')).toEqual([all[0]]);
    expect(r.selectTowns('far:where:occupied')).toEqual([all[1]]);
    // (the charter: every far town is a trade partner while it stands, tagged so; the caravan rule reads the tag)
    expect(r.partners().map((p) => p.id).sort()).toEqual([...all].sort());
    expect(r.things().find((x) => x.id === all[1])!.tags).toContain('trade-partner');
    expect(t.hits.some((h) => h.hit.rule === 'wide-caravan-pay')).toBe(true);
  });
});
