// Nested scales lab, round 32 step B1 (docs/design/NESTED_SCALES.md "As built (round 32, step B1)"): the WGSL port of the
// cliff rule (src/nested/gpu/cliffrule.wgsl) against the TS reference (src/nested/exp/cliffrule.ts) on real Dawn. Heights
// go in as f32 level-local units (one unit = a 16 m column = 1024 height units) through the shader's own conversion
// (crUnits, round half up); the TS gets the same integers. Per cell: kind, h, H, L, a, b, A, B, F, theta, saddle; per fine
// column of every split cell: up / down (dTheta 0 on both sides: not stored yet). Hash keys take GLOBAL cell indices
// (window origin + local), as the draw does.
//   - the synthetic field of test/unit/nested-cliffrule.test.ts, at a negative origin (floor division and shifts of
//     negative indices exercised);
//   - the real 16 m level window of the generated world, when local/nested/rB1-heights.json exists (written once by
//     scripts/nested-rB1-stills.mjs from a test-only readback; local, not committed).
// On demand (NESTED_B1_COST=1): compile time of the default textured sheet pipeline against the ?cliff=4 variant, fresh
// device each, alternating.
import fs from 'node:fs';
import { expect, it } from 'vitest';
import { testGpu } from './dawn';
import cliffRuleWgsl from '../../src/nested/gpu/cliffrule.wgsl?raw';
import { COARSE_U, KIND_SPLIT, defaultParams, deriveCell, isUp, type Field } from '../../src/nested/exp/cliffrule';
import { makeField } from '../support/nested-cliffield';
import { cliffRuleCode, drawModuleCode } from '../../src/nested/render';

const HARNESS = `
@group(0) @binding(0) var<storage, read> hz: array<f32>;
@group(0) @binding(1) var<uniform> U: array<vec4<i32>, 2>;
@group(0) @binding(2) var<storage, read> splits: array<vec2<i32>>;
@group(0) @binding(3) var<storage, read_write> cellOut: array<i32>;
@group(0) @binding(4) var<storage, read_write> bits: array<u32>;
fn crH(x: i32, y: i32) -> i32 {
  let X = clamp(x - U[1].x, 0, U[0].x - 1);
  let Y = clamp(y - U[1].y, 0, U[0].y - 1);
  return crUnits(hz[Y * U[0].x + X], 1024.0);
}
@compute @workgroup_size(64)
fn cells(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = i32(gid.x);
  if (i >= U[0].x * U[0].y) { return; }
  let r = crDerive(U[1].x + i % U[0].x, U[1].y + i / U[0].x);
  let b = i * 11;
  cellOut[b] = i32(r.kind);
  cellOut[b + 1] = r.h;
  cellOut[b + 2] = r.H;
  cellOut[b + 3] = r.L;
  cellOut[b + 4] = r.a;
  cellOut[b + 5] = r.b;
  cellOut[b + 6] = r.A;
  cellOut[b + 7] = r.B;
  cellOut[b + 8] = r.F;
  cellOut[b + 9] = r.theta;
  cellOut[b + 10] = select(0, 1, r.saddle);
}
@compute @workgroup_size(64)
fn upBits(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {
  let i = gid.x + gid.y * nw.x * 64u;
  let s = i / 128u;
  if (s >= u32(U[0].z)) { return; }
  let c = splits[s];
  let r = crDerive(c.x, c.y);
  var w = 0u;
  for (var j = 0u; j < 32u; j++) {
    let col = i32((i % 128u) * 32u + j);
    if (crIsUp(r, c.x, c.y, col & 63, col >> 6u)) { w |= 1u << j; }
  }
  bits[i] = w;
}
`;

/** f32 local units -> 1/64 m units, the shader's crUnits in JS */
function units(z: number): number {
  const v = z * COARSE_U;
  const f = Math.floor(v);
  return f + (v - f >= 0.5 ? 1 : 0);
}

