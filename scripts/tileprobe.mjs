// tile cache probe: ride (or park) at the phone tier, sample stats/coverage/fps each second, shots
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const url = opt('url', 'http://localhost:5299');
const extra = opt('extra', '&tiles=1');
const drive = opt('drive', '18');
const secs = Number(opt('seconds', 40));
const at = opt('at', '11956,15471');
const out = opt('out', '');
const win = opt('win', '320');
const turn = argv.includes('--turn');
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
  defaultViewport: { width: 412, height: 915, deviceScaleFactor: 2.6 },
  protocolTimeout: 600000,
});
try {
  const p = await browser.newPage();
  // (round 106, --throttle N: the CPU N times slower — Chrome's emulation: a phone's main thread)
  const thr = Number(opt('throttle', 0));
  if (thr > 1) {
    const cdp = await p.createCDPSession();
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: thr });
  }
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.text().slice(0, 400)); });
  const u = `${url}/?skipmenu=1&level=atlas&tutorial=0&q=low&perf=1${drive !== '0' ? `&drive=${drive}` : ''}&at=${at}&win=${win}${extra}`;
  console.log(u);
  await p.goto(u, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  await new Promise((r) => setTimeout(r, 30000));
  // (--zoom z: the camera's zoom, px a cell, set before the sampling; round 105)
  const zoom = Number(opt('zoom', 0));
  if (zoom) {
    await p.evaluate((z) => (window.reclaimed.camera.zoom = z), zoom);
    await new Promise((r) => setTimeout(r, Number(opt('settle', 15)) * 1000));
  }
  // (--pan v,s: the camera moved up the screen at v cells/s for s seconds, from the start of the sampling)
  const pan = opt('pan', '');
  if (pan) {
    const [v, ps] = pan.split(',').map(Number);
    await p.evaluate((v, ps) => {
      const c = window.reclaimed.camera;
      const t0 = performance.now();
      let last = t0;
      const step = () => {
        const now = performance.now();
        if (now - t0 > ps * 1000) return;
        const [dx, dy] = c.screenDeltaToWorld(0, -v * c.zoom * 0.5 * ((now - last) / 1000));
        c.target[0] += dx;
        c.target[1] += dy;
        last = now;
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }, v, ps);
  }
  const t0 = Date.now();
  let k = 0;
  while (Date.now() - t0 < secs * 1000) {
    const s = await p.evaluate(async () => {
      const R = window.reclaimed;
      const n0 = R.scene.frameMs?.length ?? 0;
      let f = 0;
      const t = performance.now();
      await new Promise((res) => { const g = () => { f++; if (performance.now() - t < 1000) requestAnimationFrame(g); else res(); }; requestAnimationFrame(g); });
      const T = R.renderer.tiles;
      const c = T ? T.coverage(R.camera) : null;
      // (round 105: the share in detail on the screen's leading and trailing halves, across the camera's motion; with no
      // tiles, the window's land alone — up the screen, the pan's way)
      const up = R.camera.screenDeltaToWorld(0, -100);
      const split = T?.coverageSplit ? T.coverageSplit(R.camera, up) : null;
      const L = T?.land ? { ...T.land.stats } : null;
      return { fps: f, tiles: T ? { ...T.stats } : null, land: L, cover: c, split, motion: T?.motion ? T.motion.map((v) => +v.toFixed(1)) : null, zoom: +R.camera.zoom.toFixed(2), az: +R.camera.azimuth.toFixed(3), slides: R.renderer.fieldMesh.slides, n0 };
    });
    console.log(JSON.stringify(s));
    if (out && k % 10 === 9) await p.screenshot({ path: `${out}-${k}.png` });
    if (turn && k === Math.floor(secs / 2)) await p.evaluate(() => window.reclaimed.scene.turn?.step(1));
    k++;
  }
  if (out) await p.screenshot({ path: `${out}-end.png` });
  // (round 105, tilelatency: each render-only region's way from wanted to drawn, stage by stage — p50 / p95 ms)
  const lat = await p.evaluate(() => {
    const L = window.reclaimed.renderer.tiles?.land?.latencies ?? [];
    const q = (a, f) => (a.length ? +a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * f))].toFixed(1) : null);
    const st = {
      queue: (t) => t.start - t.wanted,
      columns: (t) => (t.cols ? t.cols - t.start : null),
      stamps: (t) => (t.ways && t.cols ? t.ways - t.cols : null),
      finish: (t) => (t.mapped && t.ways ? t.mapped - t.ways : t.mapped - t.start),
      meta: (t) => t.ready - t.mapped,
      bakeQueue: (t) => t.cur - t.ready,
      meshBake: (t) => t.baked - t.cur,
      toDrawn: (t) => t.drawn - t.baked,
      total: (t) => t.drawn - t.wanted,
    };
    const o = { n: L.length };
    for (const [k, f] of Object.entries(st)) {
      const v = L.map(f).filter((x) => x !== null && Number.isFinite(x));
      o[k] = [q(v, 0.5), q(v, 0.95)];
    }
    return o;
  });
  console.log('LATENCY', JSON.stringify(lat));
  const fatal = await p.evaluate(() => document.querySelector('.fatal')?.textContent ?? null);
  console.log('fatal', fatal);
  console.log('errors', JSON.stringify(errs.slice(0, 20)));
} finally {
  await browser.close();
}
