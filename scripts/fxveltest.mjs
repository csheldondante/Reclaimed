// fx.burst's `vel` (round 58): a burst carried by its mover's velocity. Two
// dust bursts far apart, one still, one with vel [12, 0, 0]; reads the
// particles back and compares their mean velocity. Prints the measures.
//
//   node scripts/fxveltest.mjs [--url http://localhost:5185]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5185');
const browser = await puppeteer.launch({
  executablePath: opt('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'),
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1200,800'],
  defaultViewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
  protocolTimeout: 10 * 60 * 1000,
});
let failed = false;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => {
    failed = true;
    console.log('pageerror:', e.message);
  });
  await page.goto(`${url}/?skipmenu=1&level=sandbox&tutorial=0&tod=0.4${opt("extra", "")}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.api?.fx, { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 3000));
  const m = await page.evaluate(async () => {
    const R = window.reclaimed;
    const { cellPos } = await import('/src/world/lattice.ts');
    const { w, h } = R.core.dims;
    const A = cellPos(Math.floor(w / 2) - 30, Math.floor(h / 2));
    const B = cellPos(Math.floor(w / 2) + 30, Math.floor(h / 2));
    const z = (R.api.terrain.heightAt(A[0], A[1]) ?? 10) + 6;
    const zb = (R.api.terrain.heightAt(B[0], B[1]) ?? 10) + 6;
    R.api.fx.burst('dust', A[0], A[1], z, { count: 60 });
    R.api.fx.burst('dust', B[0], B[1], zb, { count: 60, vel: [12, 0, 0] });
    // (a few ticks: headless runs fewer ticks than frames)
    const t0 = R.sim.tick;
    while (R.sim.tick < t0 + 4) await new Promise((r) => requestAnimationFrame(r));
    const f = new Float32Array((await R.core.readBuffer('particles')).buffer);
    const near = (c) => {
      let n = 0;
      let vx = 0;
      for (let i = 0; i < f.length; i += 12) {
        if (f[i + 3] <= 0) continue;
        if (Math.hypot(f[i] - c[0], f[i + 1] - c[1]) > 6) continue;
        n++;
        vx += f[i + 4];
      }
      return { n, meanVx: +(vx / Math.max(n, 1)).toFixed(2) };
    };
    return { still: near(A), carried: near(B) };
  });
  const ok = m.still.n > 20 && m.carried.n > 20 && m.carried.meanVx - m.still.meanVx > 6;
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} vel carries the burst: ${JSON.stringify(m)}`);
} finally {
  await browser.close();
}
if (failed) process.exit(1);
