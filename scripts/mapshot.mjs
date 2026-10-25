// Round 80: the atlas map in the atlas level (the 🗺 button): open, a shot of it; a tap somewhere else, a shot
// of where the warp lands.  node scripts/mapshot.mjs [--url http://localhost:5207] [--out map]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5207');
const out = opt('out', 'map');
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
  defaultViewport: { width: 412, height: 915, deviceScaleFactor: 2 },
  protocolTimeout: 600000,
});
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=low&at=12304,5457`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  await new Promise((r) => setTimeout(r, 4000));
  await p.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === '🗺')?.click());
  await new Promise((r) => setTimeout(r, 1500));
  await p.screenshot({ path: `${out}-open.png` });
  const before = await p.evaluate(() => [...window.reclaimed.stream.origin]);
  // (a tap a third of the way up the screen: somewhere else)
  await p.mouse.click(206, 300);
  await p.waitForFunction((b) => window.reclaimed.stream.origin[0] !== b[0] || window.reclaimed.stream.origin[1] !== b[1], { timeout: 60000 }, before);
  await new Promise((r) => setTimeout(r, 6000));
  const after = await p.evaluate(() => ({ origin: [...window.reclaimed.stream.origin], oz: window.reclaimed.stream.oz }));
  console.log(JSON.stringify({ before, after }));
  await p.screenshot({ path: `${out}-landed.png` });
} finally {
  await browser.close();
}
