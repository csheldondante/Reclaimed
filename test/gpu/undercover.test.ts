// Terrain track (round 117): render.wgsl underCover (lighting's shade under a roof) on a tiny world on Dawn — 0 under the
// open sky, more the deeper into a cave, through the window's own surface words (the SurfaceSystem's) and common.wgsl's
// column layout. The function's source is taken from render.wgsl itself, so the test runs the shipped code.
import { describe, expect, it } from 'vitest';
import { testGpu } from './dawn';
import { tinyWorld } from './world';
import { tinyMap } from '../support/tinymap';
import { MAT } from '../../src/world/materials';
import { cellPos } from '../../src/world/lattice';
import { makeBindGroup, makeCompute } from '../../src/gpu/pipeline';
import commonWgsl from '../../src/shaders/common.wgsl?raw';
import layersWgsl from '../../src/shaders/layers.wgsl?raw';
import materialsWgsl from '../../src/shaders/materials.wgsl?raw';
import renderWgsl from '../../src/shaders/render.wgsl?raw';

/** a function's source out of a WGSL text (from `fn name(` to the closing brace at the start of a line) */
function fnSource(src: string, name: string): string {
  const s = src.replace(/\r\n/g, '\n');
  const i = s.indexOf(`fn ${name}(`);
  if (i < 0) throw new Error(`no fn ${name}`);
  const j = s.indexOf('\n}\n', i);
  return s.slice(i, j + 3);
}

describe('underCover (render.wgsl)', () => {
  it('is 0 in the open and grows deeper under a roof', async () => {
    const g = await testGpu();
    // a hill with a cave under it: stone to 10 everywhere; over x 8..24 × y 8..24 a roof of stone 14..20 over a gap
    const map = tinyMap(32, 32, 32, (x, y) =>
      x >= 8 && x < 24 && y >= 8 && y < 24
        ? [{ z0: 0, z1: 10, mat: MAT.Stone }, { z0: 14, z1: 20, mat: MAT.Stone }]
        : [{ z0: 0, z1: 10, mat: MAT.Stone }],
    );
    const w = await tinyWorld(g, map, ['surface']);
    await w.step(4);
    const probe = `
@group(0) @binding(11) var<storage, read> surface: array<u32>;
@group(0) @binding(40) var<storage, read_write> outP: array<f32>;
@group(0) @binding(41) var<storage, read> pts: array<vec4<f32>>;
${fnSource(renderWgsl, 'underCover')}
@compute @workgroup_size(8)
fn probe(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&pts)) { return; }
  let q = pts[id.x];
  outP[id.x] = underCover(q.xyz, vec3<f32>(0.0, 0.0, 1.0));
}
`;
    const dev = g.device;
    const k = makeCompute(dev, 'undercover probe', [commonWgsl, layersWgsl, materialsWgsl, probe], { 0: 'uniform', 1: 'read', 2: 'uniform', 11: 'read', 40: 'rw', 41: 'read' }, 'probe');
    // the points: open ground, the cave's floor at its middle, near its mouth, the roof's top
    const at = (x: number, y: number, z: number) => [...cellPos(x, y), z, 0];
    const P = new Float32Array([...at(3, 3, 10), ...at(16, 16, 10), ...at(9, 16, 10), ...at(16, 16, 20)]);
    const pts = dev.createBuffer({ size: P.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(pts, 0, P);
    const out = dev.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const W = w.core.world;
    const enc = dev.createCommandEncoder();
    const cp = enc.beginComputePass();
    cp.setPipeline(k.pipeline);
    cp.setBindGroup(0, makeBindGroup(dev, 'undercover probe', k.layout, { 0: W.globals, 1: W.chunks, 2: W.materials, 11: W.surface, 40: out, 41: pts }));
    cp.dispatchWorkgroups(1);
    cp.end();
    dev.queue.submit([enc.finish()]);
    const v = new Float32Array(await g.read(out, 16));
    if (process.env.TERRAIN_LOG) console.log(`underCover: open ${v[0]}, cave middle ${v[1]}, by the mouth ${v[2]}, on the roof ${v[3]}`);
    expect(g.takeErrors()).toEqual([]);
    expect(v[0]).toBe(0);
    expect(v[3]).toBe(0);
    expect(v[1]).toBeGreaterThan(0.5);
    expect(v[2]).toBeGreaterThan(0);
    expect(v[2]).toBeLessThan(v[1]);
    w.destroy();
  });
});
