// (round 128l, m4; V128-10) The follow card (follow.ts, Node): a name and a thought made from the person's number (the
// same each time), what it does and carries, its day, and plain words for every state (docs/WRITING.md).
import { describe, expect, it } from 'vitest';
import { lint } from '../../test/support/writing';
import { doingLine, FortressFollow, nameOf, personCard, thoughtOf, type Doing, type PersonFacts } from './follow';

const base: PersonFacts = { id: 14, kind: 'villager', job: 'miner', workplace: 'the quarry', doing: 'work', carrying: {}, today: ['home', 'work'], hungry: false, day: 2 };

describe('the follow card', () => {
  it('names a person from its number, the same every time', () => {
    expect(nameOf(14)).toBe(nameOf(14));
    const names = new Set(Array.from({ length: 40 }, (_, i) => nameOf(i + 1)));
    expect(names.size).toBeGreaterThan(15);
  });

  it('says who, what it does, what it carries, its day and a thought', () => {
    const c = personCard({ ...base, doing: 'haul', carrying: { stone: 2 }, today: ['home', 'work', 'haul'] });
    expect(c.title).toBe(`${nameOf(14)}, a miner`);
    expect(c.lines).toContain('Person number 14.');
    expect(c.lines).toContain('Taking goods to the stores.');
    expect(c.lines).toContain('Carrying 2 stone.');
    expect(c.lines).toContain('Today: home, work, haul.');
    expect(c.lines[c.lines.length - 1]).toMatch(/thinks: "/);
    // (the thought: from the number, the day and the state — the same again; another day, maybe another)
    expect(thoughtOf(base)).toBe(thoughtOf(base));
    const cart = personCard({ ...base, id: 3, kind: 'cart', job: null, doing: 'cart-back', carrying: { stone: 8 } });
    expect(cart.title).toBe('Cart number 3');
    expect(cart.lines).toContain('Carrying 8 stone.');
    expect(personCard({ ...base, kind: 'soldier', job: null, doing: 'wall' }).title).toBe(`${nameOf(14)}, a soldier`);
  });

  it('every line in plain words', () => {
    const doings: Doing[] = ['home', 'rest', 'idle', 'arrive', 'build-fetch', 'build-carry', 'build-work', 'to-work', 'work', 'haul', 'eat', 'fetch', 'drill', 'muster', 'march', 'wall', 'cart-park', 'cart-out', 'cart-load', 'cart-back'];
    for (const doing of doings)
      for (const kind of ['villager', 'soldier', 'cart'] as const)
        for (let id = 1; id < 8; id++)
          for (const hungry of [false, true]) {
            const c = personCard({ ...base, id, kind, doing, hungry });
            for (const l of [c.title, ...c.lines, doingLine({ ...base, doing })]) expect(lint(l), l).toEqual([]);
          }
  });

  it('a pick, Follow, and a tap elsewhere letting go', () => {
    const f = new FortressFollow();
    f.follow(true);
    expect(f.following).toBe(false);
    f.select(5);
    f.follow(true);
    expect(f.following).toBe(true);
    f.select(null);
    expect(f.following).toBe(false);
  });
});
