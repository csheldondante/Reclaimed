// Nested scales lab (round 27, ?tex=2): the tiling textures sample the same at a world point whichever level draws it.
// The textures are generated as the page does (TexGen: texgen.wgsl, every layer and its mips). Each test point is given
// as each level L (0..3, k = 8) would give it to the fragment stage (its window origin in L's global columns, a
// level-local point, L's own z origin) with the same world-space pixel footprint (the level-local derivatives scaled by
// 8^L), and tex.wgsl's txMat and texShade2 run on all four. Adjacent levels must agree (colour well under an 8-bit step);
// a point moved by half a fine texel must not (the check is not vacuous). Also: the textures' generation time.
import { expect, it } from 'vitest';
import detailWgsl from '../../src/nested/gpu/detail.wgsl?raw';
import shadeWgsl from '../../src/nested/gpu/shade.wgsl?raw';
import texWgsl from '../../src/nested/gpu/tex.wgsl?raw';
import storeWgsl from '../../src/nested/gpu/store.wgsl?raw';
import { TexGen, TEX_TILE_M } from '../../src/nested/texgen';

const LEVELS = 4;
const K_LOG2 = 3;
const ROOT_M = 128;
// (store.wgsl for matId; its table and page functions want tabLoad, pgLoad, TCAP: stand-ins, never called)
const WGSL = `const TCAP: u32 = 16u;
fn tabLoad(i: u32) -> u32 { return 0u; }
fn pgLoad(i: u32) -> u32 { return 0u; }
${storeWgsl}\n${detailWgsl}\n${shadeWgsl}\n${texWgsl}
struct P { o: vec2<i32>, s: i32, zo: f32, f: vec4<f32>, qx: vec4<f32>, qy: vec4<f32> }
struct Q { ng: vec4<f32>, view: vec4<f32>, px: f32, mat: u32, matB: u32, wb: f32, pad: vec4<f32> }
@group(0) @binding(0) var<storage, read> pts: array<P>;
@group(0) @binding(1) var<storage, read> qs: array<Q>;
@group(0) @binding(2) var<storage, read_write> outp: array<vec4<f32>>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= arrayLength(&pts)) { return; }
  let a = pts[i];
  let q = qs[i / ${LEVELS}u];
  let p = DPt(a.o, a.s, a.zo, a.f.xyz);
  let ng = normalize(q.ng.xyz);
  let m = txMat(p, i32(q.mat) - 1, ng, a.qx.xyz, a.qy.xyz, MF);
  outp[i * 3u] = vec4<f32>(m.alb, m.h);
  outp[i * 3u + 1u] = vec4<f32>(m.g, m.cav);
  var si: ShadeIn;
  si.p = p;
  si.ng = ng;
  si.mat = q.mat;
  si.pxW = q.px;
  si.view = normalize(q.view.xyz);
  si.distW = 2000.0 * q.px;
  si.sun = normalize(vec3<f32>(0.55, -0.45, 0.62));
  si.split = -1.0;
  si.canopy = 0.05;
  si.fog = 0.0;
  outp[i * 3u + 2u] = vec4<f32>(texShade2(si, MatMix(q.mat, q.matB, q.wb), a.qx.xyz, a.qy.xyz, MF), 0.0);
}`;

