// (card-table; PACK_FORMAT draft 7) Factions as data, stances, found places, and cards as templates. The owner: "I
// wanted opportunities like discovering a far off resource that you can make a mining colony at to get income per
// season. Or vassalizing other places or pirates! Or making a deal with pirates" and "The dealer can always generate
// cards from parameterized templates to fit the actual world." Over the test world's far towns (Millbrook, Vellford).
import { describe, expect, it } from 'vitest';
import { checkPack, type Pack } from '../../src/packs/check';
import { effectsText, findId, stanceOf } from '../../src/packs/load';
import { enumerate } from '../../src/living/engine';
import { grant } from '../../src/season/ledger';
import { HOME, Table } from '../../src/table/game';

const card = (id: string, at: string, if_taken: unknown[], extra: Record<string, unknown> = {}) => ({ id, title: id, presenter: { role: 'clerk', at }, pitch: 'Do it.', weight: 5, cost: { materials: 1 }, if_taken: [...if_taken, { say: 'Done.' }], if_expires: [{ say: 'Gone.' }], ...extra });
export const PACK: Pack = {
  pack: { id: 'fx', name: 'Factions test', version: 1 },
  factions: [
    { id: 'fx-reavers', name: 'the Gull Reavers', kind: 'pirates', text: 'Sea raiders.' },
    { id: 'fx-saltmen', name: 'the Saltmen', kind: 'town', text: 'A rival salt town.' },
  ],
  cards: [
    // (a template: one card for each standing far town that is not sworn yet)
    card('fx-swear', 'site:keep', [{ far: 'vassal', where: '$town', tribute: 2 }], { title: 'Swear {town} to you', bind: { town: { far: { state: ['standing'] } } } }),
    card('fx-scout', 'site:watch', [{ far: 'revealed', id: 'fx-redstone', name: 'Redstone', resource: 'ore' }]),
    card('fx-colony', 'site:pit', [{ far: 'founded', where: '$find', purpose: 'mining' }], { title: 'Settle {find}', bind: { find: { far: { state: ['found'] } } } }),
    card('fx-truce', 'site:harbour', [{ stance: 'fx-reavers', to: 'truce' }, { stance: 'fx-reavers', to: 'hostile', with: 'fx-saltmen' }]),
    card('fx-reavers-raid', 'site:gate', [{ far: 'captured', where: '$colony', by: 'fx-reavers' }], { title: 'The Reavers come for {colony}', bind: { colony: { far: { tags: ['colony'] } } }, appears_when: [{ faction_stance: 'fx-reavers', is: ['truce'] }] }),
  ],
  rules: [
    { id: 'fx-colony-pays', name: 'Ore from the colonies', on: 'turn', a: { tags: ['colony', 'ore', 'standing'] }, effect: { pool: 'materials', n: 2 }, per: 'a', cap: 9, why: '{count} ore colonies: +{n} Materials' },
    { id: 'fx-tribute', name: 'Tribute', on: 'turn', a: { tags: ['vassal', 'yours'] }, effect: { pool: 'materials', n: 2 }, per: 'a', cap: 9, why: '{count} sworn towns pay: +{n} Materials' },
  ],
} as unknown as Pack;

/** seasons played (rich enough to pay) until a card of the template is on the table and taken, and its season ends;
 *  [] with none: one season. Returns what was taken: "template|title" */
function play(t: Table, ids: string[], max = 6): string[] {
  const took: string[] = [];
  for (let s = 0; s < (ids.length ? max : 1); s++) {
    t.realm.ledger = grant(t.realm.ledger, { materials: 20, intel: 5 });
    for (const c of t.cards().filter((x) => ids.includes(x.template))) if (t.take(c.id)) took.push(`${c.template}|${c.title}`);
    t.endSeason();
    if (took.length) break;
  }
  return took;
}

