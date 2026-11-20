// Nested scales lab (round 31, step 4c, NS-260): does the version 3 source (shade.wgsl shCol3 and its helpers, compiled
// into the textured draws only with the override CLIFF_V3) cost the DEFAULT textured pipelines (CLIFF_V3 false) compile
// time? Measurement, run on demand only (NESTED_V3_COST=1 npx vitest run --project gpu test/gpu/nested-v3-cost.test.ts):
// the default textured sheet and box pipelines from the real draw module ("full") against the same module with the
// version 3 section replaced by a stub of the same signature ("stub"), plus the CLIFF_V3 pipelines for reference;
// alternating, ROUNDS rounds, each pipeline on a fresh device (no cache shared between measurements); medians printed.
import fs from 'node:fs';
import { expect, it } from 'vitest';
import { drawModuleCode } from '../../src/nested/render';

const ROUNDS = 7;
const START = '// ---- (round 31, version 3, ?cliff=3';
const END = '// ---- (round 31, look experiment, ?cliff=1)';
const STUB =
  'fn shCol3(si: ShadeIn, k: i32, steps: i32, drop: u32, pxAng: f32, pxT: f32, dbg: u32, dropF: f32, hnz: f32, sink: f32, patchP: f32, gap: f32, gapD: u32) -> ShCol {\n  return ShCol(0.0, si.ng, 1.0, 1.0, true, -1);\n}\n';

it.skipIf(!process.env.NESTED_V3_COST)('NS-260: the version 3 source and the default textured pipelines\' compile time', async () => {
  const full = drawModuleCode(4, 64);
  const a = full.indexOf(START);
  const b = full.indexOf(END);
  expect(a > 0 && b > a, 'the version 3 section markers in shade.wgsl').toBe(true);
  const stub = full.slice(0, a) + STUB + full.slice(b);
  const time = async (code: string, vs: string, fs: string, constants: Record<string, number>) => {
    // (an adapter makes one device: a fresh adapter each time)
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter!.requestDevice();
    const m = device.createShaderModule({ code });
    const info = await m.getCompilationInfo();
    const errs = info.messages.filter((x) => x.type === 'error').map((x) => `${x.lineNum}:${x.linePos} ${x.message}`);
    expect(errs, errs.join('\n')).toEqual([]);
    const t0 = performance.now();
    await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module: m, entryPoint: vs },
      fragment: { module: m, entryPoint: fs, constants, targets: [{ format: 'bgra8unorm' }, { format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
    });
    const ms = performance.now() - t0;
    device.destroy();
    return ms;
  };
  const cases: [string, string, string, string, Record<string, number>][] = [
    ['sheetsTex full', full, 'vsSheet', 'fsST', {}],
    ['sheetsTex stub', stub, 'vsSheet', 'fsST', {}],
    ['boxesTex full', full, 'vs', 'fsT', {}],
    ['boxesTex stub', stub, 'vs', 'fsT', {}],
    ['sheetsTexV3', full, 'vsSheet', 'fsST', { CLIFF_V3: 1 }],
    ['boxesTexV3', full, 'vs', 'fsT', { CLIFF_V3: 1 }],
  ];
  const res: Record<string, number[]> = {};
  for (let r = 0; r < ROUNDS; r++) {
    // (the order rotated each round, so no case always follows the same one)
    for (let i = 0; i < cases.length; i++) {
      const [name, code, vs, fs, c] = cases[(i + r) % cases.length];
      (res[name] ??= []).push(await time(code, vs, fs, c));
    }
  }
  const med = (v: number[]) => [...v].sort((x, y) => x - y)[Math.floor(v.length / 2)];
  const table = `[NS-260] Dawn, ${ROUNDS} rounds, ms: median (runs)\n${Object.entries(res).map(([k, v]) => `  ${k.padEnd(15)} ${med(v).toFixed(0).padStart(5)}  (${v.map((x) => x.toFixed(0)).join(' ')})`).join('\n')}\n`;
  // (the gpu project keeps a passing test's console quiet: the table is also appended to local/nested/ns260-compile.txt)
  console.log(table);
  fs.mkdirSync('local/nested', { recursive: true });
  fs.appendFileSync('local/nested/ns260-compile.txt', `${new Date().toISOString()}\n${table}`);
}, 600_000);
