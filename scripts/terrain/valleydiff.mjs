// Terrain rivers, step 2: the valley field's seams from two continuity.mjs runs of one world — the valley off
// (?valleyoff=1) and on. D = g(off) − g(on) is what the valley took away. A seam is a step of D between neighbours
// where the ground without the valley is smooth (each of the four cells along the line within 0.5 of the next: no
// cliff of the landforms there, so a step of D is a step of the valley's surface), and an *isolated* one has flats of D
// on both sides (≤ 0.3).
//   node scripts/terrain/valleydiff.mjs --dir local/terrain2 --off s1voff --on s1on
import fs from 'node:fs';

/** A: the valley-off run's windows, B: the valley-on run's (same windows) */
export function valleyDiff(A, B) {
  const all = [];
  let iso = 0;
  let over1 = 0;
  let worst = null;
  // (by distance from the channel — riverCut's bank reaches 4 half-widths, up to ~48 cells, and its Voronoi blocks are
  // steps of the valley-off ground there: a band near the river is riverCut's and the fine profile's, past it the
  // coarse field's)
  const BANDS = [12, 30, 1e9];
  const band = BANDS.map(() => ({ pairs: 0, over1: 0, iso: 0, max: 0 }));
  for (let k = 0; k < Math.min(A.length, B.length); k++) {
    const a = A[k];
    const b = B[k];
    if (a.x0 !== b.x0 || a.y0 !== b.y0) throw new Error(`window ${k} differs: ${a.x0},${a.y0} vs ${b.x0},${b.y0} (not the same rivers)`);
    const w = 128;
    const h = 64;
    const D = a.g.map((v, j) => v - b.g[j]);
    const ok = (j) => a.ok[j] && b.ok[j];
    const smooth = (p, q) => Math.abs(a.g[q] - a.g[p]) <= 0.5;
    // distance (cells, 8-neighbour BFS) to the nearest channel cell of either run
    const dist = new Float32Array(w * h).fill(1e9);
    const qu = [];
    for (let j = 0; j < w * h; j++)
      if ((a.rv && a.rv[j]) || (b.rv && b.rv[j])) {
        dist[j] = 0;
        qu.push(j);
      }
    for (let qi = 0; qi < qu.length; qi++) {
      const j = qu[qi];
      const x = j % w;
      const y = (j - x) / w;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const u = yy * w + xx;
          if (dist[u] > dist[j] + 1) {
            dist[u] = dist[j] + 1;
            qu.push(u);
          }
        }
    }
    const line = (idx) => {
      for (let q = 1; q < idx.length - 2; q++) {
        const [a0, a1, a2, a3] = [idx[q - 1], idx[q], idx[q + 1], idx[q + 2]];
        if (!ok(a0) || !ok(a1) || !ok(a2) || !ok(a3)) continue;
        if (!smooth(a0, a1) || !smooth(a1, a2) || !smooth(a2, a3)) continue;
        const s = Math.abs(D[a2] - D[a1]);
        all.push(s);
        const bi = BANDS.findIndex((r) => Math.min(dist[a1], dist[a2]) < r);
        const bd = band[bi];
        bd.pairs++;
        bd.max = Math.max(bd.max, +s.toFixed(2));
        if (s > 1) {
          over1++;
          bd.over1++;
        }
        if (!worst || s > worst.s) worst = { s: +s.toFixed(2), window: k, x: b.x0 + (a1 % w), row: b.y0 + Math.floor(a1 / w), fromChannel: dist[a1] };
        if (s >= 1 && Math.abs(D[a1] - D[a0]) <= 0.3 && Math.abs(D[a3] - D[a2]) <= 0.3) {
          iso++;
          bd.iso++;
        }
      }
    };
    for (let y = 0; y < h; y++) line(Array.from({ length: w }, (_, x) => y * w + x));
    for (let x = 0; x < w; x++) line(Array.from({ length: h }, (_, y) => y * w + x));
  }
  all.sort((p, q) => p - q);
  const pc = (q) => +(all[Math.min(all.length - 1, Math.floor(q * all.length))] ?? 0).toFixed(3);
  const bands = Object.fromEntries(BANDS.map((r, i) => [i === 0 ? `<${r}` : i === BANDS.length - 1 ? `>=${BANDS[i - 1]}` : `${BANDS[i - 1]}-${r}`, band[i]]));
  return { pairs: all.length, max: +(all[all.length - 1] ?? 0).toFixed(2), p99: pc(0.99), p999: pc(0.999), over1, iso, worst, bands };
}

if (process.argv[1] && process.argv[1].endsWith('valleydiff.mjs')) {
  const argv = process.argv.slice(2);
  const opt = (k, d) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : d;
  };
  const dir = opt('dir', 'local/terrain2');
  const A = JSON.parse(fs.readFileSync(`${dir}/${opt('off', 's1voff')}-cont.json`, 'utf8')).per;
  const B = JSON.parse(fs.readFileSync(`${dir}/${opt('on', 's1on')}-cont.json`, 'utf8')).per;
  const d = valleyDiff(A, B);
  console.log(JSON.stringify(d));
  fs.writeFileSync(`${dir}/${opt('on', 's1on')}-valley.json`, JSON.stringify(d, null, 1));
}
