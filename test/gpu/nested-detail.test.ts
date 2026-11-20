// Nested scales lab (round 20): the detail bands and the textured shading are the same at a world point whichever level
// draws it. Each test point is given as each level L (0..3, k = 8) would give it to the fragment stage: its window origin
// in L's global columns, a level-local point and L's own z origin (different on every level), and shade.wgsl's texShade
// runs on all four with the same normal, pixel footprint and view. Under every band (?bands=all, the default) the
// colours agree to well under one 8-bit step and every band's height and gradient agree to f32 rounding; under the
// per-level cut-off (?bands=split) they differ (the check is not vacuous).
import { expect, it } from 'vitest';
import detailWgsl from '../../src/nested/gpu/detail.wgsl?raw';
import shadeWgsl from '../../src/nested/gpu/shade.wgsl?raw';

const LEVELS = 4;
const K_LOG2 = 3;
const WGSL = `${detailWgsl}\n${shadeWgsl}
struct P { o: vec2<i32>, s: i32, zo: f32, f: vec4<f32> }
struct Q { ng: vec4<f32>, view: vec4<f32>, px: f32, dist: f32, mat: u32, split: f32, canopy: f32 }
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
  var si: ShadeIn;
  si.p = p;
  si.ng = normalize(q.ng.xyz);
  si.mat = q.mat;
  si.pxW = q.px;
  si.view = normalize(q.view.xyz);
  si.distW = q.dist;
  si.sun = normalize(vec3<f32>(0.45, -0.35, 0.82));
  si.split = select(-1.0, f32(a.s), q.split > 0.5);
  si.canopy = q.canopy;
  outp[i * 4u] = vec4<f32>(texShade(si), 0.0);
  // three bands' height and gradient: a coarse, a middle and a fine one
  outp[i * 4u + 1u] = detailHG(p, q.mat, 2);
  outp[i * 4u + 2u] = detailHG(p, q.mat, 8);
  outp[i * 4u + 3u] = detailHG(p, q.mat, 14);
}`;