async function compare(name: string, zs: Float32Array, nx: number, ny: number, ox: number, oy: number): Promise<{ cells: number; splits: number; cols: number; cellMis: number; colMis: number }> {
  const g = await testGpu();
  const dev = g.device;
  const p = { ...defaultParams() };
  const f: Field = { nx, ny, h: new Int32Array(nx * ny) };
  for (let i = 0; i < nx * ny; i++) f.h[i] = units(zs[i]);
  const ts = [];
  const spl: number[] = [];
  for (let cy = 0; cy < ny; cy++)
    for (let cx = 0; cx < nx; cx++) {
      const r = deriveCell(f, cx, cy, p);
      ts.push(r);
      if (r.kind === KIND_SPLIT) spl.push(cx, cy);
    }
  const nS = spl.length / 2;
  const mod = dev.createShaderModule({ code: `${cliffRuleWgsl}\n${HARNESS}` });
  const info = await mod.getCompilationInfo();
  const errs = info.messages.filter((x) => x.type === 'error').map((x) => `${x.lineNum}:${x.linePos} ${x.message}`);
  expect(errs, errs.join('\n')).toEqual([]);
  const sb = (data: ArrayBufferView | number, usage = GPUBufferUsage.STORAGE) => {
    const size = typeof data === 'number' ? data : Math.max(16, data.byteLength);
    const b = dev.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    if (typeof data !== 'number') dev.queue.writeBuffer(b, 0, data.buffer, data.byteOffset, data.byteLength);
    return b;
  };
  const hz = sb(zs);
  const ub = sb(new Int32Array([nx, ny, nS, 0, ox, oy, 0, 0]), GPUBufferUsage.UNIFORM);
  const sp = sb(new Int32Array(spl.length ? spl.map((v, i) => v + (i % 2 ? oy : ox)) : [0, 0]));
  const co = sb(nx * ny * 11 * 4);
  const nb = Math.max(1, nS * 128);
  const bo = sb(nb * 4);
  const run = (entry: string, groups: number) => {
    const pipe = dev.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: entry } });
    const used = entry === 'cells' ? [0, 1, 3] : [0, 1, 2, 4];
    const all = [hz, ub, sp, co, bo];
    const bg = dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: used.map((b) => ({ binding: b, resource: { buffer: all[b] } })) });
    const e = dev.createCommandEncoder();
    const pass = e.beginComputePass();
    pass.setPipeline(pipe);
    pass.setBindGroup(0, bg);
    const gx = Math.min(groups, 65535);
    pass.dispatchWorkgroups(gx, Math.ceil(groups / gx));
    pass.end();
    dev.queue.submit([e.finish()]);
  };
  run('cells', Math.ceil((nx * ny) / 64));
  if (nS > 0) run('upBits', Math.ceil(nb / 64));
  const cells = new Int32Array(await g.read(co, nx * ny * 11 * 4));
  const bits = new Uint32Array(await g.read(bo, nb * 4));
  expect(g.takeErrors()).toEqual([]);
  let cellMis = 0;
  const firsts: string[] = [];
  for (let i = 0; i < nx * ny; i++) {
    const r = ts[i];
    const want = [r.kind, r.h, r.H, r.L, r.a, r.b, r.A, r.B, r.F, r.theta, r.saddle ? 1 : 0];
    const got = Array.from(cells.subarray(i * 11, i * 11 + 11));
    if (r.kind !== KIND_SPLIT) {
      // (a sheet: only the kind and h are defined in the port)
      want.length = 2;
      got.length = 2;
    }
    if (want.some((v, j) => v !== got[j])) {
      cellMis++;
      if (firsts.length < 5) firsts.push(`cell ${i % nx},${Math.floor(i / nx)}: ts ${want.join(',')} wgsl ${got.join(',')}`);
    }
  }
  let colMis = 0;
  for (let s = 0; s < nS; s++) {
    const cx = spl[2 * s];
    const cy = spl[2 * s + 1];
    const r = ts[cy * nx + cx];
    for (let c = 0; c < 4096; c++) {
      const up = isUp(r, cx + ox, cy + oy, c & 63, c >> 6, p);
      const gu = ((bits[s * 128 + (c >> 5)] >>> (c & 31)) & 1) === 1;
      if (up !== gu) {
        colMis++;
        if (firsts.length < 10) firsts.push(`split ${cx},${cy} col ${c & 63},${c >> 6}: ts ${up} wgsl ${gu}`);
      }
    }
  }
  const kinds = [0, 0, 0, 0];
  for (const r of ts) kinds[r.kind]++;
  const line = `[B1 exactness] ${name}: ${nx} x ${ny} cells at origin ${ox},${oy} (sheet ${kinds[0]}, top ${kinds[1]}, bottom ${kinds[2]}, split ${kinds[3]}); cell mismatches ${cellMis}; fine columns compared ${nS * 4096}, mismatches ${colMis}${firsts.length ? `\n  ${firsts.join('\n  ')}` : ''}`;
  console.log(line);
  fs.mkdirSync('local/nested', { recursive: true });
  fs.appendFileSync('local/nested/rB1-exactness.txt', `${new Date().toISOString()} ${line}\n`);
  for (const b of [hz, ub, sp, co, bo]) b.destroy();
  return { cells: nx * ny, splits: nS, cols: nS * 4096, cellMis, colMis };
}

