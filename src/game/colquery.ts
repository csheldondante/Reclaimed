// (round 120, JB6: "no CPU readback on the hot path") Small questions asked of the GPU's columns in place
// (shaders/colquery.wgsl): how many columns of each box hold one of some materials — a few bytes back instead of the
// boxes' columns. The integrity system asks it whether the structures' analyse (fracture.ts analyse) has anything built
// to look at in a box before it reads that box. test/gpu/colapply.test.ts holds it to a count over the CPU's columns.
import colqueryWgsl from '../shaders/colquery.wgsl?raw';
import { makeBindGroup, makeLayout } from '../gpu/pipeline';
import { CHUNK } from '../world/layout';
import type { GpuColumns } from './colapply';

const BINDS = { 0: 'uniform', 1: 'read', 2: 'read', 3: 'read', 4: 'rw' } as const;
const MAX_X = 65535;

export class ColumnQuery {
  private layout: GPUBindGroupLayout;
  private pipe: GPUComputePipeline;
  /** bytes read back by the last query */
  lastBytes = 0;

  constructor(private device: GPUDevice) {
    this.layout = makeLayout(device, 'colquery', BINDS, GPUShaderStage.COMPUTE);
    const module = device.createShaderModule({ label: 'colquery.wgsl', code: colqueryWgsl });
    this.pipe = device.createComputePipeline({ label: 'colquery count', layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }), compute: { module, entryPoint: 'count' } });
  }

  /**
   * For each box (window columns x0, y0, x1, y1, inclusive; clamped to the window), how many of its columns hold an
   * interval of a material `mask` says yes to. Read back when the GPU has done (the columns as they are then).
   */
  async count(cols: GpuColumns, boxes: [number, number, number, number][], mask: (m: number) => boolean): Promise<number[]> {
    if (!boxes.length) return [];
    const { packed } = cols;
    const W = packed.dims.w;
    const H = packed.dims.h;
    const clamped = boxes.map(([x0, y0, x1, y1]) => [Math.max(0, Math.floor(x0)), Math.max(0, Math.floor(y0)), Math.min(W - 1, Math.ceil(x1)), Math.min(H - 1, Math.ceil(y1))] as const);
    const words: number[] = [];
    for (const b of clamped) words.push(...b);
    const startOff = words.length;
    let t = 0;
    for (const [x0, y0, x1, y1] of clamped) {
      words.push(t);
      t += x1 >= x0 && y1 >= y0 ? (x1 - x0 + 1) * (y1 - y0 + 1) : 0;
    }
    words.push(t);
    const maskOff = words.length;
    const mw = new Uint32Array(8);
    for (let m = 0; m < 256; m++) if (mask(m)) mw[m >> 5] |= 1 << (m & 31);
    words.push(...mw);
    const dev = this.device;
    const inp = dev.createBuffer({ label: 'colquery input', size: words.length * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(inp, 0, new Uint32Array(words));
    const params = dev.createBuffer({ label: 'colquery params', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(params, 0, new Uint32Array([W, H, packed.chunksX, CHUNK, clamped.length, t, startOff, maskOff]));
    const out = dev.createBuffer({ label: 'colquery counts', size: Math.max(16, clamped.length * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const rd = dev.createBuffer({ label: 'colquery read', size: Math.max(16, clamped.length * 4), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = dev.createCommandEncoder({ label: 'colquery' });
    if (t > 0) {
      const pass = enc.beginComputePass({ label: 'colquery count' });
      pass.setPipeline(this.pipe);
      pass.setBindGroup(0, makeBindGroup(dev, 'colquery', this.layout, { 0: params, 1: cols.chunks, 2: cols.slots, 3: inp, 4: out }));
      const groups = Math.ceil(t / 64);
      pass.dispatchWorkgroups(Math.min(groups, MAX_X), Math.ceil(groups / MAX_X));
      pass.end();
    }
    enc.copyBufferToBuffer(out, 0, rd, 0, rd.size);
    dev.queue.submit([enc.finish()]);
    inp.destroy();
    params.destroy();
    out.destroy();
    try {
      await rd.mapAsync(GPUMapMode.READ);
      this.lastBytes = rd.size;
      return [...new Uint32Array(rd.getMappedRange()).slice(0, clamped.length)];
    } finally {
      rd.destroy();
    }
  }
}
