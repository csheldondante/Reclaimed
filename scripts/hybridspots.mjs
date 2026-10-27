// Spots to look at the hybrid renderer (?hybrid=1) in: a mesa's rim, a giant, a tunnel, a bridge, a site (ruins),
// in temperate places — each as the level's ?at= cell. Prints JSON.
//   node scripts/hybridspots.mjs [--url http://localhost:5235]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const i = argv.indexOf('--url');
const url = i >= 0 ? argv[i + 1] : 'http://localhost:5235';
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'],
  protocolTimeout: 600000,
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`${url}/?atlas=view&overlay=0`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.atlas, { timeout: 180000 });
  const spots = await page.evaluate(() => {
    const a = window.reclaimed.atlas;
    const warm = (y) => 0.5 - 0.5 * Math.cos((2 * Math.PI * y) / a.worldH);
    const ok = (y) => warm(y) > 0.55 && warm(y) < 0.95;
    const cell = (x, y) => [Math.floor(x), Math.floor(y / 0.866)];
    const out = {};
    const sites = a.settlement.sites;
    const mesa = sites.find((s) => s.setting === 0 && warm(s.y) > 0.72 && warm(s.y) < 0.95);
    if (mesa) out.mesa = cell(mesa.x, mesa.y);
    const ruin = sites.find((s) => s.setting !== 0 && ok(s.y));
    if (ruin) out.ruin = cell(ruin.x, ruin.y);
    const G = a.giants;
    for (let k = 0; k < G.length; k += 8) if (ok(G[k + 1]) && !out.giant) out.giant = cell(G[k], G[k + 1]);
    const names = ['road', 'tunnel', 'bridge', 'switchbacks', 'lift', 'plaza'];
    for (const p of a.ways.points) {
      const k = names[p.kind];
      if ((k === 'tunnel' || k === 'bridge') && ok(p.y) && !out[k]) out[k] = cell(p.x, p.y);
    }
    return out;
  });
  console.log(JSON.stringify(spots));
} finally {
  await browser.close();
}
