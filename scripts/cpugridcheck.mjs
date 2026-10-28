// Round 106 (frameprobe): the CPU's per-column arrays against the GPU's after slides. The atlas at the phone tier
// (every system on, 1x); a pan out and back (generated, then thawed from the pool) at --speed for --seconds each way;
// then, parked, every window column's height as the CPU keeps it (core.map.surface — on the ring since round 106,
// window order before) against the GPU's surface (read back in window order), and the level's surface cache. Reports
// how many columns agree (|dz| < 0.01) — on places and on frameprobe the same share is expected.
//   node scripts/cpugridcheck.mjs [--url http://localhost:5311] [--win 256] [--zoom 14] [--speed 120] [--seconds 6]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5311');
const win = Number(opt('win', 256));
const zoom = Number(opt('zoom', 14));
const speed = Number(opt('speed', 120));
const seconds = Number(opt('seconds', 6));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
  defaultViewport: { width: 412, height: 915, deviceScaleFactor: 2.6, hasTouch: true, isMobile: true },
  protocolTimeout: 900000,
});
let bad = false;
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => {
    bad = true;
    console.log('pageerror', e.message);
  });
  await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=low&at=15024,14337&win=${win}&world=gc-${Date.now().toString(36)}${opt('extra', '')}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  await sleep(Number(opt('wait', 30000)));
  const check = async (label) => {
    const r = await p.evaluate(async () => {
      const R = window.reclaimed;
      const core = R.core;
      const { w, h } = core.dims;
      const ring = core.ring;
      const onRing = typeof ring.i === 'function';
      const at = (x, y) => (onRing ? ring.i(x, y) : y * w + x);
      const gpu = new Uint32Array((await core.readBuffer('surface')).buffer);
      // (surface words: world/layout.ts sfPack)
      const sfZ = (v) => (v & 0x1ffff) / 256;
      let same = 0;
      let n = 0;
      let worst = 0;
      const cache = R.scene.surfaceCache;
      let cacheSame = 0;
      let off = 0;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const g = sfZ(gpu[y * w + x]);
          const c = core.map.surface[at(x, y)];
          const d = Math.abs(g - c);
          n++;
          if (d < 0.6) same++;
          worst = Math.max(worst, d);
          if (cache && Math.abs(sfZ(cache[at(x, y)]) - g) < 0.6) cacheSame++;
          // (the control: a column a region off — what a wrong index would agree with)
          if (Math.abs(core.map.surface[at((x + 64) % w, y)] - g) < 0.6) off++;
        }
      // (the hybrid's per-chunk choice, made again now from the streamer's relief, against what it holds)
      let hyDiff = -1;
      const hy = R.scene.hybrid;
      if (hy) {
        const before = hy.land.slice();
        hy.landBox(0, 0, w, h);
        hyDiff = 0;
        for (let k = 0; k < before.length; k++) if (before[k] !== hy.land[k]) hyDiff++;
      }
      return { hyDiff, off: +(off / n).toFixed(4), onRing, ring: [ring.x, ring.y], slides: R.stream.stats.slides, thawed: R.stream.stats.thawed, same: +(same / n).toFixed(4), cacheSame: +(cacheSame / n).toFixed(4), worst: +worst.toFixed(2) };
    });
    console.log(`${label}: ${JSON.stringify(r)}`);
  };
  await check('start');
  await p.evaluate((zoom) => {
    const R = window.reclaimed;
    R.scene.drive = null;
    R.camera.zoom = zoom;
    const [ux, uy] = R.camera.screenDeltaToWorld(0, -1);
    const l = Math.hypot(ux, uy) || 1;
    window.__dir = [ux / l, uy / l];
  }, zoom);
  for (const sign of [1, -1, 0]) {
    if (sign === 0) break;
    await p.evaluate(
      (speed, sign) => {
        const d = window.__dir;
        window.reclaimed.scene.pan = { speed, dir: [d[0] * sign, d[1] * sign], t: 0, turnAt: 0, turnBy: 0, turned: 0, asked: 0 };
      },
      speed,
      sign,
    );
    await sleep(seconds * 1000);
    if (sign === 1) {
      await p.evaluate(() => (window.reclaimed.scene.pan = null));
      await sleep(4000);
      await check('after the pan out');
    }
  }
  await p.evaluate(() => (window.reclaimed.scene.pan = null));
  // (the level's surface cache is read back once a second; the slides' writes settle)
  await sleep(4000);
  await check('after the pan out and back');
} finally {
  await browser.close();
}
if (bad) process.exit(1);
