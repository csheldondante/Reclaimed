// Terrain track (round 117): the terrain on a real (small) atlas on Dawn in Node — the atlas's kernels with the terrain's
// WGSL in them compile and run (terrain/river.wgsl, cave.wgsl, sample.wgsl, flood.wgsl), the river courses keep falling
// where the ground falls, the region graph is made from the GPU's samples, a flood fills a basin the CPU agrees on, and
// a region's columns are made over a river; caves open at cliffs (ground() probed over the world).
import { describe, expect, it } from 'vitest';
import { testGpu } from './dawn';
import { Atlas, DEFAULT_ATLAS } from '../../src/atlas/atlas';
import { TerrainSystem } from '../../src/terrain/terrain';
import { CAPS_PRESETS } from '../../src/api/contracts/terrain';
import { makeBindGroup, makeComputeAsync, makeModule } from '../../src/gpu/pipeline';

// (one small atlas for every test here: two in one worker crashed Dawn's process — the gpu tier shares one device)
let atlas: Promise<Atlas> | null = null;
const small = async () => (atlas ??= testGpu().then((g) => Atlas.build(g.device, { ...DEFAULT_ATLAS, n: 512, cols: 4096, rows: 4736, sites: 30, craters: 4, oddities: 2, seed: 3 })));

const PROBE = `
@group(0) @binding(41) var<storage, read_write> outP: array<vec4<f32>>;
@compute @workgroup_size(8, 8)
fn probe(@builtin(global_invocation_id) id: vec3<u32>) {
  let W = 512u;
  if (id.x >= W || id.y >= W) { return; }
  let p = vec2<f32>((f32(id.x) + 0.5) / f32(W) * AP.worldW, (f32(id.y) + 0.5) / f32(W) * AP.worldH);
  let g = ground(p);
  outP[id.y * W + id.x] = vec4<f32>(g.h, g.ov.y, g.ov.z, f32(g.ov.x));
}
`;



describe('terrain on a small atlas', () => {
  it('builds, samples, partitions, floods and makes columns over a river', async () => {
    const g = await testGpu();
    const a = await small();
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
    // the partition's top level: the atlas's regions, their borders' barriers
    const ag = T.atlasGraph();
    const ns = [...ag.nodes()];
    expect(ns.length).toBe(a.defs.length);
    const all = ns.flatMap((n) => ag.edges(n.id));
    expect(all.length).toBeGreaterThan(ns.length);
    const bk = new Set<string | null>(all.map((e) => e.barrier));
    if (process.env.TERRAIN_LOG) console.log(`atlas graph: ${ns.length} regions, ${all.length / 2} borders: ${[...bk].join(', ')}`);
    expect(bk.has('sea') || bk.has('cliff')).toBe(true);
    expect(bk.has(null)).toBe(true);
    for (const e of all) expect(ag.edges(e.a).includes(e) && ag.edges(e.b).includes(e)).toBe(true);
    expect(ag.regionAt(ns[0].centre)).toBeGreaterThanOrEqual(0);
  }, 180_000);
  it('caves: open runs at cliffs (terrain/cave.wgsl), ground() over the whole small world', async () => {
    const g = await testGpu();
    const a = await small();
    const dev = g.device;
    const k = await makeComputeAsync(dev, 'probe', makeModule(dev, 'probe', a.parts(PROBE)), { 0: 'uniform', 20: 'read', 21: 'read', 22: 'read', 23: 'read', 25: 'read', 26: 'read', 41: 'rw' }, 'probe');
    const out = dev.createBuffer({ size: 512 * 512 * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const ap = dev.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    a.writeParams({}, ap);
    const enc = dev.createCommandEncoder();
    const cp = enc.beginComputePass();
    cp.setPipeline(k.pipeline);
    cp.setBindGroup(0, makeBindGroup(dev, 'probe', k.layout, { 0: ap, 20: a.region, 21: a.dist, 22: a.regs, 23: a.pat, 25: a.riverBuf, 26: a.coarse.cells, 41: out }));
    cp.dispatchWorkgroups(64, 64);
    cp.end();
    dev.queue.submit([enc.finish()]);
    const v = new Float32Array(await g.read(out, 512 * 512 * 16));
    let gaps = 0;
    let lips = 0;
    for (let i = 0; i < 512 * 512; i++) {
      const fl = v[i * 4 + 1];
      const rf = v[i * 4 + 2];
      if (rf > fl + 2.5) {
        if (v[i * 4 + 3] > 0) lips++;
        else gaps++;
      }
    }
    if (process.env.TERRAIN_LOG) console.log(`ground at 512²: ${gaps} cells with an open run at a foot (cave or undercut), ${lips} under a lip`);
    expect(g.takeErrors()).toEqual([]);
    expect(gaps).toBeGreaterThan(0);
  }, 180_000);
});
