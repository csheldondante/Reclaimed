// Nested scales lab: the lab's two WGSL modules compile, and every pipeline the page makes is timed against its budget
// on Dawn (round 18: a cheap check before any browser run; round 19, the owner: "a quick regression test to flag
// slowdowns"). Budgets: test/gpu/nested-compile-budgets.ts. Part of the quick loop every builder runs.
import { expect, it } from 'vitest';
import storeWgsl from '../../src/nested/gpu/store.wgsl?raw';
import nestWgsl from '../../src/nested/gpu/nest.wgsl?raw';
import drawWgsl from '../../src/nested/gpu/draw.wgsl?raw';
import { segWgsl, TCAP } from '../../src/nested/gpu/nest';
import { BUDGET_MS, FLOOR_MS, TOTAL_BUDGET_MS, budgetOf } from './nested-compile-budgets';

/** every compute pipeline of nest.wgsl the page makes: name -> (entry point, override constants) */
const COMPUTE: [string, string, Record<string, number>][] = [
  ...['derive', 'restrictK', 'rootGen', 'zPick', 'release', 'resClear', 'merge', 'edit', 'meltSnap', 'meltApply', 'camera', 'pick', 'ball', 'pack', 'faceBake', 'snap', 'tabOut', 'tabIn', 'shrinkFree', 'shrinkMove', 'shrinkCopy', 'plan', 'dilate', 'dirClear', 'dirBuild', 'dirFinish'].map((e) => [e, e, {}] as [string, string, Record<string, number>]),
  ['faceBakeRim', 'faceBake', { BAKE_RIM: 1 }],
  ['faceBakeOne', 'faceBake', { BAKE_RIM: 1, BAKE_SPLIT: 0 }],
  ['sheetBake', 'sheetBake', { BAKE_RIM: 1 }],
];
/** draw.wgsl: the two draws (render pipelines) and the watertight check's captures (compute) */
const DRAW_COMPUTE = ['capture', 'captureSheet'];

it('nested: both modules compile; every pipeline within its compile budget', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter!.requestDevice();
  const errs: string[] = [];
  const times: Record<string, number> = {};
  const timed = async (name: string, make: () => Promise<unknown>) => {
    const t0 = performance.now();
    await make().catch((e) => errs.push(`${name}: ${e}`));
    times[name] = performance.now() - t0;
  };
  const mod = async (name: string, code: string) => {
    const m = device.createShaderModule({ label: name, code });
    const info = await m.getCompilationInfo();
    errs.push(...info.messages.filter((x) => x.type === 'error').map((x) => `${name}:${x.lineNum}:${x.linePos} ${x.message}`));
    return m;
  };
  const nest = await mod('nest', `const TCAP: u32 = ${TCAP}u;\n${segWgsl(4, 64, false)}\n${storeWgsl}\n${nestWgsl}`);
  const draw = await mod('draw', `const TCAP: u32 = ${TCAP}u;\n${segWgsl(4, 64, true)}\n${storeWgsl}\n${drawWgsl}`);
  expect(errs, errs.join('\n')).toEqual([]);
  for (const [name, entryPoint, constants] of COMPUTE) await timed(name, () => device.createComputePipelineAsync({ layout: 'auto', compute: { module: nest, entryPoint, constants } }));
  const render = (vs: string, fs: string) => () =>
    device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module: draw, entryPoint: vs },
      fragment: { module: draw, entryPoint: fs, targets: [{ format: 'bgra8unorm' }, { format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
    });
  await timed('drawBoxes', render('vs', 'fs'));
  await timed('drawSheets', render('vsSheet', 'fsS'));
  for (const e of DRAW_COMPUTE) await timed(e, () => device.createComputePipelineAsync({ layout: 'auto', compute: { module: draw, entryPoint: e } }));
  const total = Object.values(times).reduce((a, b) => a + b, 0);
  console.log(`[compile] Dawn (${(adapter as unknown as { info?: { backend?: string } }).info?.backend ?? 'default backend'}), ms (budget):\n${Object.entries(times).map(([k, v]) => `  ${k.padEnd(14)} ${v.toFixed(0).padStart(6)} (${budgetOf(k)})`).join('\n')}\n  total          ${total.toFixed(0).padStart(6)} (${TOTAL_BUDGET_MS})`);
  const over = Object.entries(times)
    .filter(([k, v]) => v > budgetOf(k))
    .map(([k, v]) => `${k}: ${v.toFixed(0)} ms over its budget ${budgetOf(k)} ms`);
  if (total > TOTAL_BUDGET_MS) over.push(`total: ${total.toFixed(0)} ms over its budget ${TOTAL_BUDGET_MS} ms`);
  const unlisted = Object.keys(times).filter((k) => !(k in BUDGET_MS));
  expect(errs, errs.join('\n')).toEqual([]);
  expect(unlisted, `pipelines with no budget (add them to nested-compile-budgets.ts; floor ${FLOOR_MS} ms): ${unlisted.join(', ')}`).toEqual([]);
  expect(over, over.join('\n')).toEqual([]);
  device.destroy();
}, 120_000);
