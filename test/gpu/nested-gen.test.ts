// Nested scales lab (round 25): the root made from the atlas's ground and each finer level adding the generator's
// detail at its own column size (docs/design/NESTED_SCALES.md "Round 25 plan" c). On real Dawn, the page's own classes:
// the lab's atlas (Atlas.build over the 65.5 km torus), the generator field, GpuNest with it.
// Measured and checked:
// - the zoom cycle: every level demoted and promoted again over the same windows is bit-identical (enhance is a function
//   of the parent and the field);
// - restrict: an edit that changes nothing (raise by 0 at the finest level) moves no ancestor by more than f32 rounding
//   (parent = mean of its children holds with the detail in);
// - the generator's detail per level (the bracket: G_L less the PPM of G_(L-1)), RMS and max in metres: what reappears on
//   a surface edited flat at a coarser level (the open point, measured, not solved);
// - the atlas's build and the fill's cost.
import { expect, it } from 'vitest';
import { testGpu } from './dawn';
import { NestGen, labAtlasParams } from '../../src/nested/gen';
import { GpuNest, type Snapshot, type Win } from '../../src/nested/gpu/nest';
import { ppm2 } from '../../src/nested/oracle';

const K = 8;
const N = 256;
const ROOT_M = 128;

function tops(s: Snapshot, L: number, w: Win): Float64Array {
  const out = new Float64Array(w.n * w.n);
  for (let y = 0; y < w.n; y++)
    for (let x = 0; x < w.n; x++) {
      const r = s.records(L, w.gx + x, w.gy + y);
      // the top surface: the last solid record's top
      let t = NaN;
      for (let j = r.mat.length - 1; j >= 0; j--)
        if ((r.mat[j] & 255) !== 0) {
          t = r.top[j];
          break;
        }
      out[y * w.n + x] = t;
    }
  return out;
}

