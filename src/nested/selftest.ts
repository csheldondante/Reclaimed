// Nested scales lab: the page self-test (?selftest=1). The same invariants as test/unit/nested-oracle.test.ts, run on
// the GPU passes over pages, and the GPU compared with the oracle. Readbacks here are test-only.
import { GpuNest, RES_ID, type Snapshot, type Win } from './gpu/nest';
import { Level, Nest, OPEN_BOTTOM, toLayers, type Col, type Frame } from './oracle';

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

const K = 8;
const SEED = 7;
const ROOT = 48;
const F1: Win = { gx: 128, gy: 160, n: 64 };
const F2: Win = { gx: (128 + 24) * K, gy: (160 + 24) * K, n: 64 };
/** f32 against f64: local values up to a few hundred units */
const TOL = 2e-3;

type Cols = Map<string, Col>;
function levelCols(s: Snapshot, lid: number, w: Win): Cols {
  const m = new Map<string, Col>();
  for (let y = w.gy; y < w.gy + w.n; y++) for (let x = w.gx; x < w.gx + w.n; x++) m.set(`${x},${y}`, s.column(lid, x, y));
  return m;
}
/** bit-identical (as f32 bits) */
function identical(a: Cols, b: Cols): { same: boolean; diff: number } {
  let diff = 0;
  for (const [key, c] of a) {
    const d = b.get(key);
    if (!d || d.mat.length !== c.mat.length || c.mat.some((v, i) => v !== d.mat[i] || !Object.is(c.z0[i], d.z0[i]) || !Object.is(c.z1[i], d.z1[i]))) diff++;
  }
  return { same: diff === 0 && a.size === b.size, diff };
}
/** max |gpu - oracle| over every interval bound (the open bottom left out); -1 on a structure difference */
function against(g: Cols, o: Level): number {
  let worst = 0;
  for (const [key, c] of g) {
    const [x, y] = key.split(',').map(Number);
    const r = o.at(x, y)!;
    if (c.mat.length !== r.mat.length || c.mat.some((v, i) => v !== r.mat[i])) return -1;
    for (let i = 0; i < c.mat.length; i++) worst = Math.max(worst, Math.abs(c.z1[i] - r.z1[i]), i ? Math.abs(c.z0[i] - r.z0[i]) : 0);
  }
  return worst;
}
const frame = (L: number, w: Win, s: Snapshot): Frame => ({ depth: L, gx: w.gx, gy: w.gy, n: w.n, z0: s.zOrigin(L) });

