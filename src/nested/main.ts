// Nested scales lab page (nested.html; docs/design/NESTED_SCALES.md). ?selftest=1 runs the GPU self-test; otherwise
// the sandbox (src/nested/app.ts).
import { selftest } from './selftest';

function fatal(msg: string): void {
  const d = document.createElement('div');
  d.className = 'fatal';
  d.textContent = msg;
  document.body.appendChild(d);
}

/** ?maxbuf=<MB>: clamp the device's largest buffer and storage binding to a phone-like size (desktop reproduction) */
async function boot(q: URLSearchParams): Promise<GPUDevice> {
  if (!navigator.gpu) throw new Error('This page needs WebGPU, and this browser does not have it.\nOn a phone, open it over https in Chrome.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('WebGPU is here but no graphics adapter was offered.');
  const clamp = q.has('maxbuf') ? Number(q.get('maxbuf')) * 2 ** 20 : Infinity;
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: Math.min(clamp, adapter.limits.maxStorageBufferBindingSize),
      maxBufferSize: Math.min(clamp, adapter.limits.maxBufferSize),
      maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage,
    },
  });
  const mb = (v: number) => `${Math.round(v / 2 ** 20)} MB`;
  (window as unknown as { __limits: unknown }).__limits = {
    adapterBinding: mb(adapter.limits.maxStorageBufferBindingSize),
    adapterBuffer: mb(adapter.limits.maxBufferSize),
    binding: mb(device.limits.maxStorageBufferBindingSize),
    buffer: mb(device.limits.maxBufferSize),
    storagePerStage: adapter.limits.maxStorageBuffersPerShaderStage,
  };
  device.addEventListener('uncapturederror', (e) => fatal(`GPU error: ${(e as GPUUncapturedErrorEvent).error.message}`));
  device.lost.then((i) => fatal(`The GPU device was lost: ${i.message}`));
  return device;
}

async function main(): Promise<void> {
  const q = new URLSearchParams(location.search);
  const device = await boot(q);
  if (q.get('selftest') === '1') {
    const log = document.getElementById('log')!;
    log.style.display = 'block';
    log.textContent = 'Self-test: the GPU passes against the oracle\n\n';
    const say = (c: { pass: boolean; name: string; detail: string }) => (log.textContent += `${c.pass ? 'PASS' : 'FAIL'}  ${c.name}\n      ${c.detail}\n`);
    const res = await selftest(device, say);
    // then the box draw's watertight suite on the sandbox's scene (?wt=0 skips it)
    if (q.get('wt') !== '0') {
      log.textContent += '\nThe watertight suite on the sandbox scene\n\n';
      const { App } = await import('./app');
      const { watertightSuite } = await import('./suite');
      await App.start(device, new URLSearchParams('k=8&d=8&pitch=0.3&yaw=0&tx=100&ty=140'));
      const api = (window as unknown as { nested: Parameters<typeof watertightSuite>[0] }).nested;
      while (api.app.frameCount < 60) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 1500));
      const wt = await watertightSuite(api, { log: (s) => console.log(`[suite] ${s}`) });
      for (const c of wt.checks) {
        res.push(c);
        say(c);
      }
      // (round 8) the deep pit, the cave, the shafts below the old world bottom, after a cruise, a demote and shrinks
      const { pitAndCave } = await import('./suite');
      const pit = await pitAndCave(api, { taps: 4, log: (s) => console.log(`[suite] ${s}`) });
      for (const c of [
        { name: 'screen: no hole pixels where ground is expected in the pit, cave and shaft poses (round 8), also after a cruise, a demote and the pool\'s shrinks', pass: pit.total === 0, detail: `${pit.total} hole pixels over ${pit.poses} poses` },
        { name: 'coverage: every column in view drawn by exactly one level (no stale caps, none missing) after the pit, cave, shafts, a cruise, a demote and shrinks', pass: pit.coverage === 0, detail: `${pit.coverage} faults` },
      ]) {
        res.push(c);
        say(c);
      }
    }
    const failed = res.filter((c) => !c.pass).length;
    log.textContent += `\n${res.length - failed} of ${res.length} passed.\n`;
    (window as unknown as { __selftest: unknown }).__selftest = { done: true, failed, results: res };
    return;
  }
  const { App } = await import('./app');
  await App.start(device, q);
}

main().catch((e: Error) => {
  fatal(e.message);
  (window as unknown as { __selftest: unknown }).__selftest = { done: true, failed: -1, error: e.message };
});
