// The agents' road bits from shapes (round 128i, FT-58; the user: "everything should be instanced without CPU
// readback"). An owner (the fortress: its lanes and roads, fortress/lanes.ts) hands the agents its road shapes in its
// own grid's frame, once a change, and where that frame sits in the window (whole columns and rows); the bits a step's
// cost reads (agents.wgsl `roads`, ROAD_COST) are stamped from them on the GPU (shaders/roadstamp.wgsl), again only
// when the shapes or the offset change — a slide moves the offset, nothing is remade on the CPU, nothing read back.
// `roadBitsCpu` is the same rule on the CPU: the GPU's reference (test/gpu/roadstamp.test.ts) and the unit tests'.
import { makeBindGroup, makeCompute, type ComputeKernel } from '../gpu/pipeline';
import roadstampWgsl from '../shaders/roadstamp.wgsl?raw';
import { ROW_H } from '../world/lattice';

type P = readonly [number, number];

/** a road shape: a band (a capsule a→b of radius half) or a paved patch (a convex quad grown by half) */
export type RoadShape = { a: P; b: P; half: number } | { quad: readonly [P, P, P, P]; half?: number };

/** floats a shape packs to (three vec4s: a b | c d | half kind) */
export const ROAD_SHAPE_FLOATS = 12;

export function packRoadShapes(shapes: readonly RoadShape[]): Float32Array {
  const out = new Float32Array(shapes.length * ROAD_SHAPE_FLOATS);
  shapes.forEach((s, i) => {
    const o = i * ROAD_SHAPE_FLOATS;
    if ('quad' in s) {
      const [a, b, c, d] = s.quad;
      out.set([a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1], s.half ?? 0, 1, 0, 0], o);
    } else out.set([s.a[0], s.a[1], s.b[0], s.b[1], 0, 0, 0, 0, s.half, 0, 0, 0], o);
  });
  return out;
}

const segDist = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / Math.max(dx * dx + dy * dy, 1e-12)));
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
};

/** how far inside packed shape i point (x, y) is (>= 0: in) — roadstamp.wgsl rsInside */
export function roadInside(p: Float32Array, i: number, x: number, y: number): number {
  const o = i * ROAD_SHAPE_FLOATS;
  const half = p[o + 8];
  const [ax, ay, bx, by] = [p[o], p[o + 1], p[o + 2], p[o + 3]];
  if (p[o + 9] < 0.5) return half - segDist(x, y, ax, ay, bx, by);
  const [cx, cy, dx, dy] = [p[o + 4], p[o + 5], p[o + 6], p[o + 7]];
  const cr = (x0: number, y0: number, x1: number, y1: number) => (x1 - x0) * (y - y0) - (y1 - y0) * (x - x0);
  const s = [cr(ax, ay, bx, by), cr(bx, by, cx, cy), cr(cx, cy, dx, dy), cr(dx, dy, ax, ay)];
  const e = Math.min(segDist(x, y, ax, ay, bx, by), segDist(x, y, bx, by, cx, cy), segDist(x, y, cx, cy, dx, dy), segDist(x, y, dx, dy, ax, ay));
  const inq = s.every((v) => v >= 0) || s.every((v) => v <= 0);
  return inq ? half + e : half - e;
}

/**
 * The road bits on the CPU (the GPU's rule): per window column (y·w + x) whether its middle lies in a shape, the shapes
 * at window offset (ox, oy) — whole columns and rows, oy even.
 */
