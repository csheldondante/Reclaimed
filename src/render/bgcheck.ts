// Round 112 (bgcheck): how much of the screen shows the background — the world pass's clear colour, where nothing
// (geometry, tile, far land) was drawn — and how much shows the flat far land (far.wgsl fsFar) where detail should be.
// The user: "Can we do a pan test for the phone that fails if any bg color shows?" / "Or flags it anyway".
//
// Only with ?bgcheck=1 (the pan bench's pages and scripts/tilegate.mjs ask for it): the renderer then keeps the world
// pass's depth and pick targets (stored, not discarded) and this samples them on a coarse grid (64 x 128 on a portrait
// screen, 128 x 64 on a landscape one) in one small compute pass a frame: a sample whose depth is still the clear (1.0)
// is background; one whose pick is (0, FAR_PICK_TAG) is the far land. Per frame the counts are folded into running
// totals on the GPU (frames, frames with any, samples summed, the worst frame); those are read back a few times a second
// (async, mapAsync) and zeroed. Without the flag nothing here exists and the world pass is as it was.

import { ignoreTeardown, makeLayout } from '../gpu/pipeline';

/** far.wgsl fsFar's pick (x 0: no column — Renderer.pick reads it as nothing — y this): the far land's pixels */
export const FAR_PICK_TAG = 0xfa000000;

export const BGCHECK = typeof location !== 'undefined' && new URLSearchParams(location.search).get('bgcheck') === '1';

/** running totals since the last take(): background (bg) and far land (far) */
export interface BgTotals {
  /** frames sampled */
  frames: number;
  /** samples a frame (the grid) */
  samples: number;
  bg: { framesAny: number; sum: number; max: number };
  far: { framesAny: number; sum: number; max: number };
}

/** a step's view of the totals: shares of the screen (0..1) */
export interface BgShares {
  frames: number;
  samples: number;
  bgMean: number;
  bgMax: number;
  bgFrames: number;
  farMean: number;
  farMax: number;
  farFrames: number;
}

export function bgShares(t: BgTotals): BgShares {
  const n = Math.max(1, t.frames) * t.samples;
  const r = (v: number) => Math.round(v * 1e5) / 1e5;
  return {
    frames: t.frames,
    samples: t.samples,
    bgMean: r(t.bg.sum / n),
    bgMax: r(t.bg.max / Math.max(1, t.samples)),
    bgFrames: t.bg.framesAny,
    farMean: r(t.far.sum / n),
    farMax: r(t.far.max / Math.max(1, t.samples)),
    farFrames: t.far.framesAny,
  };
}

