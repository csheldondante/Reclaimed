// A tour of the atlas (round 67): for each kind asked for, walks into the
// world at the middle of its largest region and takes a picture.
//   node scripts/atlastour.mjs [--url ...] [--q "a.style=1"] [--kinds kaleido,coral] [--out tour]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5203');
const q = opt('q', '');
const kinds = opt('kinds', 'kaleido,coral,basalt,range,mesa,craters').split(',');
const out = opt('out', 'tour');
// (the close shot's zoom, times the level's own)
const zoom = Number(opt('zoom', '1'));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1200,800'],
  defaultViewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
  protocolTimeout: 10 * 60 * 1000,
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto(`${url}/?atlas=view&${q}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.atlas, { timeout: 180000 });
  const spots = await page.evaluate((kinds) => {
    const a = window.reclaimed.atlas;
    const out = {};
    a.defs.forEach((d) => {
      if (!kinds.includes(d.kind) || !d.stat.land) return;
      // (temperate first: the largest of a kind is often near a pole, under snow)
      const warm = 0.5 - 0.5 * Math.cos(2 * Math.PI * d.stat.cy);
      const score = d.stat.area * (warm > 0.5 ? 4 : 1);
      if (!out[d.kind] || score > out[d.kind].score) out[d.kind] = { score, warm: +warm.toFixed(2), temp: +a.climateAt(0, d.stat.cy * a.p.rows).temp.toFixed(1), at: [Math.floor(d.stat.cx * a.p.cols), Math.floor(d.stat.cy * a.p.rows)] };
    });
    return out;
  }, kinds);
  console.log(JSON.stringify(spots));
  await page.close();
  for (const k of kinds) {
    if (!spots[k]) continue;
    const lv = await browser.newPage();
    lv.on('pageerror', (e) => console.log(k, 'pageerror:', e.message));
    await lv.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&tod=0.35&q=high&at=${spots[k].at.join(',')}&${q}`, { waitUntil: 'load' });
    await lv.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
    await new Promise((r) => setTimeout(r, 5000));
    await lv.evaluate(() => (document.getElementById('ui').style.visibility = 'hidden'));
    await lv.screenshot({ path: `${out}-${k}.png` });
    // wider, then panning east over two slides (the strips that came in are in the picture)
    const z0 = await lv.evaluate(() => {
      const c = window.reclaimed.camera;
      const z = c.zoom;
      c.zoom = z * 0.55;
      return z;
    });
    await new Promise((r) => setTimeout(r, 2500));
    await lv.screenshot({ path: `${out}-${k}-wide.png` });
    const pan = await lv.evaluate(async () => {
      const R = window.reclaimed;
      const S = R.stream;
      const n0 = S.stats.slides;
      for (let f = 0; f < 900 && S.stats.slides - n0 < 2; f++) {
        R.camera.target[0] += 1.2;
        await new Promise((r) => requestAnimationFrame(r));
      }
      await new Promise((r) => setTimeout(r, 3000));
      return { slides: S.stats.slides - n0, prefetched: S.stats.prefetched, lastMs: S.stats.lastMs };
    });
    console.log(k, JSON.stringify(pan));
    await lv.screenshot({ path: `${out}-${k}-panned.png` });
    void z0;
    await lv.close();
  }
} finally {
  await browser.close();
}
