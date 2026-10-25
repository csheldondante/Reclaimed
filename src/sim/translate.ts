// Moving what lives in window coordinates when the streamed window slides (round 80; the hoverbike session:
// "Agents and physics bodies don't move with a slide … the horde is 64 cells off from the land under it").
// A buffer of elements of `stride` vec4s, some of them positions (bit k of `mask`: the element's k-th vec4's
// xyz): each moved by −d, the land's own move.

const WGSL = /* wgsl */ `
struct T { d: vec4<f32>, n: vec4<u32> };
@group(0) @binding(0) var<uniform> t: T;
@group(0) @binding(1) var<storage, read_write> buf: array<vec4<f32>>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= t.n.x) { return; }
  for (var k = 0u; k < t.n.y; k++) {
    if (((t.n.z >> k) & 1u) == 0u) { continue; }
    let j = id.x * t.n.y + k;
    let v = buf[j];
    buf[j] = vec4<f32>(v.xyz - t.d.xyz, v.w);
  }
}
`;

export class Translator {
  private pipeline: GPUComputePipeline;
  private layout: GPUBindGroupLayout;

  constructor(private device: GPUDevice) {
    this.layout = device.createBindGroupLayout({
      label: 'translate',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    this.pipeline = device.createComputePipeline({
      label: 'translate',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module: device.createShaderModule({ label: 'translate', code: WGSL }), entryPoint: 'main' },
    });
  }

  /** `count` elements of `stride` vec4s in `buf`, the vec4s in `mask` moved by −d */
  run(buf: GPUBuffer, count: number, stride: number, mask: number, d: [number, number, number]): void {
    if (count <= 0) return;
    const u = this.device.createBuffer({ label: 'translate', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const ab = new ArrayBuffer(32);
    new Float32Array(ab).set(d, 0);
    new Uint32Array(ab).set([count, stride, mask, 0], 4);
    this.device.queue.writeBuffer(u, 0, ab);
    const enc = this.device.createCommandEncoder({ label: 'translate' });
    const pass = enc.beginComputePass({ label: 'translate' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.device.createBindGroup({ layout: this.layout, entries: [{ binding: 0, resource: { buffer: u } }, { binding: 1, resource: { buffer: buf } }] }));
    pass.dispatchWorkgroups(Math.ceil(count / 64));
    pass.end();
    this.device.queue.submit([enc.finish()]);
    u.destroy();
  }
}
