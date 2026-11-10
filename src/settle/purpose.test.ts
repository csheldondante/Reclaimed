// Settlements' purposes and stories (round 120, `cities`; BACKLOG STR30, STR36): read from the land and the world state,
// on the record the GM and the wiki read, and (switchover: the old planner's part of them gone). Node, no GPU: `npx vitest run src/settle`.
import { describe, expect, it } from 'vitest';
import { purposeOf, purposeScores, type PurposeFacts } from './purpose';
import { storyOf } from './story';
import { kindTraits } from '../atlas/kind-traits';

const facts = (o: Partial<PurposeFacts> & { kind?: string; tier?: string | null; rivers?: number; dryness?: number; temp?: number; stamps?: string[] } = {}): PurposeFacts => {
  const kind = o.kind ?? 'plains';
  return {
    setting: o.setting ?? 'plain',
    size: o.size ?? 'town',
    roads: o.roads ?? 2,
    crossings: o.crossings ?? 0,
    region: { kind, tier: o.tier === undefined ? 'lowland' : o.tier, rivers: o.rivers ?? 0, dryness: o.dryness ?? 0.4, temp: o.temp ?? 12, ground: { min: 90, mean: 110, max: 140 }, stamps: o.stamps ?? [], traits: kindTraits(kind) },
    ground: o.ground ?? 100,
    sea: 90,
    hostile: o.hostile ?? 0,
    seat: o.seat ?? false,
  };
};

describe('a purpose is read from the land', () => {
  it('a town down by the sea is a port; the same town high over it is not', () => {
    expect(purposeOf(facts({ setting: 'port', ground: 93, kind: 'tundra' })).kind).toBe('port');
    expect(purposeOf(facts({ setting: 'port', ground: 160, kind: 'tundra' })).kind).not.toBe('port');
  });
  it('a mountain flank of rock is a mine; a crater rim too', () => {
    expect(purposeOf(facts({ setting: 'mountain flank', kind: 'range', tier: 'massif' })).kind).toBe('mining');
    expect(purposeOf(facts({ setting: 'crater rim', kind: 'craters', tier: 'upland' })).kind).toBe('mining');
  });
  it('a forest with a river is a lumber camp; a forest without one hardly', () => {
    const wet = purposeOf(facts({ setting: 'river', kind: 'hills', tier: 'upland', rivers: 6, dryness: 0.1, roads: 1 }));
    expect(wet.kind).toBe('lumber');
    expect(wet.why).toMatch(/forest/);
    expect(purposeScores(facts({ setting: 'plain', kind: 'hills', rivers: 0, dryness: 0.1 })).lumber).toBeLessThan(purposeScores(facts({ setting: 'river', kind: 'hills', rivers: 6, dryness: 0.1 })).lumber);
  });
  it('fertile flats are farmed; dry dunes are not', () => {
    expect(purposeOf(facts({ setting: 'plain', kind: 'plains', dryness: 0.5, roads: 1 })).kind).toBe('farming');
    expect(purposeScores(facts({ kind: 'dunes', dryness: 0.95 })).farming).toBeLessThan(purposeScores(facts({ kind: 'plains', dryness: 0.3 })).farming);
  });
  it('a crossroads of four roads is a trading post; a ford adds to it', () => {
    expect(purposeOf(facts({ roads: 4, kind: 'tundra', dryness: 0.9 })).kind).toBe('trading');
    expect(purposeScores(facts({ roads: 3, crossings: 1 })).trading).toBeGreaterThan(purposeScores(facts({ roads: 3 })).trading);
  });
  it('a cliffside height with enemies near is a hold', () => {
    const h = purposeOf(facts({ setting: 'cliffside', kind: 'mesa', tier: 'plateau', ground: 138, hostile: 0.5 }));
    expect(h.kind).toBe('hold');
    expect(h.trades[0]).toBe('guard');
  });
});

describe('a story from the world state', () => {
  const base = { id: 's3', name: 'Harrow', at: [500, 500] as [number, number], size: 'town', setting: 'port', purpose: purposeOf(facts({ setting: 'port', ground: 92 })), owner: 'f-x', ownerName: 'The X Crown', ground: 92, sea: 90, ruin: 0, flooded: null, history: [] };
  it('a strong hostile power raided it, burned a quarter and it was walled; low by the sea it flooded', () => {
    const s = storyOf({ ...base, hostiles: [{ id: 'f-salt-fleet', name: 'The Salt Fleet', v: 0.5 }] });
    expect(s.founding).toMatch(/Harrow was founded by The X Crown/);
    const what = s.events.map((e) => e.what);
    expect(what).toEqual(expect.arrayContaining(['founded', 'raided', 'burned', 'walled', 'flooded']));
    const burned = s.events.find((e) => e.what === 'burned')!;
    expect(burned.at).toBeTruthy();
    expect(s.events.map((e) => e.run)).toEqual([...s.events.map((e) => e.run)].sort((a, b) => a - b));
  });
  it('a quiet inland town has only its founding; the world state’s own events are added in', () => {
    const quiet = storyOf({ ...base, setting: 'plain', ground: 120, hostiles: [] });
    expect(quiet.events.map((e) => e.what)).toEqual(['founded']);
    const burnt = storyOf({ ...base, setting: 'plain', ground: 120, hostiles: [], history: [{ id: 'e1', kind: 'burn', regions: [0], magnitude: 1, run: 2, cause: { by: 'story' } }] });
    expect(burnt.events.find((e) => e.what === 'burned')?.cause).toBe('e1');
  });
});
