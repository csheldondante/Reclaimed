// (loop round 16) What a card combines with at the moment of choice (season/combos.ts): read from the rules as they
// stand — a rule missing its second thing names the first ("With your …"), a rule missing its first with nothing
// second says it sets off; a pack card's unlock says what it opens.
import { describe, expect, it } from 'vitest';
import { combosOf } from '../../src/season/combos';
import type { Realm } from '../../src/season/realm';
import type { RuleDef, RuleMissing } from '../../src/living/rules';

function realmWith(rules: { def: RuleDef; missing: RuleMissing | null }[], things: { name: string; tags: string[] }[] = []): Realm {
  return {
    engine: { template: (id: string) => ({ id, title: id, outcome: [], outcomes: {} }) },
    things: () => things.map((t, i) => ({ id: `t${i}`, name: t.name, tags: t.tags, at: [0, 0], town: 'home' })),
    rules: { rules: rules.map((r) => r.def), check: (d: RuleDef) => { const r = rules.find((x) => x.def === d)!; return { rule: d.id, name: d.name, on: d.on, fired: 0, ok: r.missing === null, ...(r.missing ? { missing: r.missing } : {}) }; } },
    lawDef: () => null,
  } as unknown as Realm;
}

describe('combos at the moment of choice', () => {
  const trade: RuleDef = { id: 'trade', name: 'Trade at the market', on: 'turn', a: { tags: ['market', 'worked'] }, b: { tags: ['homes', 'worked'] }, effect: { pool: 'materials', n: 1 }, why: '' };
  const alone: RuleDef = { id: 'quarry', name: 'Stone sold', on: 'turn', a: { tags: ['quarry', 'worked'] }, effect: { pool: 'materials', n: 2 }, why: '' };

  it('names what the town already has that the card would combine with', () => {
    const r = realmWith([{ def: trade, missing: { kind: 'a', tags: ['market', 'worked'], closest: null } }], [{ name: 'the houses', tags: ['homes', 'worked', 'standing'] }]);
    expect(combosOf(r, 'build:market')).toEqual(['With your houses: Trade at the market: +1 Materials each season.']);
  });

  it('a rule missing its second thing names the first', () => {
    const r = realmWith([{ def: trade, missing: { kind: 'b', a: 'the market', tags: ['homes', 'worked'], closest: null } }]);
    expect(combosOf(r, 'build:houses')).toEqual(['With your market: Trade at the market: +1 Materials each season.']);
  });

  it('a one-thing rule the card fills says it sets off', () => {
    const r = realmWith([{ def: alone, missing: { kind: 'a', tags: ['quarry', 'worked'], closest: null } }]);
    expect(combosOf(r, 'build:quarry')).toEqual(['Sets off Stone sold: +2 Materials each season.']);
  });

  it('nothing for a rule already firing, or one the card does not fill', () => {
    const r = realmWith([
      { def: alone, missing: null },
      { def: trade, missing: { kind: 'a', tags: ['market', 'worked'], closest: null } },
    ]);
    expect(combosOf(r, 'build:quarry')).toEqual([]);
    expect(combosOf(r, 'build:farms')).toEqual([]);
  });

  it("a pack card's unlock is what it opens", () => {
    const r = realmWith([]);
    const played = [{ pack: { id: 'p', name: 'P' }, cards: [{ id: 'crown', title: 'Crown', if_taken: [{ unlock: 'wizards' }] }, { id: 'wizards', title: 'Invite the wizards' }] }] as never;
    expect(combosOf(r, 'crown', [], played)).toEqual(['Opens "Invite the wizards" for later.']);
  });
});
