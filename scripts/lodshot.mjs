// Round 83: the rings of less detail (atlas/lod.ts) seen zoomed out — the atlas level with and without them
// (?lod=0) — and the camera's puck (api/puck.ts) on the valley: panned across the map, its height, the
// slice and the orbit logged, a shot at each stop.
//   node scripts/lodshot.mjs [--url http://localhost:5207] [--out C:/Projects/shots78/lod] [--only lod|cam]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5207');
const out = opt('out', 'C:/Projects/shots78/lod');
const only = opt('only', '');
const zoom = Number(opt('zoom', 1));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1200,800'],
  defaultViewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const page = async (q) => {
  const p = await browser.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  p.on('console', (m) => m.type() === 'error' && console.log('console', m.text()));
  await p.goto(`${url}/?skipmenu=1&tutorial=0&q=high&${q}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.camera, { timeout: 240000 });
  return p;
};
try {
  if (only !== 'cam') {
    for (const [name, q] of [['on', ''], ['off', '&lod=0']]) {
      const p = await page(`level=atlas${q}`);
      await sleep(15000);
      await p.evaluate((z) => (window.reclaimed.camera.zoom = z), zoom);
      await sleep(5000);
      await p.screenshot({ path: `${out}-${name}.png` });
      const fatal = await p.$eval('.fatal', (e) => e.textContent).catch(() => null);
      if (fatal) console.log('FATAL', fatal);
      await p.close();
      console.log('lod', name);
    }
  }
  if (only !== 'lod') {
    const p = await page('cutaway=1');
    await sleep(8000);
    await p.evaluate(() => (window.reclaimed.camera.zoom = 6));
    const log = async (tag) => {
      const s = await p.evaluate(() => {
        const R = window.reclaimed;
        const c = R.scene.cutaway;
        const r = (v) => (v ? v.map((x) => +x.toFixed(1)) : v);
        return { pos: r(c?.puck.pos), goal: r(c?.puck.goal), slice: c?.slice.z, az: +((R.camera.azimuth * 180) / Math.PI).toFixed(1), goalAz: c?.orbit.goal };
      });
      console.log(tag, JSON.stringify(s));
    };
    await sleep(1500);
    await log('start');
    // pan with the keys, a stop at a time; the puck's height sampled through each glide
    for (let k = 0; k < 6; k++) {
      await p.keyboard.down('w');
      await sleep(700);
      await p.keyboard.up('w');
      for (let i = 0; i < 4; i++) {
        await sleep(250);
        await log(`pan${k}.${i}`);
      }
      await p.screenshot({ path: `${out}-cam${k}.png` });
    }
    await p.close();
  }
} finally {
  await browser.close();
}
