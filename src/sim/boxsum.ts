// (DA-B13) Box means of a per-column texture's x channel, on the GPU: a few floats read back, not the texture. One
// workgroup a box sums its texels (where they lie on the ring: common.wgsl texCol) and writes the mean. For a reader
// that wants "how much is there over these boxes" — the menu's dust over its buried models — instead of reading the
// whole texture back and summing on the CPU.
import { makeBindGroup, makeCompute, type ComputeKernel } from '../gpu/pipeline';
import commonWgsl from '../shaders/common.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';

/** boxes a query at most */
export const MAX_BOXES = 64;

const SUM_WGSL = `
@group(0) @binding(40) var<storage, read> boxes: array<vec4<u32>>;
@group(0) @binding(41) var<storage, read_write> means: array<f32>;
@group(0) @binding(42) var src: texture_2d<f32>;
var<workgroup> part: array<f32, 64>;
@compute @workgroup_size(64)
fn boxMean(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let b = boxes[wg.x];
  let w = b.z - b.x;
  let n = w * (b.w - b.y);
  var s = 0.0;
  for (var k = li; k < n; k += 64u) {
    let p = vec2<i32>(i32(b.x + k % w), i32(b.y + k / w));
    s += textureLoad(src, texCol(p), 0).x;
  }
  part[li] = s;
  workgroupBarrier();
  for (var h = 32u; h > 0u; h /= 2u) {
    if (li < h) { part[li] += part[li + h]; }
    workgroupBarrier();
  }
  if (li == 0u) { means[wg.x] = select(part[0] / f32(n), 0.0, n == 0u); }
}
`;

export class BoxMeans {
  private k: ComputeKernel;
  private group: GPUBindGroup;
  private boxes: GPUBuffer;
  private means: GPUBuffer;
  private busy = false;
  constructor(
    private device: GPUDevice,
    globals: GPUBuffer,
    view: GPUTextureView,
  ) {
    // (common.wgsl's helpers name the material table: its declaration is in, nothing of it bound)
    this.k = makeCompute(device, 'box means', [commonWgsl, materialsWgsl, SUM_WGSL], { 0: 'uniform', 40: 'read', 41: 'rw', 42: 'tex' }, 'boxMean');
    this.boxes = device.createBuffer({ label: 'box means boxes', size: MAX_BOXES * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.means = device.createBuffer({ label: 'box means', size: MAX_BOXES * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.group = makeBindGroup(device, 'box means', this.k.layout, { 0: globals, 40: this.boxes, 41: this.means, 42: view });
  }

  /** each box's mean (window columns [x0, y0, x1, y1)), or null while the last query is in flight */
  query(boxes: [number, number, number, number][]): Promise<number[]> | null {
    if (this.busy || !boxes.length) return null;
    if (boxes.length > MAX_BOXES) throw new Error(`BoxMeans: ${boxes.length} boxes, at most ${MAX_BOXES}`);
    this.busy = true;
    const dev = this.device;
    dev.queue.writeBuffer(this.boxes, 0, new Uint32Array(boxes.flat()));
    const st = dev.createBuffer({ label: 'box means read', size: MAX_BOXES * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = dev.createCommandEncoder({ label: 'box means' });
    const pass = enc.beginComputePass({ label: 'box means' });
    pass.setPipeline(this.k.pipeline);
    pass.setBindGroup(0, this.group);
    pass.dispatchWorkgroups(boxes.length);
    pass.end();
    enc.copyBufferToBuffer(this.means, 0, st, 0, MAX_BOXES * 4);
    dev.queue.submit([enc.finish()]);
    return st.mapAsync(GPUMapMode.READ).then(
      () => {
        const out = [...new Float32Array(st.getMappedRange()).slice(0, boxes.length)];
        st.unmap();
        st.destroy();
        this.busy = false;
        return out;
      },
      (e) => {
        st.destroy();
        this.busy = false;
        throw e;
      },
    );
  }

  destroy(): void {
    this.boxes.destroy();
    this.means.destroy();
  }
}
