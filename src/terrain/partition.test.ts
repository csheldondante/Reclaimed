import { describe, expect, it } from 'vitest';
import { partition, RegionGraph, type TerrainSamples } from './partition';
import { CAPS_PRESETS } from '../api/contracts/terrain';

/** a w×h sample grid, step 4, ground from f(x, y) (sample coords) */
function land(w: number, h: number, f: (x: number, y: number) => number, extra?: (S: TerrainSamples, i: number, x: number, y: number) => void): TerrainSamples {
  const N = w * h;
  const S: TerrainSamples = { w, h, x0: 0, y0: 0, step: 4, ground: new Float32Array(N), water: new Float32Array(N).fill(NaN), wet: new Uint8Array(N), lava: new Uint8Array(N), veg: new Float32Array(N), seed: 1 };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    S.ground[i] = f(x, y);
    extra?.(S, i, x, y);
  }
  return S;
}
const graph = (S: TerrainSamples) => new RegionGraph(partition(S));
const { walker, bike, lich } = CAPS_PRESETS;

describe('partition', () => {
  it('a small open plain is one feature, one room', () => {
    const g = graph(land(30, 30, () => 100));
    expect(g.features().length).toBe(1);
    expect(g.rooms().length).toBe(1);
    expect(g.borders().length).toBe(0);
  });
  it('a big plain splits into rooms 1-3 screens big, joined by open borders', () => {
    const g = graph(land(160, 160, (x, y) => 100 + 0.2 * Math.sin(x * 0.1) + 0.2 * Math.cos(y * 0.13)));
    expect(g.features().length).toBe(1);
    const rooms = g.rooms();
    expect(rooms.length).toBeGreaterThan(3);
    for (const r of rooms) expect(r.screens).toBeGreaterThanOrEqual(0.99);
    expect(g.borders().every((b) => b.kind === 'open')).toBe(true);
    expect(g.reach(rooms[0].id, walker).length).toBe(rooms.length);
  });
  it('rooms meet at the narrows (a dumbbell: two halls and a corridor)', () => {
    // two 50×50 halls joined by a 6-wide corridor; the rest a high wall
    const hall = (x: number, y: number) => (x < 50 && y >= 5 && y < 55) || (x >= 70 && y >= 5 && y < 55) || (y >= 27 && y < 33);
    const g = graph(land(120, 60, (x, y) => (hall(x, y) ? 100 : 160)));
    // (the high ground round them is a plateau of its own: its rooms aren't the halls')
    const rooms = g.rooms().filter((r) => r.floor[1] === 100);
    expect(rooms.length).toBe(2);
    const open = g.borders().filter((b) => b.kind === 'open' && g.region(b.a).floor[1] === 100);
    expect(open.length).toBe(1);
    const door = g.pass(open[0].passes[0]);
    // the door is in the corridor (x 50..70 samples → 200..280 world)
    expect(door.at[0]).toBeGreaterThanOrEqual(180);
    expect(door.at[0]).toBeLessThanOrEqual(300);
  });
  it('a cliff between a plain and a plateau: walker no, lich yes, measured', () => {
    const g = graph(land(100, 60, (x) => (x < 50 ? 100 : 140)));
    expect(g.features().length).toBe(2);
    const b = g.borders().filter((b) => b.kind !== 'open');
    expect(b.length).toBeGreaterThan(0);
    const B = b[0];
    expect(B.kind).toBe('cliff');
    expect(g.cost(B.id, walker)).toBe(Infinity);
    expect(g.cost(B.id, lich)).toBeLessThan(Infinity);
    expect(Math.abs(B.measure.rise)).toBeCloseTo(40, 0);
    expect(B.measure.minClimb).toBeCloseTo(40, 0);
  });
  it('one way down: a walker drops a short cliff but cannot climb it', () => {
    const g = graph(land(100, 60, (x) => (x < 50 ? 100 : 108)));
    const B = g.borders().find((b) => b.kind !== 'open')!;
    const hi = g.region(B.a).floor[1] > g.region(B.b).floor[1] ? B.a : B.b;
    const lo = hi === B.a ? B.b : B.a;
    expect(g.cost(B.id, walker, hi)).toBeLessThan(Infinity);
    expect(g.cost(B.id, walker, lo)).toBe(Infinity);
  });
  it('a river: the walker stops, the bike rides over, the border says river', () => {
    const g = graph(land(100, 60, (x) => (x >= 46 && x < 54 ? 96 : 100), (S, i, x) => {
      if (x >= 46 && x < 54) { S.water[i] = 99.5; S.wet[i] = 1; }
    }));
    const B = g.borders().find((b) => b.kind !== 'open')!;
    expect(B.kind).toBe('river');
    expect(g.cost(B.id, walker)).toBe(Infinity);
    expect(g.cost(B.id, bike)).toBeLessThan(Infinity);
    expect(B.measure.minDeep).toBeCloseTo(3.5, 1);
    expect(B.measure.minWaterSpan).toBeCloseTo(32, 0);
  });
  it('a ford: shallow water somewhere along the river lets the walker over', () => {
    const g = graph(land(100, 60, (x, y) => (x >= 46 && x < 54 ? (y >= 28 && y < 31 ? 99 : 96) : 100), (S, i, x) => {
      if (x >= 46 && x < 54) { S.water[i] = 99.5; S.wet[i] = 1; }
    }));
    expect(g.features().length).toBe(1);
  });
  it('dense vegetation: a walker cuts through at a cost, a bike cannot', () => {
    const g = graph(land(100, 60, () => 100, (S, i, x) => { if (x >= 46 && x < 54) S.veg[i] = 0.95; }));
    const B = g.borders().find((b) => b.kind !== 'open')!;
    expect(B.kind).toBe('vegetation');
    const cw = g.cost(B.id, walker);
    expect(cw).toBeLessThan(Infinity);
    expect(cw).toBeGreaterThan(8 * 4 * 4);
    expect(g.cost(B.id, bike)).toBe(Infinity);
  });
  it('a ravine: lower than both sides; the bike jumps a narrow one', () => {
    const g = graph(land(100, 60, (x) => (x >= 49 && x < 51 ? 60 : 100)));
    const B = g.borders().find((b) => b.kind !== 'open')!;
    expect(B.kind).toBe('ravine');
    expect(g.cost(B.id, walker)).toBe(Infinity);
    expect(B.measure.minGap).toBeLessThanOrEqual(12);
    expect(g.cost(B.id, bike)).toBeLessThan(Infinity);
  });
  it('soft barriers add to the cost', () => {
    const g = graph(land(160, 160, () => 100));
    const B = g.borders()[0];
    const c0 = g.cost(B.id, walker);
    g.soften(B.id, 'storm', 0.5);
    expect(g.cost(B.id, walker)).toBeCloseTo(c0 + 200, 3);
  });
});
