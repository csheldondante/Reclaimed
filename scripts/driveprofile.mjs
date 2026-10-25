// Round 79: riding through the atlas (?drive=speed: the camera along a road, zooming out with speed, the
// window streaming ahead) in a phone-shaped viewport — frame times (p50, p95, worst, hitches over 50 ms),
// the streamer's slides, and the GPU's passes. The phone itself: /places/?skipmenu=1&level=atlas&drive=18&perf=1.
//   node scripts/driveprofile.mjs [--url http://localhost:5207] [--speed 18] [--seconds 30] [--q low] [--at x,y]
//     [--size 412x915] [--dpr 2.6] [--extra "&skip=band"]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5207');
const speed = opt('speed', '18');
const seconds = Number(opt('seconds', 30));
const q = opt('q', 'low');
const at = opt('at', '');
const [vw, vh] = opt('size', '412x915').split('x').map(Number);
const dpr = Number(opt('dpr', '2.6'));
const extra = opt('extra', '');
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${vw},${vh}`],
  defaultViewport: { width: vw, height: vh, deviceScaleFactor: dpr },
  protocolTimeout: 600000,
});
try {
  let start = at;
  if (!start) {
    // (on a road: the longest in a temperate place, at its middle)
    const v = await browser.newPage();
    await v.goto(`${url}/?atlas=view&overlay=0`, { waitUntil: 'load' });
    await v.waitForFunction(() => window.reclaimed?.atlas, { timeout: 180000 });
    start = await v.evaluate(() => {
      const a = window.reclaimed.atlas;
      const warm = (y) => 0.5 - 0.5 * Math.cos((2 * Math.PI * y) / a.worldH);
      const r = a.settlement.roads.filter((r) => warm(r.path[1]) > 0.55).sort((x, y) => y.length - x.length)[0];
      const k = Math.floor(r.path.length / 4) * 2;
      return `${Math.floor(r.path[k])},${Math.floor(r.path[k + 1] / 0.866)}`;
    });
    await v.close();
  }
  console.log('at', start);
  const p = await browser.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=${q}&perf=1&drive=${speed}&at=${start}${extra}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  // (settled first: the first seconds build the mesh)
  await new Promise((r) => setTimeout(r, 5000));
  await p.evaluate(() => {
    const s = window.reclaimed.scene;
    s.hitches = 0;
    // (the main thread's steps from here on: startup's pipeline compiles aren't riding's)
    s.cpuReset?.();
    s.longFrames = [];
    s.worstMs = 0;
    s.frameMs = [];
    window.__all = [];
    const tick = () => {
      window.__all.push(performance.now());
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const r = await p.evaluate(() => {
    const R = window.reclaimed;
    const t = window.__all;
    const d = [];
    for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
    const f = [...d].sort((a, b) => a - b);
    const qq = (x) => +f[Math.min(f.length - 1, Math.floor(x * f.length))].toFixed(1);
    const pm = {};
    for (const [k, v] of R.core.host.profiler.passMs) pm[k] = +v.toFixed(2);
    return {
      frames: d.length,
      fps: +(d.length / ((t[t.length - 1] - t[0]) / 1000)).toFixed(1),
      p50: qq(0.5),
      p95: qq(0.95),
      p99: qq(0.99),
      worst: +f[f.length - 1].toFixed(0),
      hitches50: d.filter((x) => x > 50).length,
      hitches100: d.filter((x) => x > 100).length,
      stream: R.stream.stats,
      gpu: pm,
      gpuFrame: +R.core.host.profiler.gpuFrameMs.toFixed(2),
      cpu: R.scene.cpuWorst?.() ?? null,
      long: R.scene.longFrames,
    };
  });
  console.log(JSON.stringify(r));
} finally {
  await browser.close();
}
