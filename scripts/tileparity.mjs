// Tile parity shots (round 108, TC18-TC20): the window's land against the tiles past it — straight, turned, and in a
// cold storm's snow — at the phone tier with every system in play, as deployed.
//   node scripts/tileparity.mjs --url http://localhost:5373 --out C:/Projects/shots88/tileparity/before
//     [--at 11956,15471] [--win 256] [--zoom 1.3] [--snow 60] [--extra '&tiledebug=1'] [--size 412x915]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const url = opt('url', 'http://localhost:5373');
const out = opt('out', 'C:/Projects/shots88/tileparity/shot');
const at = opt('at', '11956,15471');
const win = opt('win', '256');
const zoom = Number(opt('zoom', 1.3));
const snowS = Number(opt('snow', 60));
const extra = opt('extra', '');
const [W, H] = opt('size', '412x915').split('x').map(Number);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${W},${H}`],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 2.6 },
  protocolTimeout: 600000,
});
const errs = [];
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 400)); });
  const u = `${url}/?skipmenu=1&level=atlas&tutorial=0&q=low&perf=1&at=${at}&win=${win}${extra}`;
  console.log(u);
  await p.goto(u, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  await wait(30000);
  await p.evaluate((z) => (window.reclaimed.camera.zoom = z), zoom);
  await wait(15000);
  // (the shots without the page's panels over them: only the canvas)
  const bare = () => p.evaluate(() => { for (const e of document.body.querySelectorAll('*')) if (e.tagName !== 'CANVAS' && !e.querySelector('canvas')) e.style.visibility = 'hidden'; });
  // (each shot twice: as it is, and the tiles tinted — TileCache.debug — to tell them from the window)
  const shot = async (name) => {
    await p.screenshot({ path: `${out}-${name}.png` });
    await p.evaluate(() => (window.reclaimed.renderer.tiles.debug = true));
    await wait(400);
    await p.screenshot({ path: `${out}-${name}-dbg.png` });
    await p.evaluate(() => (window.reclaimed.renderer.tiles.debug = false));
  };
  const stats = () => p.evaluate(() => {
    const T = window.reclaimed.renderer.tiles;
    return { tiles: T ? { ...T.stats } : null, land: T?.land ? { ...T.land.stats } : null, az: +window.reclaimed.camera.azimuth.toFixed(3) };
  });
  console.log('straight', JSON.stringify(await stats()));
  await bare();
  await shot('straight');
  // (--quick: that shot only — e.g. the rivers at another wetness: --extra '&riverwet=0.3')
  if (argv.includes('--quick')) throw Object.assign(new Error('quick'), { quick: true });
  await p.evaluate(() => window.reclaimed.scene.turn?.step(1));
  await wait(20000);
  console.log('turned', JSON.stringify(await stats()));
  await shot('turned');
  await p.evaluate(() => window.reclaimed.scene.turn?.step(-1));
  await wait(15000);
  // (closer: the window's land against the tiles at its edges, cell by cell — straight and turned)
  // (the camera not moved: off the window's middle the streamer slides the window after it)
  const edgeZoom = Number(opt('edgezoom', 2.2));
  const back = await p.evaluate((z) => {
    const R = window.reclaimed;
    const c = R.camera;
    const was = { t: [...c.target], z: c.zoom };
    c.zoom = z;
    return was;
  }, edgeZoom);
  await wait(12000);
  await shot('edge');
  await p.evaluate(() => window.reclaimed.scene.turn?.step(1));
  await wait(15000);
  await shot('edge-turned');
  await p.evaluate((was) => {
    const c = window.reclaimed.camera;
    window.reclaimed.scene.turn?.step(-1);
    c.target[0] = was.t[0];
    c.target[1] = was.t[1];
    c.zoom = was.z;
  }, back);
  await wait(12000);
  if (snowS > 0) {
    // (a cold storm over the window: snow falls on its land — the tiles past it should show what it lays and where)
    await p.evaluate(() => {
      const R = window.reclaimed;
      R.globals.climate = { temp: -8, lapse: 0 };
      const { w, h } = R.core.dims;
      for (const [fx, fy] of [[0.5, 0.5], [0.2, 0.3], [0.8, 0.7]]) R.weather.spawn(w * fx, h * fy * 0.866);
    });
    await wait(snowS * 1000);
    console.log('snow', JSON.stringify(await stats()));
    await shot('snow');
    await p.evaluate(() => window.reclaimed.scene.turn?.step(1));
    await wait(20000);
    await shot('snow-turned');
  }
  const fatal = await p.evaluate(() => document.querySelector('.fatal')?.textContent ?? null);
  console.log('fatal', fatal);
} catch (e) {
  if (!e.quick) throw e;
} finally {
  console.log('errors', JSON.stringify(errs.slice(0, 20)));
  await browser.close();
}
