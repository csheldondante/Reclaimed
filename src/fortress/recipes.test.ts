// (round 128l, milestone 4) The recipe runner (recipes.ts, Node, no GPU): the smith's batch of ore and wood into a
// weapon over its seconds of work, the barracks' recruit and weapon into a soldier while there's a bed, what a batch
// dropped gives back, and what a structure takes in a day for the card.
import { describe, expect, it } from 'vitest';
import { RECIPES, RecipeRunner, recipeTakes } from './recipes';

describe('the recipe runner', () => {
  it('reads the recipes from data/recipes/fortress.json', () => {
    const forge = RECIPES.find((r) => r.at === 'blacksmith')!;
    expect(forge.kind).toBe('craft');
    expect(forge.in).toEqual({ ore: 2, log: 1 });
    expect(forge.out).toEqual({ weapons: 1 });
    const drill = RECIPES.find((r) => r.at === 'barracks')!;
    expect(drill.kind).toBe('train');
    expect(drill.people).toBe(1);
  });

  it('a smith makes a weapon from ore and wood over the batch\'s seconds', () => {
    const r = new RecipeRunner();
    const forge = r.recipeAt('blacksmith')!;
    // (no ore: nothing starts)
    expect(r.start(1, 'blacksmith', 7, { log: 5 })).toBe(null);
    const took = r.start(1, 'blacksmith', 7, { ore: 3, log: 5 });
    expect(took).toEqual({ ore: 2, log: 1 });
    // (one batch a worker at a time)
    expect(r.start(1, 'blacksmith', 7, { ore: 3, log: 5 })).toBe(null);
    let out = null;
    let t = 0;
    while (!out && t < 100) {
      out = r.work(1, 0.5);
      t += 0.5;
    }
    expect(out).toEqual({ weapons: 1 });
    expect(t).toBeCloseTo(forge.seconds, 6);
    expect(r.made.get(7)).toEqual({ weapons: 1 });
    expect(r.batchOf(1)).toBe(null);
  });

  it('the barracks trains a soldier from a weapon while its beds have room', () => {
    const r = new RecipeRunner();
    expect(r.canStart('barracks', { weapons: 1 }, { units: 0, beds: 4 })).toBe(true);
    expect(r.canStart('barracks', { weapons: 0 }, { units: 0, beds: 4 })).toBe(false);
    expect(r.canStart('barracks', { weapons: 3 }, { units: 4, beds: 4 })).toBe(false);
    expect(r.canStart('barracks', { weapons: 3 })).toBe(false);
    expect(r.start(2, 'barracks', 9, { weapons: 1 }, { units: 0, beds: 4 })).toEqual({ weapons: 1 });
    expect(r.inProgress('train')).toBe(1);
    expect(r.work(2, 29)).toBe(null);
    expect(r.work(2, 1)).toEqual({ soldiers: 1 });
    expect(r.inProgress('train')).toBe(0);
  });

  it('a batch dropped gives its goods back', () => {
    const r = new RecipeRunner();
    r.start(3, 'blacksmith', 7, { ore: 2, log: 1 });
    r.work(3, 5);
    expect(r.giveBack(3)).toEqual({ ore: 2, log: 1 });
    expect(r.giveBack(3)).toBe(null);
    expect(r.stats).toEqual({ started: 1, finished: 0, givenBack: 1 });
  });

  it('what a structure takes in for what it makes (the card\'s In)', () => {
    expect(recipeTakes('blacksmith', { weapons: 6 })).toEqual({ goods: { ore: 12, log: 6 }, people: 0 });
    expect(recipeTakes('barracks', { soldiers: 2 })).toEqual({ goods: { weapons: 2 }, people: 2 });
    expect(recipeTakes('house', {})).toEqual({ goods: {}, people: 0 });
    const r = new RecipeRunner();
    expect(r.perWorkerDay('blacksmith', 60)).toEqual({ weapons: 3 });
  });
});
