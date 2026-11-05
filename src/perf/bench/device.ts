// What the device is and can do: a fixed GPU workload, upload and readback rates, the device's facts. API:
// deviceFacts (re-exported by bench.ts), fixedWorkload, ioRates.
import type { Host } from '../../scenes/world-core';
import { Stat, stat, MB } from './defs';
import { GpuTimer } from './page';

/** The fixed workload (thermal state): ALU over a 16 MB buffer, the same at the start and the end. */
export async function fixedWorkload(device: GPUDevice, timer: GpuTimer, reps = 10): Promise<Record<string, unknown>> {
  const N = 1 << 20;
  const buf = device.createBuffer({ size: N * 16, usage: GPUBufferUsage.STORAGE });
  const mod = device.createShaderModule({
    code: `@group(0) @binding(0) var<storage, read_write> d: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x + g.y * 1048576u;
  if (i >= arrayLength(&d)) { return; }
  var v = d[i] + vec4f(f32(i & 255u) * 0.001);
  for (var k = 0u; k < 192u; k++) { v = fract(v * 1.37 + vec4f(0.11, 0.23, 0.31, 0.47)); }
  d[i] = v;
}`,
  });
  const pipe = device.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'main' } });
  const bg = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: buf } }] });
  const gpu: number[] = [];
  const wall: number[] = [];
  for (let k = 0; k < reps + 3; k++) {
    const enc = device.createCommandEncoder({ label: 'bench fixed workload' });
    const p = enc.beginComputePass({ timestampWrites: timer.timestamps('fixed') });
    p.setPipeline(pipe);
    p.setBindGroup(0, bg);
    p.dispatchWorkgroups(N / 64);
    p.end();
    await device.queue.onSubmittedWorkDone();
    const t0 = performance.now();
    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();
    const ms = performance.now() - t0;
    // (three to warm the clocks up, not counted)
    if (k >= 3) wall.push(ms);
    const t = (await timer.read()).get('fixed');
    if (k >= 3 && t) gpu.push(...t);
  }
  buf.destroy();
  return { what: '2^20 threads x 192 fract-FMA iterations over a 16 MB buffer, one dispatch', gpu: timer.on ? stat(gpu, 'ms') : 'n/a', wall: stat(wall, 'ms (wall: submit to onSubmittedWorkDone)') };
}

