// Round 90 (phonecam): what a wider streamed window costs to hold — the time to the level, the world's GPU
// buffers (their sizes summed, the largest), the JS heap, the adapter's binding limit — at each ?win=.
//   node scripts/rangeprobe.mjs [--url http://localhost:5283] [--wins 256,320,384] [--size 412x915] [--extra "&q=low"]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5283');
const wins = opt('wins', '256,320,384').split(',');
const [vw, vh] = opt('size', '412x915').split('x').map(Number);
const extra = opt('extra', '');
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-precise-memory-info', `--window-size=${vw},${vh}`],
  defaultViewport: { width: vw, height: vh, deviceScaleFactor: 2.6 },
  protocolTimeout: 600000,
});
try {
  for (const w of wins) {
    const p = await browser.newPage();
    p.on('pageerror', (e) => console.log('pageerror', e.message));
    const t0 = Date.now();
    await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=low&win=${w}${extra}`, { waitUntil: 'load' });
    await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
    const loadS = (Date.now() - t0) / 1000;
    await new Promise((r) => setTimeout(r, 8000));
    const r = await p.evaluate(() => {
      const R = window.reclaimed;
      const seen = new Set();
      const bufs = [];
      const walk = (o, path, depth) => {
        if (!o || typeof o !== 'object' || depth > 3) return;
        for (const k of Object.keys(o)) {
          const v = o[k];
          if (v instanceof GPUBuffer) {
            if (!seen.has(v)) {
              seen.add(v);
              bufs.push([`${path}.${k}`, v.size]);
            }
          } else if (v && typeof v === 'object' && !(v instanceof GPUDevice) && !ArrayBuffer.isView(v) && !(v instanceof HTMLElement)) walk(v, `${path}.${k}`, depth + 1);
        }
      };
      walk(R.world, 'world', 0);
      walk(R.renderer, 'renderer', 0);
      bufs.sort((a, b) => b[1] - a[1]);
      const mb = (n) => +(n / 2 ** 20).toFixed(1);
      return {
        dims: R.core.dims,
        gpuMB: mb(bufs.reduce((s, b) => s + b[1], 0)),
        largest: bufs.slice(0, 6).map(([k, v]) => `${k} ${mb(v)}`),
        heapMB: performance.memory ? mb(performance.memory.usedJSHeapSize) : null,
        maxBinding: mb(R.core.host.gpu.device.limits.maxStorageBufferBindingSize),
        maxBuffer: mb(R.core.host.gpu.device.limits.maxBufferSize),
      };
    });
    console.log(`WIN ${w} load ${loadS.toFixed(1)} s ${JSON.stringify(r)}`);
    await p.close();
  }
} finally {
  await browser.close();
}
