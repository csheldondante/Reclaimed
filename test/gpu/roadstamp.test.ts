// (round 128i, FT-58) The agents' road bits stamped on the GPU from shapes (agents/roads.ts, shaders/roadstamp.wgsl)
// equal the CPU's rule (roadBitsCpu) column for column — bands and paved quads, at an offset and after a slide moves
// only the offset — but for columns whose middle lies within a hair of a shape's edge (f32 against f64).
import { describe, expect, test } from 'vitest';
import { packRoadShapes, roadBitsCpu, roadInside, RoadStamp, ROAD_SHAPE_FLOATS, type RoadShape } from '../../src/agents/roads';
import { ROW_H } from '../../src/world/lattice';
import { testGpu } from './dawn';

const W = 96;
const H = 80;

function shapes(seed: number): RoadShape[] {
  let s = seed;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const out: RoadShape[] = [];
  for (let i = 0; i < 300; i++) {
    const x = r() * 90 - 10;
    const y = r() * 70 - 10;
    if (i % 5 === 4) {
      const a = r() * Math.PI;
      const c = Math.cos(a) * 3;
      const d = Math.sin(a) * 3;
      out.push({ quad: [[x - c, y - d], [x + d, y - c], [x + c, y + d], [x - d, y + c]] });
    } else out.push({ a: [x, y], b: [x + (r() - 0.5) * 8, y + (r() - 0.5) * 8], half: 0.4 + r() * 1.0 });
  }
  return out;
}

/** columns where the CPU and GPU differ, but for those within EPS of an edge */
function differ(gpu: Uint32Array, cpu: Uint32Array, packed: Float32Array, ox: number, oy: number): number {
  let bad = 0;
  const n = packed.length / ROAD_SHAPE_FLOATS;
  for (let k = 0; k < W * H; k++) {
    const g = (gpu[k >> 5] >>> (k & 31)) & 1;
    const c = (cpu[k >> 5] >>> (k & 31)) & 1;
    if (g === c) continue;
    const x = k % W;
    const y = Math.floor(k / W);
    const px = x + 0.5 + 0.5 * (y & 1) - ox;
    const py = (y + 0.5) * ROW_H - oy * ROW_H;
    let edge = false;
    for (let i = 0; i < n && !edge; i++) edge = Math.abs(roadInside(packed, i, px, py)) < 1e-3;
    if (!edge) bad++;
  }
  return bad;
}

describe('road bits stamped on the GPU', () => {
  test('equal the CPU rule, at an offset and after a slide', async () => {
    const g = await testGpu();
    const dev = g.device;
    const words = Math.ceil((W * H) / 32);
    const bits = dev.createBuffer({ size: words * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    const stamp = new RoadStamp(dev, bits, W, H);
    const packed = packRoadShapes(shapes(7));
    let total = 0;
    for (const [ox, oy] of [[0, 0], [5, 4], [-7, -2]] as const) {
      expect(stamp.set(packed, ox, oy)).toBe(true);
      const enc = dev.createCommandEncoder();
      stamp.encode(enc);
      dev.queue.submit([enc.finish()]);
      const gpu = new Uint32Array(await g.read(bits, words * 4));
      const cpu = roadBitsCpu(packed, ox, oy, W, H);
      const on = cpu.reduce((s, v) => s + (v.toString(2).match(/1/g)?.length ?? 0), 0);
      total += on;
      expect(on).toBeGreaterThan(300);
      expect(differ(gpu, cpu, packed, ox, oy)).toBe(0);
    }
    // the same shapes and offset again: nothing to do
    expect(stamp.set(packed, -7, -2)).toBe(false);
    // none: every bit cleared
    stamp.set(new Float32Array(0), 0, 0);
    const enc = dev.createCommandEncoder();
    stamp.encode(enc);
    dev.queue.submit([enc.finish()]);
    expect(new Uint32Array(await g.read(bits, words * 4)).every((v) => v === 0)).toBe(true);
    expect(total).toBeGreaterThan(0);
    expect(g.takeErrors()).toEqual([]);
  });
});
