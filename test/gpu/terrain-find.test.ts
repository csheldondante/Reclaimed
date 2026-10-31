// Terrain track diagnostics (TERRAIN_FIND=gorge; off otherwise): the default atlas on Dawn, ground() over the whole
// world every 16 world units, listing where a gorge is cut 10+ deep with plateau ground (its rims) either side — spots
// to frame pictures on.
import { describe, expect, it } from 'vitest';
import { testGpu } from './dawn';
import { Atlas, DEFAULT_ATLAS } from '../../src/atlas/atlas';
import { makeBindGroup, makeComputeAsync, makeModule } from '../../src/gpu/pipeline';

const FIND = process.env.TERRAIN_FIND;
const S = 1024;
const PROBE = `
@group(0) @binding(41) var<storage, read_write> outP: array<vec4<f32>>;
@compute @workgroup_size(8, 8)
fn probe(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= ${S}u || id.y >= ${S}u) { return; }
  let p = vec2<f32>((f32(id.x) + 0.5) / ${S}.0 * AP.worldW, (f32(id.y) + 0.5) / ${S}.0 * AP.worldH);
  let g = ground(p);
  let A = regs[g.a];
  var depth = 0.0;
  if (isLand(A) && A.tier == TIER_PLATEAU && g.w > 0.98) {
    let gz = gorgeAt(torusU(p), g.h, AP.sea + 10.0, g.dl);
    depth = max(g.h - gz.cut, 0.0);
  }
  outP[id.y * ${S}u + id.x] = vec4<f32>(g.h, depth, g.rx, g.lk);
}
`;

describe('terrain find', () => {
  it.runIf(FIND === 'gorge')('gorges', async () => {
    const g = await testGpu();
    const a = await Atlas.build(g.device, { ...DEFAULT_ATLAS });
    const dev = g.device;
    const k = await makeComputeAsync(dev, 'probe', makeModule(dev, 'probe', a.parts(PROBE)), { 0: 'uniform', 20: 'read', 21: 'read', 22: 'read', 23: 'read', 25: 'read', 26: 'read', 41: 'rw' }, 'probe');
    const out = dev.createBuffer({ size: S * S * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const ap = dev.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    a.writeParams({}, ap);
    const enc = dev.createCommandEncoder();
    const cp = enc.beginComputePass();
    cp.setPipeline(k.pipeline);
    cp.setBindGroup(0, makeBindGroup(dev, 'probe', k.layout, { 0: ap, 20: a.region, 21: a.dist, 22: a.regs, 23: a.pat, 25: a.riverBuf, 26: a.coarse.cells, 41: out }));
    cp.dispatchWorkgroups(S / 8, S / 8);
    cp.end();
    dev.queue.submit([enc.finish()]);
    const v = new Float32Array(await g.read(out, S * S * 16));
    const spots: string[] = [];
    let cells = 0;
    for (let j = 2; j < S - 2; j++)
      for (let i = 2; i < S - 2; i++) {
        const o = (j * S + i) * 4;
        if (v[o + 1] > 0) cells++;
        if (v[o + 1] < 18 || v[o + 2] < 6) continue;
        const x = ((i + 0.5) / S) * a.worldW;
        const y = ((j + 0.5) / S) * a.worldH;
        const warm = 0.5 - 0.5 * Math.cos((2 * Math.PI * y) / a.worldH);
        if (warm < 0.45 || warm > 0.9) continue;
        if (spots.some((s) => { const [sx, sy] = s.split(',').map(Number); return Math.hypot(sx - x, sy - y) < 800; })) continue;
        spots.push(`${x.toFixed(0)},${y.toFixed(0)},${v[o + 1].toFixed(0)}`);
      }
    console.log(`gorge cells ${cells} of ${S * S}; spots (world x,y,depth): ${spots.slice(0, 12).join('  ')}`);
    expect(g.takeErrors()).toEqual([]);
    a.dispose();
  }, 300_000);
});
