// Round 83: land just come in, before its mesh is built — the atlas level, a slide forced toward the camera's
// view (the window held otherwise), shots right after it and when its chunks are made. The rings fill what
// isn't built yet (far.wgsl meshBuilt): before, a hole.
//   node scripts/slideshot.mjs [--url http://localhost:5207] [--out C:/Projects/shots78/slide] [--extra "&slots=1"]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5207');
const out = opt('out', 'C:/Projects/shots78/slide');
const extra = opt('extra', '&slots=1');
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
  // (the camera by the window's far x edge, looking at it; the window slid one region that way)
  await p.evaluate(() => {
    const R = window.reclaimed;
    R.stream.auto = false;
    const { w, h } = R.core.dims;
    R.camera.target = [w * 0.15, h * 0.866 * 0.5, R.camera.target[2]];
    R.camera.zoom = 2.5;
  });
  await sleep(4000);
  const t0 = await p.evaluate(async () => {
    const R = window.reclaimed;
    await R.stream.slide(-(R.stream.R ?? 64), 0);
    return performance.now();
  });
  for (const ms of [50, 400, 3000]) {
    const now = await p.evaluate(() => performance.now());
    await sleep(Math.max(0, ms - (now - t0)));
    await p.screenshot({ path: `${out}-${ms}.png` });
  }
} finally {
  await browser.close();
}
