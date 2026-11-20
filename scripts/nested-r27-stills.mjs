// Nested scales (round 27): stills to local/nested/<tag>-<pose>.png.
// --set mat (part 1, materials per level): r25's spot (the root window's steepest step) at each of the four levels, and
//   2 km up looking at it (r25's root-high):
//   zoom-L0..L3  one spot on the step's high side at each level (the finest open level is L)
//   high         2 km up, 6 km from the step, the default fog
// node scripts/nested-r27-stills.mjs --chromeargs ignore-certificate-errors --port 5461 --set mat --tag r27-mat-after
//   [--only a,b] [--extra "&tex=1"]
import { run, sleep } from './lib/runner.mjs';
import fs from 'node:fs';

await run({ name: 'r27-stills', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const tag = R.opt('tag', 'r27');
  const only = R.opt('only', '').split(',').filter(Boolean);
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`[page exception] ${e.message}`));
  await page.goto(`https://localhost:${port}/nested.html?smooth=1${R.opt('extra', '')}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.pipesReady && nested.app.genReady && nested.app.fieldDone && (!nested.app.render.tex2 || nested.app.render.texDrawn2) && nested.app.frameCount > 30, { timeout: 300000, polling: 200 });
  await sleep(1500);
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
  console.log('steepest step', JSON.stringify(spot));
  const look = (eye, at) => {
    const d = [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]];
    const n = Math.hypot(...d);
    return { yaw: Math.atan2(-d[1], -d[0]), pitch: Math.asin(-d[2] / n), eye };
  };
  const M = 128;
  const sx = spot.x + 0.5;
  const sy = spot.y + 0.5;
  const away = [spot.dir[0] * 20, spot.dir[1] * 20];
  const poses = {};
  const set = R.opt('set', 'mat');
  if (set === 'mat') {
    poses.high = look([sx + away[0] * 2.4, sy + away[1] * 2.4, spot.h + 2000 / M], [sx, sy, spot.lo]);
    const zx = sx - spot.dir[0] * 1.5;
    const zy = sy - spot.dir[1] * 1.5;
    const dz = [0.9 * 32, 0.3 * 32, 0.3 * 4, 0.3 * 0.5];
    for (let L = 0; L <= 3; L++) poses[`zoom-L${L}`] = { tx: zx, ty: zy, d: dz[L], pitch: 0.95, yaw: Math.atan2(spot.dir[1], spot.dir[0]) + 0.5, level: L };
  }
  fs.mkdirSync('local/nested', { recursive: true });
  for (const [name, v] of Object.entries(poses)) {
    if (only.length && !only.includes(name)) continue;
    if (v.eye) await page.evaluate((v) => nested.setView(v), { yaw: v.yaw, pitch: v.pitch, eye: v.eye });
    else await page.evaluate((v) => nested.setView(v), { tx: v.tx, ty: v.ty, d: v.d, yaw: v.yaw, pitch: v.pitch });
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      const st = await page.evaluate(() => ({ live: nested.app.nest.live, settled: nested.app.nest.settled && !nested.app.nest.switching }));
      if (st.settled && i > 8 && (v.level === undefined || st.live === v.level + 1)) break;
    }
    await sleep(800);
    await page.evaluate(() => (nested.app.frozen = true));
    await sleep(300);
    const got = await page.evaluate(() => ({ ...nested.eye(), live: nested.app.nest.live, frame: nested.app.frames.slice(-30).reduce((a, b) => a + b, 0) / 30 }));
    const file = `local/nested/${tag}-${name}.png`;
    await page.screenshot({ path: file });
    await page.evaluate(() => (nested.app.frozen = false));
    console.log(`${file}: eye (${got.x.toFixed(1)}, ${got.y.toFixed(1)}, ${(got.z * M).toFixed(0)} m), ${(got.dNear * M).toFixed(1)} m from the nearest surface, levels open ${got.live}, frame ${got.frame.toFixed(1)} ms`);
  }
});
