// The structures track's perf test (round 117: "a small perf test of your own … < 2 min, alone"): per tile system and
// city size, the plan's time (CPU, in the page), the pieces, triangles and draws, and the GPU's time for a frame of the
// viewer at the phone proxy (412×915, dpr 2.6, the viewer's own renderer: shadow pass + main pass). Timing kind: the
// GPU alone. JSON to data/perf/structures-<adapter>.json.
//   node scripts/perf/structures.mjs [--quick]
import fs from 'node:fs';
import path from 'node:path';
import { run, ROOT } from '../lib/runner.mjs';

await run({ name: 'perf-structures', kind: 'timing', size: '412x915', dpr: 2.6 }, async (R) => {
  const quick = R.flag('quick');
  const cases = [];
  for (const system of ['irregular', 'contour-voronoi', 'radial', 'orthogonal'])
    for (const r of quick ? [48] : [32, 64, 112]) cases.push({ system, r, style: system === 'radial' ? 'bastion' : 'hearth' });
  const p = await R.page();
  const out = { when: new Date().toISOString(), size: `${R.W}x${R.H}@${R.dpr}`, cases: [] };
  for (const c of cases) {
    await p.goto(`${R.url}/structures.html?view=city&system=${c.system}&style=${c.style}&r=${c.r}&ground=hill&msaa=4`, { waitUntil: 'load' });
    await p.waitForFunction(() => document.body.dataset.ready === '1' || document.querySelector('.fatal'), { timeout: 60000 });
    const f = await p.$eval('.fatal', (e) => e.textContent).catch(() => null);
    if (f) {
      R.fail(`viewer fatal: ${f.slice(0, 400)}`);
      continue;
    }
    // build time: plan + pieces + upload, three in the page (the first warms the JIT)
    const buildMs = await p.evaluate(() => {
      const s = window.structures;
      const t = [];
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        s.rebuild();
        t.push(performance.now() - t0);
      }
      return t;
    });
    await p.evaluate(() => new Promise((r) => setTimeout(r, 2500)));
    const res = await p.evaluate(() => ({ stats: window.structures.stats(), gpu: window.structures.gpuMs(), adapter: window.structures.adapter }));
    const g = res.gpu.slice().sort((a, b) => a - b);
    const med = g.length ? g[Math.floor(g.length / 2)] : null;
    const p95 = g.length ? g[Math.floor(g.length * 0.95)] : null;
    out.adapter = res.adapter;
    const row = { ...c, buildMs: +Math.min(...buildMs.slice(1)).toFixed(1), pieces: res.stats.pieces, tris: res.stats.tris, draws: res.stats.draws, buildings: res.stats.buildings, tiles: res.stats.tiles, gpuMedMs: med && +med.toFixed(2), gpuP95Ms: p95 && +p95.toFixed(2), frames: g.length };
    out.cases.push(row);
    R.check(`${c.system} r${c.r}: build ${row.buildMs} ms, ${row.pieces} pieces, ${(row.tris / 1000).toFixed(0)}k tris, ${row.draws} draws, GPU ${row.gpuMedMs} ms (p95 ${row.gpuP95Ms})`, row.pieces > 0);
  }
  const name = (out.adapter || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'unknown';
  const file = path.join(ROOT, 'data', 'perf', `structures-${name}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  R.log(`wrote ${file}`);
});
