// The world between runs (api/contracts/world-state.ts, MemoryWorldState — the WorldState contract's reference
// implementation): events applied in order, clamped, kept in the history; listeners told; a snapshot restores to the
// same world.
import { describe, expect, test } from 'vitest';
import { MemoryWorldState } from '../../src/api/contracts/world-state';
import { freshRegion, lakeFlood, type AtlasEvent, type Faction, type Lake } from '../../src/api/contracts/world';
import type { RunRecord } from '../../src/api/contracts/run';

let n = 0;
const ev = (kind: AtlasEvent['kind'], regions: number[], magnitude: number, extra: Partial<AtlasEvent> = {}): AtlasEvent => ({
  id: `e${n++}`,
  kind,
  regions,
  magnitude,
  run: 0,
  cause: { by: 'story' },
  ...extra,
});

const NAMES = [
  { id: 1, name: 'Ashvale', kind: 'valley' },
  { id: 2, name: 'Greywater', kind: 'marsh' },
];
const FACTIONS: Faction[] = [{ id: 'iron', name: 'The Iron Choir', ethos: 'order', era: 'industrial', attitude: 0, relations: {} }];

describe('apply', () => {
  test('a region nothing happened to is fresh', () => {
    expect(new MemoryWorldState(7).region(5)).toEqual(freshRegion());
  });

  test('the 0..1 fields add and clamp; their opposites take away', () => {
    const w = new MemoryWorldState(1);
    w.apply(ev('sink', [1], 0.7));
    w.apply(ev('sink', [1], 0.7));
    expect(w.region(1).sunk).toBe(1);
    w.apply(ev('raise', [1], 0.4));
    expect(w.region(1).sunk).toBeCloseTo(0.6);
    w.apply(ev('raise', [1], 5));
    expect(w.region(1).sunk).toBe(0);
    for (const [up, down, key] of [
      ['overgrow', null, 'overgrowth'],
      ['freeze', 'thaw', 'frozen'],
      ['shadow', 'light', 'shadow'],
      ['raise-dead', 'lay-dead', 'undead'],
      ['ruin', 'rebuild', 'ruin'],
    ] as const) {
      w.apply(ev(up, [2], 3));
      expect(w.region(2)[key]).toBe(1);
      if (down) {
        w.apply(ev(down, [2], 3));
        expect(w.region(2)[key]).toBe(0);
      }
    }
  });

  test('bury adds depth (not clamped) and keeps or changes the material', () => {
    const w = new MemoryWorldState(1);
    w.apply(ev('bury', [1], 3));
    w.apply(ev('bury', [1], 4, { detail: { material: 'sand' } }));
    expect(w.region(1).buried).toEqual({ depth: 7, material: 'sand' });
  });

  test('a flood needs its level and keeps the highest; drain clears it', () => {
    const w = new MemoryWorldState(1);
    expect(() => w.apply(ev('flood', [1], 1))).toThrow(/level/);
    w.apply(ev('flood', [1], 1, { level: 30 }));
    w.apply(ev('flood', [1], 1, { level: 20 }));
    expect(w.region(1).flooded).toBe(30);
    w.apply(ev('drain', [1], 1));
    expect(w.region(1).flooded).toBeNull();
  });

  test('a lake is the flood of its regions at its level', () => {
    const w = new MemoryWorldState(1);
    const lake: Lake = { id: 3, name: 'Mere', level: 14, at: [0, 0], outlet: [1, 1], area: 16, depth: 2, regions: [1, 2], inflow: 1, outflow: true };
    w.apply(lakeFlood(lake, 0));
    expect(w.region(1).flooded).toBe(14);
    expect(w.region(2).flooded).toBe(14);
  });

  test('burn ruins by half the magnitude and burns the overgrowth off', () => {
    const w = new MemoryWorldState(1);
    w.apply(ev('overgrow', [1], 0.8));
    w.apply(ev('burn', [1], 0.5));
    expect(w.region(1).ruin).toBeCloseTo(0.25);
    expect(w.region(1).overgrowth).toBeCloseTo(0.3);
  });

  test('a storm takes its kind and strength (clamped); clear-storm calms it and keeps the kind', () => {
    const w = new MemoryWorldState(1);
    w.apply(ev('storm', [1], 2, { detail: { storm: 'ash' } }));
    expect(w.region(1).storm).toEqual({ kind: 'ash', strength: 1 });
    w.apply(ev('clear-storm', [1], 0));
    expect(w.region(1).storm).toEqual({ kind: 'ash', strength: 0 });
  });

  test('faction presence moves by at most 1 a step, within 0..1, and needs its faction', () => {
    const w = new MemoryWorldState(1, NAMES, structuredClone(FACTIONS));
    expect(() => w.apply(ev('faction-presence', [1], 0.5))).toThrow(/detail.faction/);
    w.apply(ev('faction-presence', [1], 0.6, { detail: { faction: 'iron' } }));
    w.apply(ev('faction-presence', [1], -0.2, { detail: { faction: 'iron' } }));
    expect(w.region(1).presence.iron).toBeCloseTo(0.4);
  });

  test("faction attitude is the faction's (applied once, however many regions), within -1..1", () => {
    const w = new MemoryWorldState(1, NAMES, structuredClone(FACTIONS));
    w.apply(ev('faction-attitude', [1, 2], 0.3, { detail: { faction: 'iron' } }));
    expect(w.faction('iron')!.attitude).toBeCloseTo(0.3);
    w.apply(ev('faction-attitude', [1], -5, { detail: { faction: 'iron' } }));
    expect(w.faction('iron')!.attitude).toBe(-1);
    expect(() => w.apply(ev('faction-attitude', [1], 0.1, { detail: { faction: 'nobody' } }))).toThrow(/known faction/);
  });

  test('a mark is left on each region, named for its event', () => {
    const w = new MemoryWorldState(1);
    expect(() => w.apply(ev('mark', [1], 0))).toThrow(/detail.name/);
    const e = ev('mark', [1, 2], 0, { detail: { name: 'The Drowned Bell', kind: 'monument', at: [3, 4] } });
    w.apply(e);
    expect(w.region(2).marks).toEqual([{ id: e.id, name: 'The Drowned Bell', kind: 'monument', at: [3, 4], cause: e.id }]);
  });

  test('an event with no regions is an error and changes nothing', () => {
    const w = new MemoryWorldState(1);
    expect(() => w.apply(ev('sink', [], 1))).toThrow(/no regions/);
    expect(w.version).toBe(0);
    expect(w.history()).toEqual([]);
  });
});

