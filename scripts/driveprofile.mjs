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
  // (perfopt, --uncapped: no vsync, frames as fast as the GPU goes — it stays busy, so its clocks stay up and a
  // pass's time is its work, not the power state's; the frame time is then the GPU's cost)
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${vw},${vh}`].concat(argv.includes('--uncapped') ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []),
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
    window.reclaimed.core.host.profiler.resetTotals();
    window.reclaimed.core.host.profiler.gpuLong.length = 0;
    s.longFrames = [];
    s.worstMs = 0;
    s.frameMs = [];
    if (s.hybrid) s.hybrid.totals = { frames: 0, voxel: 0, drawn: 0 };
    window.__all = [];
    window.__tick0 = window.reclaimed.core.sim.tick;
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
      gpuLong: R.core.host.profiler.gpuLong,
      drawMax: +(R.core.host.profiler.maxMs.get('draw') ?? 0).toFixed(1),
      // (perfopt: each pass's mean a frame over the ride, from the raw totals — the draw's with ?defer's G-buffer)
      perFrame: Object.fromEntries(['draw', 'gbuffer', 'tcache-g', 'tcache-r', 'shadow', 'shadow-static', 'renderprep'].map((k) => [k, +((R.core.host.profiler.totalMs.get(k) ?? 0) / Math.max(R.core.host.profiler.framesResolved, 1)).toFixed(2)]).concat([['gpu', +(R.core.host.profiler.gpuTotalMs / Math.max(R.core.host.profiler.framesResolved, 1)).toFixed(2)]])),
      // (perfopt: every pass's mean a frame over the ride, the largest first)
      ticks: R.core.sim.tick - window.__tick0,
      // (hybrid: the mean voxel chunks wanted and mesh chunks drawn a frame, of the grid's)
      hybrid: R.scene.hybrid ? { chunks: R.scene.hybrid.stats.chunks, voxel: +(R.scene.hybrid.totals.voxel / Math.max(1, R.scene.hybrid.totals.frames)).toFixed(1), drawn: +(R.scene.hybrid.totals.drawn / Math.max(1, R.scene.hybrid.totals.frames)).toFixed(1) } : { drawn: R.core.renderer.fieldMesh.drawn },
      allPerFrame: Object.fromEntries([...R.core.host.profiler.totalMs].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => [k, +(v / Math.max(R.core.host.profiler.framesResolved, 1)).toFixed(3)])),
      meshTotal: Object.fromEntries([...R.core.host.profiler.totalMs].filter(([k]) => k.includes('fieldmesh')).map(([k, v]) => [k, +v.toFixed(1)])),
      meshMax: Object.fromEntries([...R.core.host.profiler.maxMs].filter(([k]) => k.includes('fieldmesh')).map(([k, v]) => [k, +v.toFixed(2)])),
    };
  });
  console.log(JSON.stringify(r));
  console.log(`HYBRID ${JSON.stringify(r.hybrid)}`);
  console.log(`SUMMARY p50 ${r.p50} p95 ${r.p95} p99 ${r.p99} worst ${r.worst} h50 ${r.hitches50} | per frame: ${Object.entries(r.perFrame).map(([k, v]) => `${k} ${v}`).join(', ')} | meshTotal ${Object.values(r.meshTotal).reduce((a, b) => a + b, 0).toFixed(0)} ms | in renderprep units (the clocks drift): draw ${((r.perFrame.draw + r.perFrame.gbuffer + r.perFrame['tcache-g'] + r.perFrame['tcache-r']) / r.perFrame.renderprep).toFixed(2)}, shadow ${(r.perFrame.shadow / r.perFrame.renderprep).toFixed(2)}, mesh ${Object.entries(['hash', 'sample', 'verts', 'quads'].reduce((o, k) => ((o[k] = Object.entries(r.meshTotal).filter(([n]) => n.endsWith(k)).reduce((a, [, v]) => a + v, 0) / (r.perFrame.renderprep * r.frames)), o), {})).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(' ')}`);
} finally {
  await browser.close();
}
