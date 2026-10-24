// A probe of the atlas level (round 67): loads it, runs a page expression, screenshots.
//   node scripts/atlasprobe.mjs [--url ...] [--q "at=1000,2000"] [--eval "js returning JSON"] [--wait ms] [--out probe.png]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5203');
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
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && console.log(m.type(), m.text().slice(0, 800)));
  await page.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&tod=0.4&q=high&${opt('q', '')}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  await new Promise((r) => setTimeout(r, Number(opt('wait', 4000))));
  const r = await page.evaluate(`(async () => { ${opt('eval', 'return null')} })()`);
  console.log(JSON.stringify(r));
  await page.screenshot({ path: opt('out', 'probe.png') });
} finally {
  await browser.close();
}
