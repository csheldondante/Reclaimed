// (card-table: laws; docs/design/LAWS.md) Laws: each kind applied over the base definitions, in the order they came
// into force; a law that leaves with its thing (gone, or ruined); save and load keeping the order; the table's views
// (the Laws list, a card's preview, the Rules list marks); and packs/laws.json played on the Realm.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyTags, cardTerms, deriveRules, liveLaw, raidersOf, resultAlso, shiftTier, spellMech, wonBy, type LawDef, type LawDo } from '../../src/living/laws';
import type { LiveDef } from '../../src/living/live';
import { RuleBook, type RuleDef, type Thing } from '../../src/living/rules';
import { checkPack, checkTogether, type Pack } from '../../src/packs/check';
import { thingEntity } from '../../src/packs/load';
import { grant } from '../../src/season/ledger';
import { siteId } from '../../src/season/realm-templates';
import { HOME, Table } from '../../src/table/game';

const LAWS = JSON.parse(fs.readFileSync('packs/laws.json', 'utf8')) as Pack;
const law = (id: string, does: LawDo, name = id): LawDef => ({ id, name, does });
const thing = (id: string, tags: string[]): Thing => ({ id, name: id, tags, at: [0, 0], town: 'h' });
const rune: RuleDef = { id: 'blessed-fields', name: 'Rune-fed fields', on: 'turn', a: { tags: ['field', 'worked', 'growth-active'] }, effect: { pool: 'materials', n: 2 }, cap: 2, perSeason: 1, why: '+{n}' };
const drums: RuleDef = { id: 'drums', name: 'Drums', on: { live: 'parade' }, a: { tags: ['pit'] }, effect: { amount: 'crowd', op: 'mul', n: 2 }, why: '{n}' };