it('B1: the WGSL cliff rule equals the TS on the synthetic field (negative origin)', async () => {
  const f = makeField();
  const zs = new Float32Array(f.h.length);
  for (let i = 0; i < f.h.length; i++) zs[i] = f.h[i] / COARSE_U;
  const r = await compare('synthetic', zs, f.nx, f.ny, -20, -16);
  expect(r.splits).toBeGreaterThan(100);
  expect(r.cellMis).toBe(0);
  expect(r.colMis).toBe(0);
}, 120_000);

const REAL = 'local/nested/rB1-heights.json';
it.skipIf(!fs.existsSync(REAL))('B1: the WGSL cliff rule equals the TS on the real 16 m window (rB1-heights.json)', async () => {
  const j = JSON.parse(fs.readFileSync(REAL, 'utf8')) as { gx: number; gy: number; n: number; z: number[] };
  const r = await compare('real 16 m window', new Float32Array(j.z), j.n, j.n, j.gx, j.gy);
  expect(r.cellMis).toBe(0);
  expect(r.colMis).toBe(0);
}, 300_000);

it.skipIf(!process.env.NESTED_B1_COST)('B1: compile time, default textured sheets against the ?cliff=4 variant', async () => {
  const ROUNDS = 7;
  const def = drawModuleCode(4, 64);
  const v4 = cliffRuleCode(4, 64, 1, 1024);
  expect(def.includes('crDerive'), 'the default module carries none of the rule').toBe(false);
  const time = async (code: string, fsName: string) => {
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter!.requestDevice();
    const m = device.createShaderModule({ code });
    const info = await m.getCompilationInfo();
    const errs = info.messages.filter((x) => x.type === 'error').map((x) => `${x.lineNum}:${x.linePos} ${x.message}`);
    expect(errs, errs.join('\n')).toEqual([]);
    const t0 = performance.now();
    await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module: m, entryPoint: 'vsSheet' },
      fragment: { module: m, entryPoint: fsName, targets: [{ format: 'bgra8unorm' }, { format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
    });
    const ms = performance.now() - t0;
    device.destroy();
    return ms;
  };
  const cases: [string, string, string][] = [
    ['sheetsTex default', def, 'fsST'],
    ['sheetsTex in variant', v4, 'fsST'],
    ['sheets cliff=4', v4, 'fsST4'],
  ];
  const res: Record<string, number[]> = {};
  for (let r = 0; r < ROUNDS; r++)
    for (let i = 0; i < cases.length; i++) {
      const [name, code, fsName] = cases[(i + r) % cases.length];
      (res[name] ??= []).push(await time(code, fsName));
    }
  const med = (v: number[]) => [...v].sort((x, y) => x - y)[Math.floor(v.length / 2)];
  const table = `[B1 compile] Dawn, ${ROUNDS} rounds, ms: median (runs)\n${Object.entries(res).map(([k, v]) => `  ${k.padEnd(22)} ${med(v).toFixed(0).padStart(5)}  (${v.map((x) => x.toFixed(0)).join(' ')})`).join('\n')}\n`;
  console.log(table);
  fs.mkdirSync('local/nested', { recursive: true });
  fs.appendFileSync('local/nested/rB1-compile.txt', `${new Date().toISOString()}\n${table}`);
}, 600_000);