describe('history, listeners, versions', () => {
  test('every event is kept in order; a region sees the ones that touched it', () => {
    const w = new MemoryWorldState(1);
    const a = ev('sink', [1], 0.1);
    const b = ev('ruin', [2], 0.1);
    const c = ev('freeze', [1, 2], 0.1);
    for (const e of [a, b, c]) w.apply(e);
    expect(w.history().map((e) => e.id)).toEqual([a.id, b.id, c.id]);
    expect(w.history(1).map((e) => e.id)).toEqual([a.id, c.id]);
    expect(w.version).toBe(3);
  });

  test('listeners are told each region before and after, the before untouched by the change', () => {
    const w = new MemoryWorldState(1);
    const seen: [number, number, number][] = [];
    w.onChange.push((id, before, after) => seen.push([id, before.frozen, after.frozen]));
    w.apply(ev('freeze', [1, 2], 0.5));
    expect(seen).toEqual([
      [1, 0, 0.5],
      [2, 0, 0.5],
    ]);
  });

  test('a recorded run moves the run on', () => {
    const w = new MemoryWorldState(1);
    const r: RunRecord = { run: 0, hero: 'h', story: 's', end: 'won', deeds: [], events: [] };
    w.record(r);
    expect(w.run).toBe(1);
    expect(w.runs).toEqual([r]);
  });
});

describe('snapshot and restore', () => {
  test('a restored world is the world that was saved, and independent of it', () => {
    const w = new MemoryWorldState(42, NAMES, structuredClone(FACTIONS));
    w.apply(ev('sink', [1], 0.3));
    w.apply(ev('mark', [2], 0, { detail: { name: 'Cairn', kind: 'grave' } }));
    w.apply(ev('faction-attitude', [1], 0.2, { detail: { faction: 'iron' } }));
    w.record({ run: 0, hero: 'h', story: 's', end: 'fled', deeds: ['spared the ferryman'], events: [] });
    const snap = w.snapshot();
    const r = MemoryWorldState.restore(JSON.parse(JSON.stringify(snap)));
    expect(r.snapshot()).toEqual(snap);
    // (independent: changing the restored world leaves the saved snapshot and the original alone)
    r.apply(ev('sink', [1], 0.5));
    expect(w.region(1).sunk).toBeCloseTo(0.3);
    expect(snap.regions[0].state.sunk).toBeCloseTo(0.3);
    expect(r.region(1).sunk).toBeCloseTo(0.8);
  });

  test("a snapshot's regions are copies: editing one doesn't change the world", () => {
    const w = new MemoryWorldState(1, NAMES);
    const s = w.snapshot();
    s.regions[0].state.ruin = 1;
    expect(w.region(1).ruin).toBe(0);
  });

  test('a snapshot (a save between runs) is unchanged by what happens after it', () => {
    const w = new MemoryWorldState(1, NAMES, structuredClone(FACTIONS));
    w.apply(ev('sink', [1], 0.2));
    const s = w.snapshot();
    const before = JSON.parse(JSON.stringify(s));
    w.apply(ev('faction-attitude', [1], 0.5, { detail: { faction: 'iron' } }));
    w.apply(ev('sink', [1], 0.5));
    w.settlements.push({} as never);
    expect(s).toEqual(before);
  });

  test("restore doesn't share the snapshot's factions", () => {
    const w = new MemoryWorldState(1, NAMES, structuredClone(FACTIONS));
    const s = w.snapshot();
    const r = MemoryWorldState.restore(s);
    r.apply(ev('faction-attitude', [1], 0.5, { detail: { faction: 'iron' } }));
    expect(s.factions[0].attitude).toBe(0);
  });
});
