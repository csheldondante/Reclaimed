// Round 107 (`pages`): the M1 page-table bench (src/perf/pagebench.ts, ?pagebench=1) driven headless on the desktop's
// GPU — Start tapped, the six pages left to run, the end page's report saved.
//   node scripts/pagebenchrun.mjs [--url http://localhost:5313] [--out data/bench/pagebench-desktop.json]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5313');
const out = opt('out', 'data/bench/pagebench-desktop-igpu.json');
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915', '--enable-features=WebGPUDeveloperFeatures'],
  defaultViewport: { width: 412, height: 915, deviceScaleFactor: 2.6 },
  protocolTimeout: 1800000,
});
let failed = false;
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => {
    failed = true;
    console.log('pageerror', e.message);
  });
  p.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) console.log('console.error:', m.text().slice(0, 400));
  });
  await p.goto(`${url}/?pagebench=1`, { waitUntil: 'load' });
  await p.evaluate(() => localStorage.removeItem('reclaimed-pagebench'));
  await p.goto(`${url}/?pagebench=1`, { waitUntil: 'load' });
  await p.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Start'), { timeout: 60000 });
  await p.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Start').click());
  const t0 = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    let u = '';
    try {
      u = p.url();
    } catch {}
    if (u.includes('pagebench=done')) break;
    if (Date.now() - t0 > 30 * 60000) throw new Error('timed out');
  }
  await p.waitForFunction(() => document.querySelector('pre'), { timeout: 60000 });
  const s = await p.evaluate(() => JSON.parse(localStorage.getItem('reclaimed-pagebench')));
  const text = await p.evaluate(() => document.querySelector('pre').textContent);
  console.log(text);
  fs.mkdirSync('data/bench', { recursive: true });
  fs.writeFileSync(out, JSON.stringify(s, null, 1));
  console.log('saved', out, `(${((Date.now() - t0) / 60000).toFixed(1)} min)`);
} finally {
  await browser.close();
}
if (failed) process.exit(1);
