// Round 104 (`slidehitch`): rectangles of u32 words moved between buffers by a compute kernel, one dispatch a
// rectangle, instead of one copyBufferToBuffer a row. A region's per-column buffers are 64-row rectangles of the
// window's (row stride W columns) and packed rows in a pool slot: as copies that was ~800 commands a region, ~6 400
// for a strip of eight frozen and as many thawed — on the desktop's D3D11 each copy a command of its own, the slide's
// frame held 100–200 ms by them (DEVLOG round 104). As dispatches: ~13 a region.
//
//   const rc = new RegionCopier(device)
//   rc.rect({ src, srcOff, srcRow, dst, dstOff, dstRow, rowWords, rows, planes, srcPlane, dstPlane })
//   rc.encode(enc)        // one compute pass with every rectangle queued since the last encode, in order
//
// Offsets and strides are in words (4 bytes). A buffer is never both a rectangle's source and destination.

const WG = 64;
/** a rectangle's parameters, one 256-byte slot each in a ring (uniform dynamic offsets) */
const SLOT = 256;
const RING = 4096;

const CODE = /* wgsl */ `
struct P {
  srcOff: u32, dstOff: u32, rowWords: u32, rows: u32,
  srcRow: u32, dstRow: u32, srcPlane: u32, dstPlane: u32,
};
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= p.rowWords || g.y >= p.rows) { return; }
  dst[p.dstOff + g.z * p.dstPlane + g.y * p.dstRow + g.x] = src[p.srcOff + g.z * p.srcPlane + g.y * p.srcRow + g.x];
}
`;

export interface Rect {
  src: GPUBuffer;
  srcOff: number;
  srcRow: number;
  dst: GPUBuffer;
  dstOff: number;
  dstRow: number;
  rowWords: number;
  rows: number;
  planes?: number;
  srcPlane?: number;
  dstPlane?: number;
  /** a buffer let go soon (a pool's temp slot): its bind group isn't kept */
  once?: boolean;
}

export class RegionCopier {
  private pipeline: GPUComputePipeline;
  private layout: GPUBindGroupLayout;
  private params: GPUBuffer;
  private at = 0;
  private queued: Rect[] = [];
  private groups = new WeakMap<GPUBuffer, Map<GPUBuffer, GPUBindGroup>>();
  private host = new Uint32Array(SLOT / 4);
  /** rectangles and passes encoded so far */
  readonly stats = { rects: 0, passes: 0 };

  constructor(private device: GPUDevice) {
    this.layout = device.createBindGroupLayout({
      label: 'regionCopy',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 32 } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    this.pipeline = device.createComputePipeline({
      label: 'regionCopy',
      layout: device.createPipelineLayout({ label: 'regionCopy', bindGroupLayouts: [this.layout] }),
      compute: { module: device.createShaderModule({ label: 'regionCopy', code: CODE }), entryPoint: 'main' },
    });
    this.params = device.createBuffer({ label: 'regionCopy params', size: SLOT * RING, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /** A rectangle queued for the next encode (on the same encoder: queue, then encode). */
  rect(r: Rect): void {
    if (r.src === r.dst) throw new Error('regionCopy: a rectangle within one buffer');
    this.queued.push(r);
  }

  /** Every rectangle queued, in one compute pass of `enc` (nothing when none); their parameters in one write. */
  encode(enc: GPUCommandEncoder): void {
    const n = this.queued.length;
    if (!n) return;
    if (n > RING) throw new Error(`regionCopy: ${n} rectangles in one pass (room for ${RING})`);
    // (the ring: what an encoder not submitted yet holds is never written over — a slide queues a few hundred)
    if (this.at + n > RING) this.at = 0;
    const W = SLOT / 4;
    if (this.host.length < n * W) this.host = new Uint32Array(n * W);
    const h = this.host;
    this.queued.forEach((r, k) => {
      const o = k * W;
      h[o] = r.srcOff;
      h[o + 1] = r.dstOff;
      h[o + 2] = r.rowWords;
      h[o + 3] = r.rows;
      h[o + 4] = r.srcRow;
      h[o + 5] = r.dstRow;
      h[o + 6] = r.srcPlane ?? 0;
      h[o + 7] = r.dstPlane ?? 0;
    });
    const base = this.at;
    this.at += n;
    this.device.queue.writeBuffer(this.params, base * SLOT, h, 0, n * W);
    const pass = enc.beginComputePass({ label: 'regionCopy' });
    pass.setPipeline(this.pipeline);
    this.queued.forEach((r, k) => {
      pass.setBindGroup(0, this.group(r), [(base + k) * SLOT]);
      pass.dispatchWorkgroups(Math.ceil(r.rowWords / WG), r.rows, r.planes ?? 1);
    });
    pass.end();
    this.stats.rects += n;
    this.stats.passes++;
    this.queued.length = 0;
  }

  private group(r: Rect): GPUBindGroup {
    const make = () =>
      this.device.createBindGroup({
        label: 'regionCopy',
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.params, size: 32 } },
          { binding: 1, resource: { buffer: r.src } },
          { binding: 2, resource: { buffer: r.dst } },
        ],
      });
    if (r.once) return make();
    let m = this.groups.get(r.src);
    if (!m) this.groups.set(r.src, (m = new Map()));
    let g = m.get(r.dst);
    if (!g) m.set(r.dst, (g = make()));
    return g;
  }
}
