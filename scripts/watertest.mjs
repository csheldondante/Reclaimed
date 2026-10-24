// Thin water, flows and shores (round 41): the camera on the patch of the
// map with the fastest thin water (--pick flow: under 0.3 deep, by its
// flow), the most thin water (thin: 0.015–0.15 deep) or the deepest (deep),
// screenshots there in prisms and the field mesh, wide and close, then a
// storm over it.
//
//   node scripts/watertest.mjs [--url http://localhost:5177] [--out water] [--pick flow|thin|deep]
//     [--only mesh|prisms] [--extra "&q=low"] [--level valley] [--storm 1] [--at x,y]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5177');
const out = opt('out', 'water');
const only = opt('only', '');
const extra = opt('extra', '');
const level = opt('level', 'valley');
const storm = opt('storm', '0') === '1';
const pick = opt('pick', 'flow');
const atArg = opt('at', '');
const browser = await puppeteer.launch({
  executablePath: opt('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'),
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1600,900'],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 },
  protocolTimeout: 10 * 60 * 1000,
});
let failed = false;
try {
  for (const mode of ['prisms', 'mesh']) {
    if (only && only !== mode) continue;
    const page = await browser.newPage();
    page.on('pageerror', (e) => {
      failed = true;
      console.log(mode, 'pageerror:', e.message);
    });
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('404')) {
        console.log(mode, 'console.error:', m.text().slice(0, 600));
        failed = true;
      }
    });
    await page.goto(`${url}/?skipmenu=1&level=${level}&tutorial=0&mode=free&tod=0.35${mode === 'mesh' ? '&mesh=1' : '&mesh=0'}${extra}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.reclaimed?.core, { timeout: 90000 });
    await new Promise((res) => setTimeout(res, 8000));
    const at = await page.evaluate(async (pick, mesh, atArg) => {
      const R = window.reclaimed;
      document.querySelectorAll('.hint, .toast').forEach((e) => e.remove());
      if (atArg) {
        const [x, y] = atArg.split(',').map(Number);
        R.camera.target[0] = x;
        R.camera.target[1] = y;
        return [x, y, 0];
      }
      const w = await R.core.readBuffer('water');
      const f = await R.core.readBuffer('renderFields');
      // (the flow's speed: renderfields stores its direction in x, w with the mesh)
      const flow = (i) => (mesh ? Math.hypot(f[i * 4], f[i * 4 + 3]) : f[i * 4 + 3]);
      const W = R.core.dims.w;
      const H = w.length / W;
      // thin water per 8×8 block; the best block
      const B = 8;
      const bw = Math.ceil(W / B);
      const score = new Float32Array(bw * Math.ceil(H / B));
      // (only where the camera may go: a story level keeps it over the reach)
      const lb = R.scene.director?.limits?.bounds ?? [-1e9, -1e9, 1e9, 1e9];
      for (let i = 0; i < w.length; i++) {
        const cx = (i % W) + 0.5 + 0.5 * ((i / W | 0) & 1);
        const cy = ((i / W | 0) + 0.5) * (Math.sqrt(3) / 2);
        if (cx < lb[0] + 6 || cx > lb[2] - 6 || cy < lb[1] + 6 || cy > lb[3] - 6) continue;
        let v = 0;
        if (pick === 'thin') v = w[i] > 0.015 && w[i] < 0.15 ? 1 : 0;
        else if (pick === 'deep') v = w[i];
        else v = w[i] > 0.012 && w[i] < 0.3 ? flow(i) : 0;
        score[Math.floor((i / W | 0) / B) * bw + Math.floor((i % W) / B)] += v;
      }
      let best = 0;
      let bi = 0;
      for (let i = 0; i < score.length; i++) if (score[i] > best) [best, bi] = [score[i], i];
      const x = (bi % bw) * B + B / 2;
      const y = Math.floor(bi / bw) * B + B / 2;
      const wx = x + 0.5 + 0.5 * (y & 1);
      const wy = (y + 0.5) * (Math.sqrt(3) / 2);
      R.camera.target[0] = wx;
      R.camera.target[1] = wy;
      return [wx, wy, best];
    }, pick, mode === 'mesh', atArg);
    console.log(mode, pick, 'water at', at.map((v) => v.toFixed(1)).join(', '));
    const z0 = await page.evaluate(() => window.reclaimed.camera.zoom);
    for (const [name, zoom] of [
      ['wide', 1.6],
      ['close', 4],
      ['closer', 9],
    ]) {
      await page.evaluate((z) => (window.reclaimed.camera.zoom = z), z0 * zoom);
      await new Promise((res) => setTimeout(res, 1500));
      await page.screenshot({ path: `${out}-${mode}-${name}.png` });
    }
    if (storm) {
      await page.evaluate((at) => window.reclaimed.weather.spawn(at[0], at[1]), at);
      await new Promise((res) => setTimeout(res, 14000));
      await page.screenshot({ path: `${out}-${mode}-storm.png` });
    }
    await page.close();
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