it('nested tex=2: a world point samples the same texel from every level', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter!.requestDevice();
  // the textures, as the page makes them: the pipelines, then a layer a step
  const tg = new TexGen(device);
  const t0 = performance.now();
  while (!tg.step()) await new Promise((r) => setTimeout(r, 5));
  await device.queue.onSubmittedWorkDone();
  console.log(`[tex] textures generated: pipelines ${tg.ms.compile.toFixed(0)} ms, layers encoded ${tg.ms.layers.map((x) => x.toFixed(1)).join(', ')} ms, all done on the GPU ${(performance.now() - t0).toFixed(0)} ms after the start; ${(tg.bytes / 2 ** 20).toFixed(1)} MB`);
  // (the fine tile's frequency in world units (root columns): 2^MF tiles a world unit)
  const MF = Math.round(Math.log2(ROOT_M / TEX_TILE_M));
  const module = device.createShaderModule({ code: `const MF: i32 = ${MF};\n${WGSL}` });
  const info = await module.getCompilationInfo();
  const errs = info.messages.filter((m) => m.type === 'error').map((m) => `${m.lineNum}:${m.linePos} ${m.message}`);
  expect(errs, errs.join('\n')).toEqual([]);
  const tc = performance.now();
  const pipe = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  console.log(`[tex] test pipeline (txMat, texShade2) made in ${(performance.now() - tc).toFixed(0)} ms`);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const N = 512;
  // shift: every point moved by this many world units in x (the not-vacuous run)
  const run = async (shift: number) => {
    seed = 12345;
    const pb = new ArrayBuffer(N * LEVELS * 64);
    const qb = new ArrayBuffer(N * 64);
    for (let j = 0; j < N; j++) {
      const X = Math.floor(rnd() * 300 * 512);
      const Y = Math.floor(rnd() * 300 * 512);
      const fx = Math.fround(rnd());
      const fy = Math.fround(rnd());
      const zW = -20 + rnd() * 60;
      const Lc = j % (LEVELS - 1);
      // (footprints from 0.3 world units down to 1/200 of the coarse level's column, as the detail test)
      const pxMin = 2 ** -(Lc * K_LOG2) / 200;
      const px = 0.3 * Math.pow(pxMin / 0.3, rnd());
      // (the screen derivatives in world units: two axes of about the footprint, one stretched up to 4 x: grazing)
      const ax = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
      const an = Math.hypot(...ax);
      const st = 1 + 3 * rnd();
      const dxW = ax.map((v) => (v / an) * px);
      const ay = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
      const ayn = Math.hypot(...ay);
      const dyW = ay.map((v) => (v / ayn) * px * st);
      for (let L = 0; L < LEVELS; L++) {
        const s = L * K_LOG2;
        const sh = (LEVELS - 1 - L) * K_LOG2;
        const o = [(X >> sh) - 40 - ((j * 7 + L * 13) % 160), (Y >> sh) - 40 - ((j * 11 + L * 5) % 160)];
        const f = [(X - (o[0] << sh) + fx) / 2 ** sh + shift * 2 ** s, (Y - (o[1] << sh) + fy) / 2 ** sh];
        const zo = Math.fround(zW - (0.5 + rnd() * 29.5) / 2 ** s);
        const fz = (zW - zo) * 2 ** s;
        const e = (j * LEVELS + L) * 64;
        new Int32Array(pb, e, 3).set([o[0], o[1], s]);
        new Float32Array(pb, e + 12, 13).set([zo, f[0], f[1], fz, 0, ...dxW.map((v) => v * 2 ** s), 0, ...dyW.map((v) => v * 2 ** s), 0]);
      }
      const ng = [rnd() - 0.5, rnd() - 0.5, rnd()];
      const view = [rnd() - 0.5, rnd() - 0.5, -rnd()];
      new Float32Array(qb, j * 64, 9).set([...ng, 0, ...view, 0, px]);
      // (materials 1-5; half the points at a border with another material, its weight 0.3..0.7)
      const mat = 1 + (j % 5);
      new Uint32Array(qb, j * 64 + 36, 2).set([mat, j & 1 ? 1 + ((j + 2) % 5) : mat]);
      new Float32Array(qb, j * 64 + 44, 1).set([0.3 + 0.4 * rnd()]);
    }
    const buf = (data: ArrayBuffer | null, size: number, usage: number) => {
      const b = device.createBuffer({ size, usage, mappedAtCreation: !!data });
      if (data) {
        new Uint8Array(b.getMappedRange()).set(new Uint8Array(data));
        b.unmap();
      }
      return b;
    };
    const S = GPUBufferUsage.STORAGE;
    const pB = buf(pb, pb.byteLength, S);
    const qB = buf(qb, qb.byteLength, S);
    const oSize = N * LEVELS * 48;
    const oB = buf(null, oSize, S | GPUBufferUsage.COPY_SRC);
    const rB = buf(null, oSize, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    const bg = device.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [...[pB, qB, oB].map((b, binding) => ({ binding, resource: { buffer: b } })), { binding: 6, resource: tg.viewA }, { binding: 7, resource: tg.viewN }, { binding: 8, resource: tg.sampler }],
    });
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipe);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil((N * LEVELS) / 64));
    pass.end();
    enc.copyBufferToBuffer(oB, 0, rB, 0, oSize);
    device.queue.submit([enc.finish()]);
    await rB.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(rB.getMappedRange().slice(0));
    rB.unmap();
    // per point: level Lc + 1 against Lc (the pair a level opening shows), the texture's colour and height, the slope,
    // and the shaded colour
    const per = { alb: 0, h: 0, g: 0, col: 0 };
    for (let j = 0; j < N; j++) {
      const L = (j % (LEVELS - 1)) + 1;
      const a = (r: number, c: number) => out[((j * LEVELS + L) * 3 + r) * 4 + c];
      const b = (r: number, c: number) => out[((j * LEVELS + L - 1) * 3 + r) * 4 + c];
      for (let c = 0; c < 3; c++) {
        per.alb = Math.max(per.alb, Math.abs(a(0, c) - b(0, c)));
        per.g = Math.max(per.g, Math.abs(a(1, c) - b(1, c)));
        per.col = Math.max(per.col, Math.abs(a(2, c) - b(2, c)));
      }
      per.h = Math.max(per.h, Math.abs(a(0, 3) - b(0, 3)));
    }
    const c0: number[] = [];
    for (let j = 0; j < N; j++) for (let c = 0; c < 3; c++) c0.push(out[j * LEVELS * 12 + 8 + c]);
    return { per, c0 };
  };
  const same = await run(0);
  // (half a fine texel: 2 m / 512 / 2 in world units)
  const moved = await run(TEX_TILE_M / 512 / 2 / ROOT_M);
  const diff = same.c0.reduce((m, x, i) => Math.max(m, Math.abs(x - moved.c0[i])), 0);
  console.log(`[tex] adjacent levels, largest difference: texture colour ${same.per.alb.toExponential(2)}, height ${same.per.h.toExponential(2)}, slope ${same.per.g.toExponential(2)}, shaded colour ${same.per.col.toExponential(2)} (8-bit step ${(1 / 255).toExponential(2)}); moved half a fine texel: shaded colour ${diff.toExponential(2)}`);
  expect(same.per.col).toBeLessThan(0.5 / 255);
  expect(same.per.alb).toBeLessThan(0.5 / 255);
  expect(diff).toBeGreaterThan(2 / 255);
  tg.destroy();
  device.destroy();
}, 120_000);
