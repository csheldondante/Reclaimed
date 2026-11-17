// Terrain rivers, step 2 (docs/design/TERRAIN_RIVERS.md §9): the valley field's continuity, measured on the streamed
// columns' own ground. Windows of 128 × 64 cells round sampled water river nodes (every k-th node of the land's water
// rivers, the same rule in every world); in each, every pair of neighbours along a row and along a column (the cells
// of the river's channel and 3 cells round it left out — the channel's banks are riverCut's own steps — and any cell
// with standing water). A seam is an *isolated step*: |Δ| ≥ STEP between two cells whose neighbours on either side
// along the same line change by ≤ FLAT (a flat, a jump, a flat — the step-1 cross-section's 5-cell steps); a slope or
// a cliff (many cells of large Δ in a row) is not one.
//   node scripts/terrain/continuity.mjs --tag on --params "a.rivers2=1" --dir local/terrain2 [--windows 40]
// Writes <dir>/<tag>-cont.json: per window and in total — pairs, max |Δ|, p99 / p99.9 |Δ|, isolated steps.
import fs from 'node:fs';
import { run, sleep } from '../lib/runner.mjs';
import { valleyDiff } from './valleydiff.mjs';

await run({ name: 'terrain-continuity', kind: 'behaviour', size: '600x600' }, async (R) => {
  const tag = R.opt('tag', 'on');
  const dir = R.opt('dir', 'local/terrain2');
  fs.mkdirSync(dir, { recursive: true });
  const extra = R.opt('params', '');
  const K = Number(R.opt('windows', '40'));
  const p = await R.page();
  await p.goto(`${R.url}/?atlas=view&mode=ground&overlay=0&${extra}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.atlas || document.querySelector('.fatal'), { timeout: 400000, polling: 250 });
  await R.fatal(p);
  await sleep(500);
  const res = await p.evaluate(async (K) => {
    const STEP = 1.0;
    const FLAT = 0.3;
    const a = window.reclaimed.atlas;
    const u = a.riverNodes;
    const f = new Float32Array(u.buffer, u.byteOffset, u.length);
    const W = 8;
    const n = u.length / W;
    const picks = [];
    for (let k = 0; k < n; k++) {
      const o = k * W;
      if (u[o + 5] & 1 || u[o + 4] === k || f[o + 2] < a.p.sea + 3) continue;
      picks.push(k);
    }
    const stride = Math.max(1, Math.floor(picks.length / K));
    const out = [];
    const all = [];
    let isoT = 0;
    for (let i = 0; i < picks.length && out.length < K; i += stride) {
      const k = picks[i];
      const x0 = Math.floor(f[k * W]) - 64;
      const y0 = Math.floor(f[k * W + 1] / 0.8660254) - 32;
      const w = 128;
      const h = 64;
      const c = await a.columns(x0, y0, w, h);
      const g = new Float32Array(w * h);
      const bad = new Uint8Array(w * h);
      for (let j = 0; j < w * h; j++) {
        g[j] = c.f[j * 16 + 11];
        if (c.f[j * 16 + 3] > 0) bad[j] = 1;
      }
      // (3 cells round the channel)
      const near = new Uint8Array(w * h);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          if (!(c.f[(y * w + x) * 16 + 15] > 0)) continue;
          for (let dy = -3; dy <= 3; dy++)
            for (let dx = -3; dx <= 3; dx++) {
              const xx = x + dx;
              const yy = y + dy;
              if (xx >= 0 && yy >= 0 && xx < w && yy < h) near[yy * w + xx] = 1;
            }
        }
      const ok = (j) => !bad[j] && !near[j];
      let maxD = 0;
      let iso = 0;
      let pairs = 0;
      const line = (idx) => {
        for (let q = 1; q < idx.length - 2; q++) {
          const [a0, a1, a2, a3] = [idx[q - 1], idx[q], idx[q + 1], idx[q + 2]];
          if (!ok(a1) || !ok(a2)) continue;
          const d = Math.abs(g[a2] - g[a1]);
          pairs++;
          all.push(d);
          if (d > maxD) maxD = d;
          if (d >= STEP && ok(a0) && ok(a3) && Math.abs(g[a1] - g[a0]) <= FLAT && Math.abs(g[a3] - g[a2]) <= FLAT) iso++;
        }
      };
      for (let y = 0; y < h; y++) line(Array.from({ length: w }, (_, x) => y * w + x));
      for (let x = 0; x < w; x++) line(Array.from({ length: h }, (_, y) => y * w + x));
      isoT += iso;
      out.push({ node: k, x0, y0, pairs, max: +maxD.toFixed(2), iso, g: Array.from(g, (v) => +v.toFixed(3)), ok: Array.from({ length: w * h }, (_, j) => (ok(j) ? 1 : 0)), rv: Array.from({ length: w * h }, (_, j) => (c.f[j * 16 + 15] > 0 ? 1 : 0)) });
    }
    all.sort((p, q) => p - q);
    const pc = (q) => +(all[Math.min(all.length - 1, Math.floor(q * all.length))] ?? 0).toFixed(3);
    return { windows: out.length, pairs: all.length, max: +(all[all.length - 1] ?? 0).toFixed(2), p99: pc(0.99), p999: pc(0.999), over2: all.filter((d) => d > 2).length, iso: isoT, per: out };
  }, K);
  R.log(JSON.stringify({ tag, windows: res.windows, pairs: res.pairs, max: res.max, p99: res.p99, p999: res.p999, over2: res.over2, iso: res.iso }));
  fs.writeFileSync(`${dir}/${tag}-cont.json`, JSON.stringify(res));
  // --vs <tag>: the valley's own field. The other run is the same world with the valley switched off (?valleyoff=1:
  // the same rivers, the same landforms), so D = g(valley off) − g(valley on) is what the valley took away, the
  // landforms' own cliffs cancelling; its steps between neighbours are the field's seams.
  const vs = R.opt('vs', null);
  if (vs) {
    const o = JSON.parse(fs.readFileSync(`${dir}/${vs}-cont.json`, 'utf8'));
    const d = valleyDiff(o.per, res.per);
    R.log(`valley field (${vs} − ${tag}): ${JSON.stringify(d)}`);
    fs.writeFileSync(`${dir}/${tag}-valley.json`, JSON.stringify(d, null, 1));
  }
});
