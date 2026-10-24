// Where a frame's GPU time goes (perf branch): for each variant (a fresh
// page: the level at a quality, maybe with ?skip= pieces of the frame left
// out), the GPU ms per FRAME of every pass (summed over every frame, so a
// pass that runs every 4th tick counts a quarter), fps and ticks a frame.
// A phone-shaped viewport by default.
//
//   node scripts/perfprofile.mjs [--url http://localhost:5189] [--q low] [--level valley]
//     [--size 412x915] [--dpr 2.6] [--wait 8000] [--seconds 6]
//     [--variants "base;shadow;water;particles"] [--eval js] [--extra "&mesh=1"]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5189');
const q = opt('q', 'low');
const level = opt('level', '');
const [vw, vh] = opt('size', '412x915').split('x').map(Number);
const dpr = Number(opt('dpr', '2.6'));
const waitMs = Number(opt('wait', 8000));
const seconds = Number(opt('seconds', 6));
const variants = opt('variants', 'base').split(';');
const evalJs = opt('eval');

const browser = await puppeteer.launch({
  executablePath: opt('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'),
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${vw},${vh}`],
  defaultViewport: { width: vw, height: vh, deviceScaleFactor: dpr },
  protocolTimeout: 10 * 60 * 1000,
});
const rows = [];
try {
  for (const v of variants) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const skip = v === 'base' ? '' : `&skip=${v}`;
    await page.goto(`${url}/?skipmenu=1&tutorial=0&perf=1&q=${q}${level ? `&level=${level}` : ''}${opt('extra', '')}${skip}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.reclaimed?.core, { timeout: 90000 });
    await new Promise((r) => setTimeout(r, waitMs));
    // (after the level has settled: its first resize sets the zoom)
    if (evalJs) {
      await page.evaluate(evalJs);
      await new Promise((r) => setTimeout(r, 2000));
    }
    const r = await page.evaluate(async (secs) => {
      const R = window.reclaimed;
      const prof = R.core.host.profiler;
      const t0Tick = R.sim.tick;
      prof.resetTotals();
      const t0 = performance.now();
      let frames = 0;
      while (performance.now() - t0 < secs * 1000) {
        await new Promise((res) => requestAnimationFrame(res));
        frames++;
      }
      const n = Math.max(prof.framesResolved, 1);
      const per = [...prof.totalMs].map(([k, ms]) => [k, ms / n]).sort((a, b) => b[1] - a[1]);
      const canvas = document.getElementById('world');
      return { zoom: +R.camera.zoom.toFixed(2), fps: frames / secs, ticksPerFrame: (R.sim.tick - t0Tick) / Math.max(frames, 1), per, sum: per.reduce((a, [, m]) => a + m, 0), px: [canvas.width, canvas.height] };
    }, seconds);
    rows.push({ v, ...r, errors });
    await page.close();
    console.log(`${v.padEnd(28)} ${r.fps.toFixed(1)} fps, ${r.ticksPerFrame.toFixed(2)} ticks/frame, GPU ${r.sum.toFixed(2)} ms/frame (${r.px.join('x')} px, zoom ${r.zoom})${errors.length ? ' ERRORS ' + errors.join(' | ') : ''}`);
  }
  const base = rows.find((r) => r.v === 'base');
  if (base) {
    console.log('\nbase, GPU ms per frame by pass:');
    for (const [k, ms] of base.per) if (ms > 0.01) console.log(`  ${k.padEnd(22)} ${ms.toFixed(3)}`);
    for (const r of rows) {
      if (r === base) continue;
      const d = (name) => (base.per.find(([k]) => k === name)?.[1] ?? 0) - (r.per.find(([k]) => k === name)?.[1] ?? 0);
      console.log(`without ${r.v.padEnd(20)} saves ${(base.sum - r.sum).toFixed(3)} ms/frame (draw ${d('draw').toFixed(3)}, shadow ${d('shadow').toFixed(3)}, renderprep ${d('renderprep').toFixed(3)})`);
    }
  }
} finally {
  await browser.close();
}
