// (round 117, flora) vegplan.wgsl's trees and the CPU port in api/plants.ts must agree (birds perch, leaves fall and
// trees are felled where the GPU draws them). Never tested before; now on Dawn: a kernel runs vegPlan over a 64×64
// window with a ramp of succession and a world origin, and every column's tree (or none), species, trunk and crown is
// compared with planTree. Also the birch woods (birchWood) exactly.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { makeBindGroup, makeCompute } from '../../src/gpu/pipeline';
import commonWgsl from '../../src/shaders/common.wgsl?raw';
import materialsWgsl from '../../src/shaders/materials.wgsl?raw';
import vegplanWgsl from '../../src/shaders/vegplan.wgsl?raw';
import { GLOBALS_BYTES } from '../../src/sim/globals';
import { packMaterialTable } from '../../src/world/materials';
import { birchWood, planTree } from '../../src/api/plants';
import { testGpu, type TestGpu } from './dawn';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

const W = 64;
const H = 64;
const KERNEL = /* wgsl */ `
@group(0) @binding(3) var<storage, read_write> outv: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> vin: array<f32>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= ${W}u || id.y >= ${H}u) { return; }
  let i = id.y * ${W}u + id.x;
  let pl = vegPlan(id.x, id.y, vin[i], 0u);
  outv[i * 2u] = vec4<f32>(select(0.0, 1.0, pl.tree), f32(pl.species), pl.trunk, pl.crown);
  outv[i * 2u + 1u] = vec4<f32>(birchWood(id.x, id.y), 0.0, 0.0, 0.0);
}
`;

test('vegPlan (GPU) and planTree (CPU) put the same trees in the same places', async () => {
  const dev = g.device;
  // a window far into the world (the origin goes into every hash), succession ramping 3.4 → 5.4 across it
  const org: [number, number] = [-1234, 5678];
  const glob = new ArrayBuffer(GLOBALS_BYTES);
  const u = new Uint32Array(glob);
  const f = new Float32Array(glob);
  u[0] = W;
  u[1] = H;
  f[276] = org[0];
  f[277] = org[1] * (Math.sqrt(3) / 2);
  f[278] = org[0];
  f[279] = org[1];
  const v = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) v[y * W + x] = 3.4 + (2 * (x + y)) / (W + H);
  const mk = (size: number, usage: number, data?: ArrayBufferView | ArrayBuffer) => {
    const b = dev.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST });
    if (data) dev.queue.writeBuffer(b, 0, data as ArrayBuffer);
    return b;
  };
  const mats = packMaterialTable();
  const k = makeCompute(dev, 'flora-plan', [commonWgsl, materialsWgsl, vegplanWgsl, KERNEL], { 0: 'uniform', 2: 'uniform', 3: 'rw', 4: 'read' });
  const out = mk(W * H * 32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const bg = makeBindGroup(dev, 'flora-plan', k.layout, {
    0: mk(GLOBALS_BYTES, GPUBufferUsage.UNIFORM, glob),
    2: mk(mats.byteLength, GPUBufferUsage.UNIFORM, mats),
    3: out,
    4: mk(v.byteLength, GPUBufferUsage.STORAGE, v),
  });
  const enc = dev.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(k.pipeline);
  pass.setBindGroup(0, bg);
  pass.dispatchWorkgroups(W / 8, H / 8);
  pass.end();
  dev.queue.submit([enc.finish()]);
  const r = new Float32Array(await g.read(out, W * H * 32));
  expect(g.takeErrors()).toEqual([]);
  const SP = ['broadleaf', 'conifer', 'birch', 'giant'];
  let trees = 0;
  let birches = 0;
  let maxWood = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const t = planTree(x, y, v[i], W, H, org);
      const gpu = r.subarray(i * 8, i * 8 + 8);
      expect(gpu[4]).toBeCloseTo(birchWood(x, y, org), 4);
      maxWood = Math.max(maxWood, gpu[4]);
      expect(gpu[0] === 1, `tree at ${x},${y}`).toBe(!!t);
      if (!t) continue;
      trees++;
      if (t.species === 'birch') birches++;
      expect(SP[gpu[1]], `species at ${x},${y}`).toBe(t.species);
      expect(gpu[2]).toBe(t.trunk);
      expect(gpu[3]).toBe(t.crown);
    }
  expect(trees).toBeGreaterThan(40);
  expect(birches).toBeGreaterThan(0);
});

test('birch woods exist: a world-scale patchwork, about a fifth of the land in one', () => {
  let inWood = 0;
  const N = 200;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (birchWood(x * 8, y * 8, [0, 0]) > 0.5) inWood++;
  const share = inWood / (N * N);
  expect(share).toBeGreaterThan(0.08);
  expect(share).toBeLessThan(0.4);
});
