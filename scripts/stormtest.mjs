// A storm over the water (G13 h): Dam Valley, the camera on its deepest
// water, a storm spawned over it; what each frame costs while it rains
// (GPU passes, the field mesh's rebuilds), and screenshots of the water
// before and during. Prisms and the field mesh, one after the other.
//
//   node scripts/stormtest.mjs [--url http://localhost:5177] [--out storm] [--seconds 12]
//     [--only mesh|prisms] [--extra "&q=low"] [--level valley]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5177');
const out = opt('out', 'storm');
const seconds = Number(opt('seconds', 12));
const only = opt('only', '');
const extra = opt('extra', '');
const level = opt('level', 'valley');
const browser = await puppeteer.launch({
  executablePath: opt('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'),
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1600,900'],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 },
  protocolTimeout: 10 * 60 * 1000,
});
let failed = false;
let errs = 0;
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
        if (!failed || errs++ < 4) console.log(mode, 'console.error:', m.text().slice(0, 600));
        failed = true;
      }
    });
    await page.goto(`${url}/?skipmenu=1&level=${level}&tutorial=0&perf=1&tod=0.35${mode === 'mesh' ? '&mesh=1' : '&mesh=0'}${extra}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.reclaimed?.core, { timeout: 90000 });
    await new Promise((res) => setTimeout(res, 6000));
    // the camera on the deepest water
    const at = await page.evaluate(async () => {
      const R = window.reclaimed;
      document.querySelectorAll('.hint, .toast').forEach((e) => e.remove());
      const w = await R.core.readBuffer('water');
      const W = R.core.dims.w;
      let best = 0;
      let bi = 0;
      for (let i = 0; i < w.length; i++) if (w[i] > best) [best, bi] = [w[i], i];
      const x = bi % W;
      const y = Math.floor(bi / W);
      const wx = x + 0.5 + 0.5 * (y & 1);
      const wy = (y + 0.5) * (Math.sqrt(3) / 2);
      R.camera.target[0] = wx;
      R.camera.target[1] = wy;
      R.camera.zoom *= 2.2;
      return [wx, wy, best];
    });
    await new Promise((res) => setTimeout(res, 2000));
    await page.screenshot({ path: `${out}-${mode}-calm.png` });
    const measure = (secs) =>
      page.evaluate(async (secs) => {
        const R = window.reclaimed;
        const prof = R.core.host.profiler;
        const sum = new Map();
        let n = 0;
        let changed = 0;
        const t0 = performance.now();
        while (performance.now() - t0 < secs * 1000) {
          await new Promise((r) => requestAnimationFrame(r));
          for (const [k, v] of prof.passMs) sum.set(k, (sum.get(k) ?? 0) + v);
          changed += R.renderer.fieldMesh.stats.changed;
          n++;
        }
        const avg = [...sum].map(([k, v]) => [k, v / n]);
        const total = avg.reduce((a, [, v]) => a + v, 0);
        return { fps: n / secs, avg, total, changed: changed / n };
      }, secs);
    const calm = await measure(4);
    await page.evaluate((at) => window.reclaimed.weather.spawn(at[0], at[1]), at);
    await new Promise((res) => setTimeout(res, 3000));
    const storm = await measure(seconds);
    await page.screenshot({ path: `${out}-${mode}-storm.png` });
    for (const [label, r] of [
      ['calm', calm],
      ['storm', storm],
    ]) {
      const pick = (k) => (r.avg.find((a) => a[0] === k)?.[1] ?? 0).toFixed(2);
      const mesh = r.avg.filter(([k]) => k.startsWith('fieldmesh')).reduce((a, [, v]) => a + v, 0);
      console.log(
        `${mode} ${label}: ${r.fps.toFixed(0)} fps  all GPU ${r.total.toFixed(2)} ms  draw ${pick('draw')}  field mesh ${mesh.toFixed(2)} (${r.changed.toFixed(1)} chunks changed)  water ${pick('water-flux')}+${pick('water-depth')}  sediment ${pick('sediment')}+${pick('sediment-out')}`,
      );
    }
    await page.close();
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
