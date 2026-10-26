// Round 83: the streamed window's edge (fieldmesh.ts openEdges) — the atlas level, the window held (no
// slides), the camera put by its far and near edges; a shot of each. Before: a wall down the window's edge
// (the mesh closed the map's edge), left in the chunks by the old edge after a slide.
//   node scripts/edgeshot.mjs [--url http://localhost:5207] [--out C:/Projects/shots78/edge] [--zoom 4]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5207');
const out = opt('out', 'C:/Projects/shots78/edge');
const zoom = Number(opt('zoom', 4));
const extra = opt('extra', '');
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1200,800'],
  defaultViewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  await p.goto(`${url}/?skipmenu=1&tutorial=0&q=high&level=atlas${extra}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  await sleep(15000);
  for (const [name, fx, fy] of [['far', 0.06, 0.5], ['near', 0.94, 0.5]]) {
    await p.evaluate(
      (fx, fy, z) => {
        const R = window.reclaimed;
        R.stream.auto = false;
        const { w, h } = R.core.dims;
        R.camera.target = [w * fx, h * 0.866 * fy, R.camera.target[2]];
        R.camera.zoom = z;
      },
      fx,
      fy,
      zoom,
    );
    await sleep(5000);
    await p.screenshot({ path: `${out}-${name}.png` });
  }
} finally {
  await browser.close();
}
