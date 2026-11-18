// Nested scales lab (tests only, NS-86): the store's workgroup reductions on their own, many workgroups, many rounds.
// Each variant has every thread add its value into a workgroup-memory result and then read the result back after the
// barrier; a thread that reads anything but the full result counts as a miss. Per the WGSL memory model there must be
// none. Round 9 found the store's root columns empty because threads read the workgroup's atomicMax as 0 (variant
// 'atomic + uniform load'); this probe says which forms a device's driver path gets wrong.
const VARIANTS: Record<string, string> = {
  // the store's old form: an atomic max in workgroup memory, read with workgroupUniformLoad
  'atomic + uniform load': `
  if (li == 0u) { atomicStore(&wa, 0u); }
  workgroupBarrier();
  atomicMax(&wa, li + 1u);
  let m = workgroupUniformLoad(&wa);`,
  // an atomic max, read with a barrier and atomicLoad
  'atomic + barrier + atomicLoad': `
  if (li == 0u) { atomicStore(&wa, 0u); }
  workgroupBarrier();
  atomicMax(&wa, li + 1u);
  workgroupBarrier();
  let m = atomicLoad(&wa);`,
  // a tree reduction in a plain workgroup array (each word written by one thread), read with workgroupUniformLoad
  'tree + uniform load': `
  wr[li] = li + 1u;
  workgroupBarrier();
  for (var s = 128u; s > 0u; s >>= 1u) {
    if (li < s) { wr[li] = max(wr[li], wr[li + s]); }
    workgroupBarrier();
  }
  let m = workgroupUniformLoad(&wr[0]);`,
  // an atomic add from the zero-initialised workgroup memory, read with a barrier and atomicLoad
  'atomic add + barrier + atomicLoad': `
  atomicAdd(&wa, 1u);
  workgroupBarrier();
  let m = atomicLoad(&wa);`,
  // one writer of an atomic (thread 0), read with workgroupUniformLoad
  'one writer atomic + uniform load': `
  if (li == 0u) { atomicStore(&wa, 256u); }
  let m = workgroupUniformLoad(&wa);`,
  // one writer (thread 0), read by all with workgroupUniformLoad of a plain variable
  'one writer + uniform load': `
  if (li == 0u) { wp = 256u; }
  let m = workgroupUniformLoad(&wp);`,
};

export async function reductionHazard(device: GPUDevice, groups = 4096, rounds = 6): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [name, body] of Object.entries(VARIANTS)) {
    const code = `
@group(0) @binding(0) var<storage, read_write> bad: array<atomic<u32>>;
var<workgroup> wa: atomic<u32>;
var<workgroup> wr: array<u32, 256>;
var<workgroup> wp: u32;
@compute @workgroup_size(16, 16)
fn main(@builtin(local_invocation_index) li: u32) {
${body}
  if (m != 256u) { atomicAdd(&bad[0], 1u); }
}`;
    const mod = device.createShaderModule({ label: `hazard ${name}`, code });
    const pipe = device.createComputePipeline({ label: `hazard ${name}`, layout: 'auto', compute: { module: mod, entryPoint: 'main' } });
    const buf = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    const rd = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const bg = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: buf } }] });
    const enc = device.createCommandEncoder();
    const p = enc.beginComputePass();
    p.setPipeline(pipe);
    p.setBindGroup(0, bg);
    for (let r = 0; r < rounds; r++) p.dispatchWorkgroups(64, groups / 64);
    p.end();
    enc.copyBufferToBuffer(buf, 0, rd, 0, 16);
    device.queue.submit([enc.finish()]);
    await rd.mapAsync(GPUMapMode.READ);
    out[name] = new Uint32Array(rd.getMappedRange())[0];
    rd.unmap();
    rd.destroy();
    buf.destroy();
  }
  return out;
}
