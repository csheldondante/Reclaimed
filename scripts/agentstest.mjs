// Agents (round 52): units spawned at one spot in a level, sent to another;
// prints the surfaces peeled (columns with 0..4), the field's reach, and how
// far the units are from the goal over time; saves shots and an image of the
// field (blue near, red far, black unreachable, white the units).
//
//   node scripts/agentstest.mjs [--url http://localhost:5185] [--level sandbox] [--n 300]
//     [--from dx,dy] [--to dx,dy] (cells from the map centre) [--seconds 20] [--out agents]
//     [--wall] (a stone wall across the way, 4 high: they go round)
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5185');
const out = opt('out', 'agents');
const level = opt('level', 'sandbox');
const n = Number(opt('n', 300));
const from = opt('from', '-30,-10').split(',').map(Number);
const to = opt('to', '30,15').split(',').map(Number);
const seconds = Number(opt('seconds', 20));
const browser = await puppeteer.launch({
  executablePath: opt('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'),
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1200,800'],
  defaultViewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
  protocolTimeout: 10 * 60 * 1000,
});
let failed = false;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => {
    failed = true;
    console.log('pageerror:', e.message);
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) {
      failed = true;
      console.log('console.error:', m.text().slice(0, 800));
    }
  });
  await page.goto(`${url}/?skipmenu=1&level=${level}&tutorial=0&tod=0.4`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.agents, { timeout: 90000 });
  await wait(3000);
  const setup = await page.evaluate(
    async (n, from, to, wall) => {
      const R = window.reclaimed;
      const { cellPos } = await import('/src/world/lattice.ts');
      const { w, h } = R.core.dims;
      const [ax, ay] = cellPos(Math.floor(w / 2) + from[0], Math.floor(h / 2) + from[1]);
      const [bx, by] = cellPos(Math.floor(w / 2) + to[0], Math.floor(h / 2) + to[1]);
      if (wall) {
        // a stone wall 4 high across the way, 40 cells long: they go round it
        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2;
        const dx = bx - ax;
        const dy = by - ay;
        const l = Math.hypot(dx, dy);
        for (let t = -20; t <= 20; t += 1) {
          R.globals.events.push({ kind: 5, x: mx - (dy / l) * t, y: my + (dx / l) * t, z: 1 * 32 + 1 + (t === -20 ? 512 : 0), radius: 1.2, strength: 4 });
        }
      }
      R.agents.spawn(n, ax, ay, { group: 0 });
      R.agents.goTo(0, bx, by);
      R.camera.target[0] = (ax + bx) / 2;
      R.camera.target[1] = (ay + by) / 2;
      R.camera.zoom *= 2.2;
      return { ax, ay, bx, by, w, h };
    },
    n,
    from,
    to,
    argv.includes('--wall'),
  );
  await wait(1500);
  const stats = await page.evaluate(async () => {
    const R = window.reclaimed;
    const nav = new Uint32Array(await R.agents.readRaw('nav'));
    const f = new Float32Array(nav.buffer);
    const { w, h } = R.core.dims;
    const per = [0, 0, 0, 0, 0];
    let links = 0;
    for (let i = 0; i < w * h; i++) {
      let k = 0;
      while (k < 4 && f[(i * 4 + k) * 4] >= 0) {
        const l = nav[(i * 4 + k) * 4 + 1] >>> 9;
        for (let d = 0; d < 6; d++) if ((l >>> (3 * d)) & 7) links++;
        k++;
      }
      per[k]++;
    }
    return { columnsWith0to4Surfaces: per, links };
  });
  console.log('surfaces:', JSON.stringify(stats));
  const progress = () =>
    page.evaluate(async (s) => {
      const R = window.reclaimed;
      const u = await R.agents.read();
      let sum = 0;
      let near = 0;
      for (let i = 0; i < u.length / 4; i++) {
        const d = Math.hypot(u[i * 4] - s.bx, u[i * 4 + 1] - s.by);
        sum += d;
        if (d < 6) near++;
      }
      return { meanToGoal: +(sum / (u.length / 4)).toFixed(1), within6: near };
    }, setup);
  const t0 = Date.now();
  console.log('t=0:', JSON.stringify(await progress()));
  await page.screenshot({ path: `${out}-0.png` });
  for (let k = 1; k <= 4; k++) {
    await wait((seconds * 1000) / 4);
    console.log(`t=${((Date.now() - t0) / 1000).toFixed(0)}s:`, JSON.stringify(await progress()));
    await page.screenshot({ path: `${out}-${k}.png` });
  }
  // what it costs (GPU timestamps, ms a tick, when the adapter has them)
  console.log(
    'gpu ms:',
    JSON.stringify(
      await page.evaluate(() => {
        const p = window.reclaimed.core.host.profiler.passMs;
        const o = {};
        for (const k of ['agents', 'water', 'sediment', 'particles', 'render']) if (p.has(k)) o[k] = +p.get(k).toFixed(3);
        return o;
      }),
    ),
  );
  // the field as an image
  const png = await page.evaluate(async () => {
    const R = window.reclaimed;
    const { w, h } = R.core.dims;
    const nav = new Float32Array(await R.agents.readRaw('nav'));
    const dist = new Float32Array(await R.agents.readRaw('dist'));
    const u = await R.agents.read();
    const { cellAt } = await import('/src/world/lattice.ts');
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    const img = g.createImageData(w, h);
    let max = 0;
    for (let i = 0; i < w * h; i++) if (dist[i * 4] < 1e8 && nav[i * 16] >= 0) max = Math.max(max, dist[i * 4]);
    for (let i = 0; i < w * h; i++) {
      const d = dist[i * 4];
      const t = nav[i * 16] < 0 || d >= 1e8 ? -1 : d / max;
      const band = t >= 0 && Math.floor(d / 4) % 2 === 0 ? 0.85 : 1;
      img.data[i * 4] = t < 0 ? 0 : 255 * t * band;
      img.data[i * 4 + 1] = t < 0 ? 0 : 80 * band;
      img.data[i * 4 + 2] = t < 0 ? 0 : 255 * (1 - t) * band;
      img.data[i * 4 + 3] = 255;
    }
    for (let i = 0; i < u.length / 4; i++) {
      const [x, y] = cellAt(u[i * 4], u[i * 4 + 1]);
      const j = (y * w + x) * 4;
      img.data[j] = img.data[j + 1] = img.data[j + 2] = 255;
    }
    g.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  });
  fs.writeFileSync(`${out}-field.png`, Buffer.from(png.split(',')[1], 'base64'));
} finally {
  await browser.close();
}
if (failed) process.exit(1);
