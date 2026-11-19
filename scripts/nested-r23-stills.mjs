// Nested scales (round 23): the snap (?rimsnap=1), against the same poses without it. Round 22's script (the same
// features and poses) with --rimsnap and the prefix: stills local/nested/<prefix>-<pose>-<slide|noslide>-<tex|flat>.png.
// Features made at level 1 from world positions (heights read back): a crater, an add mound, overlapping carves, a
// carve across level 1's window edge, a tunnel into a slope.
// node scripts/nested-r23-stills.mjs --chromeargs ignore-certificate-errors --port 5486 [--only a,b] [--rimsnap 1]
//   [--prefix r23a] [--modes slide-tex,slide-flat,...]
import { run, sleep } from './lib/runner.mjs';
import fs from 'node:fs';

await run({ name: 'r23-stills', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5486');
  const rimtop = R.opt('rimtop', '0');
  const rimsnap = R.opt('rimsnap', '0');
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}] ${m.text()}`);
  });
  await page.goto(`https://localhost:${port}/nested.html?k=8&d=8&pitch=0.3&yaw=0&tx=100&ty=140&rimtop=${rimtop}&rimsnap=${rimsnap}`, { waitUntil: 'load' });
  // (NS-159: wait for the staged boot's pipelines, not only frames)
  await page.waitForFunction(() => window.nested && nested.app.frameCount > 60 && nested.app.pipesReady, { timeout: 180000, polling: 100 });
  await sleep(1500);
  await page.evaluate(() => nested.smooth(true));
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
    const ed = async (op, x, y, zw, r, L = 1) => {
      const w = a.nest.wins[L];
      const kk = k ** L;
      const z = (zw - (await zoW(L))) * kk;
      while (!a.nest.edit({ op, radius: r, amount: 0, at: { level: L, x: x * kk - w.gx, y: y * kk - w.gy, z } })) await new Promise((r) => setTimeout(r, 30));
      await a.device.queue.onSubmittedWorkDone();
      await fr(2);
    };
    const ex = w1.gx / k;
    const P = { crater: [cx + 7, cy - 7], mound: [cx + 7, cy + 6], overlap: [cx - 7, cy - 7], tunnel: [cx - 10, cy + 7], edge: [ex + 0.6, cy - 2] };
    const tc = await top(...P.crater);
    await ed('carve', P.crater[0], P.crater[1], tc + 0.3, 1.4);
    const tm = await top(...P.mound);
    await ed('add', P.mound[0], P.mound[1], tm - 0.4, 1.0);
    const to = await top(...P.overlap);
    await ed('carve', P.overlap[0], P.overlap[1], to + 0.2, 1.1);
    await ed('carve', P.overlap[0] + 1.2, P.overlap[1] + 0.5, to + 0.2, 0.9);
    await ed('carve', P.overlap[0] + 0.3, P.overlap[1] + 1.3, to + 0.2, 0.8);
    const tt = await top(...P.tunnel);
    for (let i = 0; i < 8; i++) await ed('carve', P.tunnel[0] + i * 0.8, P.tunnel[1], tt - 1.0 - i * 0.6, 1.5);
    const te = await top(...P.edge);
    await ed('carve', P.edge[0], P.edge[1], te + 0.3, 1.3);
    const close = await top(P.crater[0] - 1.6, P.crater[1] - 1.6);
    return { P, tc, tm, to, tt, te, cx, cy, ex, close };
  });
  console.log('features', JSON.stringify(feat));
  const { P } = feat;
  const look = (eye, at) => {
    const d = [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]];
    const n = Math.hypot(...d);
    return { yaw: Math.atan2(-d[1], -d[0]), pitch: Math.asin(-d[2] / n), eye };
  };
  const poses = {
    'crater-above': look([P.crater[0] - 0.4, P.crater[1] - 2.2, feat.tc + 3.2], [P.crater[0], P.crater[1], feat.tc - 0.6]),
    'crater-low': look([P.crater[0] - 2.4, P.crater[1] - 2.4, feat.tc + 0.45], [P.crater[0] + 0.3, P.crater[1] + 0.3, feat.tc - 0.5]),
    mound: look([P.mound[0] - 2.6, P.mound[1] - 2.2, feat.tm + 1.4], [P.mound[0], P.mound[1], feat.tm + 0.2]),
    overlap: look([P.overlap[0] - 0.8, P.overlap[1] - 2.6, feat.to + 3.0], [P.overlap[0] + 0.5, P.overlap[1] + 0.5, feat.to - 0.5]),
    'level-edge': look([P.edge[0] + 2.4, P.edge[1] - 2.0, feat.te + 2.2], [P.edge[0], P.edge[1], feat.te - 0.5]),
    'tunnel-mouth': look([P.tunnel[0] - 1.5, P.tunnel[1], feat.tt + 0.3], [P.tunnel[0] + 2, P.tunnel[1], feat.tt - 2.0]),
    closeup: look([P.crater[0] - 1.6, P.crater[1] - 1.6, feat.close + 0.12], [P.crater[0] - 0.9, P.crater[1] - 0.9, feat.close - 0.1]),
  };
  fs.mkdirSync('local/nested', { recursive: true });
  const only = R.opt('only', '').split(',').filter(Boolean);
  const all = [
    ['slide-tex', true, true],
    ['noslide-tex', false, true],
    ['slide-flat', true, false],
    ['noslide-flat', false, false],
  ];
  const want = R.opt('modes', '').split(',').filter(Boolean);
  const modes = want.length ? all.filter((m) => want.includes(m[0])) : all;
  for (const [name, v] of Object.entries(poses)) {
    if (only.length && !only.includes(name)) continue;
    await page.evaluate((v) => nested.setView(v), { yaw: v.yaw, pitch: v.pitch, eye: v.eye });
    await sleep(3000);
    for (const [m, sl, tex] of modes) {
      await page.evaluate(([sl, tex]) => Promise.all([nested.slide(sl), nested.tex(tex)]), [sl, tex]);
      await sleep(300);
      const got = await page.evaluate(() => nested.eye());
      const file = `local/nested/${R.opt('prefix', rimsnap === '1' ? 'r23a' : 'r23a-before')}-${name}-${m}.png`;
      await page.screenshot({ path: file });
      const lift = Math.hypot(got.x - v.eye[0], got.y - v.eye[1], got.z - v.eye[2]);
      console.log(`${file}: eye moved ${lift.toFixed(3)}, level ${got.level}, levels open ${await page.evaluate(() => nested.app.nest.live)}`);
    }
  }
});
