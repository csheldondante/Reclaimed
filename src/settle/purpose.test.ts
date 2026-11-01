// Settlements' purposes and stories (round 120, `cities`; BACKLOG STR30, STR36): read from the land and the world state,
// on the record the GM and the wiki read, and what the planner makes of them. Node, no GPU: `npx vitest run src/settle`.
import { describe, expect, it } from 'vitest';
import type { Settlement, SettlementPurpose } from '../api/contracts/settlement';
import { purposeOf, purposeScores, type PurposeFacts } from './purpose';
import { storyOf } from './story';
import { kindTraits } from '../atlas/kind-traits';
import { planSettlement, type PlanInput } from './plan';
import { civById } from './catalogue';
import { MAT } from '../world/materials';
import { cellPos, ROW_H } from '../world/lattice';

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

/** a box with the sea along its east side (the plan's port test) */
function coastInput(purpose: SettlementPurpose, story = false): PlanInput {
  const W = 256;
  const H = 288;
  const N = W * H;
  const ground = new Float32Array(N);
  const water = new Float32Array(N);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const [wx] = cellPos(x, y);
      const g = 24 - Math.max(0, wx - 150) * 0.3 + 0.6 * Math.sin(y * 0.1);
      ground[y * W + x] = g;
      water[y * W + x] = Math.max(0, 20 - g);
    }
  const rec: Settlement = { id: 's9', name: 'Saltmere', region: 0, faction: 'f-x', at: [130, (H / 2) * ROW_H], radius: 30, size: 'town', condition: 'thriving', grids: [], buildings: [], people: [], stores: {}, needs: [] };
  rec.purpose = { kind: purpose, why: 'test', scores: { port: 0, mining: 0, lumber: 0, farming: 0, trading: 0, hold: 0 }, trades: [] };
  if (story) rec.story = { founding: 'test', owner: 'f-x', events: [{ what: 'walled', run: -5, note: '' }, { what: 'burned', run: -8, note: '', at: [110, (H / 2) * ROW_H + 10], radius: 14 }] };
  return { rec, civ: civById('river-guilds'), camp: null, seed: 5, setting: 'port', ruin: false, box: { x0: 0, y0: 0, w: W, h: H }, ground, water, top: new Uint8Array(N).fill(MAT.Soil), veg: new Float32Array(N), sea: 20 };
}

describe('the planner makes the purpose', () => {
  it('a port: piers, moored ships, warehouses on its record; dockers and sailors; loading at the piers', () => {
    const p = planSettlement(coastInput('port'));
    expect(p.city.linear.some((f) => f.kind === 'pier')).toBe(true);
    expect(p.city.berths.length).toBeGreaterThan(0);
    expect(p.rec.buildings.some((b) => b.use.includes('dock'))).toBe(true);
    expect(p.rec.buildings.some((b) => b.use.includes('trade'))).toBe(true);
    expect(p.rec.people.map((x) => x.role)).toEqual(expect.arrayContaining(['docker', 'sailor', 'fisher']));
    expect(p.rec.needs.some((n) => n.kind === 'load')).toBe(true);
    expect(p.rec.stores.fish).toBeTruthy();
  });
  it('a hold: Bulwark’s rings, walls, a keep; mostly guards', () => {
    const p = planSettlement(coastInput('hold'));
    expect(p.city.spec.system).toBe('radial');
    expect(p.city.spec.walls).toBe(true);
    expect(p.rec.people.find((x) => x.role === 'guard')!.count).toBeGreaterThan(p.rec.people.find((x) => x.role === 'farmer')!.count);
  });
  it('its story in its fabric: a burned quarter gutted, walls raised', () => {
    const p = planSettlement(coastInput('farming', true));
    expect(p.city.spec.walls).toBe(true);
    expect(p.city.buildings.some((b) => b.wear === 'burned')).toBe(true);
    const gutted = p.rec.buildings.filter((b) => p.things.get(b.thing)!.condition < 0.2);
    expect(gutted.length).toBeGreaterThan(0);
  });
});
