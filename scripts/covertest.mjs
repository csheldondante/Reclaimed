// Cover on structures (round 52): a house and a bus stood up in the sandbox,
// a cold storm over them (snow on their roofs), the sun on it, a thaw, then a
// dust storm (dust on them) and rain to wash it off. Prints the structure
// voxels' cover (voxels with any, mean level of those) at each step.
//
//   node scripts/covertest.mjs [--url http://localhost:5181] [--cold -8] [--warm 14]
//     [--seconds 24] [--speed 4] [--out cover]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5181');
const out = opt('out', 'cover');
const cold = Number(opt('cold', -8));
const warm = Number(opt('warm', 14));
const seconds = Number(opt('seconds', 24));
const speed = Number(opt('speed', 4));
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
  await page.goto(`${url}/?skipmenu=1&level=sandbox&tutorial=0&tod=0.35&speed=${speed}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.core, { timeout: 90000 });
  await wait(4000);
  const at = await page.evaluate(async () => {
    const R = window.reclaimed;
    const { cellPos } = await import('/src/world/lattice.ts');
    const { w, h } = R.core.dims;
    const [px, py] = cellPos(Math.floor(w / 2), Math.floor(h / 2));
    R.grids.place('house', px - 6, py, 25);
    R.grids.place('bus', px + 7, py + 2, -15);
    R.camera.target[0] = px;
    R.camera.target[1] = py;
    R.camera.zoom *= 10;
    return { px, py };
  });
  const cover = () =>
    page.evaluate(async () => {
      const R = window.reclaimed;
      const n = R.world.strVoxels;
      const v = new Uint32Array((await R.core.readBuffer('strVox')).buffer).subarray(0, n);
      let snow = 0;
      let dust = 0;
      let sum = 0;
      for (const w of v) {
        const lv = (w >>> 24) & 31;
        if (!lv) continue;
        if ((w >>> 29) & 1) dust++;
        else snow++;
        sum += lv;
      }
      return { voxels: n, snow, dust, meanLevel: snow + dust ? +(sum / (snow + dust)).toFixed(1) : 0 };
    });
  await wait(1500);
  console.log('start:', JSON.stringify(await cover()));
  await page.screenshot({ path: `${out}-0-start.png` });
  await page.evaluate(
    (t, a) => {
      const R = window.reclaimed;
      R.globals.climate = { temp: t, lapse: 0 };
      R.weather.spawn(a.px, a.py);
    },
    cold,
    at,
  );
  await wait(seconds * 1000);
  console.log(`snow, ${cold} °C ${seconds} s:`, JSON.stringify(await cover()));
  await page.screenshot({ path: `${out}-1-snowing.png` });
  await page.evaluate(() => {
    window.reclaimed.weather.storms.length = 0;
  });
  await wait(4000);
  await page.screenshot({ path: `${out}-2-snow-sun.png` });
  await page.evaluate((t) => {
    window.reclaimed.globals.climate = { temp: t, lapse: 0 };
  }, warm);
  await wait(seconds * 1000);
  console.log(`thaw, ${warm} °C ${seconds} s:`, JSON.stringify(await cover()));
  await page.screenshot({ path: `${out}-3-thawed.png` });
  await page.evaluate((a) => {
    window.reclaimed.weather.placeDust(a.px, a.py);
  }, at);
  await wait(seconds * 1000);
  console.log(`dust storm ${seconds} s:`, JSON.stringify(await cover()));
  await page.screenshot({ path: `${out}-4-dust.png` });
  await page.evaluate((a) => {
    const R = window.reclaimed;
    R.weather.dusts.length = 0;
    R.weather.spawn(a.px, a.py);
  }, at);
  await wait(seconds * 1000);
  console.log(`rain ${seconds} s:`, JSON.stringify(await cover()));
  await page.screenshot({ path: `${out}-5-rained.png` });
} finally {
  await browser.close();
}
if (failed) process.exit(1);
