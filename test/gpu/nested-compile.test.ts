// Nested scales lab (round 18): the lab's two WGSL modules compile, and how long module + pipelines take on Dawn. A
// cheap check before any browser run (round 18 lost a 20-minute browser run to a module that failed to compile).
import { expect, it } from 'vitest';
import storeWgsl from '../../src/nested/gpu/store.wgsl?raw';
import nestWgsl from '../../src/nested/gpu/nest.wgsl?raw';
import drawWgsl from '../../src/nested/gpu/draw.wgsl?raw';
import { segWgsl, TCAP } from '../../src/nested/gpu/nest';

it('nested: nest.wgsl and draw.wgsl compile without errors', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter!.requestDevice();
  const out: string[] = [];
  for (const [name, code] of [
    ['nest', `const TCAP: u32 = ${TCAP}u;\n${segWgsl(4, 64, false)}\n${storeWgsl}\n${nestWgsl}`],
    ['draw', `const TCAP: u32 = ${TCAP}u;\n${segWgsl(4, 64, true)}\n${storeWgsl}\n${drawWgsl}`],
  ] as const) {
    const t0 = performance.now();
    const m = device.createShaderModule({ label: name, code });
    const info = await m.getCompilationInfo();
    const errs = info.messages.filter((x) => x.type === 'error').map((x) => `${name}:${x.lineNum}:${x.linePos} ${x.message}`);
    out.push(...errs);
    console.log(`[compile] ${name}: ${code.split('\n').length} lines, ${errs.length} errors, ${(performance.now() - t0).toFixed(0)} ms`);
    // (the pipelines the page makes from it, timed one by one: the sheet pass's creation is the smooth draw's wait)
    if (!errs.length && name === 'nest')
      for (const [entryPoint, constants] of [['faceBake', {}], ['sheetBake', { BAKE_RIM: 1 }], ['derive', {}]] as const) {
        const t1 = performance.now();
        await device.createComputePipelineAsync({ layout: 'auto', compute: { module: m, entryPoint, constants } }).catch((e) => out.push(`${entryPoint}: ${e}`));
        console.log(`[compile] pipeline ${entryPoint}: ${(performance.now() - t1).toFixed(0)} ms (Dawn, D3D12)`);
      }
  }
  expect(out, out.join('\n')).toEqual([]);
  device.destroy();
});
