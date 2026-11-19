// Nested scales lab: the page self-test (?selftest=1). The same invariants as test/unit/nested-oracle.test.ts, run on
// the GPU passes over pages, and the GPU compared with the oracle. Readbacks here are test-only.
import { GpuNest, RES_ID, type Snapshot, type Win } from './gpu/nest';
import { Level, Nest, OPEN_BOTTOM, edgeAt, toLayers, type Col, type Frame } from './oracle';
import { edgeClose, edgeDec, edgeDiff } from './edge';

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
    // (round 22: the edge samples too)
    if (!d || d.mat.length !== c.mat.length || c.mat.some((v, i) => v !== d.mat[i] || edgeAt(c, i) !== edgeAt(d, i) || !Object.is(c.z0[i], d.z0[i]) || !Object.is(c.z1[i], d.z1[i]))) diff++;
  }
  return { same: diff === 0 && a.size === b.size, diff };
}
/** max |gpu - oracle| over every interval bound (the open bottom left out); -1 on a structure difference */
function against(g: Cols, o: Level): number {
  let worst = 0;
  for (const [key, c] of g) {
    const [x, y] = key.split(',').map(Number);
    const r = o.at(x, y)!;
    const say = (w: string) => (worstAt = `${o.f.depth}:${key} ${w} gpu ${JSON.stringify({ ...c, edge: c.edge?.map((e) => e >>> 0) })} oracle ${JSON.stringify(r)}`);
    if (c.mat.length !== r.mat.length || c.mat.some((v, i) => v !== r.mat[i])) {
      say('structure');
      return -1;
    }
    for (let i = 0; i < c.mat.length; i++) {
      const d = Math.max(Math.abs(c.z1[i] - r.z1[i]), i ? Math.abs(c.z0[i] - r.z0[i]) : 0);
      if (d > worst) {
        worst = d;
        say(`interval ${i}`);
      }
    }
  }
  return worst;
}
/** (round 24, diagnosis) where `against` found its worst (or the structure difference) */
let worstAt = '';
const frame = (L: number, w: Win, s: Snapshot): Frame => ({ depth: L, gx: w.gx, gy: w.gy, n: w.n, z0: s.zOrigin(L) });

