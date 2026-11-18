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
    const res = await selftest(device, (c) => (log.textContent += `${c.pass ? 'PASS' : 'FAIL'}  ${c.name}\n      ${c.detail}\n`));
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
