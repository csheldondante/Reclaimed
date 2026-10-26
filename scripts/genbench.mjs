// Round 80: what a streamed region costs to make — eight regions' columns made one after another (whole, not
// a tile a frame) in the atlas level, the GPU's time for each pass (the profiler) and the CPU's steps; at a
// road (12304, 5457) and a mesa (5040, 12672).  node scripts/genbench.mjs [--url http://localhost:5207]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const url = argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : 'http://localhost:5207';
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'],
  protocolTimeout: 600000,
});
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=low&perf=1&at=12304,5457`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  await new Promise((r) => setTimeout(r, 6000));
  const r = await p.evaluate(async () => {
    const R = window.reclaimed;
    const a = R.atlas;
    const prof = R.core.host.profiler;
    const out = {};
    for (const [name, x0, y0] of [['road', 12544, 5440], ['mesa', 4992, 12608]]) {
      prof.resetTotals?.();
      const t0 = performance.now();
      const ms = [];
      for (let k = 0; k < 8; k++) {
        const t = performance.now();
        await a.regionLand(x0 + (k % 4) * 64, y0 + Math.floor(k / 4) * 64, 64, 64);
        ms.push(+(performance.now() - t).toFixed(0));
      }
      // (a few frames for the profiler to resolve)
      await new Promise((res) => setTimeout(res, 800));
      const g = {};
      for (const [k2, v] of prof.passMs) if (k2.startsWith('atlas')) g[k2] = +v.toFixed(2);
      out[name] = { wallMsEach: ms, gpu: g, total: +(performance.now() - t0).toFixed(0) };
    }
    return out;
  });
  console.log(JSON.stringify(r));
} finally {
  await browser.close();
}
