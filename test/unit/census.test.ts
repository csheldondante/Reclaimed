// The frame census's counter (src/perf/census.ts): what it counts, who a call belongs to, the per-frame averages and
// the phone's cost model. Fake WebGPU classes stand in for the page's: the wrapping is by prototype and method name.
import { expect, test } from 'vitest';
import { Census, copyBytes, estimateMs, installCensus, PHONE_MODEL, uploadBytes, zero, type GpuClasses } from '../../src/gpu/census';

class Pass {
  calls: string[] = [];
  dispatchWorkgroups(): void {
    this.calls.push('d');
  }
  dispatchWorkgroupsIndirect(): void {
    this.calls.push('i');
  }
  draw(): void {}
  drawIndexed(): void {}
  drawIndirect(): void {}
  drawIndexedIndirect(): void {}
}
class Encoder {
  beginComputePass(_d?: { label?: string }): Pass {
    return new Pass();
  }
  beginRenderPass(_d?: { label?: string }): Pass {
    return new Pass();
  }
  clearBuffer(_b: unknown, _o?: number, _s?: number): void {}
  copyBufferToBuffer(..._a: unknown[]): void {}
  copyTextureToTexture(..._a: unknown[]): void {}
}
class Queue {
  writeBuffer(..._a: unknown[]): void {}
  submit(): void {}
}
class Buffer {
  constructor(
    public label: string,
    public size: number,
  ) {}
  mapAsync(_mode: number, _o?: number, _s?: number): Promise<void> {
    return Promise.resolve();
  }
}
class Device {
  createBindGroup(_d: unknown): object {
    return {};
  }
  createComputePipeline(_d: unknown): object {
    return {};
  }
}
/** fresh classes a test (the wrapping changes prototypes) */
function fakes(): GpuClasses & { E: typeof Encoder; Q: typeof Queue; B: typeof Buffer; D: typeof Device } {
  const E = class extends Encoder {};
  const P = class extends Pass {};
  E.prototype.beginComputePass = () => new P();
  E.prototype.beginRenderPass = () => new P();
  const Q = class extends Queue {};
  const B = class extends Buffer {};
  const D = class extends Device {};
  // (the wrapped methods must be the class's own or inherited functions: both are found by name on the prototype)
  return { GPUCommandEncoder: E, GPUComputePassEncoder: P, GPURenderPassEncoder: P, GPUQueue: Q, GPUBuffer: B, GPUDevice: D, E, Q, B, D };
}

test('passes, direct and indirect dispatches and draws are counted under the scope that began the pass', () => {
  const c = new Census();
  const G = fakes();
  const undo = installCensus(c, G);
  const enc = new G.E();
  const d = c.enter('water');
  const p = enc.beginComputePass({ label: 'water-flux' });
  c.leave(d);
  // (the scope has closed: the pass's dispatches still belong to water)
  p.dispatchWorkgroups();
  p.dispatchWorkgroups();
  p.dispatchWorkgroupsIndirect();
  const r = enc.beginRenderPass({ label: 'draw' });
  r.draw();
  r.drawIndexedIndirect();
  c.endFrame();
  const rep = c.take();
  const water = rep.systems.find((s) => s.system === 'water')!;
  expect(water).toMatchObject({ computePasses: 1, direct: 2, indirect: 1 });
  expect(water.labels[0].label).toBe('water-flux');
  // (no scope open: a pass is its own label's)
  expect(rep.systems.find((s) => s.system === '(draw)')).toMatchObject({ renderPasses: 1, draws: 1, drawsIndirect: 1 });
  undo();
  // (unwrapped: nothing more is counted)
  new G.E().beginComputePass({ label: 'x' }).dispatchWorkgroups();
  c.endFrame();
  expect(c.take().total.direct).toBe(0);
});

test('the wrapped call still runs and returns what it returned', () => {
  const c = new Census();
  const G = fakes();
  installCensus(c, G);
  const p = new G.E().beginComputePass({ label: 'a' });
  p.dispatchWorkgroupsIndirect();
  expect((p as Pass).calls).toEqual(['i']);
});