export function roadBitsCpu(shapes: Float32Array, ox: number, oy: number, w: number, h: number): Uint32Array {
  const bits = new Uint32Array(Math.ceil((w * h) / 32));
  const n = shapes.length / ROAD_SHAPE_FLOATS;
  const fx = ox;
  const fy = oy * ROW_H;
  for (let i = 0; i < n; i++) {
    const o = i * ROAD_SHAPE_FLOATS;
    const quad = shapes[o + 9] > 0.5;
    const xs = quad ? [shapes[o], shapes[o + 2], shapes[o + 4], shapes[o + 6]] : [shapes[o], shapes[o + 2]];
    const ys = quad ? [shapes[o + 1], shapes[o + 3], shapes[o + 5], shapes[o + 7]] : [shapes[o + 1], shapes[o + 3]];
    const half = shapes[o + 8];
    const y0 = Math.max(Math.floor((Math.min(...ys) - half + fy) / ROW_H - 0.5), 0);
    const y1 = Math.min(Math.ceil((Math.max(...ys) + half + fy) / ROW_H - 0.5), h - 1);
    const x0 = Math.max(Math.floor(Math.min(...xs) - half + fx - 1), 0);
    const x1 = Math.min(Math.ceil(Math.max(...xs) + half + fx), w - 1);
    if (y1 - y0 > 64 || x1 - x0 > 64) continue;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5 + 0.5 * (y & 1) - fx;
        const py = (y + 0.5) * ROW_H - fy;
        if (roadInside(shapes, i, px, py) >= 0) {
          const k = y * w + x;
          bits[k >> 5] |= 1 << (k & 31);
        }
      }
  }
  return bits;
}

const RP_BYTES = 32;

/** The stamp on the GPU: `set` the shapes and their offset; `encode` makes the bits again when either changed. */
export class RoadStamp {
  private clearK: ComputeKernel;
  private stampK: ComputeKernel;
  private shapesBuf: GPUBuffer;
  private cap = 0;
  private params: GPUBuffer;
  private group: GPUBindGroup | null = null;
  private shapes: Float32Array = new Float32Array(0);
  private off: [number, number] = [0, 0];
  private dirty = true;
  readonly words: number;

  constructor(
    private device: GPUDevice,
    private bits: GPUBuffer,
    private w: number,
    private h: number,
  ) {
    this.words = Math.ceil((w * h) / 32);
    const spec = { 40: 'rw', 41: 'read', 42: 'uniform' } as const;
    this.clearK = makeCompute(device, 'agents-roadClear', [roadstampWgsl], spec, 'roadClear');
    this.stampK = makeCompute(device, 'agents-roadStamp', [roadstampWgsl], spec, 'roadStamp');
    this.params = device.createBuffer({ label: 'agents road params', size: RP_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.shapesBuf = this.grow(256);
  }

  private grow(n: number): GPUBuffer {
    this.shapesBuf?.destroy();
    this.cap = n;
    this.shapesBuf = this.device.createBuffer({ label: 'agents road shapes', size: n * ROAD_SHAPE_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.group = makeBindGroup(this.device, 'agents-roads', this.clearK.layout, { 40: this.bits, 41: this.shapesBuf, 42: this.params });
    return this.shapesBuf;
  }

  /** the shapes (packRoadShapes; the same array again: unchanged) at window offset (ox, oy); true if anything changed */
  set(shapes: Float32Array, ox: number, oy: number): boolean {
    if (shapes === this.shapes && ox === this.off[0] && oy === this.off[1]) return false;
    if (oy % 2) throw new Error(`roads: the shapes' row offset ${oy} must be even (the rows' stagger)`);
    const n = shapes.length / ROAD_SHAPE_FLOATS;
    if (shapes !== this.shapes) {
      if (n > this.cap) this.grow(Math.max(n, this.cap * 2));
      if (n) this.device.queue.writeBuffer(this.shapesBuf, 0, shapes);
    }
    this.shapes = shapes;
    this.off = [ox, oy];
    this.dirty = true;
    return true;
  }

  /** the bits made again if the shapes or their offset changed (a pass of its own) */
  encode(enc: GPUCommandEncoder): void {
    if (!this.dirty) return;
    this.dirty = false;
    const n = this.shapes.length / ROAD_SHAPE_FLOATS;
    const u = new ArrayBuffer(RP_BYTES);
    new Uint32Array(u, 0, 4).set([n, this.w, this.h, this.words]);
    new Int32Array(u, 16, 2).set(this.off);
    this.device.queue.writeBuffer(this.params, 0, u);
    const pass = enc.beginComputePass({ label: 'agents roads' });
    pass.setBindGroup(0, this.group!);
    pass.setPipeline(this.clearK.pipeline);
    pass.dispatchWorkgroups(Math.ceil(this.words / 64));
    if (n) {
      pass.setPipeline(this.stampK.pipeline);
      pass.dispatchWorkgroups(Math.ceil(n / 64));
    }
    pass.end();
  }
}
