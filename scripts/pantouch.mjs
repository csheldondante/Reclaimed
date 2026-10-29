// Round 112 (panfinger): the pan tool and the two-finger dead zone in the real page, with synthetic touches
// (CDP Input.dispatchTouchEvent) on a phone-sized touch screen (412x915, every system as deployed).
//   node scripts/pantouch.mjs --url http://localhost:5231/?skipmenu=1&level=playground&tutorial=0 [--out dir] [--wait 30000]
// Checks: the pan tool is selected first on a touch screen; a one-finger drag held still then lifted moves the
// view by exactly the finger's motion; a flick coasts on after the lift; a two-finger pan with jitter doesn't
// zoom; a clear pinch does (fingers kept left of the editor panel); a double tap goes back to the tool before (the hands).
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? 'true' : arr[i + 1]]);
    return acc;
  }, []),
);
const url = args.url ?? 'http://localhost:5231/?skipmenu=1&level=playground&tutorial=0';
const out = args.out ?? 'C:/Projects/shots88/panfinger';
fs.mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  protocolTimeout: 600000,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
});
let bad = 0;
const ok = (c, m) => {
  console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`);
  if (!c) bad++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 412, height: 915, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  page.on('pageerror', (e) => {
    bad++;
    console.log(`[pageerror] ${e.message}`);
  });
  page.on('console', (m) => m.type() === 'error' && console.log(`[console.error] ${m.text()}`));
  const cdp = await page.createCDPSession();
  await page.goto(url, { waitUntil: 'load' });
  // (a first load is slow: the level up first, then the terrain's time to draw)
  await page.waitForFunction(() => window.reclaimed?.scene && document.querySelector('.editor'), { timeout: 240000 });
  await sleep(Number(args.wait ?? 30000));
  const fatal = await page.$eval('.fatal', (e) => e.textContent).catch(() => null);
  if (fatal) ok(false, `fatal: ${fatal}`);
  const tool = () => page.evaluate(() => document.querySelector('.editor [data-t].on')?.getAttribute('data-t'));
  const cam = () => page.evaluate(() => {
    const c = window.reclaimed.camera;
    return { target: [...c.target], zoom: c.zoom };
  });
  const delta = (dx, dy) => page.evaluate((dx, dy) => window.reclaimed.camera.screenDeltaToWorld(dx, dy), dx, dy);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 })) });
  /** fingers along paths (arrays of [x, y] per finger, same length), a move per step every `every` ms */
  const gesture = async (paths, { every = 16, hold = 0 } = {}) => {
    await touch('touchStart', paths.map((p) => p[0]));
    for (let i = 1; i < paths[0].length; i++) {
      await sleep(every);
      await touch('touchMove', paths.map((p) => p[i]));
    }
    if (hold) await sleep(hold);
    await touch('touchEnd', []);
  };
  const line = (x0, y0, x1, y1, n, jitter = () => [0, 0]) => Array.from({ length: n + 1 }, (_, i) => {
    const [jx, jy] = jitter(i);
    return [x0 + ((x1 - x0) * i) / n + jx, y0 + ((y1 - y0) * i) / n + jy];
  });

  // (the level keeps the camera inside its map: each check starts at the map's middle, zoomed in, far from the edge)
  const centre = async () => {
    await page.evaluate(() => (window.reclaimed.camera.target = [1e9, 1e9, window.reclaimed.camera.target[2]]));
    await sleep(150);
    await page.evaluate(() => {
      const c = window.reclaimed.camera;
      c.target = [c.target[0] / 2, c.target[1] / 2, c.target[2]];
      c.zoom = 10;
    });
    await sleep(150);
  };
  ok((await tool()) === 'pan', `the pan tool is selected first on a touch screen (${await tool()})`);
  await page.screenshot({ path: `${out}/before.png` });

  // 1. one finger, held still before lifting: the view moves by exactly the finger's motion
  await centre();
  let a = await cam();
  await gesture([line(80, 750, 140, 450, 20)], { hold: 250 });
  await sleep(300);
  let b = await cam();
  const [ex, ey] = await delta(60, -300);
  const moved = [a.target[0] - b.target[0], a.target[1] - b.target[1]];
  ok(Math.abs(moved[0] - ex) < 1e-6 && Math.abs(moved[1] - ey) < 1e-6 && a.zoom === b.zoom, `one-finger pan 1:1: moved ${moved.map((v) => v.toFixed(4))}, finger ${[ex, ey].map((v) => v.toFixed(4))}`);
  await page.screenshot({ path: `${out}/after-pan.png` });

  // 2. a flick: released while moving, it coasts on
  await centre();
  a = await cam();
  await gesture([line(110, 800, 110, 550, 10)], { every: 12 });
  const atLift = await cam();
  await sleep(700);
  b = await cam();
  const lift = Math.hypot(atLift.target[0] - a.target[0], atLift.target[1] - a.target[1]);
  const coast = Math.hypot(b.target[0] - atLift.target[0], b.target[1] - atLift.target[1]);
  ok(coast > 1, `flick coasts on: ${lift.toFixed(2)} cells dragged, ${coast.toFixed(2)} more after the lift`);
  await sleep(800);

  // 3. two fingers panning with jitter in their spread: no zoom
  await centre();
  a = await cam();
  await gesture([
    line(40, 700, 80, 480, 25, (i) => [Math.sin(i * 2.3) * 4, 0]),
    line(170, 720, 210, 500, 25, (i) => [-Math.sin(i * 2.3) * 4, Math.cos(i * 1.7) * 3]),
  ], { hold: 200 });
  await sleep(300);
  b = await cam();
  ok(a.zoom === b.zoom && Math.hypot(b.target[0] - a.target[0], b.target[1] - a.target[1]) > 1, `two-finger pan with jitter: zoom ${a.zoom} → ${b.zoom}, panned`);

  // 4. a clear pinch: zooms
  await centre();
  a = await cam();
  await gesture([line(80, 650, 40, 650, 20), line(140, 650, 200, 650, 20)], { hold: 200 });
  await sleep(300);
  b = await cam();
  ok(b.zoom > a.zoom * 1.5, `pinch out zooms: ${a.zoom.toFixed(2)} → ${b.zoom.toFixed(2)} (spread ×${(160 / 60).toFixed(2)})`);
  await page.screenshot({ path: `${out}/after-pinch.png` });

  // 5. a double tap: back to the hands
  await touch('touchStart', [[100, 600]]);
  await touch('touchEnd', []);
  await sleep(120);
  await touch('touchStart', [[102, 602]]);
  await touch('touchEnd', []);
  await sleep(200);
  ok((await tool()) === 'wind', `a double tap goes back to the hands (${await tool()})`);
} finally {
  await browser.close();
}
console.log(bad ? `${bad} FAILED` : 'all ok');
process.exit(bad ? 1 : 0);
