// Nested scales (round 25, step 4): cruise over the generated land. Per height (300 m, 1500 m) and speed, the page's own
// cruise (the camera pass flies the heading over the ground at the height it had when switched on; no readback) along
// +x for a few seconds while the root and level 1 slide after the eye; per run:
//   frame ms (median, p95, worst) from the page's frame intervals,
//   the speed reached (the eye's travel over the run's time: the camera stops at the root window's edge if the root's
//   slides fall behind),
//   ahead: the least distance from the eye to the root window's front edge along the travel (the land is generated up
//   to there: inside the fog's 8 km nothing ungenerated can show if this stays over 8 km), and the least to its sides,
//   level ops (slides of the root and of level 1, promotes, demotes) and ops refused (waiting for the pool).
// A run holds 16.7 ms when its p95 does, and keeps ahead when the least front distance stays over the fog distance.
// node scripts/nested-cruise.mjs --chromeargs ignore-certificate-errors --port 5497 [--heights 300,1500]
//   [--speeds 100,200,400,800,1600,3200] [--secs 5] [--smooth 0]
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'nested-cruise', kind: 'timing', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5497');
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning' || m.text().startsWith('[gen]')) console.log(`[page ${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`[page exception] ${e.message}`));
  const smooth = R.opt('smooth', '0');
  await page.goto(`https://localhost:${port}/nested.html?smooth=${smooth}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.pipesReady && nested.app.genReady && nested.app.frameCount > 30, { timeout: 300000, polling: 200 });
  console.log(`terrain ready: first frame ${await page.evaluate(() => nested.app.firstFrameAt.toFixed(0))} ms, every boot pipeline ${await page.evaluate(() => nested.app.pipesAt.toFixed(0))} ms, atlas built ${await page.evaluate(() => nested.app.genAt.toFixed(0))} ms, root from it ${await page.evaluate(() => nested.app.terrainAt.toFixed(0))} ms after the page opened`);
  const M = 128;
  const FOG = 8000;
  const secs = Number(R.opt('secs', '5'));
  const rows = [];
  for (const H of R.opt('heights', '300,1500').split(',').map(Number)) {
    for (const v of R.opt('speeds', '100,200,400,800,1600,3200').split(',').map(Number)) {
      // start at the root window's rear (the eye where it is in y), H over the ground there, heading +x, looking ahead
      const r = await page.evaluate(
        async ([H, v, secs, M]) => {
          const a = nested.app;
          const fr = (n) => new Promise((res) => (function f(i) { if (i <= 0) res(); else requestAnimationFrame(() => f(i - 1)); })(n));
          a.setCruise(false);
          const e0 = nested.eye();
          // (the ground under the eye: the root's top there)
          const w0 = a.nest.wins[0];
          const s = await a.nest.readAll();
          const X = Math.floor(e0.x);
          const Y = Math.floor(e0.y);
          const c = s.column(0, Math.min(w0.gx + w0.n - 1, Math.max(w0.gx, X)), Math.min(w0.gy + w0.n - 1, Math.max(w0.gy, Y)));
          const g = c.z1[c.z1.length - 1];
          nested.setView({ eye: [e0.x, e0.y, g + H / M], yaw: Math.PI, pitch: 0.12 });
          // (the levels settle at the new height)
          for (let i = 0; i < 120 && !(a.nest.settled && i > 40); i++) await fr(1);
          // the cruise at v m/s: the slider's unit is the finest live window's width a second
          a.cruiseWps = v / M / a.width(a.nest.live - 1);
          a.setCruise(true);
          await fr(30);
          const t0 = performance.now();
          const x0 = nested.eye().x;
          const ops0 = a.opLog.length;
          const ref0 = a.refusedAt.length;
          const log = [];
          let minFront = 1e9;
          let minSide = 1e9;
          let maxLive = 0;
          let minLive = 9;
          const old = a.post;
          // (the frame intervals the page itself takes, read as each frame ends: a.frames keeps only the last 600)
          const ft = [];
          a.post = () => {
            ft.push(a.frames[a.frames.length - 1]);
            const w = a.nest.wins[0];
            const ex = a.ex;
            const ey = a.ey;
            minFront = Math.min(minFront, (w.gx + w.n - ex) * M);
            minSide = Math.min(minSide, (ey - w.gy) * M, (w.gy + w.n - ey) * M);
            maxLive = Math.max(maxLive, a.nest.live);
            minLive = Math.min(minLive, a.nest.live);
          };
          while (performance.now() - t0 < secs * 1000) await fr(1);
          a.post = old;
          const dt = (performance.now() - t0) / 1000;
          const x1 = nested.eye().x;
          a.setCruise(false);
          const ops = a.opLog.slice(ops0);
          const count = (w, d) => ops.filter((o) => o.what === w && (d === undefined || o.depth === d)).length;
          for (const o of ops) if (o.what === 'slide' && o.depth === 0) log.push(o.ms);
          const sorted = [...ft].sort((p, q) => p - q);
          const q = (f) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
          return {
            frames: ft.length,
            median: q(0.5),
            p95: q(0.95),
            worst: sorted[sorted.length - 1],
            speed: ((x1 - x0) * M) / dt,
            minFront,
            minSide,
            rootSlides: count('slide', 0),
            l1Slides: count('slide', 1),
            l2Slides: count('slide', 2),
            promotes: count('promote'),
            demotes: count('demote'),
            refused: a.refusedAt.length - ref0,
            rootSlideCpuMs: log.length ? Math.max(...log) : 0,
            live: `${minLive}-${maxLive}`,
            dNear: nested.eye().dNear * M,
          };
        },
        [H, v, secs, M],
      );
      const holds = r.p95 <= 16.7;
      const ahead = r.minFront > FOG;
      rows.push({ H, v, ...r, holds, ahead });
      console.log(
        `H ${H} m, ${v} m/s: frame median ${r.median.toFixed(1)} ms, p95 ${r.p95.toFixed(1)}, worst ${r.worst.toFixed(1)} (${r.frames} frames); reached ${r.speed.toFixed(0)} m/s; root front ${(r.minFront / 1000).toFixed(1)} km ahead at least, sides ${(r.minSide / 1000).toFixed(1)} km; slides root ${r.rootSlides} (CPU ${r.rootSlideCpuMs.toFixed(1)} ms at most), level 1 ${r.l1Slides}, level 2 ${r.l2Slides}; promotes ${r.promotes}, demotes ${r.demotes}; refused ${r.refused}; levels ${r.live}; ${holds ? 'holds 16.7' : 'OVER 16.7'}, ${ahead ? 'kept ahead' : 'FELL BEHIND'}`,
      );
      await sleep(500);
    }
  }
  for (const H of [...new Set(rows.map((r) => r.H))]) {
    const ok = rows.filter((r) => r.H === H && r.holds && r.ahead && r.speed > 0.8 * r.v).map((r) => r.v);
    console.log(`H ${H} m: the highest speed that holds 16.7 ms (p95), keeps ahead and reaches 80 % of its speed: ${ok.length ? Math.max(...ok) : 'none'} m/s`);
  }
  R.check('cruise ran', rows.length > 0, `${rows.length} runs`);
});
