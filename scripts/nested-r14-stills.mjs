// Nested scales (round 14): boxes vs the smooth draw at the same poses, local/nested/r14-<pose>-<box|smooth>.png, and a
// short zoom GIF with the smooth draw on (r14-zoom-smooth.gif). The watertight suite's scene (mound + tunnel, blob, arch,
// a stroke across a level rim) plus, at the finest level near the mound: a ball carve on open ground, a raised cliff,
// a one-column pillar (adds stacked) and a one-column tunnel (small carves in a row).
// node scripts/nested-r14-stills.mjs --chromeargs ignore-certificate-errors [--size 412x915] [--tag -phone] [--gif 1]
import { run, sleep } from './lib/runner.mjs';
import * as gifenc from 'gifenc';
import { PNG } from 'pngjs';
import fs from 'node:fs';
const { GIFEncoder, quantize, applyPalette } = gifenc.GIFEncoder ? gifenc : gifenc.default;

await run({ name: 'r14-stills', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
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
  // the extra features, 5 to 8 world units off the mound, edited at the finest live level there (forced hits)
  const feat = await page.evaluate(async (h) => {
    const a = nested.app;
    nested.setView({ yaw: 0.6, pitch: 0.6, eye: [h[0] + 8, h[1] - 6, h[2] + 4] });
    for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
    const L = a.nest.live - 1;
    const k = 8;
    const s = k ** L;
    const snap = await a.nest.readAll();
    const top = (x, y) => {
      const c = snap.column(L, Math.floor(x * s), Math.floor(y * s));
      return c.z1[c.z1.length - 1];
    };
    const ed = async (op, x, y, z, r) => {
      const w = a.nest.wins[L];
      while (!a.nest.edit({ op, radius: r, amount: op === 'raise' ? 1.5 : 0, at: { level: L, x: x * s - w.gx, y: y * s - w.gy, z } })) await new Promise((r) => setTimeout(r, 30));
      await a.device.queue.onSubmittedWorkDone();
    };
    const col = 1 / s;
    const p = { carve: [h[0] + 6, h[1] - 4], cliff: [h[0] + 9, h[1] - 7], pillar: [h[0] + 6, h[1] - 8], tunnel: [h[0] + 9, h[1] - 3] };
    await ed('carve', p.carve[0], p.carve[1], top(...p.carve), 0.6);
    await ed('raise', p.cliff[0], p.cliff[1], top(...p.cliff), 0.5);
    const t0 = top(...p.pillar);
    // (z in the level's units: a column is one unit wide)
    for (let i = 1; i <= 8; i++) await ed('add', p.pillar[0], p.pillar[1], t0 + i * 0.6, 0.6 * col);
    const t1 = top(...p.tunnel);
    for (let i = 0; i < 12; i++) await ed('carve', p.tunnel[0] + i * col, p.tunnel[1], t1 - 3, 0.6 * col);
    return { L, p, t0, t1, zo: L ? snap.zOrigin(L) : 0 };
  }, h);
  const P = feat.p;
  const poses = {
    'hillside-l0': { yaw: 0.6, pitch: 0.7, eye: [hx + 60, hy + 40, hz + 70] },
    'hillside-l1': { yaw: 0.6, pitch: 0.5, eye: [hx + 20, hy + 14, hz + 12] },
    'hillside-l2': { yaw: 0.6, pitch: 0.45, eye: [hx + 6, hy + 4, hz + 3] },
    'carve-rim': { yaw: 0.8, pitch: 0.7, eye: [P.carve[0] - 1.6, P.carve[1] - 1.2, hz + 2.2] },
    'tunnel-mouth': { yaw: 0, pitch: 0.05, eye: [hx + 2.6, hy + 0.2, tz] },
    'tunnel-inside': { yaw: Math.PI, pitch: 0.0, eye: [hx - 0.3, hy, tz - 0.1] },
    cliff: { yaw: 0.3, pitch: 0.35, eye: [P.cliff[0] - 2.2, P.cliff[1] - 0.8, hz + 1.6] },
    'level-rim': { yaw: 0, pitch: 0.03, eye: [hx + 7, hy, tz + 0.2] },
    'pillar-1col': { yaw: 1.2, pitch: 0.2, eye: [P.pillar[0] - 0.12, P.pillar[1] - 0.3, hz + 0.6] },
    'tunnel-1col': { yaw: 0, pitch: 0.4, eye: [P.tunnel[0] - 0.15, P.tunnel[1] - 0.12, hz + 0.3] },
  };
  fs.mkdirSync('local/nested', { recursive: true });
  for (const sm of [false, true]) {
    await page.evaluate((sm) => nested.smooth(sm), sm);
    for (const [name, v] of Object.entries(poses)) {
      await page.evaluate((v) => nested.setView(v), v);
      await sleep(3000);
      const file = `local/nested/${R.opt('prefix', 'r14')}-${name}-${sm ? 'smooth' : 'box'}${tag}.png`;
      await page.screenshot({ path: file });
      console.log(file);
    }
  }
  if (R.opt('gif', '0') === '1') {
    // a zoom from the hillside down to the finest level, smooth on
    const frames = [];
    for (let i = 0; i < 24; i++) {
      const t = i / 23;
      const d = 70 * Math.pow(0.04, t);
      await page.evaluate((v) => nested.setView(v), { yaw: 0.6, pitch: 0.55, eye: [hx + d * 0.7, hy + d * 0.5, hz + d * 0.8] });
      await sleep(i === 0 ? 3000 : 700);
      frames.push(PNG.sync.read(await page.screenshot()));
    }
    const enc = GIFEncoder();
    for (const f of frames) {
      const pal = quantize(f.data, 256);
      enc.writeFrame(applyPalette(f.data, pal), f.width, f.height, { palette: pal, delay: 120 });
    }
    enc.finish();
    fs.writeFileSync(`local/nested/${R.opt('prefix', 'r14')}-zoom-smooth${tag}.gif`, enc.bytes());
    console.log(`local/nested/${R.opt('prefix', 'r14')}-zoom-smooth${tag}.gif`);
  }
});
