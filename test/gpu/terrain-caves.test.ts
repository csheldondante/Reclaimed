// Terrain track (round 117): caves at cliffs' feet (terrain/cave.wgsl) on a small atlas on Dawn — ground() evaluated over
// the world on a grid, counting the cells whose column has an open run at a cliff's foot (g.ov), and whether they open
// out of the cliff's face (a neighbour lower than the cave's roof: a mouth).
import { describe, expect, it } from 'vitest';
import { testGpu } from './dawn';
import { Atlas, DEFAULT_ATLAS } from '../../src/atlas/atlas';
import { makeBindGroup, makeComputeAsync, makeModule } from '../../src/gpu/pipeline';

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

describe('cliff caves on a small atlas', () => {
  it('open runs appear at cliffs', async () => {
    const g = await testGpu();
    const a = await Atlas.build(g.device, { ...DEFAULT_ATLAS, n: 512, cols: 4096, rows: 4736, sites: 30, craters: 4, oddities: 2, seed: 3 });
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