it('nested: a world point shades the same from every level (bands=all)', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter!.requestDevice();
  const module = device.createShaderModule({ code: WGSL });
  const info = await module.getCompilationInfo();
  const errs = info.messages.filter((m) => m.type === 'error').map((m) => `${m.lineNum}:${m.linePos} ${m.message}`);
  expect(errs, errs.join('\n')).toEqual([]);
  const pipe = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  // points: a world position as a finest-level (L3) global column and a fraction (exact), a world height
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const N = 512;
  // (round 21) canopy: the forest canopy's crossover footprint (0 off; 0.05 the page's default); far: footprints from 0.02
  // to 2 world units a pixel (the canopy's range: hills from afar) instead of the near range
  const run = async (split: boolean, canopy = 0.05, far = false) => {
    seed = 12345;
    const pb = new ArrayBuffer(N * LEVELS * 32);
    const qb = new ArrayBuffer(N * 64);
    for (let j = 0; j < N; j++) {
      // (world x, y up to 300 root columns; heights -20..40; level 3 columns 1/512)
      const X = Math.floor(rnd() * 300 * 512);
      const Y = Math.floor(rnd() * 300 * 512);
      const fx = Math.fround(rnd());
      const fy = Math.fround(rnd());
      const zW = -20 + rnd() * 60;
      // (the pair compared: coarse level Lc and its child)
      const Lc = j % (LEVELS - 1);
      for (let L = 0; L < LEVELS; L++) {
        const s = L * K_LOG2;
        const sh = (LEVELS - 1 - L) * K_LOG2;
        // (the window starts 40 to 200 of L's columns before the point)
        const o = [(X >> sh) - 40 - ((j * 7 + L * 13) % 160), (Y >> sh) - 40 - ((j * 11 + L * 5) % 160)];
        const f = [((X - (o[0] << sh)) + fx) / 2 ** sh, ((Y - (o[1] << sh)) + fy) / 2 ** sh];
        // (a level's z origin lies near its terrain: the point 0.5 to 30 of L's columns above it)
        const zo = Math.fround(zW - (0.5 + rnd() * 29.5) / 2 ** s);
        const fz = (zW - zo) * 2 ** s;
        const e = (j * LEVELS + L) * 32;
        new Int32Array(pb, e, 3).set([o[0], o[1], s]);
        new Float32Array(pb, e + 12, 5).set([zo, f[0], f[1], fz, 0]);
      }
      const ng = [rnd() - 0.5, rnd() - 0.5, rnd()];
      const view = [rnd() - 0.5, rnd() - 0.5, -rnd()];
      // (pixel footprints from 0.3 world units, the overview, down to 1/200 of the coarse level's column: nearer, its
      // child is drawn)
      const pxMin = 2 ** -(Lc * K_LOG2) / 200;
      const u = rnd();
      const px = far ? 0.02 * Math.pow(100, u) : 0.3 * Math.pow(pxMin / 0.3, u);
      new Float32Array(qb, j * 64, 10).set([...ng, 0, ...view, 0, px, 2000 * px]);
      // (round 25: plants, material 5, carry the canopy now; soil is plain dirt)
      new Uint32Array(qb, j * 64 + 40, 1).set([1 + (j % 5)]);
      new Float32Array(qb, j * 64 + 44, 2).set([split ? 1 : 0, canopy]);
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
    const oSize = N * LEVELS * 64;
    const oB = buf(null, oSize, S | GPUBufferUsage.COPY_SRC);
    const rB = buf(null, oSize, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    const bg = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [pB, qB, oB].map((b, binding) => ({ binding, resource: { buffer: b } })) });
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
    // per point: the largest difference between any level and level 0, colour (0..1) and band (relative to its scale)
    let col = 0;
    let band = 0;
    const per = [0, 0, 0, 0];
    for (let j = 0; j < N; j++)
      for (let L = (j % (LEVELS - 1)) + 1, once = true; once; once = false)
        for (let r = 0; r < 4; r++)
          for (let c = 0; c < (r === 0 ? 3 : 4); c++) {
            const a = out[(j * LEVELS + L) * 16 + r * 4 + c];
            const b = out[(j * LEVELS + L - 1) * 16 + r * 4 + c];
            if (r === 0) col = Math.max(col, Math.abs(a - b));
            else if (r < 3) {
              // (band 14, 1/8192 world units, is reported, not checked: here it is evaluated at every point, but it is
              // drawn only at footprints under 1/16384 world units, where level 3's local point is precise enough; at
              // level 0's local magnitudes f32 holds 1/8 of its wavelength)
              // (heights relative to the band's wavelength, gradients as they are: both about -1..1)
              const scale = c === 0 ? 2 ** (1 - [2, 8, 14][r - 1]) : 1;
              band = Math.max(band, Math.abs(a - b) / scale);
            }
            per[r] = Math.max(per[r], Math.abs(a - b) / (r > 0 && c === 0 ? 2 ** (1 - [2, 8, 14][r - 1]) : 1));
          }
    console.log(`[detail] split ${split} canopy ${canopy} far ${far}: colour, band 2, band 8, band 14: ${per.map((x) => x.toExponential(2)).join(', ')}`);
    // (the colours of level 0's copy of each point, to compare runs)
    const c0: number[] = [];
    for (let j = 0; j < N; j++) for (let c = 0; c < 3; c++) c0.push(out[j * LEVELS * 16 + c]);
    return { col, band, c0 };
  };
  const all = await run(false);
  const split = await run(true);
  console.log(`[detail] bands=all: colour ${all.col.toExponential(2)} (8-bit step ${(1 / 255).toExponential(2)}), bands ${all.band.toExponential(2)}; bands=split: colour ${split.col.toExponential(2)}`);
  expect(all.col).toBeLessThan(0.25 / 255);
  expect(all.band).toBeLessThan(1e-3);
  expect(split.col).toBeGreaterThan(1 / 255);
  // (round 21) far footprints, where the forest canopy is drawn: the same from every level; and the canopy changes the
  // colour there (not vacuous; the near run's on/off difference is logged: its footprints reach 0.3, inside the canopy)
  const far = await run(false, 0.05, true);
  const farOff = await run(false, 0, true);
  const nearOff = await run(false, 0);
  const diff = (a: number[], b: number[]) => a.reduce((m, x, i) => Math.max(m, Math.abs(x - b[i])), 0);
  console.log(`[detail] far, canopy on: colour ${far.col.toExponential(2)}; canopy on vs off: far ${diff(far.c0, farOff.c0).toExponential(2)}, near ${diff(all.c0, nearOff.c0).toExponential(2)}`);
  expect(far.col).toBeLessThan(0.25 / 255);
  expect(diff(far.c0, farOff.c0)).toBeGreaterThan(8 / 255);
  device.destroy();
}, 60_000);
