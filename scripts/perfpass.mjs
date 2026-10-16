// GPU time per pass (timestamp queries, ?perf=1), averaged over a few
// seconds, for comparing builds — e.g. the hex grid against the square one
// (docs/GRIDS.md: measure at each step).
//
//   node scripts/perfpass.mjs --url http://localhost:5177 [--wait 15000] [--seconds 5] [--zoom z]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5173');
const wait = Number(opt('wait', 15000));
const seconds = Number(opt('seconds', 5));
const zoom = opt('zoom');
const browser = await puppeteer.launch({
  executablePath: opt('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'),
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1600,900'],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 },
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${url}/?skipmenu=1&tutorial=0&perf=1${opt("extra", "")}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.core, { timeout: 90000 });
  await new Promise((r) => setTimeout(r, wait));
  const r = await page.evaluate(async (secs, z) => {
    const R = window.reclaimed;
    if (z) R.camera.zoom = Number(z);
    const prof = R.core.host.profiler;
    const sum = new Map();
    let n = 0;
    const t0 = performance.now();
    let frames = 0;
    while (performance.now() - t0 < secs * 1000) {
      await new Promise((res) => requestAnimationFrame(res));
      frames++;
      for (const [k, v] of prof.passMs) sum.set(k, (sum.get(k) ?? 0) + v);
      n++;
    }
    const avg = [...sum].map(([k, v]) => [k, v / n]).sort((a, b) => b[1] - a[1]);
    return { fps: frames / secs, avg };
  }, seconds, zoom);
  console.log(`${url}: ${r.fps.toFixed(1)} fps`);
  let total = 0;
  for (const [k, v] of r.avg) {
    total += v;
    console.log(`  ${k.padEnd(22)} ${v.toFixed(3)} ms`);
  }
  console.log(`  ${'total'.padEnd(22)} ${total.toFixed(3)} ms`);
  if (errors.length) console.log('page errors:', errors);
} finally {
  await browser.close();
}
