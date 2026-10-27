// Round 93 (winmem): what the streamed window holds in GPU memory, buffer by buffer, and what of it is used —
// the field mesh's chunks built and its page pool (?meshpool=0 off), the instance lists' counts against their room.
// One page per variant (each its own query string after the level's), the level settled for --wait ms, then a
// pan of --pan ms (WASD, so slides happen) and the numbers again.
//   node scripts/memprobe.mjs [--url http://localhost:5265] [--win 320] [--size 412x915] [--wait 40000]
//     [--pan 8000] [--variants "&meshpool=0&instgrow=0|"] [--at 11956,15471]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5265');
const win = opt('win', '320');
const [vw, vh] = opt('size', '412x915').split('x').map(Number);
const wait = Number(opt('wait', 40000));
const pan = Number(opt('pan', 8000));
const at = opt('at', '11956,15471');
const variants = opt('variants', '&meshpool=0&instgrow=0|').split('|');
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-precise-memory-info', `--window-size=${vw},${vh}`],
  defaultViewport: { width: vw, height: vh, deviceScaleFactor: 2.6 },
  protocolTimeout: 600000,
});
const measure = () => {
  const R = window.reclaimed;
  const seen = new Set();
  const bufs = new Map();
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 4) return;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (v instanceof GPUBuffer) {
        if (!seen.has(v)) {
          seen.add(v);
          bufs.set(v.label || k, (bufs.get(v.label || k) ?? 0) + v.size);
        }
      } else if (v && typeof v === 'object' && !(v instanceof GPUDevice) && !ArrayBuffer.isView(v) && !(v instanceof HTMLElement) && !(v instanceof Map)) walk(v, depth + 1);
    }
  };
  walk(R.world, 0);
  walk(R.renderer, 0);
  const mb = (n) => +(n / 2 ** 20).toFixed(2);
  const all = [...bufs].sort((a, b) => b[1] - a[1]);
  const fm = R.renderer.fieldMesh;
  const band = R.renderer.band?.mesh;
  return {
    dims: R.core.dims,
    gpuMB: mb(all.reduce((s, b) => s + b[1], 0)),
    largestMB: mb(all[0][1]),
    bufs: Object.fromEntries(all.filter(([, v]) => v >= 2 ** 18).map(([k, v]) => [k, mb(v)])),
    mesh: { stats: fm.stats, pool: fm.poolStats, wanted: fm.wantedCount, drawn: fm.drawn, grid: fm.chunkGrid },
    band: band ? { stats: band.stats, pool: band.poolStats, drawn: band.drawn } : null,
    inst: R.renderer.instanceCounts,
    room: { opaque: R.renderer.opaqueCapacity, cols: R.core.dims.w * R.core.dims.h },
    slides: R.stream?.stats.slides,
  };
};
try {
  for (const v of variants) {
    const p = await browser.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    p.on('console', (m) => {
      const t = m.text();
      if (/error|invalid|validation/i.test(t)) errs.push(t.slice(0, 300));
    });
    await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=low&win=${win}&at=${at}&perf=1${v}`, { waitUntil: 'load' });
    await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
    await new Promise((r) => setTimeout(r, wait));
    const a = await p.evaluate(measure);
    console.log(`VARIANT ${v} settled ${JSON.stringify(a)}`);
    if (pan > 0) {
      await p.keyboard.down('d');
      await new Promise((r) => setTimeout(r, pan));
      await p.keyboard.up('d');
      await p.keyboard.down('w');
      await new Promise((r) => setTimeout(r, pan));
      await p.keyboard.up('w');
      await new Promise((r) => setTimeout(r, 4000));
      const b = await p.evaluate(measure);
      console.log(`VARIANT ${v} panned ${JSON.stringify(b)}`);
    }
    const fatal = await p.evaluate(() => document.body.innerText.match(/(GPU|WebGPU)[^\n]{0,200}(error|invalid)[^\n]{0,200}/i)?.[0] ?? null);
    console.log(`VARIANT ${v} errors ${JSON.stringify(errs.slice(0, 8))} fatal ${JSON.stringify(fatal)}`);
    await p.close();
  }
} finally {
  await browser.close();
}
