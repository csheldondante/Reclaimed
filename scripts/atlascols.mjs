// Times atlas column batches at a world cell (round 69): node scripts/atlascols.mjs "<query>" x,y [size]
import puppeteer from 'puppeteer-core';
const q = process.argv[2] ?? '';
const [x, y] = (process.argv[3] ?? '0,0').split(',').map(Number);
const size = Number(process.argv[4] ?? 64);
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'],
  protocolTimeout: 300000,
});
try {
  const page = await browser.newPage();
  page.on('console', (m) => m.type() === 'error' && console.log('console', m.text().slice(0, 300)));
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`http://localhost:5203/?atlas=view&${q}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.atlas, { timeout: 180000 });
  const r = await page.evaluate(async (x, y, size) => {
    const a = window.reclaimed.atlas;
    const out = [];
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      const c = await a.columns(x - size / 2, y - size / 2, size, size);
      let maxRuns = 0;
      for (let i = 0; i < size * size; i++) maxRuns = Math.max(maxRuns, c.u[i * 12 + 9]);
      out.push({ ms: +(performance.now() - t0).toFixed(1), forms: c.forms, maxRuns, kind: a.regionAt(x, y * 0.866).kind });
    }
    return out;
  }, x, y, size);
  console.log(JSON.stringify(r));
} finally {
  await browser.close();
}