test('copies, clears, uploads and reads are counted with their bytes, by buffer label', async () => {
  const c = new Census();
  const G = fakes();
  installCensus(c, G, 1);
  const enc = new G.E();
  const a = new G.B('a', 4096);
  const b = new G.B('stats staging', 256);
  enc.copyBufferToBuffer(a, 0, b, 0, 256);
  enc.copyBufferToBuffer(a, b);
  enc.clearBuffer(a, 96);
  new G.Q().writeBuffer(a, 0, new Uint32Array(16), 4, 8);
  new G.Q().writeBuffer(a, 0, new ArrayBuffer(100));
  new G.Q().submit();
  await b.mapAsync(1, 0, 64);
  await b.mapAsync(1);
  // (a write map is no read)
  await b.mapAsync(2);
  c.endFrame();
  const t = c.take().total;
  expect(t).toMatchObject({ copies: 2, copyBytes: 256 + 4096, clears: 1, clearBytes: 4000, uploads: 2, uploadBytes: 32 + 100, reads: 2, readBytes: 64 + 256, submits: 1 });
});

test('sizes: typed arrays count elements, the short copy overload the whole source', () => {
  expect(uploadBytes(new Float32Array(10))).toBe(40);
  expect(uploadBytes(new Float32Array(10), 2)).toBe(32);
  expect(uploadBytes(new Float32Array(10), 2, 3)).toBe(12);
  expect(uploadBytes(new ArrayBuffer(64), 0, 24)).toBe(24);
  expect(copyBytes([{ size: 100 }, 20, {}, 0])).toBe(80);
  expect(copyBytes([{ size: 100 }, {}])).toBe(100);
});

test('things made in a frame (bind groups, pipelines) are counted', () => {
  const c = new Census();
  const G = fakes();
  installCensus(c, G);
  const dev = new G.D();
  const d = c.enter('fieldmesh');
  dev.createBindGroup({ label: 'g' });
  dev.createComputePipeline({ label: 'k' });
  c.leave(d);
  c.endFrame();
  expect(c.take().systems[0]).toMatchObject({ system: 'fieldmesh', bindGroups: 1, pipelines: 1 });
});

test('a report is per-frame averages, with the ticks a frame; take resets', () => {
  const c = new Census();
  for (let f = 0; f < 4; f++) {
    if (f % 2 === 0) c.tick();
    c.count('x', 'indirect', 3);
    c.endFrame();
  }
  const r = c.take();
  expect(r.frames).toBe(4);
  expect(r.ticksPerFrame).toBe(0.5);
  expect(r.total.indirect).toBe(3);
  expect(c.take().frames).toBe(0);
});

test('scopes nest, and a scope left open by a throw ends with its frame', () => {
  const c = new Census();
  const a = c.enter('sim');
  const b = c.enter('water');
  expect(c.systemOf('p')).toBe('water');
  c.leave(b);
  expect(c.systemOf('p')).toBe('sim');
  c.leave(a);
  expect(c.systemOf('p')).toBe('(p)');
  c.enter('leaked');
  c.endFrame();
  expect(c.systemOf('p')).toBe('(p)');
});

test("the phone's model: 65 indirect dispatches in their own passes are the measured ~6.5 ms plus the passes", () => {
  const row = { ...zero(), indirect: 65, computePasses: 65 };
  expect(estimateMs(row)).toBeCloseTo(65 * PHONE_MODEL.indirect + 65 * PHONE_MODEL.pass, 6);
  // (65 direct in one pass: the measured 0.5 ms)
  expect(estimateMs({ ...zero(), direct: 65, computePasses: 1 })).toBeCloseTo(0.54, 2);
  // (a 2 MB read: the measured 20-35 ms)
  const read = estimateMs({ ...zero(), reads: 1, readBytes: 2 * 1048576 });
  expect(read).toBeGreaterThan(20);
  expect(read).toBeLessThan(35);
});

test('systems are ranked by estimated phone ms', () => {
  const c = new Census();
  c.count('cheap', 'direct', 10);
  c.count('dear', 'indirect', 10);
  c.endFrame();
  expect(c.take().systems.map((s) => s.system)).toEqual(['(dear)', '(cheap)']);
});