it('nested gen: atlas root, generated detail per level, zoom cycle and restrict', async () => {
  const g = await testGpu();
  const dev = g.device;
  const t0 = performance.now();
  const gen = await NestGen.create(dev, labAtlasParams(new URLSearchParams()), { slotN: N, levels: 4, rootM: ROOT_M, k: K });
  console.log(`[gen] atlas built in ${gen.ms.atlas.toFixed(0)} ms (its timings ${JSON.stringify(gen.atlas.timings)}), genFill compiled in ${gen.ms.compile.toFixed(0)} ms; ${(performance.now() - t0).toFixed(0)} ms in all`);
  const nest = new GpuNest(dev, K, 7, 2048, { syncGrow: true });
  nest.detailAmp = 0;
  nest.setGen(gen);
  // (the fill alone, timed: a whole window of root columns)
  // (round 27: a finer level's fill too; every fill now takes the slope's four more ground() calls)
  for (let i = 0; i < 4; i++) {
    const L = i >> 1;
    const enc = dev.createCommandEncoder();
    const p = enc.beginComputePass();
    gen.fill(p, L, 0, 0, N, N);
    p.end();
    const t = performance.now();
    dev.queue.submit([enc.finish()]);
    gen.submitted();
    await dev.queue.onSubmittedWorkDone();
    console.log(`[gen] fill of ${N} x ${N} level ${L} columns: ${(performance.now() - t).toFixed(1)} ms (run ${i & 1})`);
  }
  // (where to look: the whole torus at the root's columns, 2 x 2 windows; the 8 km squares with the most relief that are
  // mostly land, the page's default spot is picked from these)
  if (process.env.NESTED_GEN_SCAN) {
    const T = 512;
    const H = new Float32Array(T * T);
    for (let q = 0; q < 4; q++) {
      const ox = (q & 1) * N;
      const oy = (q >> 1) * N;
      const enc = dev.createCommandEncoder();
      const p = enc.beginComputePass();
      gen.fill(p, 0, ox, oy, N, N);
      p.end();
      dev.queue.submit([enc.finish()]);
      gen.submitted();
      const fld = new Float32Array(await g.read(gen.field, (8 + N * N) * 16));
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) H[(oy + y) * T + ox + x] = fld[(8 + y * N + x) * 4];
    }
    let land = 0;
    let hlo = 1e9;
    let hhi = -1e9;
    for (const h of H) {
      if (h > 90) land++;
      hlo = Math.min(hlo, h);
      hhi = Math.max(hhi, h);
    }
    console.log(`[gen scan] land ${((100 * land) / H.length).toFixed(0)} %, heights ${hlo.toFixed(0)}..${hhi.toFixed(0)} m`);
    const cands: { x: number; y: number; relief: number; land: number; steep: number }[] = [];
    for (let cy = 0; cy < T; cy += 16)
      for (let cx = 0; cx < T; cx += 16) {
        let lo = 1e9;
        let hi = -1e9;
        let ln = 0;
        let steep = 0;
        for (let y = -32; y < 32; y++)
          for (let x = -32; x < 32; x++) {
            const i = (((cy + y) % T) + T) % T;
            const j = (((cx + x) % T) + T) % T;
            const h = H[i * T + j];
            lo = Math.min(lo, h);
            hi = Math.max(hi, h);
            if (h > 90) ln++;
            steep = Math.max(steep, Math.abs(h - H[i * T + ((j + 1) % T)]));
          }
        cands.push({ x: cx, y: cy, relief: hi - lo, land: ln / 4096, steep });
      }
    cands.sort((a, b) => b.relief * Math.min(1, 2 * b.land) - a.relief * Math.min(1, 2 * a.land));
    console.log(`[gen scan] best 8 km squares (root columns x, y; relief m; land; steepest step m over 128 m): ${cands
      .slice(0, 8)
      .map((c) => `(${c.x}, ${c.y}) ${c.relief.toFixed(0)} ${c.land.toFixed(2)} ${c.steep.toFixed(0)}`)
      .join('; ')}`);
  }
  nest.root(N);
  const wins: Win[] = [nest.wins[0]!];
  for (let L = 1; L <= 3; L++) {
    const c = wins[L - 1].gx + wins[L - 1].n / 2;
    const w = nest.windowAt(L, c, wins[L - 1].gy + wins[L - 1].n / 2, N);
    expect(nest.promote(L, w)).toBe(true);
    wins.push(w);
  }
  // (an edit first, so the zoom cycle below also checks that it survives: a carve at level 2, radius 6 of its columns)
  {
    const s0 = await nest.readAll();
    const c = s0.column(2, wins[2].gx + N / 2, wins[2].gy + N / 2);
    expect(nest.edit({ op: 'carve', radius: 6 / K ** 2, amount: 0, at: { level: 2, x: N / 2, y: N / 2, z: c.z1[c.z1.length - 1] + 1 } })).toBe(true);
    // (round 27) a material edit too: an add (plain soil) at level 1, off the carve, so the cycle checks it survives
    const c1 = s0.column(1, wins[1].gx + N / 2 + 40, wins[1].gy + N / 2);
    expect(nest.edit({ op: 'add', radius: 4 / K, amount: 0, at: { level: 1, x: N / 2 + 40, y: N / 2, z: c1.z1[c1.z1.length - 1] + 0.5 } })).toBe(true);
  }
  const s1 = await nest.readAll();
  const t1 = wins.map((w, L) => tops(s1, L, w));
  for (let L = 0; L <= 3; L++) {
    const cs = ROOT_M / K ** L;
    // (world metres: the level's z origin, each level's in its parent's units, as draw.wgsl zOrigW)
    let zo = 0;
    for (let j = 1; j <= L; j++) zo += s1.zOrigin(j) / K ** (j - 1);
    const v = [...t1[L]].filter((x) => Number.isFinite(x)).map((x) => (zo + x / K ** L) * ROOT_M);
    const mats = new Map<string, number>();
    // (round 27) the material each sampled column shows on top (bits 0-3), and where it differs from its parent's top
    const shown = new Map<number, number>();
    let differs = 0;
    const topMat = (L2: number, X: number, Y: number) => {
      const r = s1.records(L2, X, Y);
      for (let j = r.mat.length - 1; j >= 0; j--) if ((r.mat[j] & 255) !== 0) return r.mat[j] & 15;
      return 0;
    };
    for (let y = 0; y < N; y += 4)
      for (let x = 0; x < N; x += 4) {
        const r = s1.records(L, wins[L].gx + x, wins[L].gy + y);
        const key = r.mat.filter((m) => (m & 255) !== 0).map((m) => (m & 255).toString(16)).join('.');
        mats.set(key, (mats.get(key) ?? 0) + 1);
        const t = topMat(L, wins[L].gx + x, wins[L].gy + y);
        shown.set(t, (shown.get(t) ?? 0) + 1);
        if (L > 0 && t !== topMat(L - 1, Math.floor((wins[L].gx + x) / K), Math.floor((wins[L].gy + y) / K))) differs++;
      }
    console.log(`[gen] level ${L} (${cs} m columns): local tops ${Math.min(...v).toFixed(1)}..${Math.max(...v).toFixed(1)}; column structures (material bytes bottom up, hex: count of 1/16 sampled) ${JSON.stringify([...mats])}; top material shown ${JSON.stringify([...shown])}${L > 0 ? `, ${differs} sampled columns show another top material than their parent column` : ''}`);
  }
  expect(g.takeErrors()).toEqual([]);

  // the generator's detail per level (the bracket), from the field
  const fieldBytes = (8 + 4 * N * N) * 16;
  const f = new Float32Array(await g.read(gen.field, fieldBytes));
  const G = (L: number, X: number, Y: number) => {
    const w = wins[L];
    const cx = Math.min(w.gx + w.n - 1, Math.max(w.gx, X));
    const cy = Math.min(w.gy + w.n - 1, Math.max(w.gy, Y));
    const x = ((cx % N) + N) % N;
    const y = ((cy % N) + N) % N;
    return f[(8 + L * N * N + y * N + x) * 4];
  };
  for (let L = 1; L <= 3; L++) {
    let ss = 0;
    let mx = 0;
    let n = 0;
    const w = wins[L];
    for (let y = 0; y < N; y += 3)
      for (let x = 0; x < N; x += 3) {
        const X = w.gx + x;
        const Y = w.gy + y;
        const px = Math.floor(X / K);
        const py = Math.floor(Y / K);
        const d = G(L, X, Y) - (G(L - 1, px, py) + ppm2((a, b) => G(L - 1, a, b), px, py, X - px * K, Y - py * K, K));
        ss += d * d;
        mx = Math.max(mx, Math.abs(d));
        n++;
      }
    console.log(`[gen] level ${L}: the generator's detail (G_L less the PPM of G_(L-1)): RMS ${Math.sqrt(ss / n).toFixed(3)} m, max ${mx.toFixed(3)} m`);
  }

  // the zoom cycle: demote every level, promote again over the same windows: bit-identical
  nest.demote(1);
  for (let L = 1; L <= 3; L++) expect(nest.promote(L, wins[L])).toBe(true);
  const s2 = await nest.readAll();
  let cycleDiff = 0;
  // (round 27) whole records too (tops and material words, edges included): the materials decided per level and the
  // level 1 add survive the cycle
  let recDiff = 0;
  for (let L = 0; L <= 3; L++) {
    const t2 = tops(s2, L, wins[L]);
    for (let i = 0; i < t2.length; i++) if (!(t2[i] === t1[L][i] || (Number.isNaN(t2[i]) && Number.isNaN(t1[L][i])))) cycleDiff++;
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const a = s1.records(L, wins[L].gx + x, wins[L].gy + y);
        const b = s2.records(L, wins[L].gx + x, wins[L].gy + y);
        if (a.mat.length !== b.mat.length || a.mat.some((m, j) => m !== b.mat[j] || !Object.is(a.top[j], b.top[j]))) recDiff++;
      }
  }
  console.log(`[gen] zoom cycle with a level 2 carve and a level 1 add in (demote 1, promote 1-3 again): ${cycleDiff} column tops differ, ${recDiff} columns' records differ`);
  expect(cycleDiff).toBe(0);
  expect(recDiff).toBe(0);

  // restrict: raise by 0 at the finest level's centre, radius ~70 of its columns: the ancestors move by rounding only
  expect(nest.edit({ op: 'raise', radius: 70 / K ** 3, amount: 0, at: { level: 3, x: N / 2, y: N / 2 } })).toBe(true);
  const s3 = await nest.readAll();
  for (let L = 0; L <= 3; L++) {
    const t3 = tops(s3, L, wins[L]);
    let mx = 0;
    for (let i = 0; i < t3.length; i++) if (Number.isFinite(t3[i])) mx = Math.max(mx, Math.abs(t3[i] - t1[L][i]));
    console.log(`[gen] restrict check (raise by 0 at level 3): level ${L} moved at most ${mx.toExponential(2)} of its units (${(mx * (ROOT_M / K ** L) * 1000).toExponential(2)} mm)`);
    expect(mx * (ROOT_M / K ** L)).toBeLessThan(1e-3);
  }
  expect(g.takeErrors()).toEqual([]);

  // the sliding root (round 25 step 4): a carve on the root near its rear edge, the window slid away (the carved chunks
  // leave, kept as the root's residual) and back (generated again, the residual applied): every column of the strip as
  // it was, carved ones included; the strip the window entered and left again: generated, bit-identical
  nest.demote(1);
  const w0 = { ...nest.wins[0]! };
  const colOf = (s: Snapshot, X: number, Y: number) => JSON.stringify(s.records(0, X, Y));
  const sa = await nest.readAll();
  const topAt = (s: Snapshot, X: number, Y: number) => {
    const c = s.column(0, X, Y);
    return c.z1[c.z1.length - 1];
  };
  expect(nest.edit({ op: 'carve', radius: 3, amount: 0, at: { level: 0, x: 8, y: 128, z: topAt(sa, w0.gx + 8, w0.gy + 128) + 0.5 } })).toBe(true);
  const sb = await nest.readAll();
  let carved = 0;
  for (let y = 120; y < 137; y++) for (let x = 0; x < 20; x++) if (colOf(sb, w0.gx + x, w0.gy + y) !== colOf(sa, w0.gx + x, w0.gy + y)) carved++;
  expect(nest.slide(0, { gx: w0.gx + 32, gy: w0.gy, n: N })).toBe(true);
  const sm = await nest.readAll();
  expect(nest.slide(0, { ...w0 })).toBe(true);
  const sc = await nest.readAll();
  expect(nest.slide(0, { gx: w0.gx + 32, gy: w0.gy, n: N })).toBe(true);
  const sd = await nest.readAll();
  let back = 0;
  let gen2 = 0;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < 32; x++) {
      if (colOf(sc, w0.gx + x, w0.gy + y) !== colOf(sb, w0.gx + x, w0.gy + y)) {
        if (!back) console.log(`[gen] first differing column (${x}, ${y}): before ${colOf(sb, w0.gx + x, w0.gy + y)}, after ${colOf(sc, w0.gx + x, w0.gy + y)}, generated ${colOf(sa, w0.gx + x, w0.gy + y)}`);
        back++;
      }
      if (colOf(sd, w0.gx + N + x, w0.gy + y) !== colOf(sm, w0.gx + N + x, w0.gy + y)) gen2++;
    }
  const res = sm.pagesOf(8);
  console.log(`[gen] sliding root: the carve changed ${carved} root columns; slid +32 and back: ${back} of ${32 * N} columns of the strip differ from before the slide (residual pages held while away: ${res})`);
  expect(carved).toBeGreaterThan(0);
  expect(back).toBe(0);
  expect(gen2).toBe(0);
  expect(g.takeErrors()).toEqual([]);
  nest.destroy();
}, 240_000);
