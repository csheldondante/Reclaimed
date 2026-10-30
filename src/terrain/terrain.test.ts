import { describe, expect, it } from 'vitest';
import { partition, RegionGraph, type TerrainSamples } from './partition';
import { TerrainSystem } from './terrain';
import { WALKER_PROFILE } from '../api/contracts/play';
import { library } from '../play/library';
import { StampOps } from '../atlas/stamps';
import type { Atlas } from '../atlas/atlas';

function land(w: number, h: number, f: (x: number, y: number) => number, extra?: (S: TerrainSamples, i: number, x: number, y: number) => void): TerrainSamples {
  const N = w * h;
  const S: TerrainSamples = { w, h, x0: 1000, y0: 1000, step: 4, ground: new Float32Array(N), water: new Float32Array(N).fill(NaN), wet: new Uint8Array(N), lava: new Uint8Array(N), veg: new Float32Array(N), seed: 1 };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; S.ground[i] = f(x, y); extra?.(S, i, x, y); }
  return S;
}
const fakeAtlas = () => ({ stampHooks: [] as ((ops: StampOps, x0: number, y0: number, w: number, h: number) => Promise<void>)[], worldW: 16384, worldH: 16384 }) as unknown as Atlas & { stampHooks: ((ops: StampOps, x0: number, y0: number, w: number, h: number) => Promise<void>)[] };
// (runplay: play's profiles — the walker, the hoverbike and the lich at their defaults)
const walker = WALKER_PROFILE;
const bike = library.get('hoverbike')!.profile();
const lich = library.get('lich')!.profile();

describe('terrain requests', () => {
  it('opens a cliff with a ramp the walker can climb, stamped into the land', async () => {
    const A = fakeAtlas();
    const T = new TerrainSystem(A);
    const g = new RegionGraph(partition(land(100, 60, (x) => (x < 50 ? 100 : 130))));
    const lo = g.rooms().find((r) => r.floor[1] === 100)!;
    expect(g.exits(lo.id, walker).length).toBe(0);
    const r = T.request(g, { kind: 'exits', room: lo.id, count: 1, caps: walker });
    expect(r.ok).toBe(true);
    expect(r.edits.length).toBe(1);
    expect(r.edits[0].kind).toBe('ramp');
    const e = r.edits[0];
    // long enough for the walker: 30 up at 0.75 a cell → 40 world units at least
    expect(Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1])).toBeGreaterThanOrEqual(39);
    expect(g.exits(lo.id, walker).length).toBe(1);
    // (runplay: play's bike climbs steeper than the ramp — 0.75 of the walker's slope — so it rides it too)
    expect(bike.climb.slope).toBeGreaterThan(0.75);
    expect(g.exits(lo.id, bike).length).toBe(1);
    // stamped: a region over the ramp's middle gets plan ops
    const mx = (e.a[0] + e.b[0]) / 2;
    const my = (e.a[1] + e.b[1]) / 2;
    const ops = new StampOps(16, 16);
    await A.stampHooks[0](ops, Math.floor(mx) - 8, Math.floor(my / 0.8660254) - 8, 16, 16);
    expect(ops.cols.size).toBeGreaterThan(10);
  });
  it('fords a narrow river, asks for a bridge over a wide one', () => {
    const T = new TerrainSystem(fakeAtlas());
    const river = (x0: number, x1: number) => land(100, 60, (x) => (x >= x0 && x < x1 ? 96 : 100), (S, i, x) => { if (x >= x0 && x < x1) { S.water[i] = 99.5; S.wet[i] = 1; } });
    const g1 = new RegionGraph(partition(river(46, 54)));
    const r1 = T.request(g1, { kind: 'exits', room: g1.rooms()[0].id, count: 1, caps: walker });
    expect(r1.edits.map((e) => e.kind)).toEqual(['ford']);
    const g2 = new RegionGraph(partition(river(40, 60)));
    const r2 = T.request(g2, { kind: 'exits', room: g2.rooms()[0].id, count: 1, caps: walker });
    expect(r2.needs.map((n) => n.kind)).toEqual(['bridge']);
    expect(g2.exits(g2.rooms()[0].id, walker).length).toBe(1);
  });
  it('closes doors down to the exits asked for, with walls the walker and bike cannot pass and the lich can', () => {
    const T = new TerrainSystem(fakeAtlas());
    const g = new RegionGraph(partition(land(160, 160, () => 100)));
    const room = g.rooms().reduce((a, b) => (g.exits(b.id, walker).length > g.exits(a.id, walker).length ? b : a));
    const n0 = g.exits(room.id, walker).length;
    expect(n0).toBeGreaterThan(1);
    const r = T.request(g, { kind: 'exits', room: room.id, count: 1, caps: walker });
    expect(r.ok).toBe(true);
    expect(g.exits(room.id, walker).length).toBe(1);
    expect(r.edits.every((e) => e.kind === 'wall')).toBe(true);
    expect(g.exits(room.id, lich).length).toBe(n0);
  });
});
