// (round 128e, FT-48) Inspect on the town that was there before the fortress: what's at a point of its plan (a building,
// its landmark, its wall) and the card's plain words.
import { describe, expect, it } from 'vitest';
import { lint } from '../../test/support/writing';
import type { CityPlan } from '../api/contracts/structures';
import { townThingAt } from '../settle/thing';
import { townCard } from './townpick';

/** two square tiles side by side (0..4 and 4..8 by 0..4), the first a 2-storey house, a wall along y = 10 */
function city(): CityPlan {
  return {
    tiles: { verts: new Float64Array([0, 0, 4, 0, 4, 4, 0, 4, 8, 0, 8, 4]), quads: new Uint32Array([0, 1, 2, 3, 1, 4, 5, 2]), use: [], block: new Int32Array(2) },
    quadBuilding: new Int32Array([0, -1]),
    buildings: [{ id: 0, kind: 'house', quads: [0], base: 0, storeys: 2, storeyH: 3, look: 0 }],
    megas: [],
    linear: [{ kind: 'wall', points: [[0, 10, 6], [20, 10, 6]], ground: [0, 0], width: 2 }],
  } as unknown as CityPlan;
}

describe('Inspect on the old town', () => {
  it('finds the building under a point, its use and storeys; the wall near a point; nothing elsewhere', () => {
    const c = city();
    const uses = new Map([['b0', 'house']]);
    expect(townThingAt(c, new Int32Array([2]), uses, [2, 2])).toEqual({ kind: 'building', use: 'house', mega: undefined, storeys: 2, tiles: 1, top: 6 });
    expect(townThingAt(c, new Int32Array([2]), uses, [6, 2])).toBeNull();
    const w = townThingAt(c, new Int32Array([2]), uses, [10, 10.5]);
    expect(w?.kind).toBe('wall');
    expect(w?.length).toBe(20);
    expect(w?.height).toBe(6);
    expect(w?.top).toBe(6);
    expect(townThingAt(c, new Int32Array([2]), uses, [10, 20])).toBeNull();
  });

  it('says what it is in plain words', () => {
    const cards = [
      townCard({ kind: 'building', use: 'house', storeys: 2, tiles: 1, top: 6 }, 'Ashford'),
      townCard({ kind: 'building', use: 'granary', storeys: 1, tiles: 3, top: 3 }, 'Ashford'),
      townCard({ kind: 'building', use: 'hall', mega: 'keep', storeys: 4, tiles: 6, top: 12 }, 'Ashford'),
      townCard({ kind: 'building', use: 'site', storeys: 0, tiles: 2, top: 0 }, 'Ashford'),
      townCard({ kind: 'building', use: 'nothing we know', storeys: 1, tiles: 1, top: 3 }, 'Ashford'),
      townCard({ kind: 'wall', length: 212.4, height: 6, top: 6 }, 'Ashford'),
    ];
    expect(cards[0]).toEqual({ title: 'House', lines: ['A home for the townsfolk.', '2 storeys high on 1 tile.', 'Part of Ashford. It was here before your fortress.'] });
    expect(cards[2].title).toBe('Keep');
    expect(cards[5].lines[1]).toBe('It runs 212 metres and stands 6 metres high.');
    for (const c of cards) for (const l of [c.title, ...c.lines]) expect(lint(l), l).toEqual([]);
  });
});
