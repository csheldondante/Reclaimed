// Nested scales (round 21): the forest canopy from afar, local/nested/r21-<pose>-canopy|grass.png: every pose taken twice
// in the same page, the textured draw with the canopy (?canopy=1, default) then without it (the round 20 grass). The same
// features as nested-r20-stills.mjs (the bowl the closeup looks at), carved at level 1.
// node scripts/nested-r21-stills.mjs --chromeargs ignore-certificate-errors --port 5483 [--only a,b] [--prefix r21]
//   [--fade 0.05: ?canopyfade]
import { run, sleep } from './lib/runner.mjs';
import fs from 'node:fs';

await run({ name: 'r21-stills', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5483');
  const fade = Number(R.opt('fade', '0.1'));
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}] ${m.text()}`);
  });
  await page.goto(`https://localhost:${port}/nested.html?k=8&d=8&pitch=0.3&yaw=0&tx=100&ty=140&canopyfade=${fade}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.frameCount > 60 && nested.app.pipesReady, { timeout: 180000, polling: 100 });
  await sleep(1500);
  await page.evaluate(() => nested.smooth(true));
  await page.evaluate(() => nested.tex(true));
  const feat = await page.evaluate(async () => {
    const a = nested.app;
    const k = 8;
    const fr = async (n) => {
      for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r));
    };
    const w1 = a.nest.wins[1];
    const cx = (w1.gx + w1.n / 2) / k;
    const cy = (w1.gy + w1.n / 2) / k;
    const zoW = async (L) => {
      const s = await a.nest.readAll();
      let zo = 0;
      for (let j = 1; j <= L; j++) zo += s.zOrigin(j) / k ** (j - 1);
      return zo;
    };
    const top = async (x, y, L = 1) => {
      const s = await a.nest.readAll();
      const kk = k ** L;
      const c = s.column(L, Math.floor(x * kk), Math.floor(y * kk));
      return (await zoW(L)) + c.z1[c.z1.length - 1] / kk;
    };
    const ed = async (op, x, y, zw, r, amount = 0, L = 1) => {
      const w = a.nest.wins[L];
      const kk = k ** L;
      const z = (zw - (await zoW(L))) * kk;
      while (!a.nest.edit({ op, radius: r, amount, at: { level: L, x: x * kk - w.gx, y: y * kk - w.gy, z } })) await new Promise((r) => setTimeout(r, 30));
      await a.device.queue.onSubmittedWorkDone();
      await fr(2);
    };
    const bowl = [cx + 7, cy - 7];
    const tb = await top(...bowl);
    await ed('carve', bowl[0], bowl[1], tb - 0.3, 1.0);
    const close = await top(bowl[0] - 2.4, bowl[1] - 2.4);
    const w0 = a.nest.wins[0];
    return { bowl, tb, cx, cy, close, w0: w0 ? { gx: w0.gx, gy: w0.gy, n: w0.n } : null };
  });
  console.log('features', JSON.stringify(feat));
  const look = (eye, at) => {
    const d = [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]];
    const n = Math.hypot(...d);
    return { yaw: Math.atan2(-d[1], -d[0]), pitch: Math.asin(-d[2] / n), eye };
  };
  const { cx, cy, tb, bowl } = feat;
  const poses = {
    // (from high up, the hills below and to the horizon)
    far: look([cx - 40, cy - 115, tb + 120], [cx + 20, cy + 40, tb - 10]),
    // (low over the hills, looking level across several of them to the horizon)
    low: look([cx - 20, cy - 70, tb + 14], [cx + 40, cy + 120, tb + 4]),
    // (round 20's overview: a mid-distance hillside, the crossover from canopy to grass across it)
    hillside: look([cx - 30, cy - 70, tb + 45], [cx, cy, tb - 2]),
    // (nearer, lower: the crossover in the foreground)
    mid: look([cx - 25, cy - 55, tb + 22], [cx + 5, cy + 5, tb - 4]),
    closeup: look([bowl[0] - 2.4, bowl[1] - 2.4, feat.close + 0.05], [bowl[0] - 2.1, bowl[1] - 2.2, feat.close - 0.01]),
  };
  fs.mkdirSync('local/nested', { recursive: true });
  const only = R.opt('only', '').split(',').filter(Boolean);
  for (const [name, v] of Object.entries(poses)) {
    if (only.length && !only.includes(name)) continue;
    await page.evaluate((v) => nested.setView(v), { yaw: v.yaw, pitch: v.pitch, eye: v.eye });
    await sleep(3000);
    for (const [m, on] of [['canopy', true], ['grass', false]]) {
      await page.evaluate((on) => nested.canopy(on), on);
      await sleep(400);
      const got = await page.evaluate(() => nested.eye());
      const file = `local/nested/${R.opt('prefix', 'r21')}-${name}-${m}.png`;
      await page.screenshot({ path: file });
      const lift = Math.hypot(got.x - v.eye[0], got.y - v.eye[1], got.z - v.eye[2]);
      console.log(`${file}: eye moved ${lift.toFixed(3)}, level ${got.level}, levels open ${await page.evaluate(() => nested.app.nest.live)}`);
    }
  }
});
