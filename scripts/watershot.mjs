// Round 83: the sea's swell off the shore field (render/shore.ts) — the atlas level at a coast, frames half
// a second apart (the crests running in), and the shore field's own texel count of shore found.
//   node scripts/watershot.mjs [--url http://localhost:5207] [--at 7470,70] [--zoom 5] [--out C:/Projects/shots78/water]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5207');
const at = opt('at', '7470,70');
const zoom = Number(opt('zoom', 5));
const out = opt('out', 'C:/Projects/shots78/water');
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1000,800'],
  defaultViewport: { width: 1000, height: 800, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
try {
  // (--at coast: a land texel beside the sea in the warm middle band of the atlas — a beach in the window)
  let spot = at;
  if (at === 'coast') {
    const v = await browser.newPage();
    await v.goto(`${url}/?atlas=view&overlay=0`, { waitUntil: 'load' });
    await v.waitForFunction(() => window.reclaimed?.atlas?.hmac, { timeout: 180000 });
    spot = await v.evaluate(() => {
      const a = window.reclaimed.atlas;
      const n = a.p.n;
      const hm = a.hmac;
      const sea = a.p.sea;
      for (let y = Math.floor(n * 0.4); y < n * 0.6; y++)
        for (let x = 2; x < n - 2; x++) {
          const z = hm[y * n + x];
          if (z < sea + 1 || z > sea + 6) continue;
          // (open sea a few texels away)
          if (hm[y * n + x + 3] < sea - 6 || hm[y * n + x - 3] < sea - 6 || hm[(y + 3) * n + x] < sea - 6 || hm[(y - 3) * n + x] < sea - 6)
            return `${Math.floor((x / n) * a.p.cols)},${Math.floor((y / n) * a.p.rows)}`;
        }
      return null;
    });
    await v.close();
    console.log('coast at', spot);
  }
  const p = await browser.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  p.on('console', (m) => m.type() === 'error' && !m.text().includes('404') && console.log('console', m.text()));
  await p.goto(`${url}/?skipmenu=1&tutorial=0&q=high&level=atlas&at=${spot}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  await sleep(15000);
  await p.evaluate((z) => (window.reclaimed.camera.zoom = z), zoom);
  await sleep(3000);
  for (let k = 0; k < 3; k++) {
    await p.screenshot({ path: `${out}-${k}.png` });
    await sleep(500);
  }
  const fatal = await p.$eval('.fatal', (e) => e.textContent).catch(() => null);
  if (fatal) console.log('FATAL', fatal);
} finally {
  await browser.close();
}
