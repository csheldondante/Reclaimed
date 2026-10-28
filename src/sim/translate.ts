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

  /** (round 106, frameprobe) a uniform and a bind group per buffer moved, kept (a slide made both anew for each) */
  private kept = new Map<GPUBuffer, { u: GPUBuffer; group: GPUBindGroup }>();
  private host = new ArrayBuffer(32);

  /** `count` elements of `stride` vec4s in `buf`, the vec4s in `mask` moved by −d */
  run(buf: GPUBuffer, count: number, stride: number, mask: number, d: [number, number, number]): void {
    if (count <= 0) return;
    let k = this.kept.get(buf);
    if (!k) {
      const u = this.device.createBuffer({ label: 'translate', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      k = { u, group: this.device.createBindGroup({ layout: this.layout, entries: [{ binding: 0, resource: { buffer: u } }, { binding: 1, resource: { buffer: buf } }] }) };
      this.kept.set(buf, k);
    }
    const ab = this.host;
    new Float32Array(ab, 0, 4).set([d[0], d[1], d[2], 0]);
    new Uint32Array(ab, 16, 4).set([count, stride, mask, 0]);
    // (a buffer moved twice in one task: the first submitted before its uniform is written again)
    if (Translator.batch.has(buf)) this.flush();
    // (written before the submit that reads it: the queue keeps them in order)
    this.device.queue.writeBuffer(k.u, 0, ab);
    if (!Translator.enc) {
      Translator.enc = this.device.createCommandEncoder({ label: 'translate' });
      queueMicrotask(() => this.flush());
    }
    const pass = Translator.enc.beginComputePass({ label: 'translate' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, k.group);
    pass.dispatchWorkgroups(Math.ceil(count / 64));
    pass.end();
    Translator.batch.add(buf);
  }

  /**
   * (round 106, frameprobe) a task's moves (a slide's: the agents' units and flyers, the bodies' particles) in one
   * submit at its end (a microtask): nothing between reads those buffers — the sim waits while the window slides
   */
  private static enc: GPUCommandEncoder | null = null;
  private static batch = new Set<GPUBuffer>();
  flush(): void {
    const T = Translator;
    if (!T.enc) return;
    this.device.queue.submit([T.enc.finish()]);
    T.enc = null;
    T.batch.clear();
  }
}