export async function selftest(device: GPUDevice, log: (c: Check) => void): Promise<Check[]> {
  const out: Check[] = [];
  const check = (name: string, pass: boolean, detail: string) => {
    const c = { name, pass, detail };
    out.push(c);
    log(c);
  };
  // a small pool on purpose: it must grow under load without loss (the self-test runs ops back to back, so it grows at
  // once instead of ahead)
  const g = new GpuNest(device, K, SEED, 16, { syncGrow: true });
  // (round 24) ?edgeenh=1 (or ?rimsnap=1) checks edge-aware enhance on both sides
  const uq = new URLSearchParams(location.search);
  g.edgeEnh = uq.has('edgeenh') ? uq.get('edgeenh') === '1' : uq.get('rimsnap') === '1';
  // (every op here must run: a refusal is a failure, said in words)
  for (const op of ['edit', 'promote', 'slide'] as const) {
    const f = (g[op] as (...a: unknown[]) => boolean).bind(g);
    (g as unknown as Record<string, unknown>)[op] = (...a: unknown[]) => {
      if (!f(...a)) throw new Error(`${op} refused: ${g.stats.error || 'the pool could not hold its worst case'} (cap ${g.cap}, used ${g.stats.used})`);
      return true;
    };
  }
  const stripe = { x: F1.gx / K + 4, y: F1.gy / K + 4, count: 40 };
  g.root(ROOT, stripe);
  let s = await g.readAll();
  const root = new Level({ depth: 0, gx: 0, gy: 0, n: ROOT, z0: 0 });
  for (let y = 0; y < ROOT; y++) for (let x = 0; x < ROOT; x++) root.set(x, y, s.column(0, x, y));
  const o = new Nest(root, K, SEED);
  o.edgeEnh = g.edgeEnh;
  const sc = s.column(0, stripe.x, stripe.y);
  // (40 records at 24 a column page: two stacked pages)
  check('root: a column of 40 intervals spans two stacked column pages', sc.mat.length === 40 && s.page(0, stripe.x >> 4, stripe.y >> 4, 1) >= 0 && s.page(0, stripe.x >> 4, stripe.y >> 4, 2) < 0, `${sc.mat.length} intervals`);

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
  check('the 40-interval column enhances into a 40-interval block on two stacked pages', s.column(1, stripe.x * K + 3, stripe.y * K + 5).mat.length === 40 && s.page(1, (stripe.x * K) >> 4, (stripe.y * K) >> 4, 1) >= 0, '');

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
  // (b) volume: each root column against its block: the top surface, each material's volume above the first interval
  // and the enclosed air (a block whose children differ in structure, e.g. where the dig emptied intervals the
  // partition dropped, restricts by the template rule, which conserves these, not each layer)
  let worst = 0;
  const z0 = s.zOrigin(1);
  const vols = (c: { mat: number[]; z0: number[]; z1: number[] }) => {
    const v = new Map<number, number>();
    let air = 0;
    for (let i = 1; i < c.mat.length; i++) {
      v.set(c.mat[i], (v.get(c.mat[i]) ?? 0) + c.z1[i] - c.z0[i]);
      air += c.z0[i] - c.z1[i - 1];
    }
    return { v, air, S: toLayers(c).v[0] };
  };
  for (let py = F1.gy / K; py < (F1.gy + F1.n) / K; py++)
    for (let px = F1.gx / K; px < (F1.gx + F1.n) / K; px++) {
      const p = vols(s.column(0, px, py));
      const sum = new Map<number, number>();
      let air = 0;
      let S = 0;
      for (let b = 0; b < K; b++)
        for (let a = 0; a < K; a++) {
          const c = vols(c1e.get(`${px * K + a},${py * K + b}`)!);
          for (const [m, x] of c.v) sum.set(m, (sum.get(m) ?? 0) + x);
          air += c.air;
          S += c.S;
        }
      worst = Math.max(worst, Math.abs(S / K ** 3 - (p.S - z0)), Math.abs(air / K ** 3 - p.air));
      for (const m of new Set([...sum.keys(), ...p.v.keys()])) worst = Math.max(worst, Math.abs((sum.get(m) ?? 0) / K ** 3 - (p.v.get(m) ?? 0)));
    }
  check('(b) restrict conserves the surface, each material and the enclosed air per block', worst < 1e-4, `worst block ${worst.toExponential(2)} parent units (tolerance 1e-4)`);
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
  const per = ch.map((c, m) => against(c, o.levels[m]));
  e = Math.max(...per.map((v, m) => v * K ** (2 - m)));
  check('(c) an edit at depth 2: every level matches the oracle', per.every((v) => v >= 0 && v < TOL), `max diff ${e.toExponential(2)} (in depth-2 units); per level in its own units ${per.map((v) => v.toExponential(2)).join(', ')} (tolerance ${TOL} each)`);
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
      const per = [0, 1, 2].map((m) => {
        const w = against(levelCols(s, m, m === 0 ? { gx: 0, gy: 0, n: ROOT } : m === 1 ? F1 : F2), o.levels[m]) * K ** (L - m);
        if (!(w >= 0 && w < TOL * 4)) {
          console.error(`[selftest] tunnel depth ${L}, level ${m}: ${w} at ${worstAt}`);
          // (round 24 diagnosis) the oracle's restrict of the GPU's own children there
          const [kx, ky] = worstAt.split(' ')[0].split(':')[1].split(',').map(Number);
          if (m < 2) {
            const Fc = m === 0 ? F1 : F2;
            const lc = new Level(frame(m + 1, Fc, s));
            for (let y = Fc.gy; y < Fc.gy + Fc.n; y++) for (let x = Fc.gx; x < Fc.gx + Fc.n; x++) lc.set(x, y, s.column(m + 1, x, y));
            const kids: string[] = [];
            for (let b = 0; b < K; b++) for (let a = 0; a < K; a++) {
              const c = lc.at(kx * K + a, ky * K + b)!;
              const r = o.levels[m + 1].at(kx * K + a, ky * K + b)!;
              const ge = (c.edge?.[c.mat.length - 1] ?? 0) >>> 0;
              const oe = (r.edge?.[r.mat.length - 1] ?? 0) >>> 0;
              if (ge !== oe || c.mat.length !== r.mat.length) kids.push(`#${b * K + a} gpu ${JSON.stringify(edgeDec(ge))} n ${c.mat.length} oracle ${JSON.stringify(edgeDec(oe))} n ${r.mat.length}`);
            }
            console.error(`[selftest] oracle restrict of the GPU children: ${JSON.stringify(o.restrictCell(lc, kx, ky))}; children top/edge/n ${kids.join(' ')}`);
          }
        }
        return w;
      });
      const worst = per.some((w) => w < 0) ? -1 : Math.max(...per);
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
    // (round 22) a crater at depth 1 and an add mound at depth 2: the edge samples the brushes write, carried by
    // restrict to the parents and by enhance to the children, against the oracle's (within 2 quantisation steps: f32
    // against f64)
    {
      const top1 = o.levels[1].at(F1.gx + 20, F1.gy + 44)!;
      const cz1 = top1.z1[top1.z1.length - 1] + 1;
      g.edit({ op: 'carve', radius: 6 / K, amount: 0, at: { level: 1, x: 20.3, y: 44.6, z: cz1 } });
      o.edit(1, 'carve', F1.gx + 20.3, F1.gy + 44.6, 6, 0, cz1);
      const top2 = o.levels[2].at(F2.gx + 44, F2.gy + 20)!;
      const cz2 = top2.z1[top2.z1.length - 1] - 1;
      g.edit({ op: 'add', radius: 5 / K ** 2, amount: 0, at: { level: 2, x: 44.6, y: 20.2, z: cz2 } });
      o.edit(2, 'add', F2.gx + 44.6, F2.gy + 20.2, 5, 0, cz2);
      s = await g.readAll();
      const rows: string[] = [];
      let eok = true;
      for (const [m, w] of [
        [0, { gx: 0, gy: 0, n: ROOT }],
        [1, F1],
        [2, F2],
      ] as const) {
        let n = 0;
        let bad = 0;
        let only = 0;
        let worst = { da: 0, dq: 0 };
        const firsts: string[] = [];
        for (const [key, c] of levelCols(s, m, w)) {
          const [x, y] = key.split(',').map(Number);
          const r = o.levels[m].at(x, y)!;
          if (r.mat.length !== c.mat.length) continue;
          for (let i = 0; i < c.mat.length; i++) {
            const a = edgeAt(c, i);
            const b = edgeAt(r, i);
            if (a || b) n++;
            if (a && b) {
              const d = edgeDiff(a, b);
              worst = { da: Math.max(worst.da, d.da), dq: Math.max(worst.dq, d.dq) };
            }
            // (2 angle steps; 0.05 columns: a restricted line is a mean of up to k^2 children, an enhanced one the
            // parent's scaled by k, so one step at the parent is k steps at the child)
            if (!edgeClose(a, b, 2, 51)) {
              bad++;
              if (!a !== !b) only++;
              if (bad <= 2) firsts.push(`${m}:${x},${y}#${i}/${c.mat.length} gpu ${JSON.stringify(edgeDec(a))} oracle ${JSON.stringify(edgeDec(b))} tops ${c.z1.join(',')}`);
            }
          }
        }
        // (a sample at the range's end (|d| = 2) can fall either side of it in f32 and f64, and where it falls decides
        // whether a later ball's sample replaces an earlier one's: seen 3 of 258 at depth 1 under the tunnel's
        // overlapping balls (gpu (1, 0) d 0.27 from one ball, oracle (-1, 0) d -2.0 from the next); allowed for 1 in 50)
        eok &&= n > (m === 0 ? 0 : 20) && bad <= Math.max(2, n / 50);
        rows.push(`depth ${m}: ${n} samples, ${bad} differ (${only} on one side only; worst ${worst.da} angle steps, ${worst.dq} distance steps of 1/1024)${firsts.length ? `: ${firsts.join('; ')}` : ''}`);
      }
      e = Math.max(against(levelCols(s, 1, F1), o.levels[1]), against(levelCols(s, 2, F2), o.levels[2]) / K);
      check('round edges: a crater and a mound write edge samples; every level matches the oracle (edges within 2 steps)', eok && e >= 0 && e < TOL * 4, `${rows.join('; ')}; max height diff ${e.toExponential(2)}`);
    }
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
  // page segments: a pool cut into 64-page buffers (a phone's largest buffer, much smaller) holds the same columns
  {
    const h = new GpuNest(device, K, SEED, 400, { syncGrow: true, segPages: 128 });
    // (the first 100 page ids skipped, so the level's pages straddle the first segment's end)
    device.queue.writeBuffer(h.ctl, 0, new Uint32Array([100]));
    h.root(ROOT, stripe);
    h.promote(1, F1);
    let hs = await h.readAll();
    const a = identical(levelCols(hs, 1, F1), c1);
    h.demote(1);
    h.promote(1, F1);
    hs = await h.readAll();
    const b = identical(levelCols(hs, 1, F1), c1);
    check('page segments: a pool of 128-page buffers (pages handed out from id 100, across the end of the first buffer) gives the same level 1 bit for bit (and again after demote, promote)', a.same && b.same && h.stats.segs > 1, `${a.diff} + ${b.diff} columns differ; ${h.stats.segs} segments in use, ${hs.ctl[0]} pages handed out, refused ${hs.ctl[1]}`);
  }
  // strokes (the owner: "sweep the carve along a trajectory of the original uncarved surface so you carve one layer at a
  // time"): a drag of the pointer, looking down, carves through the pick on the surface as it was when the stroke began
  {
    const h = new GpuNest(device, K, SEED, 16, { syncGrow: true });
    for (const op of ['edit'] as const) {
      const f = (h[op] as (...a: unknown[]) => boolean).bind(h);
      (h as unknown as Record<string, unknown>)[op] = (...a: unknown[]) => {
        if (!f(...a)) throw new Error(`stroke ${op} refused`);
        return true;
      };
    }
    h.root(64);
    const R = 2.5;
    const res: string[] = [];
    let ok = true;
    for (const [name, tx, ty] of [
      ['A', 20, 20],
      ['B', 44, 40],
    ] as const) {
      const control = false;
      // the eye 30 root columns above (tx, ty), looking down; the pointer moves across the screen
      h.placeEye(tx, ty, 30);
      const cam = (nx: number, ny: number, place: number) => {
        h.camIn.set([0, 0, 0, place, 0, 1.5, 1, 4, (50 * Math.PI) / 180, nx, ny, 1 / 60]);
        h.camera();
      };
      cam(0, 0, 1);
      cam(0, 0, 0);
      const pre = await h.readAll();
      if (!control) h.strokeBegin();
      const centres: [number, number][] = [];
      const drag = async (pts: [number, number][]) => {
        for (const [nx, ny] of pts) {
          cam(nx, ny, 0);
          h.edit({ op: 'carve', radius: R, amount: 0 });
          const c = await h.readCam();
          centres.push([c[301], c[302]]);
        }
      };
      // a straight drag, then back across it diagonally (the second pass crosses the first)
      await drag(Array.from({ length: 16 }, (_, i) => [-0.35 + (i * 0.7) / 15, 0] as [number, number]));
      const first = centres.length;
      await drag(Array.from({ length: 16 }, (_, i) => [-0.05 + (i * 0.1) / 15, -0.35 + (i * 0.7) / 15] as [number, number]));
      h.strokeEnd();
      const post = await h.readAll();
      const top = (s: Snapshot, x: number, y: number) => {
        const c = s.column(0, Math.floor(x), Math.floor(y));
        return c.z1[c.z1.length - 1];
      };
      const depths = centres.slice(1, first - 1).map(([x, y]) => top(pre, x, y) - top(post, x, y));
      const slope = Math.abs(top(pre, centres[first - 1][0], centres[first - 1][1]) - top(pre, centres[0][0], centres[0][1])) / Math.max(1e-6, Math.hypot(centres[first - 1][0] - centres[0][0], centres[first - 1][1] - centres[0][1]));
      // the crossing: the column of the second pass nearest the first pass's middle
      const mid = centres[(first / 2) | 0];
      const cross = centres.slice(first).reduce((b, c) => (Math.hypot(c[0] - mid[0], c[1] - mid[1]) < Math.hypot(b[0] - mid[0], b[1] - mid[1]) ? c : b));
      const dCross = top(pre, cross[0], cross[1]) - top(post, cross[0], cross[1]);
      const lo = Math.min(...depths);
      const hi = Math.max(...depths);
      const pass = lo > 0.8 * R && hi < 1.2 * R && dCross < 1.2 * R;
      if (!control) ok &&= pass;
      res.push(`${name} (slope ${slope.toFixed(2)}): depth along the drag ${lo.toFixed(2)}..${hi.toFixed(2)} for r ${R} (${depths.map((d) => d.toFixed(2)).join(' ')}); at the crossing ${dCross.toFixed(2)}; snapshot pages after the stroke ${post.pagesOf(32)}`);
      ok &&= post.pagesOf(32) === 0;
    }
    check('strokes: a drag carves one even layer on the surface as it was (depth within 20 % of the radius, flat and sloped), crossing its own path digs no deeper; the snapshot is let go', ok, res.join('; '));
  }
  check('the pool grew under load with nothing refused; no mismatches, table never full, every residual exact', st.grows > 0 && s.ctl[1] === 0 && s.ctl[4] === 0 && s.ctl[5] === 0 && s.ctl[6] === 0, `started at 16 pages, grew ${st.grows} times to ${g.cap} (${st.segs} segments of ${st.segPages}; ${st.used} used); refused ${s.ctl[1]}, mismatches ${s.ctl[4]}, table full ${s.ctl[5]}, inexact residuals ${s.ctl[6]}`);
  return out;
}