describe('factions, stances, found places and templates (draft 7)', () => {
  it('the validator takes the pack, refuses an unbound variable and a text naming one, and says a binding nothing feeds may never match', () => {
    expect(checkPack(PACK).filter((x) => x.level === 'error')).toEqual([]);
    const unbound = { ...PACK, cards: [card('fx-bad', 'site:keep', [{ far: 'vassal', where: '$port' }], { title: 'Take {harbor}' })] } as unknown as Pack;
    const errs = checkPack(unbound).filter((x) => x.level === 'error').map((x) => x.text).join(' | ');
    expect(errs).toMatch(/"\$port" is a variable the card does not bind/);
    expect(errs).toMatch(/\{harbor\}/);
    const never = { ...PACK, cards: [card('fx-odd', 'site:keep', [{ far: 'abandoned', where: '$t' }], { bind: { t: { far: { holder: 'fx-saltmen' } } } })] } as unknown as Pack;
    expect(checkPack(never).some((x) => x.level === 'warn' && /No effect of this pack makes fx-saltmen hold a town/.test(x.text))).toBe(true);
    expect(effectsText([{ stance: 'fx-reavers', to: 'truce' } as never], PACK)).toBe('The Gull Reavers and you keep a truce.');
    expect(effectsText([{ far: 'captured', where: '$colony', by: 'fx-reavers' } as never], PACK, { colony: 'v_colony' })).toBe('{v_colony} is taken by the Gull Reavers.');
  });

  it('one template gives a card for each far town that fits; taking one swears that town, and the record keeps which', () => {
    const t = new Table({ seed: 7, leader: 'ilveth', seasons: 16, packs: [PACK] });
    const r = t.realm;
    const towns = r.selectTowns('far:all');
    const swear = r.engine.templates.find((x) => x.id === 'fx-swear')!;
    // (one binding for each far town standing; the dealer offers them one at a time at the keep)
    expect(enumerate(r.w, swear, 4, r.engine.opts.stage).ok.map((b) => b.v_town).sort()).toEqual([...towns].sort());
    // (the dealer offers one card at the keep at a time: the template has a binding for each town)
    const seen = new Set<string>();
    let sworn: string[] = [];
    for (let s = 0; s < 8; s++) {
      for (const c of t.cards().filter((x) => x.template === 'fx-swear')) seen.add(c.title);
      const c = t.cards().find((x) => x.template === 'fx-swear');
      if (c && !sworn.length) {
        t.realm.ledger = grant(t.realm.ledger, { materials: 5 });
        expect(t.take(c.id)).toBe(true);
        t.endSeason();
        sworn = r.selectTowns('far:where:vassal');
        expect(sworn.length).toBe(1);
        expect(r.things().find((x) => x.id === sworn[0])!.tags).toEqual(expect.arrayContaining(['far-town', 'vassal', 'yours']));
        expect(r.record().find((e) => e.card === 'fx-swear')!.about).toContain(sworn[0]);
        // (the sworn town no longer fits: the other still does)
        expect(enumerate(r.w, swear, 4, r.engine.opts.stage).ok.map((b) => b.v_town)).toEqual(towns.filter((x) => x !== sworn[0] && r.selectTowns('far:where:standing').includes(x)));
        t.endSeason();
        expect(t.hits.some((h) => h.hit.rule === 'fx-tribute')).toBe(true);
        continue;
      }
      t.endSeason();
    }
    expect(swear.title).toBe('Swear {v_town} to you');
    expect(sworn.length).toBe(1);
    expect([...seen].some((x) => x.includes(r.w.name(sworn[0])))).toBe(true);
  });

  it('scouts reveal a place; a colony card binds to it and settles it; the colony pays while it stands; a faction takes it and it stops', () => {
    const t = new Table({ seed: 7, leader: 'ilveth', seasons: 16, packs: [PACK] });
    const r = t.realm;
    play(t, ['fx-scout']);
    expect(r.w.facts.entity(findId('fx-redstone'))?.kind).toBe('deposit');
    expect(r.things().find((x) => x.id === findId('fx-redstone'))!.tags).toEqual(['found', 'ore']);
    const took = play(t, ['fx-colony']);
    expect(took).toContain('fx-colony|Settle Redstone');
    expect(r.w.settlement('fx-redstone')).toBeTruthy();
    expect(r.things().find((x) => x.id === 'fx-redstone')!.tags).toEqual(expect.arrayContaining(['colony', 'ore', 'standing', 'yours']));
    play(t, []);
    expect(t.hits.some((h) => h.hit.rule === 'fx-colony-pays')).toBe(true);
    // (a truce with the reavers; they then turn on the colony — the card binds to the colony there is)
    play(t, ['fx-truce']);
    expect(stanceOf(r.w, 'fx-reavers', 'player')).toBe('truce');
    expect(stanceOf(r.w, 'fx-reavers', 'fx-saltmen')).toBe('hostile');
    expect(r.things().find((x) => x.id === HOME)!.tags).toContain('fx-reavers:truce');
    const raid = play(t, ['fx-reavers-raid']);
    expect(raid).toContain('fx-reavers-raid|The Reavers come for Redstone');
    const tags = r.things().find((x) => x.id === 'fx-redstone')!.tags;
    expect(tags).toEqual(expect.arrayContaining(['occupied', 'ruined', 'fx-reavers']));
    expect(tags).not.toContain('colony');
    // (the news: who holds it, the stances, and what changed with the card that did it)
    const n = t.farNews();
    expect(n.places.find((p) => p.name === 'Redstone')!.line).toMatch(/held by the Gull Reavers/);
    expect(n.stances).toEqual(expect.arrayContaining(['The Gull Reavers and you: keep a truce.', 'The Gull Reavers and the Saltmen: enemies.']));
    expect(n.changes.some((x) => /Because of "The Reavers come for Redstone"/.test(x))).toBe(true);
  });
});