/** Readback, upload and GPU-copy rates (isolated submits; wall-clock — there's no timestamp for a copy). */
export async function ioRates(device: GPUDevice, quick = false): Promise<Record<string, unknown>> {
  const BIG = 34 * MB;
  const src = device.createBuffer({ size: BIG, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const dst = device.createBuffer({ size: BIG, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const host = new Uint8Array(BIG);
  for (let i = 0; i < BIG; i += 4096) host[i] = i & 255;
  device.queue.writeBuffer(src, 0, host);
  await device.queue.onSubmittedWorkDone();
  const readOnce = async (bytes: number) => {
    const st = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = device.createCommandEncoder({ label: 'bench readback' });
    enc.copyBufferToBuffer(src, 0, st, 0, bytes);
    const t0 = performance.now();
    device.queue.submit([enc.finish()]);
    await st.mapAsync(GPUMapMode.READ);
    const t1 = performance.now();
    const copy = st.getMappedRange().slice(0);
    const t2 = performance.now();
    st.unmap();
    st.destroy();
    void copy;
    return { latency: t1 - t0, copyOut: t2 - t1 };
  };
  const sizes: [string, number, number][] = quick
    ? [
        ['1MB', 1 * MB, 5],
        ['8MB', 8 * MB, 3],
      ]
    : [
        ['0.1MB', 0.1 * MB, 10],
        ['1MB', 1 * MB, 8],
        ['8MB', 8 * MB, 5],
        ['34MB', BIG, 3],
      ];
  const readback: Record<string, unknown> = {};
  for (const [name, bytes, reps] of sizes) {
    const b = Math.ceil(bytes / 4) * 4;
    const lat: number[] = [];
    const out: number[] = [];
    for (let k = 0; k < reps; k++) {
      const r = await readOnce(b);
      lat.push(r.latency);
      out.push(r.copyOut);
    }
    const l = stat(lat, 'ms (submit to mapAsync resolved)');
    readback[name] = { bytes: b, latency: l, getMappedRangeCopy: stat(out, 'ms'), MBps: l ? +(b / MB / (l.p50 / 1000)).toFixed(1) : null };
  }
  let contention: unknown = null;
  if (!quick) {
    // a small readback asked right after a big one: does it wait for the big one?
    const small: number[] = [];
    const big: number[] = [];
    for (let k = 0; k < 3; k++) {
      const [a, s] = await Promise.all([readOnce(BIG), readOnce(Math.ceil((0.1 * MB) / 4) * 4)]);
      big.push(a.latency);
      small.push(s.latency);
    }
    const alone = (readback['0.1MB'] as { latency: Stat }).latency;
    const s = stat(small, 'ms');
    contention = { small0p1MBAfter34MB: s, big34MB: stat(big, 'ms'), small0p1MBAlone: alone?.p50 ?? null, delayedBy: s && alone ? +(s.p50 - alone.p50).toFixed(2) : null, unit: 'ms' };
  }
  const upload: Record<string, unknown> = {};
  for (const [name, bytes, reps] of (quick ? [['8MB', 8 * MB, 3]] : [['1MB', 1 * MB, 5], ['8MB', 8 * MB, 5], ['34MB', BIG, 3]]) as [string, number, number][]) {
    const call: number[] = [];
    const done: number[] = [];
    for (let k = 0; k < reps; k++) {
      await device.queue.onSubmittedWorkDone();
      const t0 = performance.now();
      device.queue.writeBuffer(dst, 0, host, 0, bytes);
      const t1 = performance.now();
      await device.queue.onSubmittedWorkDone();
      call.push(t1 - t0);
      done.push(performance.now() - t0);
    }
    const d = stat(done, 'ms (writeBuffer to onSubmittedWorkDone)');
    upload[name] = { bytes, call: stat(call, 'ms (the writeBuffer call, CPU)'), done: d, MBps: d ? +(bytes / MB / (d.p50 / 1000)).toFixed(1) : null };
  }
  const copy: number[] = [];
  for (let k = 0; k < (quick ? 2 : 4); k++) {
    const enc = device.createCommandEncoder({ label: 'bench copy' });
    for (let j = 0; j < 4; j++) enc.copyBufferToBuffer(j & 1 ? dst : src, 0, j & 1 ? src : dst, 0, BIG);
    await device.queue.onSubmittedWorkDone();
    const t0 = performance.now();
    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();
    copy.push(performance.now() - t0);
  }
  const c = stat(copy, 'ms (wall: four 34 MB copies in one submit)');
  src.destroy();
  dst.destroy();
  return { readback, contention, upload, gpuCopy: { per4x34MB: c, MBps: c ? +((4 * BIG) / MB / (c.p50 / 1000)).toFixed(0) : null, how: 'wall' } };
}

// ---------- device facts ----------

export async function deviceFacts(host: Host): Promise<Record<string, unknown>> {
  const { adapter, device } = host.gpu;
  const lim = (l: GPUSupportedLimits) => {
    const o: Record<string, number> = {};
    for (const k of ['maxStorageBufferBindingSize', 'maxBufferSize', 'maxStorageBuffersPerShaderStage', 'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupsPerDimension', 'maxTextureDimension2D', 'maxUniformBufferBindingSize', 'maxBindGroups'])
      o[k] = (l as unknown as Record<string, number>)[k];
    return o;
  };
  const info = adapter.info as unknown as Record<string, unknown>;
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  let hints: unknown = null;
  try {
    const uad = (navigator as Navigator & { userAgentData?: { getHighEntropyValues(h: string[]): Promise<unknown> } }).userAgentData;
    if (uad) hints = await uad.getHighEntropyValues(['model', 'platform', 'platformVersion', 'architecture', 'fullVersionList']);
  } catch {
    hints = null;
  }
  return {
    adapter: { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description },
    features: [...adapter.features].sort(),
    timestampQuery: device.features.has('timestamp-query'),
    adapterLimits: lim(adapter.limits),
    deviceLimits: lim(device.limits),
    ua: navigator.userAgent,
    clientHints: hints,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemoryGB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
    performanceMemory: mem ? { usedMB: +(mem.usedJSHeapSize / MB).toFixed(1), totalMB: +(mem.totalJSHeapSize / MB).toFixed(1), limitMB: +(mem.jsHeapSizeLimit / MB).toFixed(0) } : null,
    // (v4: localStorage is shared by every build on the origin — the Pixel 9a's v3 main page lost its state)
    localStorage: (() => {
      try {
        const keys: [string, number][] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i)!;
          keys.push([k, (localStorage.getItem(k) ?? '').length]);
        }
        keys.sort((a, b) => b[1] - a[1]);
        return { keys: keys.length, chars: keys.reduce((a, [, n]) => a + n, 0), top: keys.slice(0, 6).map(([k, n]) => `${k} ${n}`) };
      } catch (e) {
        return { error: String(e) };
      }
    })(),
    storageEstimate: await (navigator.storage?.estimate?.() ?? Promise.resolve(null)).then((e) => (e ? { usageMB: +((e.usage ?? 0) / MB).toFixed(1), quotaMB: +((e.quota ?? 0) / MB).toFixed(0) } : null)).catch(() => null),
    devicePixelRatio: devicePixelRatio,
    screen: { w: screen.width, h: screen.height },
    css: { w: innerWidth, h: innerHeight },
    quality: { tier: host.qualityName, ...host.quality },
  };
}
