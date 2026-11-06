// (round 128o, DA-B27) The phone's fast pan at zoom 8 as tilegate runs it (412x915 dpr 2.6, the Pixel UA, frames held to
// 60 Hz, q=low, the gate's spot, 160 c/s back and forth over 400 cells, the tiles' fill rate pinned: --tilerate), and per
// frame each region the coverage check finds undrawn: in the window or past it, what the window draws there, its place
// in the tiles' wanted list, its tile state (TileCache.whyMissing), and when each state began. A dev server of your own:
//   node scripts/fastpanprobe.mjs --url http://127.0.0.1:PORT [--tilerate 0.11]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', '');
const rate = opt('tilerate', '0.154');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit'],
  protocolTimeout: 900000,
});
try {
  const p = await browser.newPage();
  await p.setViewport({ width: 412, height: 915, deviceScaleFactor: 2.6, hasTouch: true, isMobile: true });
  await p.setUserAgent('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36');
  await p.evaluateOnNewDocument((hz) => {
    const raf = window.requestAnimationFrame.bind(window);
    const period = 1000 / hz;
    let next = 0;
    let queue = [];
    let armed = false;
    const tick = (t) => {
      if (t + 1 < next) {
        raf(tick);
        return;
      }
      next = t + period - 1;
      armed = false;
      const q = queue;
      queue = [];
      for (const e of q) e.f(t);
    };
    let ids = 0;
    window.requestAnimationFrame = (f) => {
      queue.push({ id: ++ids, f });
      if (!armed) {
        armed = true;
        raf(tick);
      }
      return ids;
    };
  }, 60);
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  await p.goto(`${url}/?bgcheck=1&skipmenu=1&level=atlas&tutorial=0&worldsave=0&world=tilegate&at=15024,14337&tod=0.42&day=100000&season=0.3&hitch=1&hitchhud=0&q=low&tilerate=${rate}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.__boot?.at['level-ready'] && window.reclaimed?.stream && window.reclaimed?.scene, { timeout: 240000, polling: 250 });
  await sleep(35000);
  const r = await p.evaluate(async () => {
    const R = window.reclaimed;
    const c = R.camera;
    const TL = R.renderer.tiles;
    const S = R.stream;
    const RG = 64;
    const ROW = Math.sqrt(3) / 2;
    c.zoom = 8;
    for (let i = 0; i < 180; i++) await new Promise((r) => requestAnimationFrame(r));
    const [ux, uy] = c.screenDeltaToWorld(0, -1);
    const l = Math.hypot(ux, uy) || 1;
    const dir = [ux / l, uy / l];
    const here = () => [S.origin[0] + c.target[0], S.origin[1] * ROW + c.target[1]];
    const home = here();
    R.scene.pan = { speed: 160, dir: [...dir], t: 0, turnAt: 0, turnBy: 0, turned: 0, asked: 0 };
    let sign = 1;
    const tl = new Map();
    const log = [];
    const t0 = performance.now();
    let f = 0;
    while (performance.now() - t0 < 3000 + 20000 * 0) {
      await new Promise((r) => requestAnimationFrame(r));
      f++;
      const h = here();
      const off = (h[0] - home[0]) * dir[0] + (h[1] - home[1]) * dir[1];
      if (off > 400 && sign > 0) sign = -1;
      else if (off < 0 && sign < 0) sign = 1;
      R.scene.pan.dir = [dir[0] * sign, dir[1] * sign];
      const gc = TL.coverCheck(c);
      const und = gc ? gc.undrawn.filter((u) => u.startsWith('r')) : [];
      // (each region seen undrawn, and the three the gate keeps finding)
      const watch = new Set([...und, 'r226,216', 'r227,215', 'r228,216', 'r227,217', 'r226,215', 'r228,215']);
      for (const k of watch) {
        const [rx, ry] = k.slice(1).split(',').map(Number);
        const x = rx * RG - TL.origin[0] + RG / 2;
        const y = ry * RG - TL.origin[1] + RG / 2;
        const st = TL.whyMissing(x, y, c.azimuth);
        const rec = tl.get(k) ?? { states: [], undrawn: 0 };
        const lastS = rec.states[rec.states.length - 1];
        if (!lastS || lastS[1] !== st) rec.states.push([f, st]);
        if (und.includes(k)) rec.undrawn++;
        tl.set(k, rec);
      }
      // (each undrawn region: in the window or past it, what the window says it draws there, its place in the wanted list)
      const order = TL.wanted(c, () => false, 32).map((w) => `r${w.rx},${w.ry}`);
      const wd = TL.host.windowDrawn();
      const [mnx, mny, mside] = TL.host.win.mesh.chunkGrid;
      const info = und.map((k) => {
        const [rx, ry] = k.slice(1).split(',').map(Number);
        const x = rx * RG - TL.origin[0] + RG / 2;
        const y = ry * RG - TL.origin[1] + RG / 2;
        const inWin = x >= 0 && x < S.W && y >= 0 && y < S.H;
        const v = inWin ? wd[Math.min(mny - 1, Math.floor(y / mside)) * mnx + Math.min(mnx - 1, Math.floor(x / mside))] : -1;
        const [mx, my] = TL.motion;
        const ml = Math.hypot(mx, my) || 1;
        const along = Math.round(((x - c.target[0]) * mx + (y * ROW - c.target[1]) * my) / ml);
        return `${k} win${inWin ? 1 : 0} wd${v} ord${order.indexOf(k)} ${TL.whyMissing(x, y, c.azimuth)} along${along} side${Math.round(Math.hypot(x - c.target[0], y * ROW - c.target[1]))}`;
      });
      log.push([f, sign, Math.round(off), `org ${S.origin.join(',')} cam ${c.target.map((v) => Math.round(v)).join(',')} mot ${TL.motion.map((v) => Math.round(v)).join(',')}`, info.join(' | '), gc ? +gc.share.toFixed(4) : null, +c.zoom.toFixed(2), +c.zoomFloor.toFixed(2), order.length]);
    }
    R.scene.pan = null;
    return { regions: Object.fromEntries([...tl].filter(([, v]) => v.undrawn > 0 || v.states.length > 1)), undrawnFrames: log.filter((x) => x[4]).length, undrawnShare: +log.reduce((a, x) => a + (x[5] ?? 0), 0).toFixed(4), worstShare: Math.max(...log.map((x) => x[5] ?? 0)), frames: log.filter((x) => x[4]).slice(0, 40), floor: c.zoomFloor, origin: [...S.origin], W: S.W, total: f };
  });
  console.log(JSON.stringify(r, null, 1));
} finally {
  await browser.close();
}
