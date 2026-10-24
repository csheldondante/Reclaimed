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
      if (!out[d.kind] || d.stat.area > out[d.kind].area) out[d.kind] = { area: d.stat.area, at: [Math.floor(d.stat.cx * a.p.cols), Math.floor(d.stat.cy * a.p.rows)] };
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
    await lv.screenshot({ path: `${out}-${k}.png` });
    await lv.close();
  }
} finally {
  await browser.close();
}
