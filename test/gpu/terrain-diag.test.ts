// Terrain track diagnostics (TERRAIN_DIAG="x,y" world units; off otherwise): the default atlas built on Dawn, ground()
// probed round a point at 1 world unit — its height, the border's kind and the open runs (caves, undercuts) — printed
// as a map. For finding why something does or doesn't show in a picture without the browser.
import { describe, expect, it } from 'vitest';
import { testGpu } from './dawn';
import { Atlas, DEFAULT_ATLAS } from '../../src/atlas/atlas';
import { makeBindGroup, makeComputeAsync, makeModule } from '../../src/gpu/pipeline';

const AT = process.env.TERRAIN_DIAG;
const R = 96;
const PROBE = `
@group(0) @binding(41) var<storage, read_write> outP: array<vec4<f32>>;
@group(0) @binding(42) var<uniform> C: vec4<f32>;
@compute @workgroup_size(8, 8)
fn probe(@builtin(global_invocation_id) id: vec3<u32>) {
  let W = ${2 * R}u;
  if (id.x >= W || id.y >= W) { return; }
  let p = C.xy + vec2<f32>(f32(id.x), f32(id.y)) - f32(${R});
  let g = ground(p);
  outP[id.y * W + id.x] = vec4<f32>(g.h, g.ov.y, g.ov.z, f32(regs[g.a].tier) + 10.0 * f32(isLand(regs[g.a])));
}
`;

describe('terrain diagnostics', () => {
  it.runIf(!!AT)('ground round a point', async () => {
    const [x, y] = AT!.split(',').map(Number);
    const g = await testGpu();
    const a = await Atlas.build(g.device, { ...DEFAULT_ATLAS });
    const dev = g.device;
    const k = await makeComputeAsync(dev, 'probe', makeModule(dev, 'probe', a.parts(PROBE)), { 0: 'uniform', 20: 'read', 21: 'read', 22: 'read', 23: 'read', 25: 'read', 26: 'read', 41: 'rw', 42: 'uniform' }, 'probe');
    const W = 2 * R;
    const out = dev.createBuffer({ size: W * W * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const ap = dev.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const cb = dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    a.writeParams({}, ap);
    dev.queue.writeBuffer(cb, 0, new Float32Array([x, y, 0, 0]));
    const enc = dev.createCommandEncoder();
    const cp = enc.beginComputePass();
    cp.setPipeline(k.pipeline);
    cp.setBindGroup(0, makeBindGroup(dev, 'probe', k.layout, { 0: ap, 20: a.region, 21: a.dist, 22: a.regs, 23: a.pat, 25: a.riverBuf, 26: a.coarse.cells, 41: out, 42: cb }));
    cp.dispatchWorkgroups(W / 8, W / 8);
    cp.end();
    dev.queue.submit([enc.finish()]);
    const v = new Float32Array(await g.read(out, W * W * 16));
    let rows = '';
    let gaps = 0;
    for (let j = 0; j < W; j += 3) {
      let l = '';
      for (let i = 0; i < W; i += 2) {
        const o = (j * W + i) * 4;
        const gap = v[o + 2] > v[o + 1] + 2.5;
        if (gap) gaps++;
        l += gap ? '#' : v[o] < a.p.sea ? '~' : ' .:-=+*%@'[Math.min(8, Math.max(0, Math.floor((v[o] - a.p.sea) / 20)))];
      }
      rows += l + '\n';
    }
    console.log(`${x},${y}: sea ${a.p.sea}, ${gaps} probed cells with an open run (#)\n${rows}`);
    // (TERRAIN_DIAG_COL="x,y": the made columns' runs round that world point, and ground()'s open run there)
    const cAt = process.env.TERRAIN_DIAG_COL;
    if (cAt) {
      const [px, py] = cAt.split(',').map(Number);
      const cy = Math.floor(py / 0.8660254);
      const cx = Math.floor(px - 0.5 * (cy & 1));
      const cols = await a.columns(cx - 2, cy - 2, 5, 5);
      for (let i = 0; i < 25; i++) {
        const runs: string[] = [];
        for (let r = 0; r < 24; r++) {
          const iv = cols.run(i, r);
          if (!iv || iv.z1 <= iv.z0) break;
          runs.push(`${iv.z0.toFixed(1)}-${iv.z1.toFixed(1)}:${iv.mat}${iv.form ? 'f' : ''}`);
        }
        console.log(`col ${i % 5},${Math.floor(i / 5)}: ${runs.join(' ')}`);
      }
      const j = Math.round(py - y + R) * W + Math.round(px - x + R);
      console.log(`ground there: h ${v[j * 4].toFixed(1)}, open ${v[j * 4 + 1].toFixed(1)}..${v[j * 4 + 2].toFixed(1)}`);
    }
    expect(g.takeErrors()).toEqual([]);
    a.dispose();
  }, 300_000);
});
