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
    // (bisecting: ?oracle=0 skips the oracle checks, ?wtscreen=0 the suite's screen checks, ?pit=0 the pit poses)
    // (NS-86, round 9) the workgroup reduction forms probed before and after the oracle checks: on the desktop's Intel Arc
    // the atomic forms go wrong after them (the reproduction); the forms the store uses must hold in both
    const { reductionHazard } = await import('./hazard');
    const h0 = await reductionHazard(device);
    const res = q.get('oracle') === '0' ? [] : await selftest(device, say);
    {
      const h1 = await reductionHazard(device);
      const used = ['tree + uniform load', 'one writer + uniform load'];
      const c = {
        name: 'workgroup reductions: the forms the store uses (a tree over a plain array, one writer and a uniform load) give every thread the full result, before and after the oracle checks (6.3 M reads each)',
        pass: used.every((k) => h0[k] === 0 && h1[k] === 0),
        detail: `misses before ${JSON.stringify(h0)}; after ${JSON.stringify(h1)} (the atomic forms are the store's old ones, NS-86; they are informational)`,
      };
      res.push(c);
      say(c);
    }
    // then the box draw's watertight suite on the sandbox's scene (?wt=0 skips it)
    if (q.get('wt') !== '0') {
      log.textContent += '\nThe watertight suite on the sandbox scene\n\n';
      const { App } = await import('./app');
      const { watertightSuite } = await import('./suite');
      // (?trace=1, NS-86: every step of the sandbox's pool checked for empty root columns)
      if (q.get('trace') === '1') {
        const { rootTracer } = await import('./trace');
        const { setTraceNew } = await import('./gpu/nest');
        setTraceNew(rootTracer((s) => console.log(`[suite] trace ${s}`)).fn);
      }
      await App.start(device, new URLSearchParams('k=8&d=8&pitch=0.3&yaw=0&tx=100&ty=140'));
      const api = (window as unknown as { nested: Parameters<typeof watertightSuite>[0] }).nested;
      while (api.app.frameCount < 60) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 1500));
      {
        // (NS-86) the sandbox's coverage and the pool's books before the suite builds its scene
        const nest = (api as unknown as { app: { nest: import('./gpu/nest').GpuNest } }).app.nest;
        const c = await (api as unknown as { coverage(): Promise<{ stale: number; missing: number; where: string[] }> }).coverage();
        const au = (await nest.readAll()).audit(nest.cap);
        console.log(`[suite] coverage at the sandbox's start: stale ${c.stale}, missing ${c.missing} ${c.where.join('; ')}; audit ${JSON.stringify(au)}`);
      }
      const wt =await watertightSuite(api, { screen: q.get('wtscreen') !== '0', log: (s) => console.log(`[suite] ${s}`) });
      for (const c of wt.checks) {
        res.push(c);
        say(c);
      }
      // (?stress=N, round 9: the store's random-op stress on this sandbox, after the oracle checks, where the desktop's
      // workgroup atomics had gone wrong: NS-86)
      if (q.has('stress')) {
        const { storeStress } = await import('./stress');
        const r = await storeStress(api as unknown as Parameters<typeof storeStress>[0], { n: Number(q.get('stress')), log: (s) => console.log(`[suite] stress ${s}`) });
        const st = (api as unknown as { state(): { stats: { refused: number } } }).state().stats;
        for (const c of [
          { name: `store stress (${JSON.stringify(r.ops)}): the pool's books, no column without records, coverage, at ${r.checks} checks; nothing refused in a kernel`, pass: r.audit + r.emptyCols + r.coverage === 0 && st.refused === 0, detail: `books ${r.audit}, empty columns ${r.emptyCols}, coverage faults ${r.coverage}, refused ${st.refused}` },
        ]) {
          res.push(c);
          say(c);
        }
      }
      if (q.get('pit') === '0') {
        const failed = res.filter((c) => !c.pass).length;
        log.textContent += `\n${res.length - failed} of ${res.length} passed.\n`;
        (window as unknown as { __selftest: unknown }).__selftest = { done: true, failed, results: res };
        return;
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
