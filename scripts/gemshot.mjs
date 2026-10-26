// Round 83: the giant crystals in the window (quartz in the field mesh, meshdraw.wgsl gemLook) — the atlas
// started beside its first giant, a shot from the fixed view near its foot.
//   node scripts/gemshot.mjs [--url http://localhost:5207] [--out C:/Projects/shots78/gem] [--zoom 5] [--k 0]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5207');
const out = opt('out', 'C:/Projects/shots78/gem');
const zoom = Number(opt('zoom', 5));
const K = Number(opt('k', 0));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1200,800'],
  defaultViewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
try {
  const v = await browser.newPage();
  await v.goto(`${url}/?atlas=view&overlay=0`, { waitUntil: 'load' });
  await v.waitForFunction(() => window.reclaimed?.atlas?.giants, { timeout: 180000 });
  const g = await v.evaluate((k) => {
    const a = window.reclaimed.atlas;
    const G = a.giants;
    const n = G.length / 8;
    const i = Math.min(k, n - 1);
    return { n, x: G[i * 8], y: G[i * 8 + 1], base: G[i * 8 + 2], h: G[i * 8 + 3], r: G[i * 8 + 4] };
  }, K);
  await v.close();
  console.log('giant', JSON.stringify(g));
  const ROW_H = Math.sqrt(3) / 2;
  // (a little toward the eye from its foot: the camera looks from +x +y)
  const at = `${Math.round(g.x + g.r * 1.5)},${Math.round((g.y + g.r * 1.5) / ROW_H)}`;
  const p = await browser.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  await p.goto(`${url}/?skipmenu=1&tutorial=0&q=high&level=atlas&at=${at}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.camera, { timeout: 240000 });
  await sleep(20000);
  await p.evaluate((z) => (window.reclaimed.camera.zoom = z), zoom);
  await sleep(5000);
  await p.screenshot({ path: `${out}.png` });
  await p.evaluate(() => (window.reclaimed.camera.zoom *= 2.5));
  await sleep(4000);
  await p.screenshot({ path: `${out}-close.png` });
  const fatal = await p.$eval('.fatal', (e) => e.textContent).catch(() => null);
  if (fatal) console.log('FATAL', fatal);
} finally {
  await browser.close();
}
