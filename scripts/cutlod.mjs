// Round 83: the rings and the cuts — the atlas level zoomed out with the camera by the window's near edge
// (the land past it on the eye's side kept under the focus: far.wgsl underFocus), then a hole kept round the
// focus (a stand-in character: the level's cutFeet, Dither) and a slice over it, the rings cut as the
// window's ground is.
//   node scripts/cutlod.mjs [--url http://localhost:5207] [--out C:/Projects/shots78/cutlod] [--zoom 2]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5207');
const out = opt('out', 'C:/Projects/shots78/cutlod');
const zoom = Number(opt('zoom', 2));
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
  await p.goto(`${url}/?skipmenu=1&tutorial=0&q=high&level=atlas&cutaway=1`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  await sleep(15000);
  await p.evaluate((z) => {
    const R = window.reclaimed;
    R.stream.auto = false;
    const { w, h } = R.core.dims;
    R.camera.target = [w * 0.9, h * 0.866 * 0.9, R.camera.target[2]];
    R.camera.zoom = z;
  }, zoom);
  await sleep(5000);
  await p.screenshot({ path: `${out}-near.png` });
  // a hole forced round a point under the focus (as a character hidden would open one), wide: the rings in
  // it are dithered out as the window's ground is
  await p.evaluate(() => {
    const R = window.reclaimed;
    const c = R.scene.cutaway;
    c.dither.update = () => {
      const t = R.camera.target;
      R.camera.cut.see = [[t[0], t[1], t[2] - 20, 260]];
    };
  });
  await sleep(2000);
  await p.screenshot({ path: `${out}-hole.png` });
  // a slice forced under the focus: the rings over it cut too
  await p.evaluate(() => {
    const R = window.reclaimed;
    const c = R.scene.cutaway;
    c.dither.update = () => (R.camera.cut.see = []);
    c.slice.update = () => (R.camera.cut.slice = R.camera.target[2] - 10);
  });
  await sleep(2000);
  await p.screenshot({ path: `${out}-slice.png` });
} finally {
  await browser.close();
}
