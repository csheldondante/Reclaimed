// The coarse world at the world's scale (round 71): in the viewer, a few meteors and an eruption,
// the coarse world run on, a picture before and after.
//   node scripts/coarseview.mjs [--url http://localhost:5203] [--out coarseview]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5203');
const out = opt('out', 'coarseview');
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1200,800'],
  defaultViewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
  protocolTimeout: 300000,
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`${url}/?atlas=view`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.atlas, { timeout: 180000 });
  // a temperate land region, framed ~3000 world units across
  const c = await page.evaluate(() => {
    const R = window.reclaimed;
    const a = R.atlas;
    const d = a.defs.find((d) => d.kind === 'plains' && d.stat.area > 600 && Math.abs(d.stat.cy - 0.35) < 0.08) ?? a.defs.find((d) => d.stat.land && d.stat.area > 600);
    const x = d.stat.cx * a.worldW;
    const y = d.stat.cy * a.worldH;
    R.view.vc = [x, y];
    R.view.scale = 3000 / 1200;
    return [x, y];
  });
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: `${out}-0.png` });
  await page.evaluate(([x, y]) => {
    const C = window.reclaimed.atlas.coarse;
    C.meteor(x + 150, y - 150, 300);
    C.meteor(x + 800, y + 350, 160);
    C.meteor(x + 1000, y - 600, 90);
  }, c);
  await new Promise((r) => setTimeout(r, 3000));
  await page.screenshot({ path: `${out}-1.png` });
  // then an eruption to the south-west: its cone, ash downwind (north-east), its lava running
  await page.evaluate(([x, y]) => window.reclaimed.atlas.coarse.erupt(x - 300, y + 600, { wind: [1, -0.6], ash: 1.5, ashR: 450, steps: 900 }), c);
  await new Promise((r) => setTimeout(r, 12000));
  await page.screenshot({ path: `${out}-2.png` });
  console.log(JSON.stringify(await page.evaluate(() => ({ steps: window.reclaimed.atlas.coarse.steps }))));
} finally {
  await browser.close();
}
