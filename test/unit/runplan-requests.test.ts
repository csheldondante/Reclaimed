// (runplay, round 119) The plan's asks of terrain as terrain's own requests, on a stage's land graphed: two halls and a
// corridor, the left hall the stage's region (1), the right another (2).
import { describe, expect, test } from 'vitest';
import { partition, RegionGraph, type TerrainSamples } from '../../src/terrain/partition';
import { WALKER_PROFILE } from '../../src/api/contracts/play';
import { asksFor, borderToward, OBSTACLE, stageRoom, toTerrainRequests } from '../../src/runplan/requests';
import type { RunTerrainAsk } from '../../src/api/contracts/run';

function halls(): RegionGraph {
  const w = 120;
  const h = 60;
  const N = w * h;
  const S: TerrainSamples = { w, h, x0: 0, y0: 0, step: 4, ground: new Float32Array(N), water: new Float32Array(N).fill(NaN), wet: new Uint8Array(N), lava: new Uint8Array(N), veg: new Float32Array(N), seed: 1 };
  const hall = (x: number, y: number) => (x < 50 && y >= 5 && y < 55) || (x >= 70 && y >= 5 && y < 55) || (y >= 27 && y < 33);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) S.ground[y * w + x] = hall(x, y) ? 100 : 160;
  return new RegionGraph(partition(S));
}
const regionAt = ([x]: [number, number]) => (x < 240 ? 1 : 2);
const stage = { region: 1, at: [100, 120] as [number, number] };

describe('the plan’s asks as terrain’s requests', () => {
  const g = halls();
  test('the stage’s room and the border toward the next region', () => {
    const room = stageRoom(g, stage.at);
    expect(g.region(room).floor[1]).toBe(100);
    const b = borderToward(g, room, 2, regionAt);
    expect(b).not.toBeNull();
    expect(regionAt(g.region(g.border(b!).a === room ? g.border(b!).b : g.border(b!).a).centre)).toBe(2);
  });
  test('an exits ask: as many as the legs out, closing the rest when asked', () => {
    const ask: RunTerrainAsk = { kind: 'exits', region: 1, toward: [2], closeOthers: true };
    const [r] = toTerrainRequests(ask, g, stage, WALKER_PROFILE, regionAt);
    expect(r.req).toMatchObject({ kind: 'exits', count: 1, room: stageRoom(g, stage.at) });
    // (not closing: one way out is there already, nothing asked)
    const [n] = toTerrainRequests({ ...ask, closeOthers: false }, g, stage, WALKER_PROFILE, regionAt);
    expect(n.req).toBeNull();
  });
  test('an obstacle ask: the barrier as terrain’s obstacle on the border toward the other region', () => {
    const ask: RunTerrainAsk = { kind: 'obstacle', a: 1, b: 2, barrier: 'vegetation', passage: 'a wood to tear through', why: 'fun' };
    const [r] = toTerrainRequests(ask, g, stage, WALKER_PROFILE, regionAt);
    expect(r.req).toMatchObject({ kind: 'obstacle', barrier: 'vegetation' });
    expect(OBSTACLE.cliff).toBe('wall');
    // (water: terrain builds no water obstacle — said, not faked)
    const [w] = toTerrainRequests({ ...ask, barrier: 'river' }, g, stage, WALKER_PROFILE, regionAt);
    expect(w.req).toBeNull();
    expect(w.note).toMatch(/no such obstacle/);
  });
  test('only the asks touching the stage’s region', () => {
    const requests: RunTerrainAsk[] = [
      { kind: 'exits', region: 1, toward: [2], closeOthers: true },
      { kind: 'exits', region: 5, toward: [6], closeOthers: true },
      { kind: 'obstacle', a: 2, b: 1, barrier: 'cliff', passage: 'p', why: 'w' },
    ];
    expect(asksFor({ requests }, stage)).toHaveLength(2);
  });
});
