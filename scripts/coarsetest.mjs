// The coarse world (round 71): events at the world's scale and the fine columns that come of them.
//  - on the coarse grid: a meteor's crater (its middle down, its rim up, rubble round it), an
//    eruption's ash downwind, its lava running and setting to basalt;
//  - in the level: a meteor far out of the window, then the window slid to it — the crater is in the
//    columns that come in; a region left, then buried in ash, then come back to — the ash is on it
//    (frozen regions get what changed while away); a meteor in sight — the window's columns change.
//   node scripts/coarsetest.mjs [--url http://localhost:5203] [--out coarse]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5203');
const out = opt('out', 'coarse');
const results = [];
let failed = false;
const check = (name, ok, info) => {
  results.push(ok);
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(info)}`);
};
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1200,800'],
  defaultViewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
  protocolTimeout: 10 * 60 * 1000,
});
try {
  const lv = await browser.newPage();
  lv.on('pageerror', (e) => console.log('pageerror:', e.message));
  lv.on('console', (m) => m.type() === 'error' && console.log('console:', m.text().slice(0, 300)));
  await lv.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&tod=0.35&q=high&at=12684,13472`, { waitUntil: 'load' });
  await lv.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  await new Promise((r) => setTimeout(r, 3000));
  await lv.evaluate(() => (document.getElementById('ui').style.visibility = 'hidden'));

  // ---- the coarse grid itself --------------------------------------------------
  const grid = await lv.evaluate(async () => {
    const R = window.reclaimed;
    const C = R.atlas.coarse;
    const S = R.stream;
    // a point far east of the window (3 regions past its edge), on the window's middle row
    const gy = S.origin[1] + 128;
    const fx = S.origin[0] + 256 + 3 * 64 + 32 + 0.5;
    const fy = (gy + 0.5) * 0.866;
    const before = await C.snapshot(Math.floor(fx) - 4, gy - 4, 8, 8);
    const b0 = C.sample(before, fx, fy);
    C.meteor(fx, fy, 160, 30);
    const after = await C.snapshot(Math.floor(fx) - 4, gy - 4, 8, 8);
    const a0 = C.sample(after, fx, fy);
    const rim = await C.snapshot(Math.floor(fx + 160) - 4, gy - 4, 8, 8);
    const r0 = C.sample(rim, fx + 160, fy);
    // an eruption far west: ash downwind (east) of it, lava that runs and sets
    const vx = S.origin[0] - 900;
    const vy = fy;
    C.erupt(vx, vy, { wind: [1, 0], steps: 400 });
    for (let k = 0; k < 40; k++) {
      C.step(25);
      await new Promise((r) => requestAnimationFrame(r));
    }
    const ash = await C.snapshot(Math.floor(vx + 700) - 4, gy - 4, 8, 8);
    const at = C.sample(ash, vx + 700, vy);
    const up = await C.snapshot(Math.floor(vx + 700) - 4, gy - 2000 - 4, 8, 8);
    const across = C.sample(up, vx + 700, vy - 2000 * 0.866);
    const vent = await C.snapshot(Math.floor(vx) - 4, gy - 4, 8, 8);
    const v0 = C.sample(vent, vx, vy);
    return { crater: { before: +b0.dr.toFixed(2), middle: +a0.dr.toFixed(2), rim: +r0.dr.toFixed(2), rubbleAtRim: +r0.loose.toFixed(2) }, ash: { downwind: +at.loose.toFixed(2), mat: at.lmat, across: +across.loose.toFixed(3) }, vent: { dr: +v0.dr.toFixed(1), cap: v0.cap, lava: +v0.lava.toFixed(2) }, far: [fx, fy], steps: C.steps };
  });
  console.log(JSON.stringify(grid));
  check('a meteor on the coarse grid: its middle deep, its rim raised, rubble round it', grid.crater.middle < -25 && grid.crater.rim > 2 && grid.crater.rubbleAtRim > 0.5, grid.crater);
  check('an eruption: ash downwind (not far across the wind), the cone and set lava basalt at the vent', grid.ash.downwind > 0.3 && grid.ash.mat === 17 && grid.ash.across < 0.05 && grid.vent.dr > 20 && grid.vent.cap === 23, { ash: grid.ash, vent: grid.vent });

  // ---- the far crater comes into the window ---------------------------------------
  const far = await lv.evaluate(async () => {
    const R = window.reclaimed;
    const S = R.stream;
    S.auto = false;
    for (let k = 0; k < 5; k++) await S.slide(64, 0);
    await new Promise((r) => setTimeout(r, 1500));
    // the crater's middle, now in window cells
    const [wx, wy] = R.atlas ? [0, 0] : [0, 0];
    void wx;
    void wy;
    const gy = S.origin[1] + 128;
    const fx = S.origin[0] - 64 * 5 + 256 + 3 * 64 + 32;
    const lx = fx - S.origin[0];
    const ly = gy - S.origin[1];
    const surf = R.map.surface;
    const mid = surf[ly * 256 + lx];
    // the ground 300 cells out on the same row isn't in the window: the rim's, east and west
    const rimW = surf[ly * 256 + Math.max(0, lx - 170)];
    const rimE = surf[ly * 256 + Math.min(255, lx + 170)];
    // the atlas's own column there (with the coarse world), and the coarse world's change there
    const ref = await R.atlas.columns(fx, gy, 1, 1);
    const C = R.atlas.coarse;
    const snap = await C.snapshot(fx - 4, gy - 4, 8, 8);
    const dr = C.sample(snap, fx + 0.5, (gy + 0.5) * 0.866).dr;
    return { lx, ly, mid: +mid.toFixed(1), atlasCol: +(ref.f[0] - S.oz).toFixed(1), dr: +dr.toFixed(1), rimW: +rimW.toFixed(1), rimE: +rimE.toFixed(1), stats: { ...S.stats } };
  });
  console.log(JSON.stringify(far));
  check('slid to the far meteor: its crater is in the columns that came in (the atlas column with the coarse crater)', Math.abs(far.mid - far.atlasCol) < 1 && far.dr < -25 && far.mid < far.rimW - 15, far);
  await lv.evaluate(() => {
    const R = window.reclaimed;
    R.camera.zoom = 1.4;
    R.camera.target[0] = 128;
  });
  await new Promise((r) => setTimeout(r, 2500));
  await lv.screenshot({ path: `${out}-crater.png` });

  // ---- a region left, buried in ash, come back to -------------------------------------
  const back = await lv.evaluate(async () => {
    const R = window.reclaimed;
    const S = R.stream;
    const C = R.atlas.coarse;
    // the window's westmost region: leave it (slide east), bury it, come back (west)
    const gx = S.origin[0] + 32;
    const gy = S.origin[1] + 32;
    await S.slide(64, 0);
    await new Promise((r) => setTimeout(r, 800));
    const changed0 = S.stats.changed;
    // ash laid straight on it (the coarse grid only: it's out of the window)
    C.event({ kind: 2, x: gx + 0.5, y: (gy + 0.5) * 0.866 - 0, r: 120, a: 3, wind: [0.0001, 0] });
    await S.slide(-64, 0);
    await new Promise((r) => setTimeout(r, 1500));
    const L = await import('/src/world/layout.ts');
    const buf = await R.core.readBuffer('layers');
    const slots = new Uint32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const lx = gx - S.origin[0];
    const ly = gy - S.origin[1];
    const col = L.readColumn(R.packed, slots, lx, ly);
    return { changed: S.stats.changed - changed0, top: col.map((iv) => `${iv.mat}:${iv.z0.toFixed(1)}-${iv.z1.toFixed(1)}`).slice(-3), lx, ly };
  });
  console.log(JSON.stringify(back));
  const topMat = back.top.length ? Number(back.top[back.top.length - 1].split(':')[0]) : -1;
  check('a region left and buried in ash comes back with the ash on it', back.changed > 0 && topMat === 17, back);

  // ---- a meteor in sight -------------------------------------------------------
  const here = await lv.evaluate(async () => {
    const R = window.reclaimed;
    const surf = R.map.surface;
    const i = 128 * 256 + 128;
    const before = surf[i];
    R.coarse.meteor(128, 128, 60);
    await new Promise((r) => setTimeout(r, 3000));
    return { before: +before.toFixed(1), after: +surf[i].toFixed(1) };
  });
  console.log(JSON.stringify(here));
  check('a meteor in sight: the window\'s columns are cut to its crater', here.after < here.before - 6, here);
  await lv.evaluate(() => {
    const R = window.reclaimed;
    R.toggleFly();
    R.camera.fly.pos = [128 - 95, 128 * 0.866 - 95, R.map.surface[128 * 256 + 128] + 70];
    R.camera.fly.yaw = Math.PI / 4;
    R.camera.fly.pitch = -0.45;
  });
  await new Promise((r) => setTimeout(r, 4000));
  await lv.screenshot({ path: `${out}-impact.png` });
} finally {
  await browser.close();
}
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
if (failed) process.exit(1);
