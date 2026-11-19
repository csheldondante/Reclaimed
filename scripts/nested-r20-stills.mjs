// Nested scales (round 20): the textured draw's stills, local/nested/r20-<pose>[-box]-tex|flat.png: every pose taken
// twice in the same page, the textured draw (?tex=1) then the flat one (tex=0), so the pairs compare. Features as
// nested-r17-stills.mjs (made at level 1 from world positions, heights read back), plus a raised cliff at level 1 and a
// tall one at the root level (diagonal to the grid: the owner's phone still (c)).
// node scripts/nested-r20-stills.mjs --chromeargs ignore-certificate-errors --port 5476 [--box 1] [--only a,b]
//   [--split 1: ?bands=split as well, files -split] [--prefix r20]
import { run, sleep } from './lib/runner.mjs';
import fs from 'node:fs';

await run({ name: 'r20-stills', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const box = R.opt('box', '0') === '1';
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning' || m.text().startsWith('[tex]')) console.log(`[page ${m.type()}] ${m.text()}`);
  });
  await page.goto(`https://localhost:${port}/nested.html?k=8&d=8&pitch=0.3&yaw=0&tx=100&ty=140`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.frameCount > 60 && nested.app.pipesReady, { timeout: 180000, polling: 100 });
  await sleep(1500);
  if (!box) await page.evaluate(() => nested.smooth(true));
  // (--diag 3: the textured draw's bands as colour: red the band value, green the bent normal toward the sun, blue the broad noise)
  await page.evaluate((m) => (nested.app.render.diag = m), Number(R.opt('diag', '0')));
  const feat = await page.evaluate(async () => {
    const a = nested.app;
    const k = 8;
    const fr = async (n) => {
      for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r));
    };
    const w1 = a.nest.wins[1];
    const cx = (w1.gx + w1.n / 2) / k;
    const cy = (w1.gy + w1.n / 2) / k;
    const top = async (x, y, L = 1) => {
      const s = await a.nest.readAll();
      const kk = k ** L;
      const c = s.column(L, Math.floor(x * kk), Math.floor(y * kk));
      let zo = 0;
      for (let j = 1; j <= L; j++) zo += s.zOrigin(j) / k ** (j - 1);
      return zo + c.z1[c.z1.length - 1] / kk;
    };
    const zoW = async (L) => {
      const s = await a.nest.readAll();
      let zo = 0;
      for (let j = 1; j <= L; j++) zo += s.zOrigin(j) / k ** (j - 1);
      return zo;
    };
    const ed = async (op, x, y, zw, r, amount = 0, L = 1) => {
      const w = a.nest.wins[L];
      const kk = k ** L;
      const z = (zw - (await zoW(L))) * kk;
      while (!a.nest.edit({ op, radius: r, amount, at: { level: L, x: x * kk - w.gx, y: y * kk - w.gy, z } })) await new Promise((r) => setTimeout(r, 30));
      await a.device.queue.onSubmittedWorkDone();
      await fr(2);
    };
    const P = { bowl: [cx + 7, cy - 7], tunnel: [cx - 10, cy + 7], cliff: [cx - 8, cy - 9], root: [cx + 30, cy + 26] };
    const tb = await top(...P.bowl);
    await ed('carve', P.bowl[0], P.bowl[1], tb - 0.3, 1.0);
    const tt = await top(...P.tunnel);
    for (let i = 0; i < 8; i++) await ed('carve', P.tunnel[0] + i * 0.8, P.tunnel[1], tt - 1.0 - i * 0.6, 1.5);
    // a cliff at level 1: a ball of radius 2.5 carved with its centre 0.5 under the surface (a stone wall round a pit)
    const tc0 = await top(...P.cliff);
    await ed('carve', P.cliff[0], P.cliff[1], tc0 - 0.5, 2.5);
    const tc = await top(...P.cliff);
    // a tall cliff at the root level: a ball of radius 7 carved there; its wall runs diagonal to the grid between the axes
    let tr = null;
    let tr0 = null;
    if (a.nest.wins[0]) {
      tr0 = await top(...P.root, 0);
      await ed('carve', P.root[0], P.root[1], tr0 + 1, 7.0, 0, 0);
      tr = await top(...P.root, 0);
    }
    const ex = w1.gx / k;
    const edge = { eye: await top(ex + 2.5, cy - 3), at: await top(ex - 0.5, cy - 3) };
    const close = await top(P.bowl[0] - 2.4, P.bowl[1] - 2.4);
    return { edge, P, tb, tt, tc0, tc, tr0, tr, cx, cy, w1, close };
  });
  console.log('features', JSON.stringify(feat));
  const { P } = feat;
  const look = (eye, at) => {
    const d = [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]];
    const n = Math.hypot(...d);
    return { yaw: Math.atan2(-d[1], -d[0]), pitch: Math.asin(-d[2] / n), eye };
  };
  const ex = feat.w1.gx / 8;
  // the root cliff's south-west face, 45 degrees to the grid, from outside it
  const rd = 7 / Math.SQRT2;
  const poses = {
    overview: look([feat.cx - 30, feat.cy - 70, feat.tb + 45], [feat.cx, feat.cy, feat.tb - 2]),
    hillside: look([feat.cx + 14, feat.cy - 12, feat.tb + 6], [feat.cx + 4, feat.cy - 4, feat.tb]),
    cliff: look([P.cliff[0] - 3.2, P.cliff[1] - 3.2, feat.tc0 + 1.0], [P.cliff[0] + 1.2, P.cliff[1] + 1.2, feat.tc0 - 1.6]),
    'bowl-rim': look([P.bowl[0] - 1.3, P.bowl[1] - 1.3, feat.tb + 0.35], [P.bowl[0] + 0.3, P.bowl[1] + 0.3, feat.tb - 0.8]),
    'tunnel-mouth': look([P.tunnel[0] - 1.5, P.tunnel[1], feat.tt + 0.3], [P.tunnel[0] + 2, P.tunnel[1], feat.tt - 2.0]),
    'level-edge-grazing': look([ex + 3, feat.cy - 3, feat.edge.eye + 1.2], [ex - 3, feat.cy - 3, feat.edge.at + 0.6]),
    // (straight down on the slope beside the bowl from 0.6 world units: the bands' shape without perspective)
    'top-down': { yaw: 0, pitch: 1.5, eye: [P.bowl[0] - 2.4, P.bowl[1] - 2.4, feat.close + 0.6] },
    closeup: look([P.bowl[0] - 2.4, P.bowl[1] - 2.4, feat.close + 0.05], [P.bowl[0] - 2.1, P.bowl[1] - 2.2, feat.close - 0.01]),
    // (from above the far rim, looking at the near side's wall across the pit: the wall faces the eye diagonally)
    ...(feat.tr !== null ? { 'root-cliff': look([P.root[0] - rd - 16, P.root[1] - rd - 16, feat.tr0 + 9], [P.root[0] + rd * 0.6, P.root[1] + rd * 0.6, feat.tr0 - 3]), 'root-cliff-far': look([P.root[0] - rd - 40, P.root[1] - rd - 40, feat.tr0 + 30], [P.root[0] + rd * 0.6, P.root[1] + rd * 0.6, feat.tr0 - 3]) } : {}),
  };
  fs.mkdirSync('local/nested', { recursive: true });
  const only = R.opt('only', '').split(',').filter(Boolean);
  const split = R.opt('split', '0') === '1';
  const modes = [['tex', true, false], ...(split ? [['tex-split', true, true]] : []), ['flat', false, false]];
  for (const [name, v] of Object.entries(poses)) {
    if (only.length && !only.includes(name)) continue;
    await page.evaluate((v) => nested.setView(v), { yaw: v.yaw, pitch: v.pitch, eye: v.eye });
    await sleep(3000);
    for (const [m, on, sp] of modes) {
      await page.evaluate(([on, sp]) => nested.tex(on, sp), [on, sp]);
      await sleep(400);
      const got = await page.evaluate(() => nested.eye());
      const file = `local/nested/${R.opt('prefix', 'r20')}-${name}${box ? '-box' : ''}-${m}.png`;
      await page.screenshot({ path: file });
      const lift = Math.hypot(got.x - v.eye[0], got.y - v.eye[1], got.z - v.eye[2]);
      console.log(`${file}: eye moved ${lift.toFixed(3)}, level ${got.level}, levels open ${await page.evaluate(() => nested.app.nest.live)}`);
    }
  }
});
