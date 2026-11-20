// Nested scales (round 25): the terrain from the atlas's ground. Stills to local/nested/r25-<pose>.png:
//   root-whole   the whole root window from high up (fog pushed out to 40 km for this one: at 8 km it is all fog)
//   root-high    high up with the default fog (8 km)
//   cruise       about 300 m over the ground looking toward the steepest step in the root window
//   zoom-L0..L3  one spot at each of the four levels, zooming in on it (the finest open level is L)
// node scripts/nested-r25-stills.mjs --chromeargs ignore-certificate-errors --port 5497 [--only a,b] [--flat 1]
import { run, sleep } from './lib/runner.mjs';
import fs from 'node:fs';

await run({ name: 'r25-stills', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5497');
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning' || m.text().startsWith('[gen]')) console.log(`[page ${m.type()}] ${m.text()}`);
  });
  const t0 = Date.now();
  await page.goto(`https://localhost:${port}/nested.html?smooth=${R.opt('smooth', '1')}&tex=${R.opt('flat', '0') === '1' ? 0 : 1}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.pipesReady && nested.app.genReady && nested.app.frameCount > 30, { timeout: 300000, polling: 200 });
  console.log(`terrain ready ${((Date.now() - t0) / 1000).toFixed(1)} s after load; page: genAt ${await page.evaluate(() => nested.app.genAt.toFixed(0))} ms, terrainAt ${await page.evaluate(() => nested.app.terrainAt.toFixed(0))} ms, first frame ${await page.evaluate(() => nested.app.firstFrameAt.toFixed(0))} ms`);
  await sleep(1500);
  // the steepest step in the root window, and the ground's height there (root units)
  const spot = await page.evaluate(async () => {
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
        const h = top(x, y);
        for (const d of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
          const st = h - top(x + d[0], y + d[1]);
          if (st > best.step) best = { x, y, step: st, dir: d };
        }
      }
    return { ...best, h: top(best.x, best.y), lo: top(best.x + best.dir[0], best.y + best.dir[1]), win: w };
  });
  console.log('steepest step', JSON.stringify(spot), `(${(spot.step * 128).toFixed(0)} m over one root column)`);
  const look = (eye, at) => {
    const d = [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]];
    const n = Math.hypot(...d);
    return { yaw: Math.atan2(-d[1], -d[0]), pitch: Math.asin(-d[2] / n), eye };
  };
  const M = 128;
  const sx = spot.x + 0.5;
  const sy = spot.y + 0.5;
  // (the cruise view: 2.5 km out on the low side, 300 m over the ground below the step, looking at the step's foot)
  const away = [spot.dir[0] * 20, spot.dir[1] * 20];
  const cz = spot.lo + 300 / M;
  const cx = spot.win.gx + spot.win.n / 2;
  const cy = spot.win.gy + spot.win.n / 2;
  const poses = {
    'root-whole': { ...look([cx - 150, cy, 230], [cx, cy, 0]), fog: 40000 },
    'root-high': look([sx + away[0] * 2, sy + away[1] * 2, spot.h + 3000 / M], [sx, sy, spot.lo]),
    cruise: look([sx + away[0], sy + away[1], cz], [sx, sy, spot.lo + 60 / M]),
  };
  // the zoom: on the high side of the step, a few columns in (the top of the cliff), each level's view
  const zx = sx - spot.dir[0] * 2.5;
  const zy = sy - spot.dir[1] * 2.5;
  const dz = [0.8 * 32, 0.3 * 32, 0.3 * 4, 0.3 * 0.5];
  for (let L = 0; L <= 3; L++) poses[`zoom-L${L}`] = { tx: zx, ty: zy, d: dz[L], pitch: 0.6, yaw: Math.atan2(spot.dir[1], spot.dir[0]) + 0.7, level: L };
  fs.mkdirSync('local/nested', { recursive: true });
  const only = R.opt('only', '').split(',').filter(Boolean);
  for (const [name, v] of Object.entries(poses)) {
    if (only.length && !only.includes(name)) continue;
    await page.evaluate((f) => (nested.app.render.fogM = f), v.fog ?? 8000);
    if (v.eye) await page.evaluate((v) => nested.setView(v), { yaw: v.yaw, pitch: v.pitch, eye: v.eye });
    else await page.evaluate((v) => nested.setView(v), { tx: v.tx, ty: v.ty, d: v.d, yaw: v.yaw, pitch: v.pitch });
    // (the levels settle: promotes and demotes run one a frame)
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const st = await page.evaluate(() => ({ live: nested.app.nest.live, settled: nested.app.nest.settled }));
      if (v.level === undefined || (st.live === v.level + 1 && st.settled && i > 8)) break;
    }
    await sleep(800);
    const got = await page.evaluate(() => ({ ...nested.eye(), live: nested.app.nest.live, frame: nested.app.frames.slice(-30).reduce((a, b) => a + b, 0) / 30 }));
    const file = `local/nested/r25-${name}${R.opt('flat', '0') === '1' ? '-flat' : ''}.png`;
    await page.screenshot({ path: file });
    console.log(`${file}: eye (${got.x.toFixed(1)}, ${got.y.toFixed(1)}, ${(got.z * M).toFixed(0)} m), ${(got.dNear * M).toFixed(1)} m from the nearest surface, levels open ${got.live}, frame ${got.frame.toFixed(1)} ms`);
  }
});