export async function selftest(device: GPUDevice, log: (c: Check) => void): Promise<Check[]> {
  const out: Check[] = [];
  const check = (name: string, pass: boolean, detail: string) => {
    const c = { name, pass, detail };
    out.push(c);
    log(c);
  };
  // a small pool on purpose: it must grow under load without loss
  const g = new GpuNest(device, K, SEED, 16);
  const stripe = { x: F1.gx / K + 4, y: F1.gy / K + 4, count: 40 };
  g.root(ROOT, stripe);
  let s = await g.readAll();
  const root = new Level({ depth: 0, gx: 0, gy: 0, n: ROOT, z0: 0 });
  for (let y = 0; y < ROOT; y++) for (let x = 0; x < ROOT; x++) root.set(x, y, s.column(0, x, y));
  const o = new Nest(root, K, SEED);
  const sc = s.column(0, stripe.x, stripe.y);
  check('root: a column of 40 intervals spans three stacked pages', sc.mat.length === 40 && s.page(0, stripe.x >> 4, stripe.y >> 4, 2) >= 0 && s.page(0, stripe.x >> 4, stripe.y >> 4, 3) < 0, `${sc.mat.length} intervals`);

  // promote
  let t0 = performance.now();
  g.promote(1, F1);
  await device.queue.onSubmittedWorkDone();
  const promoteMs = performance.now() - t0;
  s = await g.readAll();
  o.promote(frame(1, F1, s));
  const c1 = levelCols(s, 1, F1);
  let e = against(c1, o.levels[1]);
  check('promote: the GPU child matches the oracle', e >= 0 && e < TOL, `max |gpu - oracle| ${e.toExponential(2)} local units (tolerance ${TOL}); ${promoteMs.toFixed(1)} ms with readback setup`);
  check('promote: no residual pages without edits', s.pagesOf(RES_ID + 1) === 0, `${s.pagesOf(RES_ID + 1)} residual pages`);
  check('the 40-interval column enhances into a 40-interval block on three pages', s.column(1, stripe.x * K + 3, stripe.y * K + 5).mat.length === 40 && s.page(1, (stripe.x * K) >> 4, (stripe.y * K) >> 4, 2) >= 0, '');

  // (a) demote, promote: bit-identical
  g.demote(1);
  s = await g.readAll();
  check('demote frees the level, keeps no residual', s.pagesOf(1) === 0 && s.pagesOf(RES_ID + 1) === 0, `level pages ${s.pagesOf(1)}, residual ${s.pagesOf(RES_ID + 1)}`);
  g.promote(1, F1);
  s = await g.readAll();
  let id = identical(levelCols(s, 1, F1), c1);
  check('(a) promote, demote, promote: bit-identical without edits', id.same, `${id.diff} columns differ`);

  // edits at depth 1
  t0 = performance.now();
  g.edit({ op: 'raise', radius: 6 / K, amount: 3 / K, at: { level: 1, x: 20, y: 30 } });
  await device.queue.onSubmittedWorkDone();
  const editMs = performance.now() - t0;
  g.edit({ op: 'dig', radius: 5 / K, amount: 4 / K, at: { level: 1, x: 40, y: 20 } });
  g.edit({ op: 'dig', radius: 5 / K, amount: 6 / K, at: { level: 1, x: stripe.x * K + 4 - F1.gx, y: stripe.y * K + 4 - F1.gy } });
  o.edit(1, 'raise', F1.gx + 20, F1.gy + 30, 6, 3);
  o.edit(1, 'dig', F1.gx + 40, F1.gy + 20, 5, 4);
  o.edit(1, 'dig', stripe.x * K + 4, stripe.y * K + 4, 5, 6);
  s = await g.readAll();
  const c1e = levelCols(s, 1, F1);
  e = against(c1e, o.levels[1]);
  check('edits at depth 1: the GPU matches the oracle (child)', e >= 0 && e < TOL, `max diff ${e.toExponential(2)}; one edit ${editMs.toFixed(1)} ms with sync`);
  const r0 = levelCols(s, 0, { gx: 0, gy: 0, n: ROOT });
  e = against(r0, o.levels[0]);
  check('edits at depth 1 restricted into the root: the GPU matches the oracle', e >= 0 && e < TOL / K, `max diff ${e.toExponential(2)}`);
  {
    const gpuChunks = s.chunksOf(RES_ID + 1);
    const oraChunks = new Set([...o.res[1].keys()].map((key) => `${Math.floor((key % o.rowWidth(1)) / 16)},${Math.floor(Math.floor(key / o.rowWidth(1)) / 16)}`));
    const same = gpuChunks.size === oraChunks.size && [...gpuChunks].every((c) => oraChunks.has(c));
    check('residual pages exactly on the chunks where the oracle has a non-zero residual', same, `GPU ${gpuChunks.size} chunks, oracle ${oraChunks.size} of 16; ${s.pagesOf(RES_ID + 1)} residual pages with overflow`);
  }
  // (b) volume: each root column against its block
  let worst = 0;
  const z0 = s.zOrigin(1);
  for (let py = F1.gy / K; py < (F1.gy + F1.n) / K; py++)
    for (let px = F1.gx / K; px < (F1.gx + F1.n) / K; px++) {
      const pl = toLayers(s.column(0, px, py));
      const sum = pl.v.map(() => 0);
      for (let b = 0; b < K; b++) for (let a = 0; a < K; a++) toLayers(c1e.get(`${px * K + a},${py * K + b}`)!).v.forEach((v, i) => (sum[i] += v));
      worst = Math.max(worst, Math.abs(sum[0] / K ** 3 - (pl.v[0] - z0)), ...pl.v.slice(1).map((v, i) => Math.abs(sum[i + 1] / K ** 3 - v)));
    }
  check('(b) restrict conserves volume per layer', worst < 1e-4, `worst block ${worst.toExponential(2)} parent units (tolerance 1e-4)`);
  g.demote(1);
  g.promote(1, F1);
  s = await g.readAll();
  id = identical(levelCols(s, 1, F1), c1e);
  check('(a) promote, demote, promote: bit-identical with edits (and the 40-interval column dug)', id.same, `${id.diff} columns differ`);

  // melt conserves volume
  const box = { gx: 0, gy: 0, n: 64 };
  const vol = (cs: Cols) => {
    let sv = 0;
    let soil = 0;
    for (const c of cs.values()) {
      sv += c.z1[c.z1.length - 1];
      if (c.mat.length === 2) soil += c.z1[1] - c.z0[1];
    }
    return [sv, soil];
  };
  const before = vol(levelCols(s, 1, { ...box, gx: F1.gx, gy: F1.gy }));
  for (let i = 0; i < 6; i++) g.edit({ op: 'melt', radius: 9 / K, amount: 0, rate: 0.1, at: { level: 1, x: 22, y: 30 } });
  s = await g.readAll();
  const after = vol(levelCols(s, 1, { ...box, gx: F1.gx, gy: F1.gy }));
  const meltShape = identical(levelCols(s, 1, F1), c1e).diff;
  check('melt moves material and conserves it (surface sum and soil volume of the level)', meltShape > 0 && Math.abs(after[0] - before[0]) < 0.05 && Math.abs(after[1] - before[1]) < 0.05, `${meltShape} columns changed; surface sum ${before[0].toFixed(3)} -> ${after[0].toFixed(3)}, soil ${before[1].toFixed(3)} -> ${after[1].toFixed(3)} (f32 sums of 4096 columns)`);
  const c1m = levelCols(s, 1, F1);
  // the oracle follows the melt by taking the GPU's level as its own (melt has no oracle: NS-10)
  for (const [key, c] of c1m) {
    const [x, y] = key.split(',').map(Number);
    o.levels[1].set(x, y, { mat: c.mat.slice(), z0: c.z0.map((v, i) => (i ? v : OPEN_BOTTOM)), z1: c.z1.slice() });
  }
  for (let y = 0; y < ROOT; y++) for (let x = 0; x < ROOT; x++) o.levels[0].set(x, y, s.column(0, x, y));
  // the oracle's residuals for level 1 follow from its levels
  o.propagate(1, { x0: F1.gx, y0: F1.gy, x1: F1.gx + F1.n, y1: F1.gy + F1.n });

  // (c) a three-level chain
  g.promote(2, F2);
  s = await g.readAll();
  o.promote(frame(2, F2, s));
  e = against(levelCols(s, 2, F2), o.levels[2]);
  check('depth 2: the GPU matches the oracle', e >= 0 && e < TOL, `max diff ${e.toExponential(2)}`);
  g.edit({ op: 'raise', radius: 10 / K ** 2, amount: 6 / K ** 2, at: { level: 2, x: 32, y: 32 } });
  g.edit({ op: 'dig', radius: 6 / K ** 2, amount: 8 / K ** 2, at: { level: 2, x: 20, y: 40 } });
  o.edit(2, 'raise', F2.gx + 32, F2.gy + 32, 10, 6);
  o.edit(2, 'dig', F2.gx + 20, F2.gy + 40, 6, 8);
  s = await g.readAll();
  const ch = [levelCols(s, 0, { gx: 0, gy: 0, n: ROOT }), levelCols(s, 1, F1), levelCols(s, 2, F2)];
  e = Math.max(...ch.map((c, m) => against(c, o.levels[m]) * K ** (2 - m)));
  check('(c) an edit at depth 2: every level matches the oracle', e >= 0 && e < TOL, `max diff ${e.toExponential(2)} (in depth-2 units)`);
  g.demote(2);
  g.demote(1);
  s = await g.readAll();
  id = identical(levelCols(s, 0, { gx: 0, gy: 0, n: ROOT }), ch[0]);
  check('(c) demoting both leaves the root as it was', id.same, `${id.diff} columns differ`);
  g.promote(1, F1);
  g.promote(2, F2);
  s = await g.readAll();
  const id1 = identical(levelCols(s, 1, F1), ch[1]);
  const id2 = identical(levelCols(s, 2, F2), ch[2]);
  check('(c) both promoted again: bit-identical', id1.same && id2.same, `${id1.diff} + ${id2.diff} columns differ`);

  // tunnels: a row of carved balls through the ground at depth 1 and at depth 2, and a blob added in mid-air
  {
    const solidSum = (cs: Cols) => {
      let v = 0;
      for (const c of cs.values()) for (let i = 0; i < c.mat.length; i++) v += c.z1[i] - Math.max(c.z0[i], -500);
      return v;
    };
    const res: string[] = [];
    let ok = true;
    for (const [L, F] of [
      [1, F1],
      [2, F2],
    ] as const) {
      const before = solidSum(levelCols(s, L, F));
      const mid = o.levels[L].at(F.gx + 32, F.gy + 32)!;
      const cz = mid.z1[mid.z1.length - 1] - 4;
      const t0 = performance.now();
      for (let i = 0; i < 9; i++) {
        g.edit({ op: 'carve', radius: 3 / K ** L, amount: 0, at: { level: L, x: 16 + i * 4 + 0.5, y: 32.5, z: cz } });
        o.edit(L, 'carve', F.gx + 16 + i * 4 + 0.5, F.gy + 32.5, 3, 0, cz);
      }
      await device.queue.onSubmittedWorkDone();
      const ms = (performance.now() - t0) / 9;
      s = await g.readAll();
      const removed = before - solidSum(levelCols(s, L, F));
      const worst = Math.max(...[0, 1, 2].map((m) => against(levelCols(s, m, m === 0 ? { gx: 0, gy: 0, n: ROOT } : m === 1 ? F1 : F2), o.levels[m]) * K ** (L - m)));
      const t = s.column(L, F.gx + 32, F.gy + 32);
      const gap = Math.max(...t.mat.map((_m, i) => (i ? t.z0[i] - t.z1[i - 1] : 0)));
      ok &&= worst >= 0 && worst < TOL * 4 && removed > 9 * 50 && removed < 9 * 113 * 1.1 && gap > 4;
      res.push(`depth ${L}: ${removed.toFixed(0)} cells³ removed (9 balls r 3, overlapping; one alone 113), gap ${gap.toFixed(2)}, max |gpu - oracle| ${worst.toExponential(2)}, ${ms.toFixed(1)} ms a carve with sync`);
    }
    check('carve a tunnel at depth 1 and depth 2: the GPU matches the oracle on every level, the volume removed fits the balls', ok, res.join('; '));
    const mid = o.levels[1].at(F1.gx + 50, F1.gy + 50)!;
    const az = mid.z1[mid.z1.length - 1] + 10;
    g.edit({ op: 'add', radius: 4 / K, amount: 0, at: { level: 1, x: 50.5, y: 50.5, z: az } });
    o.edit(1, 'add', F1.gx + 50.5, F1.gy + 50.5, 4, 0, az);
    s = await g.readAll();
    const blob = s.column(1, F1.gx + 50, F1.gy + 50);
    e = against(levelCols(s, 1, F1), o.levels[1]);
    check('add a blob in mid-air: its own interval above an air gap, the GPU matches the oracle', blob.mat.length === 3 && blob.z0[2] - blob.z1[1] > 5 && e >= 0 && e < TOL * 4, `${blob.mat.length} intervals, gap under the blob ${(blob.z0[2] - blob.z1[1]).toFixed(2)}, max diff ${e.toExponential(2)}`);
    const t1 = levelCols(s, 1, F1);
    const t2 = levelCols(s, 2, F2);
    for (let i = 0; i < 20; i++) {
      g.demote(1);
      g.promote(1, F1);
      g.promote(2, F2);
      if (i % 5 === 4) await new Promise((r) => setTimeout(r, 30));
    }
    s = await g.readAll();
    const i1 = identical(levelCols(s, 1, F1), t1);
    const i2 = identical(levelCols(s, 2, F2), t2);
    check('tunnels and the blob: 20 demote/promote cycles of both levels, bit-identical', i1.same && i2.same, `${i1.diff} + ${i2.diff} columns differ; residual pages ${s.pagesOf(RES_ID + 1)} + ${s.pagesOf(RES_ID + 2)}`);
  }

  // (d) a parent edit while the child is demoted
  const keep = levelCols(s, 1, F1);
  g.demote(1);
  g.edit({ op: 'dig', radius: 1.5, amount: 3, at: { level: 0, x: F1.gx / K + 6.5, y: F1.gy / K + 6.5 } });
  g.promote(1, F1);
  s = await g.readAll();
  const d1 = levelCols(s, 1, F1);
  const sAt = (c: Cols, x: number, y: number) => {
    const col = c.get(`${F1.gx + x},${F1.gy + y}`)!;
    return col.z1[col.z1.length - 1];
  };
  check('(d) a parent edit under a demoted child shows in it; the child edit away from it survives', sAt(keep, 52, 52) - sAt(d1, 52, 52) > 5 && sAt(d1, 20, 30) === sAt(keep, 20, 30), `dug ${(sAt(keep, 52, 52) - sAt(d1, 52, 52)).toFixed(2)} child units at the parent's edit; the raise ${sAt(d1, 20, 30) === sAt(keep, 20, 30) ? 'bit-identical' : 'changed'}`);

  // (e) a slide by whole chunks
  const before2 = levelCols(s, 1, F1);
  const G1 = { gx: F1.gx + 16, gy: F1.gy - 32, n: 64 };
  t0 = performance.now();
  g.slide(1, G1);
  await device.queue.onSubmittedWorkDone();
  const slideMs = performance.now() - t0;
  s = await g.readAll();
  const slid = levelCols(s, 1, G1);
  let same = 0;
  let diffs = 0;
  for (const [key, c] of slid) {
    const b = before2.get(key);
    if (!b) continue;
    same++;
    if (b.mat.length !== c.mat.length || c.z1.some((v, i) => !Object.is(v, b.z1[i]))) diffs++;
  }
  g.demote(1);
  g.promote(1, G1);
  s = await g.readAll();
  id = identical(levelCols(s, 1, G1), slid);
  check('(e) a slide keeps the overlapping columns bit-identical and equals a fresh promote there', same === 48 * 32 && diffs === 0 && id.same, `${same} overlapping, ${diffs} differ; fresh promote differs in ${id.diff}; slide ${slideMs.toFixed(1)} ms`);

  // 100 cycles
  const ref = levelCols(s, 1, G1);
  for (let i = 0; i < 100; i++) {
    g.demote(1);
    g.promote(1, G1);
    // (the pool's header is read back asynchronously; let it catch up now and then, as frames would)
    if (i % 10 === 9) await new Promise((r) => setTimeout(r, 30));
  }
  s = await g.readAll();
  id = identical(levelCols(s, 1, G1), ref);
  check('100 demote/promote cycles do not drift', id.same, `${id.diff} columns differ`);

  await device.queue.onSubmittedWorkDone();
  await new Promise((r) => setTimeout(r, 50));
  const st = g.stats;
  check('the pool grew under load with nothing refused; no mismatches, table never full, every residual exact', st.grows > 0 && s.ctl[1] === 0 && s.ctl[4] === 0 && s.ctl[5] === 0 && s.ctl[6] === 0, `started at 16 pages, grew ${st.grows} times to ${g.cap}; refused ${s.ctl[1]}, mismatches ${s.ctl[4]}, table full ${s.ctl[5]}, inexact residuals ${s.ctl[6]}`);
  return out;
}
