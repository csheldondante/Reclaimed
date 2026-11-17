// (loop round 14, job 5) Where the loop's start goes. Three page loads in one browser, as a player meets them:
//   0 cold  — the start town, a new world (`fresh=1`), nothing cached;
//   1 again — the same page reloaded (what the browser and the game kept from load 0);
//   2 far   — the page opened on a far town (`?town=<id>`, no `fresh`), as the loop does when a run is played from
//             a far town (loop.ts openOn).
// Each load's boot marks (src/perf/boot-marks.ts: module, gpu, atlas, window, level, pipelines, warmup, …) and the
// loop's own lines, from the navigation, and the time to the leader's screen. The game's own settings: the warm
// cache on (`--params "&warmcache=0"` to turn it off).
//   node scripts/lab/bootphases.mjs [--out file.json] [--params "&x=1"]
import fs from 'node:fs';
import { run } from '../lib/runner.mjs';

await run({ name: 'bootphases', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const out = R.opt('out', 'bootphases.json');
  const p = await R.page();
  let t0 = 0;
  let lines = [];
  p.on('console', (m) => {
    const t = m.text();
    if (/^\[(loop|store|warm)\]|warm|snapshot|compile/i.test(t)) lines.push([Math.round(performance.now() - t0), t.slice(0, 220)]);
  });
  const res = [];
  const base = `${R.url}/?skipmenu=1&level=atlas&loop=1&q=low${R.opt('params', '')}`;
  let far = null;
  for (const [k, name] of [[0, 'cold'], [1, 'again'], [2, 'far']]) {
    lines = [];
    // (the far load is fresh too: without a run under way from it, the loop sends a page on another town back to the
    // world's last home — loop.ts openOn; its land and town are new to the browser either way)
    const url = k === 0 ? `${base}&town=1&fresh=1` : k === 1 ? `${base}&town=1` : `${base}&town=${far}&fresh=1`;
    t0 = performance.now();
    await p.goto(url, { waitUntil: 'load' });
    await p.waitForFunction(() => ['leader', 'city', 'season'].includes(window.rungame?.phase) || document.querySelector('.fatal'), { timeout: 500000, polling: 100 });
    await R.fatal(p);
    const wall = Math.round(performance.now() - t0);
    const boot = await p.evaluate(() => window.__boot?.marks ?? []);
    const phases = [];
    let prev = 0;
    for (const [stage, t] of boot) {
      phases.push({ stage, at: Math.round(t), took: Math.round(t - prev) });
      prev = t;
    }
    res.push({ load: name, url, wall, phases, lines });
    R.log(`load ${name}: ${wall} ms to the loop's first screen (${url.replace(R.url, '')})`);
    for (const ph of phases) R.log(`  ${ph.stage.padEnd(18)} at ${String(ph.at).padStart(7)} ms  (+${ph.took})`);
    for (const [t, l] of lines.slice(0, 30)) R.log(`  ${String(t).padStart(7)} ms  ${l}`);
    if (k === 0) {
      // (the far town the next load opens on: the nearest standing town the town generator builds)
      far = await p.evaluate(() => {
        const r = window.rungame.realm;
        const can = window.reclaimed.scene.opts.atlas?.fieldTowns ?? [];
        return r.selectTowns('far:all').find((id) => can.includes(id)) ?? null;
      });
      R.log(`far town: ${far}`);
      if (!far) throw new Error('no far town the generator builds');
    }
  }
  fs.writeFileSync(out, JSON.stringify(res, null, 1));
});
