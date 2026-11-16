// The world modifier list (src/mutate/list.ts, docs/design/MUTATORS.md): pure. An entry's numbers come from the
// atlas's ground when it is applied and are kept; the same modifier twice is one entry; places() gives the dealer who
// holds a place, what it pays and what happened to it; the record goes through JSON and back unchanged.
import { expect, test } from 'vitest';
import { WorldList, type ListWorld } from '../../src/mutate/list';
import { ROW_H } from '../../src/world/lattice';

const places = [
  { id: 'muru', name: 'Muru', at: [100, 200 * ROW_H] as const, radius: 30, size: 'town', faction: 'locals' },
  { id: 'kaud', name: 'Kaudru', at: [5000, 900 * ROW_H] as const, radius: 20, size: 'village', faction: null },
];
const world = (bias = 0): ListWorld => ({
  ground: (x, y) => 40 + bias - x * 0.01 + y * 0.002,
  sea: 10,
  place: (id) => places.find((p) => p.id === id) ?? null,
  places: () => places,
});

test('an entry keeps the numbers it was made with; the same modifier again is the same entry', () => {
  const L = new WorldList(world());
  const a = L.add({ kind: 'flooded', place: 'kaud', seed: 3 });
  expect(a.fresh).toBe(true);
  expect(a.m.cell).toEqual([5000, 900]);
  expect(a.m.radius).toBe(20);
  expect(a.m.params.length).toBe(1);
  const b = L.add({ kind: 'flooded', place: 'kaud', seed: 3 });
  expect(b.fresh).toBe(false);
  expect(b.m).toBe(a.m);
  expect(L.all.length).toBe(1);
  // (another seed is another modifier)
  expect(L.add({ kind: 'flooded', place: 'kaud', seed: 4 }).fresh).toBe(true);
  // (restored into a world whose atlas says something else, the entry's numbers are the saved ones)
  const saved = JSON.parse(JSON.stringify(L.record()));
  const L2 = new WorldList(world(100));
  L2.restore(saved);
  expect(L2.record()).toEqual(L.record());
});

test('a melt runs downhill by the atlas ground, its vent on the uphill side', () => {
  const L = new WorldList(world());
  const { m } = L.add({ kind: 'melted', at: [1000, 1000], radius: 30 });
  const [vx, , , reach, dx, dy] = m.params;
  // (the ground falls to the east: +x)
  expect(dx).toBeGreaterThan(0.9);
  expect(Math.hypot(dx, dy)).toBeCloseTo(1, 5);
  expect(vx).toBeLessThan(1000);
  expect(reach).toBeGreaterThan(30);
});

test('places(): owner, status, tribute and conditions from the list, in order', () => {
  const L = new WorldList(world());
  expect(L.place('muru')).toMatchObject({ owner: 'locals', status: 'standing', tribute: 0, population: 1, conditions: [], restless: false });
  expect(L.places()).toEqual([]);
  L.add({ kind: 'vassal', place: 'muru', by: 'player', tribute: 3 });
  // (a land mutator by area counts for the place whose centre it covers)
  L.add({ kind: 'burned', at: [105, 200], radius: 20, strength: 1 });
  const p = L.place('muru')!;
  expect(p).toMatchObject({ owner: 'player', status: 'vassal', tribute: 3, conditions: ['burned'], restless: true });
  expect(p.population).toBeCloseTo(0.5, 5);
  expect(p.history.length).toBe(2);
  L.add({ kind: 'captured', place: 'kaud', by: 'Iron League' });
  L.add({ kind: 'abandoned', place: 'kaud' });
  expect(L.place('kaud')).toMatchObject({ owner: 'Iron League', status: 'abandoned', population: 0, restless: false });
  expect(L.places().map((q) => q.id)).toEqual(['muru', 'kaud']);
});

test('a founded place is a place: it answers by its id and can be mutated by name', () => {
  const L = new WorldList(world());
  const { m } = L.add({ kind: 'founded', at: [700, 300], name: 'Deep Cut', size: 'camp', by: 'player' });
  expect(m.place).toBe('founded-700-300');
  expect(L.place(m.place!)).toMatchObject({ name: 'Deep Cut', size: 'camp', owner: 'player', status: 'founded', at: [700, 300] });
  L.add({ kind: 'destroyed', place: m.place! });
  expect(L.place(m.place!)).toMatchObject({ status: 'destroyed', population: 0 });
  expect(() => L.add({ kind: 'flooded', place: 'nowhere' })).toThrow(/no place/);
});

test('signs: on, replaced, off, ended by the season, kept in the record', () => {
  const L = new WorldList(world());
  expect(L.sign({ kind: 'ashfall', place: 'muru', strength: 0.5, until: 3 })).toMatchObject({ kind: 'ashfall', place: 'muru', strength: 0.5, until: 3, unrest: 0 });
  L.sign({ kind: 'ashfall', place: 'muru', strength: 0.8, until: 4 });
  L.sign({ kind: 'crime', place: 'muru' });
  expect(L.signs('muru').map((s) => [s.kind, s.strength])).toEqual([['ashfall', 0.8], ['crime', 1]]);
  expect(L.signs('muru').find((s) => s.kind === 'crime')!.unrest).toBe(2);
  expect(L.signs('kaud')).toEqual([]);
  const L2 = new WorldList(world());
  L2.restore(JSON.parse(JSON.stringify(L.record())));
  expect(L2.signs()).toEqual(L.signs());
  expect(L.season(4)).toBe(false);
  expect(L.season(5)).toBe(true);
  expect(L.signs().map((s) => s.kind)).toEqual(['crime']);
  expect(L.sign({ kind: 'crime', place: 'muru', strength: 0 })).toBeNull();
  expect(L.signs()).toEqual([]);
});
