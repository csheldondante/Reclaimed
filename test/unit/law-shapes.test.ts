// (card-table) Two law defects: a law in force several times says what it makes together in the Laws list (three of
// "one more foe" is three more foes, not one), and CT-37: the validator refuses the two law shapes that passed and
// then broke the rule book in play — `times` on a rule that acts, `on` a result on a rule that changes an amount.
import { describe, expect, it } from 'vitest';
import { checkPack, checkTogether, type Pack } from '../../src/packs/check';
import { lawText, stackedDoes } from '../../src/season/law-words';

const names = { rule: (id: string) => id, card: (id: string) => id };
const rulePack = (law: Record<string, unknown>, rule: Record<string, unknown>): Pack =>
  ({
    pack: { id: 'shape', name: 'Shapes', version: 1 },
    cards: [{ id: 'shape-card', title: 'A card', presenter: { role: 'clerk', at: 'site:keep' }, pitch: 'Do it.', cost: { materials: 1 }, if_taken: [{ law: 'shape-law' }, { say: 'Done.' }], if_expires: [{ say: 'Gone.' }] }],
    rules: [rule],
    laws: [{ id: 'shape-law', name: 'A law', does: law }],
  }) as unknown as Pack;
const ACTS = { id: 'shape-acts', name: 'It offers', on: { event: 'built' }, a: { tags: ['keep'] }, effect: { offer: 'shape-card' }, why: 'the keep asks again' };
const AMOUNT = { id: 'shape-amount', name: 'It adds stopped', on: { live: 'raid' }, a: { tags: ['keep'] }, effect: { amount: 'stopped', op: 'add', n: 1 }, why: 'the keep stops {n}' };

describe('law shapes', () => {
  it('a stacked law reads as the numbers it makes together', () => {
    expect(lawText(stackedDoes({ event: 'bout', foes: 1 }, 3), names)).toBe('A bout event has 3 more foes in each group of foes.');
    expect(lawText(stackedDoes({ raiders: { add: -6 } }, 2), names)).toMatch(/12/);
    expect(lawText(stackedDoes({ rule: 'r', times: 2 }, 3), names)).toMatch(/8 times as much/);
    // (a set number is the same however many times it stands)
    expect(stackedDoes({ spell: 'fire', kills: 3 }, 4)).toEqual({ spell: 'fire', kills: 3 });
  });

  it('CT-37: times on an acting rule and a result trigger on an amount rule are refused, alone and across packs', () => {
    const errs = (p: Pack) => checkPack(p).filter((x) => x.level === 'error').map((x) => x.text).join(' | ');
    expect(errs(rulePack({ rule: 'shape-acts', times: 2 }, ACTS))).toMatch(/acts \(it offers\); it has no number/);
    expect(errs(rulePack({ rule: 'shape-amount', on: { live: 'raid', tier: ['success'] } }, AMOUNT))).toMatch(/cannot change one/);
    expect(errs(rulePack({ rule: 'shape-acts', fires: 2 }, ACTS))).toBe('');
    // (the law in one pack, the rule in another: the TOGETHER check)
    const lawOnly = { ...rulePack({ rule: 'other-acts', times: 2 }, { ...ACTS, id: 'shape-own', effect: { pool: 'materials', n: 1 }, why: '+{n}' }) } as Pack;
    const other = { pack: { id: 'other', name: 'Other', version: 1 }, rules: [{ ...ACTS, id: 'other-acts', effect: { tag: 'festival', on: 'a' } }] } as unknown as Pack;
    expect(checkTogether([lawOnly, other]).some((x) => x.level === 'error' && /other-acts" acts/.test(x.text))).toBe(true);
  });
});
