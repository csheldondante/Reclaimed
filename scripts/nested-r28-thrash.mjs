// Nested scales (round 28): a level opened and closed over and over at the cliff600 pose (round 28 frame script)?
// Samples every 100 ms for --secs: levels live, the eye's nearest-surface distance, the field job, the ops.
// node scripts/nested-r28-thrash.mjs --chromeargs ignore-certificate-errors --port 5461 [--q "&field=1,2,3"] [--secs 12]
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'r28-thrash', kind: 'behaviour', size: '446x1000', dpr: 2, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const page = await R.page();
  page.on('pageerror', (e) => console.log(`[page exception] ${e.message}`));
  await page.goto(`https://localhost:${port}/nested.html?smooth=1${R.opt('q', '')}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.pipesReady && nested.app.genReady && nested.app.fieldDone && nested.app.frameCount > 30, { timeout: 300000, polling: 200 });
  const spot = await page.evaluate(async (below) => {
    const a = nested.app;
    const s = await a.nest.readAll();
    const w = a.nest.wins[0];
    const top = (X, Y) => {
      const c = s.column(0, X, Y);
      return c.z1[c.z1.length - 1];
    };
    let best = { x: 0, y: 0, step: 0, dir: [1, 0] };
    for (let y = w.gy + 40; y < w.gy + w.n - 40; y++)
      for (let x = w.gx + 40; x < w.gx + w.n - 40; x++) {
        if (top(x, y) > below) continue;
        for (const d of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
          const st = top(x, y) - top(x + d[0], y + d[1]);
          if (st > best.step) best = { x, y, step: st, dir: d };
        }
      }
    return { ...best, top: top(best.x, best.y) };
  }, 200 / 128);
  const m = 1 / 128;
  const c = [spot.x + 0.5 + spot.dir[0] * 2.5, spot.y + 0.5 + spot.dir[1] * 2.5];
  const ob = R.opt('pose', 'cliff600') === 'oblique190';
  const eye = ob ? [c[0] - 160 * m, c[1] - 90 * m, spot.top + 190 * m] : [spot.x + 0.5 - spot.dir[0] * 4 - spot.dir[1] * 2, spot.y + 0.5 - spot.dir[1] * 4 + spot.dir[0] * 2, spot.top + 600 * m];
  const at = ob ? [c[0], c[1], spot.top - 0.5] : [spot.x + 0.5 + spot.dir[0], spot.y + 0.5 + spot.dir[1], spot.top - 0.5];
  const d = [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]];
  const v = { yaw: Math.atan2(-d[1], -d[0]), pitch: Math.asin(-d[2] / Math.hypot(...d)), eye };
  await page.evaluate((v) => nested.setView(v), v);
  const rows = await page.evaluate(async (secs) => {
    const a = nested.app;
    const out = [];
    const t0 = performance.now();
    const ops0 = a.opLog.length;
    while (performance.now() - t0 < secs * 1000) {
      const cam = a.nest.camOut;
      out.push(`${((performance.now() - t0) / 1000).toFixed(1)}s live ${a.nest.live} dNear ${(a.dNear * 128).toFixed(0)} m (measured by level ${cam[30]}) eye z ${(cam[22] * 128).toFixed(0)}${a.nest.fieldJob ? ` job L${a.nest.fieldJob.L} ${a.nest.fieldJob.queue.length} left` : ''} wins ${a.nest.wins.slice(0, a.nest.live).map((w) => `${w.gx},${w.gy}`).join(' ')}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    return { out, ops: a.opLog.slice(ops0).filter((o) => o.what !== 'edit').map((o) => `${o.what}${o.depth}@${((o.at - t0) / 1000).toFixed(1)}`) };
  }, Number(R.opt('secs', '12')));
  const dedup = rows.out.filter((r, i) => i === 0 || r.replace(/^[0-9.]+s /, '') !== rows.out[i - 1].replace(/^[0-9.]+s /, ''));
  console.log(dedup.join('\n'));
  console.log(`ops: ${rows.ops.join(' ')}`);
  console.log(`widths: ${await page.evaluate(() => [1, 2, 3].map((m) => (nested.app.width(m) * 128).toFixed(0)).join(', '))} m`);
});
