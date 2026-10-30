// Terrain track perf test (round 117; < 2 min alone): what the terrain's generators cost.
//   - the atlas's make (its timings: the rivers' CPU pass with their shaping, every GPU pass);
//   - the land's columns made over rivers and plain (Atlas.columns: compose.wgsl ground() with terrain/river.wgsl — the
//     streaming's per-region cost), 64×64-cell regions round the world's river nodes, the median of several;
//   - the region graph over a 2048-world-unit square (the GPU sample at 4 units, the CPU partition), warm;
//   - a flood (the GPU fill and mark over a 1024-unit reach, against the CPU reference).
// Runs on the viewer page (?terrain=view; ?atlas=view on a build without the terrain track — the columns' A/B):
//   node scripts/perf/terrain.mjs [--server URL] [--label new] → data/perf/terrain-<adapter>.json (one entry a label)
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, run, sleep } from '../lib/runner.mjs';

await run({ name: 'perf-terrain', kind: 'timing', size: '800x600', dpr: 1 }, async (R) => {
  const label = R.opt('label', 'terrain');
  const p = await R.page();
  // (--view atlas: a build without the terrain track — the columns' A/B)
  const viewQ = R.opt('view', 'terrain') === 'atlas' ? 'atlas=view' : 'terrain=view';
  await p.goto(`${R.url}/?${viewQ}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.atlas || document.querySelector('.fatal'), { timeout: 240000, polling: 250 });
  const probe = await p.evaluate(() => !!window.reclaimed.terrain);
  await R.fatal(p);
  await sleep(1000);
  const res = await p.evaluate(async (hasTerrain) => {
    const a = window.reclaimed.atlas;
    const out = { adapter: '', atlas: { ...a.timings }, rivers: a.riverStats, columns: null, graph: null, flood: null };
    try {
      const info = await (await navigator.gpu.requestAdapter()).requestAdapterInfo?.();
      out.adapter = info ? `${info.vendor} ${info.architecture} ${info.description ?? ''}`.trim() : '';
    } catch {}
    // regions on rivers: every 97th water node in the temperate band, a 64² batch round it (cells)
    const u = a.riverNodes;
    const f = new Float32Array(u.buffer, u.byteOffset, u.length);
    const spots = [];
    for (let k = 0; k < u.length / 8 && spots.length < 24; k += 97) {
      if (u[k * 8 + 5] & 1) continue;
      spots.push([Math.floor(f[k * 8]) - 32, Math.floor(f[k * 8 + 1] / 0.8660254) - 32]);
    }
    const times = [];
    await a.columns(spots[0][0], spots[0][1], 64, 64);
    for (const [x, y] of spots) {
      // (the least of three: the page's other work and the shared GPU only ever add)
      let m = Infinity;
      for (let r = 0; r < 3; r++) {
        const t0 = performance.now();
        await a.columns(x, y, 64, 64);
        m = Math.min(m, performance.now() - t0);
      }
      times.push(m);
    }
    times.sort((x, y) => x - y);
    out.columns = { regions: times.length, median: +times[times.length >> 1].toFixed(2), min: +times[0].toFixed(2), max: +times[times.length - 1].toFixed(2) };
    if (hasTerrain) {
      const T = window.reclaimed.terrain;
      const cx = spots[0][0] + 32;
      const cy = (spots[0][1] + 32) * 0.8660254;
      const rect = { x0: cx - 1024, y0: cy - 1024, x1: cx + 1024, y1: cy + 1024 };
      await T.graph(rect);
      const t0 = performance.now();
      const S = await T.sample(rect.x0, rect.y0, 512, 512, 4);
      const t1 = performance.now();
      const g = await T.graph(rect);
      const t2 = performance.now();
      out.graph = { samples: S.w * S.h, sampleMs: +(t1 - t0).toFixed(1), graphMs: +(t2 - t1).toFixed(1), partitionMs: +(t2 - t1 - (t1 - t0)).toFixed(1), rooms: g.rooms().length, features: g.features().length, borders: g.borders().length };
      out.flood = await T.floodTool.check([cx, cy], 1024);
    }
    return out;
  }, probe);
  R.log(JSON.stringify(res));
  const tag = (res.adapter || 'unknown').replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40);
  const file = path.join(ROOT, 'data', 'perf', `terrain-${tag}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  prev[label] = { at: new Date().toISOString(), ...res };
  fs.writeFileSync(file, JSON.stringify(prev, null, 1));
  R.log(file);
  R.check('columns measured', !!res.columns?.median, res.columns);
});
