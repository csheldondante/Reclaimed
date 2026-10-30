// The gpu tier's self-check (as contract.ts `stamp`): a kernel made the engine's way — common.wgsl prepended,
// gpu/pipeline.ts makeCompute/makeBindGroup — runs on Dawn in Node and reports the constants it was compiled with.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { makeBindGroup, makeCompute } from '../../src/gpu/pipeline';
import { ROW_H } from '../../src/world/lattice';
import commonWgsl from '../../src/shaders/common.wgsl?raw';
import probeWgsl from '../../src/test/probe.wgsl?raw';
import { testGpu, type TestGpu } from './dawn';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

test('a kernel with common.wgsl prepended runs and reports its constants', async () => {
  const dev = g.device;
  const k = makeCompute(dev, 'probe', [commonWgsl, probeWgsl], { 3: 'rw' });
  const buf = dev.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const enc = dev.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(k.pipeline);
  pass.setBindGroup(0, makeBindGroup(dev, 'probe', k.layout, { 3: buf }));
  pass.dispatchWorkgroups(1);
  pass.end();
  dev.queue.submit([enc.finish()]);
  const v = new Float32Array(await g.read(buf, 16));
  expect(g.takeErrors()).toEqual([]);
  expect(v[0]).toBe(1);
  expect(v[1]).toBeCloseTo(ROW_H, 6);
});
