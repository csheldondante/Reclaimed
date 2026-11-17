// (card-table, docs/design/FACTORY.md) The factory game: goods, buildings with clicks (one a posted crew a season),
// recipes, the houses that eat, cards with exact needs, the shortest chain of clicks that covers a need.
import { describe, expect, it } from 'vitest';
import { BASE_GOODS, checkPack } from '../../src/packs/check';
import { FACTORY, factoryPack } from '../../src/season/factory';
import { FACTORY_GOODS } from '../../src/season/goods';
import { plan, type Machine } from '../../src/season/stock';
import { Table } from '../../src/table/game';

const mk = (leader = 'ysolt', cpc?: number) => new Table({ seed: 7, leader, factory: cpc ? { cpc } : true });
const T = (id: string) => `thing:factory-${id}`;
const stock = (t: Table, k: string) => t.realm.ledger.holdings.goods[k] ?? 0;

describe('the factory (draft 11)', () => {
  it('the pack checks with no errors; the validator and the game know the same goods', () => {
    const errs = checkPack(FACTORY, {}).filter((p) => p.level === 'error');
    expect(errs, JSON.stringify(errs)).toEqual([]);
    expect(FACTORY_GOODS.map((g) => g.id)).toEqual([...BASE_GOODS]);
  });

  it('a pack naming an unknown good is refused, one declaring its own good loads', () => {
    const bad = structuredClone(factoryPack()) as unknown as { cards: { cost: Record<string, number> }[]; goods?: unknown[] };
    bad.cards[0].cost = { silk: 2 };
    expect(checkPack(bad as never, {}).some((p) => p.level === 'error' && /silk/.test(p.text))).toBe(true);
    bad.goods = [{ id: 'silk', name: 'Silk', icon: '🧵' }];
    expect(checkPack(bad as never, {}).filter((p) => p.level === 'error')).toEqual([]);
  });

  it('starts with its buildings and stock, no Materials, and a board of offers from season 1', () => {
    const t = mk();
    expect(t.works().map((w) => w.id).sort()).toEqual([T('bakery'), T('fields'), T('houses'), T('woodcutters')]);
    expect(stock(t, 'wood')).toBe(4);
    expect(stock(t, 'bread')).toBe(6);
    expect(stock(t, 'materials')).toBe(0);
    expect(t.cards().some((c) => c.template === 'factory-open-quarry' || c.template === 'factory-build-sawmill')).toBe(true);
    // (the catalog's own buildings are out of the deck)
    expect(t.cards().some((c) => c.template.startsWith('build:'))).toBe(false);
  });

  it('a building converts only with a crew posted, once a crew a season, and the recipe changes the stock at once', () => {
    const t = mk();
    expect(t.use('factory-fell', T('woodcutters'))).toBe(false);
    expect(t.post('crew', T('woodcutters'))).toBe(true);
    expect(t.realm.clicks(T('woodcutters'))).toEqual({ left: 1, of: 1 });
    expect(t.use('factory-fell', T('woodcutters'))).toBe(true);
    expect(stock(t, 'wood')).toBe(7);
    expect(t.use('factory-fell', T('woodcutters'))).toBe(false);
    // (a second crew: a second click)
    expect(t.post('crew', T('woodcutters'))).toBe(true);
    expect(t.use('factory-fell', T('woodcutters'))).toBe(true);
    expect(stock(t, 'wood')).toBe(10);
  });

  it('clicks per crew is the lever', () => {
    const t = mk('ysolt', 2);
    t.post('crew', T('woodcutters'));
    expect(t.realm.clicks(T('woodcutters'))).toEqual({ left: 2, of: 2 });
  });

  it('the recipes of one building share its clicks: a choice per click; inputs are checked', () => {
    const t = mk();
    t.post('crew', T('fields'));
    expect(t.realm.uses().find((u) => u.use.id === 'factory-harvest-tools')!.short).toEqual({ tools: 1 });
    expect(t.use('factory-harvest-tools', T('fields'))).toBe(false);
    expect(t.use('factory-harvest', T('fields'))).toBe(true);
    expect(stock(t, 'grain')).toBe(7);
    t.post('crew', T('bakery'));
    expect(t.use('factory-bake', T('bakery'))).toBe(true);
    expect([stock(t, 'grain'), stock(t, 'bread')]).toEqual([5, 10]);
  });

  it('the houses eat bread each season; short, Unrest rises', () => {
    const t = mk();
    const crews = t.pieces().filter((p) => p.kind === 'crew').length;
    const eat = Math.ceil(crews / 3);
    t.endSeason();
    expect(stock(t, 'bread')).toBe(6 - eat);
    expect(t.realm.lastEaten.find((e) => e.thing === T('houses'))).toMatchObject({ hungry: false });
    for (let i = 0; i < 3; i++) t.endSeason();
    expect(t.realm.lastEaten[0].hungry).toBe(true);
    expect(t.poolViews().find((p) => p.pool === 'unrest')!.have).toBeGreaterThan(0);
  });

  it('a card names exact goods and pieces; the preview lists have and need; it can be taken once the chain is made', () => {
    const t = mk();
    const c = t.cards().find((x) => x.template === 'factory-build-sawmill');
    expect(c).toBeTruthy();
    expect(t.needOf(c!.id)).toEqual({ labor: 1, wood: 3 });
    const pv = t.preview(c!.id);
    expect(pv.goods).toEqual(expect.arrayContaining([{ k: 'wood', need: 3, have: 4 }]));
    expect(t.chain(c!.id)).toEqual([]);
    expect(t.take(c!.id)).toBe(true);
    expect(stock(t, 'wood')).toBe(1);
  });

  it('the planner finds the shortest chain across buildings, in order, or says none', () => {
    const machines: Machine[] = [
      { thing: 'mine', name: 'Mine', clicks: 2, recipes: [{ id: 'dig', name: 'Dig', cost: {}, gives: { ore: 1 }, left: 9 }] },
      { thing: 'smelter', name: 'Smelter', clicks: 1, recipes: [{ id: 'smelt', name: 'Smelt', cost: { ore: 2, wood: 1 }, gives: { iron: 1 }, left: 9 }] },
      { thing: 'smithy', name: 'Smithy', clicks: 1, recipes: [{ id: 'tools', name: 'Tools', cost: { iron: 1 }, gives: { tools: 2 }, left: 9 }, { id: 'weapons', name: 'Weapons', cost: { iron: 1, planks: 1 }, gives: { weapons: 1 }, left: 9 }] },
      { thing: 'woods', name: 'Woods', clicks: 2, recipes: [{ id: 'fell', name: 'Fell', cost: {}, gives: { wood: 2 }, left: 9 }] },
    ];
    const p = plan({ wood: 1, planks: 1 }, machines, { weapons: 1 });
    expect(p?.map((x) => x.use)).toEqual(['dig', 'dig', 'smelt', 'weapons']);
    // (the smelt eats the wood the need also wants: a fell is added)
    expect(plan({ wood: 1, planks: 1 }, machines, { weapons: 1, wood: 1 })?.length).toBe(5);
    expect(plan({ wood: 1 }, machines, { weapons: 1 })).toBeNull();
    expect(plan({ weapons: 2 }, machines, { weapons: 1 })).toEqual([]);
  });

  it('soldiers fight the raid without a keep or walls', () => {
    const t = mk();
    expect(t.realm.runNumbers().soldiers).toBeGreaterThan(0);
  });
});
