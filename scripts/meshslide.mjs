// The field mesh through a slide (round 73): the chunks found changed in the frames after a slide
// (only the strip that came in should be), and a picture a few frames after it.
//   node scripts/meshslide.mjs [--url http://localhost:5203] [--at x,y] [--out meshslide]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5203');
const at = opt('at', '14629,9916');
const out = opt('out', 'meshslide');
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
  page.on('console', (m) => m.type() === 'error' && console.log('console', m.text().slice(0, 300)));
  await page.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=high&at=${at}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  await new Promise((r) => setTimeout(r, 6000));
  await page.evaluate(() => (document.getElementById('ui').style.visibility = 'hidden'));
  for (const [k, d] of [['x', [64, 0]], ['y', [0, 64]], ['z', null]]) {
    const r = await page.evaluate(async (d) => {
      const R = window.reclaimed;
      const S = R.stream;
      S.auto = false;
      const fm = R.renderer.fieldMesh;
      const frames = async (n) => {
        let most = 0;
        for (let i = 0; i < n; i++) {
          await new Promise((res) => requestAnimationFrame(res));
          most = Math.max(most, fm.stats.changed);
        }
        return most;
      };
      const before = await frames(20);
      if (d) await S.slide(d[0], d[1]);
      else await S.slideZ(32);
      const after = await frames(4);
      return { before, after, chunks: fm.nx * fm.ny };
    }, d);
    await page.screenshot({ path: `${out}-${k}.png` });
    console.log(k, JSON.stringify(r));
  }
} finally {
  await browser.close();
}
