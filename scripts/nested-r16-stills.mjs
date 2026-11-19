// Nested scales (round 16): boxes vs the sheet draw at the same poses, local/nested/r16-<pose>-<box|smooth><tag>.png.
// The watertight suite's scene, then at the finest level near the mound: a carved bowl, a raised cliff with an overhang
// lip added off its side, and a tunnel carved at the page's default brush (radius 1.5) sloping into the ground (its
// mouth where it starts). Every new pose looks at its feature (lookAt). The zoom GIF of round 14 is dropped.
// node scripts/nested-r16-stills.mjs --chromeargs ignore-certificate-errors [--size 412x915] [--tag -phone]
import { run, sleep } from './lib/runner.mjs';
import fs from 'node:fs';

await run({ name: 'r16-stills', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const tag = R.opt('tag', '');
  const port = R.opt('port', '5461');
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}] ${m.text()}`);
  });
  await page.goto(`https://localhost:${port}/nested.html?k=8&d=8&pitch=0.3&yaw=0&tx=100&ty=140`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.frameCount > 60, { timeout: 120000, polling: 100 });
  await sleep(1500);
  const h = await page.evaluate(async () => {
    const { watertightSuite } = await import('/src/nested/suite.ts');
    const e = nested.eye();
    const f = nested.app.forward();
    const h = [e.x + f[0] * e.dHit, e.y + f[1] * e.dHit, e.z + f[2] * e.dHit];
    await watertightSuite(window.nested, { manifold: false, screen: false });
    return h;
  });
  const [hx, hy, hz] = h;
  const tz = hz + 1.3;
  const feat = await page.evaluate(async (h) => {
    const a = nested.app;
    nested.setView({ yaw: 0.6, pitch: 0.6, eye: [h[0] + 8, h[1] - 6, h[2] + 4] });
    for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
    const L = a.nest.live - 1;
    const s = 8 ** L;
    const top = async (x, y) => {
      const snap = await a.nest.readAll();
      const c = snap.column(L, Math.floor(x * s), Math.floor(y * s));
      return c.z1[c.z1.length - 1];
    };
    const ed = async (op, x, y, z, r) => {
      const w = a.nest.wins[L];
      while (!a.nest.edit({ op, radius: r, amount: op === 'raise' ? 1.5 : 0, at: { level: L, x: x * s - w.gx, y: y * s - w.gy, z } })) await new Promise((r) => setTimeout(r, 30));
      await a.device.queue.onSubmittedWorkDone();
    };
    const p = { bowl: [h[0] + 6, h[1] - 4], cliff: [h[0] + 9, h[1] - 7], tunnel: [h[0] + 3, h[1] - 9] };
    const tb = await top(...p.bowl);
    await ed('carve', p.bowl[0], p.bowl[1], tb, 0.6);
    const tc = await top(...p.cliff);
    await ed('raise', p.cliff[0], p.cliff[1], tc, 0.5);
    const tc2 = await top(...p.cliff);
    // the lip: balls added in a row off the cliff's -x side, level with its top, over the lower ground
    for (let i = 0; i < 4; i++) await ed('add', p.cliff[0] - 0.4 - i * 0.25, p.cliff[1], tc2 - 0.15, 0.22);
    // the tunnel: the page's default brush (3 m: radius 1.5), sloping down into the ground along +x
    const tt = await top(...p.tunnel);
    for (let i = 0; i < 8; i++) await ed('carve', p.tunnel[0] + i * 0.8, p.tunnel[1], tt - 0.6 - i * 0.35, 1.5);
    return { L, p, tb, tc: tc2, tt };
  }, h);
  const P = feat.p;
  const look = (eye, at) => {
    const d = [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]];
    const n = Math.hypot(...d);
    return { yaw: Math.atan2(-d[1], -d[0]), pitch: Math.asin(-d[2] / n), eye };
  };
  const poses = {
    'hillside-l0': { yaw: 0.6, pitch: 0.7, eye: [hx + 60, hy + 40, hz + 70] },
    'hillside-l2': { yaw: 0.6, pitch: 0.45, eye: [hx + 6, hy + 4, hz + 3] },
    cliff: look([P.cliff[0] + 0.3, P.cliff[1] - 3, feat.tc + 0.8], [P.cliff[0], P.cliff[1], feat.tc - 0.5]),
    'lip-side': look([P.cliff[0] - 0.9, P.cliff[1] - 2.2, feat.tc - 0.4], [P.cliff[0] - 0.8, P.cliff[1], feat.tc - 0.3]),
    'level-edge-grazing': { yaw: 0, pitch: 0.03, eye: [hx + 7, hy, tz + 0.2] },
    bowl: look([P.bowl[0] - 1.2, P.bowl[1] - 1.2, feat.tb + 1.0], [P.bowl[0], P.bowl[1], feat.tb - 0.3]),
    'tunnel-mouth': look([P.tunnel[0] - 3, P.tunnel[1], feat.tt + 0.8], [P.tunnel[0] + 1, P.tunnel[1], feat.tt - 1.2]),
    'tunnel-inside': look([P.tunnel[0] + 4.5, P.tunnel[1], feat.tt - 2.3], [P.tunnel[0], P.tunnel[1], feat.tt - 0.8]),
  };
  fs.mkdirSync('local/nested', { recursive: true });
  for (const sm of [false, true]) {
    await page.evaluate((sm) => nested.smooth(sm), sm);
    for (const [name, v] of Object.entries(poses)) {
      await page.evaluate((v) => nested.setView(v), v);
      await sleep(3000);
      const file = `local/nested/r16-${name}-${sm ? 'smooth' : 'box'}${tag}.png`;
      await page.screenshot({ path: file });
      console.log(file);
    }
  }
});
