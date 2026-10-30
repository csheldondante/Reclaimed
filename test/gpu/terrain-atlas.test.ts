// Terrain track (round 117): the terrain on a real (small) atlas on Dawn in Node — the atlas's kernels with the terrain's
// WGSL in them compile and run (terrain/river.wgsl, cave.wgsl, sample.wgsl, flood.wgsl), the river courses keep falling
// where the ground falls, the region graph is made from the GPU's samples, a flood fills a basin the CPU agrees on, and
// a region's columns are made over a river.
import { describe, expect, it } from 'vitest';
import { testGpu } from './dawn';
import { Atlas, DEFAULT_ATLAS } from '../../src/atlas/atlas';
import { TerrainSystem } from '../../src/terrain/terrain';
import { CAPS_PRESETS } from '../../src/api/contracts/terrain';

describe('terrain on a small atlas', () => {
  it('builds, samples, partitions, floods and makes columns over a river', async () => {
    const g = await testGpu();
    const a = await Atlas.build(g.device, { ...DEFAULT_ATLAS, n: 512, cols: 4096, rows: 4736, sites: 30, craters: 4, oddities: 2, seed: 3 });
    expect(g.takeErrors()).toEqual([]);
    const T = new TerrainSystem(a);
    // a land node of a river: the graph round it
    const u = a.riverNodes;
    const f = new Float32Array(u.buffer, u.byteOffset, u.length);
    let k = -1;
    for (let i = 0; i < u.length / 8; i++) if (!(u[i * 8 + 5] & 1) && f[i * 8 + 2] > a.p.sea + 10 && f[i * 8 + 3] > 4) { k = i; break; }
    expect(k).toBeGreaterThanOrEqual(0);
    const [x, y] = [f[k * 8], f[k * 8 + 1]];
    const graph = await T.graph({ x0: x - 512, y0: y - 512, x1: x + 512, y1: y + 512 });
    expect(graph.rooms().length).toBeGreaterThan(0);
    const kinds = new Set(graph.borders().map((b) => b.kind));
    if (process.env.TERRAIN_LOG) console.log(`graph: ${graph.features().length} features, ${graph.rooms().length} rooms, ${graph.borders().length} borders (${[...kinds].join(', ')}); walker reaches ${graph.reach(graph.rooms()[0].id, CAPS_PRESETS.walker).length}`);
    const fc = await T.floodTool.check([x, y], 512);
    expect(fc.differ).toBe(0);
    const cols = await a.columns(Math.floor(x) - 32, Math.floor(y / 0.8660254) - 32, 64, 64);
    expect(cols.w).toBe(64);
    expect(g.takeErrors()).toEqual([]);
    expect(a.riverStats.shaped.falls).toBeGreaterThan(0);
  }, 180_000);
});
