// Nested scales (round 17): the sheet draw's stills, local/nested/r17-<pose><tag>.png. Round 16's poses missed their
// features because the features' heights were level-local units read as world heights (the camera then sat in solid and
// was lifted out). Here every feature is made at level 1 from WORLD positions (converted on the way in), its world
// height read back from level 1's columns (world = the level's z origin + z / k^1), and every camera is placed from
// those world numbers; the eye the GPU actually took is printed next to the asked one (a lift means a bad pose).
// node scripts/nested-r17-stills.mjs --chromeargs ignore-certificate-errors [--size 412x915] [--tag -phone] [--box 1]
import { run, sleep } from './lib/runner.mjs';
import fs from 'node:fs';

await run({ name: 'r17-stills', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const tag = R.opt('tag', '');
  const port = R.opt('port', '5461');
  const box = R.opt('box', '0') === '1';
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}] ${m.text()}`);
  });
  await page.goto(`https://localhost:${port}/nested.html?k=8&d=8&pitch=0.3&yaw=0&tx=100&ty=140`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.frameCount > 60, { timeout: 120000, polling: 100 });
  await sleep(1500);
  if (!box) await page.evaluate(() => nested.smooth(true));
  const feat = await page.evaluate(async () => {
    const a = nested.app;
    const k = 8;
    const fr = async (n) => {
      for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r));
    };
    const w1 = a.nest.wins[1];
    // (level 1's window centre, world units = root columns)
    const cx = (w1.gx + w1.n / 2) / k;
    const cy = (w1.gy + w1.n / 2) / k;
    const zo = async () => (await a.nest.readAll()).zOrigin(1);
    // the world top at a world point, from level 1's columns
    const top = async (x, y) => {
      const s = await a.nest.readAll();
      const c = s.column(1, Math.floor(x * k), Math.floor(y * k));
      return s.zOrigin(1) + c.z1[c.z1.length - 1] / k;
    };
    const ed = async (op, x, y, zw, r, amount = 0) => {
      const w = a.nest.wins[1];
      const z = (zw - (await zo())) * k;
      while (!a.nest.edit({ op, radius: r, amount, at: { level: 1, x: x * k - w.gx, y: y * k - w.gy, z } })) await new Promise((r) => setTimeout(r, 30));
      await a.device.queue.onSubmittedWorkDone();
      await fr(2);
    };
    const P = { bowl: [cx + 7, cy - 7], tunnel: [cx - 10, cy + 7], lip: [cx + 7, cy + 7] };
    // the bowl: one carve, radius 1 (world), its centre 0.3 under the surface
    const tb = await top(...P.bowl);
    await ed('carve', P.bowl[0], P.bowl[1], tb - 0.3, 1.0);
    // the tunnel: the page's default brush (radius 1.5), sloping down along +x from 0.5 under the surface, 8 balls
    const tt = await top(...P.tunnel);
    // (the first ball breaks the surface: the mouth; from the third on the roof is under the ground)
    for (let i = 0; i < 8; i++) await ed('carve', P.tunnel[0] + i * 0.8, P.tunnel[1], tt - 1.0 - i * 0.6, 1.5);
    // the lip: a raised block, then balls added in a row off its -y side level with its top, over the lower ground
    const tl0 = await top(...P.lip);
    await ed('raise', P.lip[0], P.lip[1], tl0, 0.8, 1.5);
    const tl = await top(...P.lip);
    for (let i = 0; i < 5; i++) await ed('add', P.lip[0], P.lip[1] - 0.5 - i * 0.22, tl - 0.15, 0.2);
    // (the sawtooth's cause) level 1's columns along the bowl's rim: a quarter circle of cells at the rim radius, each
    // cell's surfaces (bottom up, solid / air changes); a cell with three surfaces has the bowl undercutting a lip
    const rim = [];
    {
      const s = await a.nest.readAll();
      const zo1 = s.zOrigin(1);
      for (let i = 0; i <= 12; i++) {
        const ang = (i / 12) * (Math.PI / 2);
        const X = Math.floor((P.bowl[0] + 0.97 * Math.cos(ang)) * k);
        const Y = Math.floor((P.bowl[1] + 0.97 * Math.sin(ang)) * k);
        const c = s.column(1, X, Y);
        rim.push(`${X},${Y}: ${c.z1.map((z, j) => `${(zo1 + z / k).toFixed(2)}m${c.mat[j]}`).join(' ')}`);
      }
    }
    // the ground at the level-edge pose's eye and target (level 1's west edge, inside and out)
    const ex = w1.gx / k;
    const edge = { eye: await top(ex + 2.5, cy - 3), at: await top(ex - 0.5, cy - 3) };
    return { edge, rim, P, tb, tt, tl, tl0, cx, cy, w1, lowAfter: { bowl: await top(...P.bowl), tunnel: await top(P.tunnel[0] + 4, P.tunnel[1]) } };
  });
  console.log('features', JSON.stringify(feat));
  const { P } = feat;
  const look = (eye, at) => {
    const d = [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]];
    const n = Math.hypot(...d);
    return { yaw: Math.atan2(-d[1], -d[0]), pitch: Math.asin(-d[2] / n), eye };
  };
  const ex = feat.w1.gx / 8;
  const poses = {
    hillside: look([feat.cx + 14, feat.cy - 12, feat.tb + 6], [feat.cx + 4, feat.cy - 4, feat.tb]),
    // a level edge: level 1's west edge, the eye inside level 1 a little above the ground, looking west along it
    'level-edge-grazing': { ...look([ex + 3, feat.cy - 3, feat.edge.eye + 1.2], [ex - 3, feat.cy - 3, feat.edge.at + 0.6]), tint: false },
    'level-edge-grazing-tint': { ...look([ex + 3, feat.cy - 3, feat.edge.eye + 1.2], [ex - 3, feat.cy - 3, feat.edge.at + 0.6]), tint: true },
    'bowl-above': look([P.bowl[0], P.bowl[1] - 0.6, feat.tb + 4], [P.bowl[0], P.bowl[1], feat.tb - 0.6]),
    'bowl-rim': look([P.bowl[0] - 1.3, P.bowl[1] - 1.3, feat.tb + 0.35], [P.bowl[0] + 0.3, P.bowl[1] + 0.3, feat.tb - 0.8]),
    'tunnel-outside': look([P.tunnel[0] - 6, P.tunnel[1] - 3, feat.tt + 2], [P.tunnel[0], P.tunnel[1], feat.tt - 0.8]),
    'tunnel-mouth': look([P.tunnel[0] - 1.5, P.tunnel[1], feat.tt + 0.3], [P.tunnel[0] + 2, P.tunnel[1], feat.tt - 2.0]),
    'tunnel-inside': look([P.tunnel[0] + 4.4, P.tunnel[1], feat.tt - 1.0 - 5.5 * 0.6], [P.tunnel[0], P.tunnel[1], feat.tt - 0.8]),
    'lip-side': look([P.lip[0] - 3, P.lip[1] - 1.1, feat.tl - 0.4], [P.lip[0], P.lip[1] - 1.1, feat.tl - 0.3]),
  };
  fs.mkdirSync('local/nested', { recursive: true });
  // (round 18: --only a,b picks poses, --prefix names the files, e.g. --only bowl-rim,hillside --prefix r18)
  const only = R.opt('only', '').split(',').filter(Boolean);
  for (const [name, v] of Object.entries(poses)) {
    if (only.length && !only.includes(name)) continue;
    await page.evaluate((t) => nested.tint(t), !!v.tint);
    await page.evaluate((v) => nested.setView(v), { yaw: v.yaw, pitch: v.pitch, eye: v.eye });
    await sleep(3000);
    const got = await page.evaluate(() => nested.eye());
    const file = `local/nested/${R.opt('prefix', 'r17')}-${name}${box ? '-box' : ''}${tag}.png`;
    await page.screenshot({ path: file });
    const lift = Math.hypot(got.x - v.eye[0], got.y - v.eye[1], got.z - v.eye[2]);
    console.log(`${file}: eye asked ${v.eye.map((x) => x.toFixed(2)).join(', ')} got ${[got.x, got.y, got.z].map((x) => x.toFixed(2)).join(', ')} (moved ${lift.toFixed(3)}), level ${got.level}, dHit ${got.dHit?.toFixed(2)}`);
  }
});