const WGSL = /* wgsl */ `
@group(0) @binding(0) var depthT: texture_depth_2d;
@group(0) @binding(1) var pickT: texture_2d<u32>;
// 0 bg this frame, 1 far this frame; 2 frames, 3 frames with bg, 4 bg summed, 5 bg worst, 6 frames with far,
// 7 far summed, 8 far worst
@group(0) @binding(2) var<storage, read_write> acc: array<atomic<u32>, 16>;
// x cols, y rows, z the far land's pick tag
@group(0) @binding(3) var<uniform> P: vec4<u32>;
// each sample's class this frame (0 drawn, 1 background, 2 far land): where on the screen, for snapshot()
@group(0) @binding(4) var<storage, read_write> cls: array<u32>;

var<workgroup> wBg: atomic<u32>;
var<workgroup> wFar: atomic<u32>;

/** far.wgsl STAND_Z (the stand-in's depth) — keep the two the same */
const STAND_Z: f32 = 0.99999976;

@compute @workgroup_size(8, 8)
fn sampleGrid(@builtin(global_invocation_id) g: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  if (li == 0u) {
    atomicStore(&wBg, 0u);
    atomicStore(&wFar, 0u);
  }
  workgroupBarrier();
  if (g.x < P.x && g.y < P.y) {
    let dims = vec2<f32>(textureDimensions(depthT));
    let px = vec2<u32>(min((vec2<f32>(g.xy) + 0.5) / vec2<f32>(P.xy) * dims, dims - 1.0));
    let d = textureLoad(depthT, px, 0);
    let k = textureLoad(pickT, px, 0).xy;
    var c = 0u;
    // (round 113, tilesfirst: the stand-in — far.wgsl vsStandIn, at depth STAND_Z, just short of the clear — is the far
    // land's whatever is blended over it (the water's surface writes its own pick, not the depth))
    if (d >= 1.0) {
      atomicAdd(&wBg, 1u);
      c = 1u;
    } else if (d >= STAND_Z || (k.x == 0u && k.y == P.z)) {
      atomicAdd(&wFar, 1u);
      c = 2u;
    }
    cls[g.y * P.x + g.x] = c;
  }
  workgroupBarrier();
  if (li == 0u) {
    let b = atomicLoad(&wBg);
    let f = atomicLoad(&wFar);
    if (b > 0u) { atomicAdd(&acc[0], b); }
    if (f > 0u) { atomicAdd(&acc[1], f); }
  }
}

@compute @workgroup_size(1)
fn finishFrame() {
  let b = atomicExchange(&acc[0], 0u);
  let f = atomicExchange(&acc[1], 0u);
  atomicAdd(&acc[2], 1u);
  if (b > 0u) {
    atomicAdd(&acc[3], 1u);
    atomicAdd(&acc[4], b);
    atomicMax(&acc[5], b);
  }
  if (f > 0u) {
    atomicAdd(&acc[6], 1u);
    atomicAdd(&acc[7], f);
    atomicMax(&acc[8], f);
  }
}
`;

const ACC_BYTES = 64;
/** the largest grid (64 x 128) */
const MAX_SAMPLES = 64 * 128;
/** a readback this often (ms) */
const READ_EVERY = 250;

export class BgCheck {
  private layout: GPUBindGroupLayout;
  private sample: GPUComputePipeline;
  private finish: GPUComputePipeline;
  private acc: GPUBuffer;
  private read: GPUBuffer;
  private uni: GPUBuffer;
  private cls: GPUBuffer;
  private clsRead?: GPUBuffer;
  private snapWanted: ((m: { cols: number; rows: number; cls: Uint8Array }) => void)[] = [];
  private snapCopied: ((m: { cols: number; rows: number; cls: Uint8Array }) => void)[] = [];
  private group?: GPUBindGroup;
  private groupFor?: GPUTexture;
  private cols = 0;
  private rows = 0;
  private readAt = 0;
  private copied = false;
  private busy = false;
  private waiters: (() => void)[] = [];
  private totals: BgTotals = BgCheck.empty(0);