describe('laws, kind by kind (pure)', () => {
  it('tags: a tag counts as another, a tag granted to every match, in order; a ruined thing is given nothing', () => {
    const things = [thing('f', ['field', 'worked']), thing('s', ['temple']), thing('r', ['ruined', 'burned'])];
    const out = applyTags(things, [law('a', { count_as: { tag: 'field', as: 'temple' } }), law('b', { count_as: { tag: 'temple', as: 'holy' } }), law('c', { grant: 'blessed', to: { tags: [] } })]);
    expect(out[0].tags).toEqual(['field', 'worked', 'temple', 'holy', 'blessed']);
    expect(out[1].tags).toEqual(['temple', 'holy', 'blessed']);
    expect(out[2].tags).toEqual(['ruined', 'burned']);
    // (order: temple → holy first, then field → temple: the field is not holy)
    const rev = applyTags(things, [law('b', { count_as: { tag: 'temple', as: 'holy' } }), law('a', { count_as: { tag: 'field', as: 'temple' } })]);
    expect(rev[0].tags).toEqual(['field', 'worked', 'temple']);
  });
  it('rules: numbers set and multiplied in order, turned off, made to fire twice, added; the meta factor doubles every multiplier', () => {
    const d = deriveRules([rune, drums], [law('t', { rule: 'blessed-fields', times: 2 }, 'Deep runes')]);
    expect(d.rules[0].effect).toEqual({ pool: 'materials', n: 4 });
    expect(d.rules[0].cap).toBe(4);
    expect(d.changed).toEqual({ 'blessed-fields': ['Deep runes'] });
    // (order matters: set then times is 6; times then set is 3)
    expect((deriveRules([rune], [law('s', { rule: 'blessed-fields', set: { n: 3, cap: null } }), law('t', { rule: 'blessed-fields', times: 2 })]).rules[0].effect as { n: number }).n).toBe(6);
    expect((deriveRules([rune], [law('t', { rule: 'blessed-fields', times: 2 }), law('s', { rule: 'blessed-fields', set: { n: 3 } })]).rules[0].effect as { n: number }).n).toBe(3);
    const off = deriveRules([rune, drums], [law('o', { rule: 'drums', off: true }, 'No drums')]);
    expect(off.rules.map((r) => r.id)).toEqual(['blessed-fields']);
    expect(off.off).toEqual({ drums: 'No drums' });
    expect(deriveRules([rune], [law('f', { rule: 'blessed-fields', fires: 2 })]).rules[0].fires).toBe(2);
    const added = deriveRules([rune], [law('a', { add_rule: { ...rune, id: 'new', name: 'New' } }, 'Adds')]);
    expect(added.rules.map((r) => r.id)).toEqual(['blessed-fields', 'new']);
    // (meta: a times of 2 becomes 4, a rule's mul of 2 becomes 4 — whenever the meta law came)
    const meta = deriveRules([rune, drums], [law('t', { rule: 'blessed-fields', times: 2 }), law('m', { multipliers: 2 }, 'Madness')]);
    expect(meta.rules[0].effect).toEqual({ pool: 'materials', n: 8 });
    expect(meta.rules[1].effect).toEqual({ amount: 'crowd', op: 'mul', n: 4 });
    expect(meta.changed.drums).toEqual(['Madness']);
    // (the base list is not changed)
    expect(rune.effect).toEqual({ pool: 'materials', n: 2 });
  });
  it('a rule that fires twice pays twice on one trigger, each a firing', () => {
    const pool: Record<string, number> = {};
    const book = new RuleBook([{ ...rune, fires: 2, perSeason: undefined }], { things: () => [thing('f', ['field', 'worked', 'growth-active'])], pool: () => 0, gain: (k, n) => ((pool[k] = (pool[k] ?? 0) + n), n) });
    book.season(1);
    expect(book.fire({ on: 'turn' }).map((h) => h.delta)).toEqual([2, 2]);
    expect(pool.materials).toBe(4);
    expect(book.fired('blessed-fields')).toBe(2);
  });
  it('the rule book reads a derived list: a law in force changes what fires, and a list that changes is checked', () => {
    let laws: LawDef[] = [];
    let view = deriveRules([rune], laws).rules;
    const book = new RuleBook(() => view, { things: () => [thing('f', ['field', 'worked', 'growth-active'])], pool: () => 0, gain: (_k, n) => n });
    book.season(1);
    expect(book.preview({ on: 'turn' })[0].delta).toBe(2);
    laws = [law('t', { rule: 'blessed-fields', times: 3 })];
    view = deriveRules([rune], laws).rules;
    expect(book.preview({ on: 'turn' })[0].delta).toBe(6);
    view = [rune, rune];
    expect(() => book.rules).toThrow(/twice/);
  });
  it('cards: cost by pool and by theme, a part paid from another pool, build time; never below 0, at least 1 season', () => {
    const card = { id: 'build:mill', themes: ['town', 'build'] };
    const printed = { locks: { labor: 2 }, costs: { materials: 3 }, turns: 2 };
    const t = cardTerms(card, printed, [law('c', { cost: { materials: -1 }, cards: { themes: ['build'] } }), law('p', { pay: { labor: 'magic' } }), law('b', { build: -5 })]);
    expect(t).toEqual({ locks: {}, costs: { materials: 2, magic: 2 }, turns: 1 });
    expect(cardTerms({ id: 'x', themes: ['war'] }, printed, [law('c', { cost: { materials: -9 }, cards: { themes: ['build'] } })])).toEqual(printed);
    expect(cardTerms(card, printed, [law('c', { cost: { materials: -9 } })]).costs).toEqual({});
  });
  it('spells and events: a cast\'s number set, spells allowed, foes added, results shifted, a result that counts as another', () => {
    expect(spellMech({ fire: { kills: 1 } }, [law('k', { spell: 'fire', kills: 3 })])).toEqual({ fire: { kills: 3 } });
    const bout: LiveDef = { tag: 'bout', title: 'Bout', how: '', line: '', groups: [{ id: 'g0', kind: 'raider', side: 'foe', n: 2, tags: ['challenger'], from: { site: 'here' } }], camera: { zoom: 1 }, spells: ['fire'], ends: [], result: [], tiers: [{ tier: 'success', when: [['x', '<=', 1]] }, { tier: 'failure' }] };
    const more = liveLaw(bout, [law('f', { event: 'bout', foes: 1 }), law('f2', { event: 'bout', foes: 1 }), law('a', { event: 'bout', allow: ['rain'] })]);
    expect(more.groups[0].n).toBe(4);
    expect(more.spells).toEqual(['fire', 'rain']);
    expect(bout.groups[0].n).toBe(2);
    expect(shiftTier(bout, 'failure', [law('s', { event: 'bout', shift: 1 })])).toBe('success');
    expect(shiftTier(bout, 'success', [law('s', { event: 'bout', shift: 1 })])).toBe('success');
    expect(resultAlso('parade', 'failure', [law('r', { event: 'parade', tier: ['failure'], counts_as: { live: 'riot', tier: ['success'] } })])).toEqual([{ live: 'riot', tier: ['success'] }]);
    expect(resultAlso('parade', 'success', [law('r', { event: 'parade', tier: ['failure'], counts_as: { live: 'riot', tier: ['success'] } })])).toEqual([]);
  });
  it('the run: raiders added and multiplied (the meta factor too), a way to win', () => {
    expect(raidersOf(18, [law('a', { raiders: { add: -4 } }), law('t', { raiders: { times: 0.5 } })])).toBe(7);
    expect(raidersOf(18, [law('t', { raiders: { times: 0.5 } }), law('m', { multipliers: 2 })])).toBe(18);
    const w = [law('w', { win: { count: 2, tags: ['temple'] } }, 'Pilgrims')];
    expect(wonBy([thing('a', ['temple'])], w)).toBeNull();
    expect(wonBy([thing('a', ['temple']), thing('b', ['temple'])], w)).toMatchObject({ law: 'Pilgrims', count: 2 });
  });
});

