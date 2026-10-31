// The settlements' cost in the game's frame (BACKLOG STR9/STR10/STR15): the atlas level at the phone proxy (412×915 dpr
// 2.6, q=low, every system in play), started at a settlement (?town=<id>, default the biggest near the start) — the GPU's
// time a frame (the profiler's passes) with the settlements' pieces drawn and skipped (?skip=structures: the same world,
// their columns still claimed), at the start's zoom and closer. Timing kind (the GPU alone). JSON to
// data/perf/structcity-<adapter>.json.
//   node scripts/perf/structcity.mjs [--town s55] [--seconds 8] [--tod 0.97]
import fs from 'node:fs';
import path from 'node:path';
import { run, ROOT } from '../lib/runner.mjs';

await run({ name: 'perf-structcity', kind: 'timing', size: '412x915', dpr: 2.6 }, async (R) => {
  const town = R.opt('town', 's55');
  const seconds = Number(R.opt('seconds', 8));
  // (round 120, cities: --tod 0.97 measures the town at night — its light pools drawn)
  const tod = R.opt('tod', null);
  const out = { when: new Date().toISOString(), town, size: `${R.W}x${R.H}@${R.dpr}`, runs: [] };
  for (const skip of ['', 'structures']) {
    const p = await R.level({ level: 'atlas', town, perf: '1', ...(skip ? { skip } : {}), ...(tod ? { tod, day: '100000' } : {}) });
    await R.simSeconds(p, 15);
    for (const zoom of [1, 3]) {
      await p.evaluate((z) => (window.reclaimed.camera.zoom *= z), zoom);
      await R.sleep(1500);
      await p.evaluate(() => {
        const pr = window.reclaimed.core.host.profiler;
        pr.resetTotals();
      });
      await R.sleep(seconds * 1000);
      const m = await p.evaluate(() => {
        const pr = window.reclaimed.core.host.profiler;
        const n = Math.max(pr.framesResolved, 1);
        const top = Object.fromEntries([...pr.totalMs].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => [k, +(v / n).toFixed(2)]));
        const v = window.reclaimed.settlementsView();
        return { gpu: +(pr.gpuTotalMs / n).toFixed(2), frames: pr.framesResolved, top, adapter: window.reclaimed.core.host.gpu.adapterInfo ?? null, view: v ? { settlements: v.stats.drawn, pieces: v.stats.pieces, tris: v.sg.stats.tris, lodTris: v.sg.stats.lodTris, draws: v.sg.stats.draws } : null };
      });
      const row = { skip: skip || 'none', zoom, ...m };
      out.runs.push(row);
      R.check(`settlements ${skip ? 'skipped' : 'drawn'}, zoom ×${zoom}: GPU ${m.gpu} ms a frame (${m.frames} frames)`, m.frames > 10, { top: m.top, view: m.view });
    }
    await p.close();
  }
  const a = out.runs.find((r) => r.skip === 'none' && r.zoom === 1);
  const b = out.runs.find((r) => r.skip !== 'none' && r.zoom === 1);
  if (a && b) R.log(`world pass: ${a.top.draw} ms drawn vs ${b.top.draw} skipped at the start's zoom`);
  const info = out.runs[0]?.adapter;
  const name = (typeof info === 'string' ? info : info ? `${info.vendor ?? ''}-${info.architecture ?? ''}` : 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
  const file = path.join(ROOT, 'data', 'perf', `structcity-${name}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  R.log(`wrote ${file}`);
});
