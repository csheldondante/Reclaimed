// The giants and the geysers (round 75): finds the tallest giant crystal in a temperate place and a
// geyser in a lava field; walks in at each — the giant from the free camera and the fixed view, the
// geyser while it goes.
//   node scripts/giantshot.mjs [--url http://localhost:5203] [--out giant] [--which giant,geyser]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5203');
const out = opt('out', 'giant');
const which = opt('which', 'giant,geyser').split(',');
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1200,800'],
  defaultViewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`${url}/?atlas=view`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.atlas, { timeout: 180000 });
  const spots = await page.evaluate(() => {
    const a = window.reclaimed.atlas;
    const G = a.giants;
    let giant = null;
    for (let k = 0; k < G.length; k += 8) {
      const warm = 0.5 - 0.5 * Math.cos((2 * Math.PI * G[k + 1]) / a.worldH);
      if (warm < 0.4 || warm > 0.9) continue;
      if (!giant || G[k + 3] > giant.H) giant = { at: [Math.floor(G[k]), Math.floor(G[k + 1] / 0.866)], H: +G[k + 3].toFixed(0), r: +G[k + 4].toFixed(0), lean: [+G[k + 5].toFixed(2), +G[k + 6].toFixed(2)] };
    }
    let geyser = null;
    for (const d of a.defs) {
      if (d.kind !== 'lavafield' || geyser) continue;
      const cx = Math.floor(d.stat.cx * a.p.cols);
      const cy = Math.floor(d.stat.cy * a.p.rows);
      const gs = a.geysersIn(cx - 200, cy - 200, 400, 400);
      if (gs.length) geyser = { at: [gs[0].x, gs[0].y], n: gs.length };
    }
    return { giant, geyser, giants: G.length / 8 };
  });
  console.log(JSON.stringify(spots));
  await page.close();
  for (const k of which) {
    const s = spots[k];
    if (!s) continue;
    const lv = await browser.newPage();
    lv.on('pageerror', (e) => console.log(k, 'pageerror', e.message));
    await lv.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&tod=0.35&q=high&at=${s.at.join(',')}`, { waitUntil: 'load' });
    await lv.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
    await new Promise((r) => setTimeout(r, 6000));
    await lv.evaluate(() => {
      document.getElementById('ui').style.visibility = 'hidden';
      window.reclaimed.stream.auto = false;
    });
    if (k === 'giant') {
      await lv.evaluate(() => (window.reclaimed.camera.zoom = 1.3));
      await new Promise((r) => setTimeout(r, 1500));
      await lv.screenshot({ path: `${out}-giant-iso.png` });
      await lv.evaluate(async () => {
        const R = window.reclaimed;
        R.toggleFly();
        const g = R.map.surface[128 * 256 + 128];
        // (from the window's far corner, low, looking up at it)
        R.camera.fly.pos = [6, 6, g + 40];
        R.camera.fly.yaw = Math.atan2(110 - 6, 128 - 6);
        R.camera.fly.pitch = 0.32;
        await new Promise((r) => setTimeout(r, 2500));
      });
      await lv.screenshot({ path: `${out}-giant-fly.png` });
    } else {
      // wait for it to go, then look at it from beside
      const st = await lv.evaluate(async () => {
        const R = window.reclaimed;
        const S = R.stream;
        for (let i = 0; i < 1200; i++) {
          const g = R.world.geysers();
          if (g.on.length) return { on: g.on, n: g.list.length, waited: i };
          await new Promise((r) => setTimeout(r, 100));
        }
        return { on: [], n: R.world.geysers().list.length };
      });
      console.log('geyser', JSON.stringify(st));
      await lv.evaluate(async (st) => {
        const R = window.reclaimed;
        const S = R.stream;
        const g = R.world.geysers().list[st.on[0] ?? 0];
        const x = g.x - S.origin[0];
        const y = (g.y - S.origin[1]) * 0.866;
        const z = R.map.surface[(g.y - S.origin[1]) * 256 + (g.x - S.origin[0])];
        R.toggleFly();
        R.camera.fly.pos = [x - 22, y - 16, z + 10];
        R.camera.fly.yaw = Math.atan2(16, 22);
        R.camera.fly.pitch = 0.3;
        await new Promise((r) => setTimeout(r, 1200));
      }, st);
      await lv.screenshot({ path: `${out}-geyser.png` });
    }
    await lv.close();
  }
} finally {
  await browser.close();
}