describe('packs/laws.json on the Realm', () => {
  const OPTS = { seed: 7, leader: 'ilveth', seasons: 16, packs: [LAWS] };
  const rich = (t: Table) => (t.realm.ledger = grant(t.realm.ledger, { magic: 20, materials: 30, intel: 5 }));
  /** end seasons until the card is offered, then take it (rich enough to pay) */
  const takeWhenOffered = (t: Table, template: string, max = 10): boolean => {
    for (let i = 0; i < max; i++) {
      rich(t);
      const c = t.cards().find((x) => x.template === template);
      if (c && !Object.keys(c.short).length) return t.take(c.id);
      t.endSeason();
    }
    return false;
  };

  it('the pack passes the validator; a law nobody brings is looked at; a law naming a missing law is refused', () => {
    expect(checkPack(LAWS).filter((x) => x.level === 'error')).toEqual([]);
    const lonely = { ...LAWS, laws: [...LAWS.laws!, { id: 'laws-lonely', name: 'Lonely', does: { board: 1 } }] };
    expect(checkPack(lonely).some((x) => x.where === 'laws (laws-lonely)' && /Nothing brings/.test(x.text))).toBe(true);
    const bad = { ...LAWS, cards: [{ ...LAWS.cards![0], if_taken: [{ law: 'laws-none' }, { say: 'x' }] }, ...LAWS.cards!.slice(1)] };
    expect(checkPack(bad).some((x) => x.level === 'error' && /laws-none/.test(x.text))).toBe(true);
    const shape = { ...LAWS, laws: [...LAWS.laws!, { id: 'laws-two', name: 'Two', does: { board: 1, income: { materials: 1 } } }] };
    expect(checkPack(shape).some((x) => x.level === 'error' && /exactly one/.test(x.text))).toBe(true);
    // (a rule law on a rule nobody has: a LOOK alone, refused in the set)
    const other = { ...LAWS, laws: [...LAWS.laws!, { id: 'laws-ghost', name: 'Ghost', does: { rule: 'nobody-rule', times: 2 } }] };
    expect(checkPack(other).some((x) => x.level === 'warn' && /nobody-rule/.test(x.text))).toBe(true);
    expect(checkTogether([other]).some((x) => x.level === 'error' && /nobody-rule/.test(x.text))).toBe(true);
    const zero = { ...LAWS, laws: [...LAWS.laws!, { id: 'laws-zero', name: 'Zero', does: { rule: 'blessed-fields', set: { n: 0 } } }] };
    expect(checkPack(zero).some((x) => x.level === 'error' && /cannot be 0/.test(x.text))).toBe(true);
  });

  it('a tag law from a card: the fields count as temples, the Laws list says who made it; the card preview said so first', () => {
    const t = new Table(OPTS);
    rich(t);
    let card = t.cards().find((x) => x.template === 'laws-holy-furrows');
    for (let i = 0; i < 6 && !card; i++) {
      t.endSeason();
      rich(t);
      card = t.cards().find((x) => x.template === 'laws-holy-furrows');
    }
    expect(card).toBeDefined();
    expect(card!.laws.brings[0]).toMatch(/^Holy furrows\. Whatever is "field" also counts as "temple"\./);
    expect(card!.laws.changes).toContain('"temple". Now: 1 thing. With it: 2 things.');
    t.take(card!.id);
    // (a card's effects apply when its build is done: at the season's end)
    expect(t.laws()).toEqual([]);
    t.endSeason();
    const fields = t.realm.things().find((x) => x.id === siteId(HOME, 'fields'))!;
    expect(fields.tags).toContain('temple');
    expect(t.laws()).toEqual([expect.objectContaining({ name: 'Holy furrows', kind: 'tags', from: '"Bless the furrows"', until: 'For the rest of the run.' })]);
    expect(t.realm.history().some((e) => e.kind === 'law-made')).toBe(true);
  });

  it('a thing carries laws: rule laws in force while it stands, the Rules list marks the rule, gone when the place is ruined, back when a law spares the ruin', () => {
    const t = new Table(OPTS);
    for (let i = 0; i < 8 && !t.cards().some((c) => c.template === 'laws-rune-charter'); i++) t.endSeason();
    // (the card's preview: the laws its thing brings, and the rule's numbers before and after)
    const card = t.cards().find((c) => c.template === 'laws-rune-charter')!;
    expect(card.laws.brings.map((l) => l.split('.')[0])).toEqual(['Deep runes', 'Runes that sing twice', 'Ash on the furrows']);
    expect(card.laws.changes).toContain('Rune-fed fields. Now: Gives +2 Materials, at most 2. With it: Gives +4 Materials, at most 4. It pays 2 times each time it fires.');
    expect(takeWhenOffered(t, 'laws-rune-charter')).toBe(true);
    // (the stones are put when the build is done: a season later)
    for (let i = 0; i < 3 && !t.realm.w.facts.entity(thingEntity('laws-rune-stones')); i++) t.endSeason();
    expect(t.laws().map((l) => l.name)).toEqual(['Deep runes', 'Runes that sing twice', 'Ash on the furrows']);
    expect(t.laws()[0]).toMatchObject({ from: 'Rune stones', until: 'While Rune stones stands.' });
    const rule = t.rules().find((r) => r.id === 'blessed-fields')!;
    expect(rule.laws).toEqual(['Deep runes', 'Runes that sing twice']);
    expect(rule.says).toMatch(/Gives \+4 Materials, at most 4\. It pays 2 times each time it fires\./);
    // (the fields burn: the stones are ruined, their laws leave)
    const fields = siteId(HOME, 'fields');
    t.realm.w.facts.setTag(fields, 'condition', 'burned', true, 'test');
    t.realm.refreshLaws();
    expect(t.laws()).toEqual([]);
    expect(t.rules().find((r) => r.id === 'blessed-fields')!.laws).toEqual([]);
    // (a law that spares the burn: the stones stand again, and their laws come back after it)
    t.realm.enact('laws-burned-still-yields', 'a test');
    t.realm.refreshLaws();
    expect(t.laws().map((l) => l.name)).toEqual(['Ash feeds the soil', 'Deep runes', 'Runes that sing twice', 'Ash on the furrows']);
    expect(t.realm.things().find((x) => x.id === fields)!.tags).toEqual(expect.arrayContaining(['field', 'standing', 'burned', 'rune-stones']));
    // (the thing taken out of play: its laws go with it)
    t.realm.w.facts.remove(thingEntity('laws-rune-stones'), 'test');
    t.realm.refreshLaws();
    expect(t.laws().map((l) => l.name)).toEqual(['Ash feeds the soil']);
  });

  it('card laws: building costs 1 Materials less and Magic stands in for Labor, shown with the printed cost, and paid that way', () => {
    const t = new Table(OPTS);
    expect(takeWhenOffered(t, 'laws-guild-rates')).toBe(true);
    for (let i = 0; i < 3 && !t.laws().length; i++) t.endSeason();
    expect(t.laws().map((l) => l.name)).toEqual(['Guild rates', 'Hands of light']);
    rich(t);
    let build = t.cards().find((c) => c.tags.includes('build') && c.printed);
    for (let i = 0; i < 6 && !build; i++) {
      t.endSeason();
      rich(t);
      build = t.cards().find((c) => c.tags.includes('build') && c.printed);
    }
    expect(build).toBeDefined();
    expect(build!.locks.labor).toBeUndefined();
    expect(build!.printed).not.toBe(build!.cost);
    const before = t.realm.ledger;
    const magic = build!.costs.magic ?? 0;
    expect(magic).toBeGreaterThan(0);
    t.take(build!.id);
    // (no worker is locked: the Labor part was paid in Magic)
    const o = t.realm.engine.offers.find((x) => x.id === build!.id)!;
    expect(o.commitment!.agents.filter((id) => t.realm.ledger.holdings.agents.find((a) => a.id === id)?.kind === 'workers')).toEqual([]);
    expect(o.commitment!.spent).toEqual(build!.costs);
    expect(t.poolViews().find((p) => p.pool === 'magic')!.have).toBe((before.holdings.goods.magic ?? 0) - magic);
  });

  it('timed laws end; meta: the next law lasts the run; save and load keep the laws and their order', () => {
    const t = new Table(OPTS);
    const r = t.realm;
    r.enact('laws-fire-burns-hot', 'a test', 1);
    r.enact('laws-next-for-good', 'a test');
    r.enact('laws-open-market', 'a test', 1);
    r.enact('laws-everything-doubles', 'a test');
    expect(t.laws().map((l) => [l.name, l.until])).toEqual([
      ["Priests' fire", 'For 1 season after this one.'],
      ['Open market days', 'For the rest of the run.'],
      ["The abbot's madness", 'For the rest of the run.'],
    ]);
    expect(t.laws()[1].from).toBe('a test (Written in stone)');
    const saved = t.save();
    const u = new Table({ ...OPTS, resume: saved });
    expect(u.laws()).toEqual(t.laws());
    expect(u.realm.runState().laws).toEqual(r.runState().laws);
    u.endSeason();
    u.endSeason();
    expect(u.laws().map((l) => l.name)).toEqual(['Open market days', "The abbot's madness"]);
    // (a new run: no law outlives the run)
    const next = u.next('ilveth');
    expect(next.laws()).toEqual([]);
  });

  it('spell, event and run laws on a live event: Fire puts down 3, a raid with 4 fewer raiders, Unrest counts as Might', () => {
    const t = new Table(OPTS);
    const r = t.realm;
    r.enact('laws-fire-burns-hot', 'a test');
    expect(t.abilities().find((a) => a.id === 'spell:fire')!.text).toBe('Cast it into an event. It puts down 3 foes.');
    r.raid = 18;
    expect(r.runNumbers().raid).toBe(18);
    r.enact('laws-blessed-walls', 'a test');
    expect(r.runNumbers().raid).toBe(14);
    r.enact('laws-everything-doubles', 'a test');
    expect(r.runNumbers().raid).toBe(14);
    r.raid = null;
  });

  it('the two engines that break the game: runes doubled by the abbot pay sixteen a season; holy ground everywhere wins the run', () => {
    const t = new Table(OPTS);
    const r = t.realm;
    r.ledger = { ...r.ledger, built: [...r.ledger.built, 'farms', 'houses', 'market', 'workshops', 'keep'] };
    r.enact('laws-runes-double', 'a test');
    r.enact('laws-runes-twice', 'a test');
    r.enact('laws-everything-doubles', 'the abbot');
    const rule = r.rules.rules.find((x) => x.id === 'blessed-fields')!;
    expect(rule.effect).toEqual({ pool: 'materials', n: 8 });
    expect(rule.fires).toBe(2);
    rich(t);
    expect(r.cast('growth', 'fields')).toBe(true);
    const before = t.poolViews().find((p) => p.pool === 'materials')!.have;
    t.endSeason();
    const paid = t.hits.filter((h) => h.hit.rule === 'blessed-fields').reduce((n, h) => n + h.hit.delta, 0);
    // (2 Materials, times 2 by the runes, times 2 by the abbot, paid twice: 16; other rules cost what they cost)
    expect(paid).toBe(16);
    expect(t.poolViews().find((p) => p.pool === 'materials')!.have).toBeGreaterThan(before);
    // (holy ground: fields count as temples, every worked place is a temple, the pilgrims' law wins at 6)
    r.enact('laws-fields-are-temples', 'a test');
    r.enact('laws-every-hearth', 'a test');
    expect(t.over).toBe(false);
    r.enact('laws-pilgrim-victory', 'a test');
    expect(r.things().filter((x) => x.tags.includes('temple')).length).toBeGreaterThanOrEqual(6);
    expect(r.won()).toMatchObject({ law: 'The pilgrim road', count: 6 });
    expect(t.over).toBe(true);
  });
});
