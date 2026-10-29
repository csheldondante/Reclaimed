// Round 112 (tilefix3): the hero's run on the phone as the user's phone has it — a saved world from an earlier session
// (worldsave on, a Chrome profile kept between launches: the store's IndexedDB), the window the user's (384), a Pixel's
// user agent. Each phase loads the page in the same profile, waits, logs every 5 s what the window draws round the hero
// (the field mesh's built chunks, the hybrid grid's, the tiles), shoots it, and (with --save) saves the world before
// closing. Run phase "save" on one build and "load" on another, on the same origin (same host and port) to test a world
// saved by an older build:
//   node scripts/herorepro.mjs --url http://localhost:5233 --profile C:/tmp/hero-profile --phase save --out a.png
//   node scripts/herorepro.mjs --url http://localhost:5233 --profile C:/tmp/hero-profile --phase load --out b.png
//   [--win 384] [--secs 60] [--screen phone|desktop] [--mode run|atlas] [--extra "&x=1"]
// Exits 1 when, at the end, the window draws under half its chunks or a page error came.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5233');
const profile = opt('profile', '');
const phase = opt('phase', 'load');
const out = opt('out', `hero-${phase}.png`);
const win = opt('win', '384');
const secs = Number(opt('secs', 60));
const screen = opt('screen', 'phone');
const mode = opt('mode', 'run');
const extra = opt('extra', '');
const phone = screen === 'phone';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await puppeteer.launch({
  executablePath: opt('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'),
  headless: 'new',
  userDataDir: profile || undefined,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', phone ? '--window-size=412,915' : '--window-size=1600,900'],
  defaultViewport: phone ? { width: 412, height: 915, deviceScaleFactor: 2.6, hasTouch: true, isMobile: true } : { width: 1600, height: 900, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
let bad = false;
let last = null;
try {
  const p = await b.newPage();
  if (phone) await p.setUserAgent('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36');
  const log = [];
  p.on('pageerror', (e) => {
    bad = true;
    log.push(`pageerror ${e.message}`);
  });
  p.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !/Failed to load resource/.test(t)) log.push(`error ${t.slice(0, 300)}`);
    else if (/worldsave|\[run\]|restored|warp|mismatch/i.test(t)) log.push(`${m.type()} ${t.slice(0, 300)}`);
  });
  const u = `${url}/?skipmenu=1&level=atlas&tutorial=0${mode === 'run' ? '&run=bell' : ''}${win ? `&win=${win}` : ''}${phone ? '&q=low' : ''}${extra}`;
  console.log(u);
  await p.goto(u, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  for (let t = 0; t < secs; t += 5) {
    await sleep(5000);
    last = await p.evaluate(() => {
      const R = window.reclaimed;
      const S = R.stream;
      const TL = R.renderer.tiles;
      const fm = TL?.host?.win?.mesh;
      const [nx, ny] = fm?.chunkGrid ?? [0, 0];
      const grid = TL?.host?.gridOn?.();
      let built = 0;
      let gridN = 0;
      for (let i = 0; i < nx * ny; i++) {
        if (fm?.built[i]) built++;
        else if (grid && grid[i]) gridN++;
      }
      const H = R.scene.hybrid;
      return { t: Math.round(performance.now() / 1000), win: [S.W, S.H], origin: [...S.origin], oz: S.oz, busy: S.busy, chunks: nx * ny, built, grid: gridN, mirror: fm ? [fm.builtSlides, fm.slides] : null, hybrid: H?.stats ?? null, target: R.camera.target.map((v) => Math.round(v)), zoom: +R.camera.zoom.toFixed(2), tiles: TL ? { drawn: TL.stats.drawn, used: TL.stats.used, slots: TL.stats.slots } : null, stream: { restored: S.stats.restored, loaded: S.stats.loaded, mismatched: S.stats.mismatched, loadFailed: S.stats.loadFailed, generated: S.stats.generated, store: S.store?.size ?? null } };
    });
    console.log(JSON.stringify(last));
  }
  await p.screenshot({ path: out });
  if (phase === 'save') {
    await p.evaluate(async () => { const S = window.reclaimed.stream; S.touch(0, 0, S.W, S.H); await S.saveAll(); return S.store?.size; }).then((n) => console.log('store', n));
    console.log('saved');
  }
  for (const l of log.slice(0, 30)) console.log(l);
} finally {
  await b.close();
}
const drawn = last ? (last.built + last.grid) / Math.max(1, last.chunks) : 0;
console.log(`window drawn: ${(drawn * 100).toFixed(0)}% of its chunks`);
if (bad || drawn < 0.5) process.exit(1);
void fs;