  constructor(private device: GPUDevice) {
    const module = device.createShaderModule({ label: 'bgcheck', code: WGSL });
    this.layout = makeLayout(device, 'bgcheck', { 0: 'depth', 1: 'utex', 2: 'rw', 3: 'uniform', 4: 'rw' }, GPUShaderStage.COMPUTE);
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    this.sample = device.createComputePipeline({ label: 'bgcheck-sample', layout, compute: { module, entryPoint: 'sampleGrid' } });
    this.finish = device.createComputePipeline({ label: 'bgcheck-finish', layout, compute: { module, entryPoint: 'finishFrame' } });
    this.acc = device.createBuffer({ label: 'bgcheck-acc', size: ACC_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this.read = device.createBuffer({ label: 'bgcheck-read', size: ACC_BYTES, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.uni = device.createBuffer({ label: 'bgcheck-uni', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.cls = device.createBuffer({ label: 'bgcheck-cls', size: MAX_SAMPLES * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  }

  private static empty(samples: number): BgTotals {
    return { frames: 0, samples, bg: { framesAny: 0, sum: 0, max: 0 }, far: { framesAny: 0, sum: 0, max: 0 } };
  }

  /** after the world pass: the frame's depth and pick (both stored) sampled, the counts folded into the totals */
  encode(enc: GPUCommandEncoder, depth: GPUTexture, pick: GPUTexture, timestamps?: GPUComputePassTimestampWrites): void {
    if (this.groupFor !== depth || !this.group) {
      const portrait = depth.height >= depth.width;
      this.cols = portrait ? 64 : 128;
      this.rows = portrait ? 128 : 64;
      this.device.queue.writeBuffer(this.uni, 0, new Uint32Array([this.cols, this.rows, FAR_PICK_TAG, 0]));
      this.group = this.device.createBindGroup({
        label: 'bgcheck',
        layout: this.layout,
        entries: [
          { binding: 0, resource: depth.createView() },
          { binding: 1, resource: pick.createView() },
          { binding: 2, resource: { buffer: this.acc } },
          { binding: 3, resource: { buffer: this.uni } },
          { binding: 4, resource: { buffer: this.cls } },
        ],
      });
      this.groupFor = depth;
    }
    const pass = enc.beginComputePass({ label: 'bgcheck', timestampWrites: timestamps });
    pass.setBindGroup(0, this.group);
    pass.setPipeline(this.sample);
    pass.dispatchWorkgroups(this.cols / 8, this.rows / 8);
    pass.setPipeline(this.finish);
    pass.dispatchWorkgroups(1);
    pass.end();
    const now = performance.now();
    if (!this.busy && (now - this.readAt >= READ_EVERY || this.waiters.length)) {
      enc.copyBufferToBuffer(this.acc, 0, this.read, 0, ACC_BYTES);
      enc.clearBuffer(this.acc, 8, ACC_BYTES - 8);
      this.copied = true;
      this.busy = true;
      this.readAt = now;
    }
    if (this.snapWanted.length && !this.snapCopied.length) {
      this.clsRead ??= this.device.createBuffer({ label: 'bgcheck-cls-read', size: MAX_SAMPLES * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      enc.copyBufferToBuffer(this.cls, 0, this.clsRead, 0, MAX_SAMPLES * 4);
      this.snapCopied = this.snapWanted;
      this.snapWanted = [];
    }
  }

  /** (a check's look) the next frame's samples: 0 drawn, 1 background, 2 far land; row-major, cols x rows */
  snapshot(): Promise<{ cols: number; rows: number; cls: Uint8Array }> {
    return new Promise((res) => this.snapWanted.push(res));
  }

  /** after submit: the readback asked for in encode */
  afterSubmit(): void {
    if (this.snapCopied.length && this.clsRead && this.clsRead.mapState === 'unmapped') {
      const take = this.snapCopied;
      const [cols, rows] = [this.cols, this.rows];
      this.clsRead.mapAsync(GPUMapMode.READ).then(() => {
        const u = new Uint32Array(this.clsRead!.getMappedRange().slice(0, cols * rows * 4));
        this.clsRead!.unmap();
        this.snapCopied = [];
        for (const f of take) f({ cols, rows, cls: Uint8Array.from(u) });
      }, ignoreTeardown);
    }
    if (!this.copied) return;
    this.copied = false;
    const waiting = this.waiters;
    this.waiters = [];
    this.read.mapAsync(GPUMapMode.READ).then(() => {
      const u = new Uint32Array(this.read.getMappedRange().slice(0));
      this.read.unmap();
      this.busy = false;
      const t = this.totals;
      t.samples = this.cols * this.rows;
      t.frames += u[2];
      t.bg.framesAny += u[3];
      t.bg.sum += u[4];
      t.bg.max = Math.max(t.bg.max, u[5]);
      t.far.framesAny += u[6];
      t.far.sum += u[7];
      t.far.max = Math.max(t.far.max, u[8]);
      for (const w of waiting) w();
    }, ignoreTeardown);
  }

  /** resolves once a readback that started after this call is in (every frame drawn before it counted) */
  sync(): Promise<void> {
    return new Promise((res) => this.waiters.push(res));
  }

  /** the totals since the last take(), and start again */
  take(): BgTotals {
    const t = this.totals;
    this.totals = BgCheck.empty(t.samples);
    return t;
  }
}
