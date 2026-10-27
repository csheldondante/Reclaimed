// Round 88: the sea by a coast after the window slid up (as walking up a mountain by the sea does) — its columns
// cut under the window's floor: shots of the sea there (the camera on the deepest of them) and the walls counted.
//   node scripts/seawallslide.mjs [--at 11600,18213] [--slidez 1] [--zooms 2,5] [--out C:/Projects/shots88/sea/slide-before]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5317');
const at = opt('at', '11600,18213');
const out = opt('out', 'C:/Projects/shots88/sea/slide-before');
const zooms = opt('zooms', '2,5').split(',').map(Number);
const slides = Number(opt('slidez', 1));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
  defaultViewport: { width: 412, height: 915, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const probe = (p) =>
  p.evaluate(async () => {
    const R = window.reclaimed;
    const W = R.core.dims.w;
    const H = R.core.dims.h;
    const w = new Float32Array((await R.readBuffer('water')).buffer);
    const s = new Uint32Array((await R.readBuffer('surface')).buffer);
    const z = (i) => (s[i] & 0xffff) / 256;
    let holes = 0;
    let holesWet = 0;
    let walls = 0;
    let lvSum = 0;
    let lvN = 0;
    let cx = 0;
    let cy = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (((s[i] >>> 24) & 0x1f) === 0) {
          holes++;
          cx += x;
          cy += y;
          if (w[i] > 0.05) holesWet++;
        }
        if (w[i] > 2 && z(i) < R.globals.seaZ) {
          lvSum += z(i) + w[i];
          lvN++;
        }
        if (w[i] <= 0.05) continue;
        const lv = z(i) + w[i];
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const X = x + dx;
          const Y = y + dy;
          if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
          const j = Y * W + X;
          if (lv - (z(j) + Math.max(w[j], 0)) > 3) walls++;
        }
      }
    return { oz: R.stream.oz, seaZ: R.globals.seaZ, zoom: R.camera.zoom, holes, holesWet, walls, seaLevel: lvN ? +(lvSum / lvN).toFixed(2) : null, holeMid: holes ? [Math.round(cx / holes), Math.round(cy / holes)] : null };
  });
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  p.on('console', (m) => m.type() === 'error' && !m.text().includes('404') && console.log('console', m.text()));
  await p.goto(`${url}/?skipmenu=1&tutorial=0&q=low&level=atlas&at=${at}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 300000 });
  await sleep(25000);
  console.log('start', JSON.stringify(await probe(p)));
  for (let k = 0; k < slides; k++) {
    await p.evaluate(() => window.reclaimed.stream.slideZ(32));
    await sleep(3000);
  }
  console.log('slid 3s', JSON.stringify(await probe(p)));
  await sleep(12000);
  const r = await probe(p);
  console.log('slid 15s', JSON.stringify(r));
  const t = r.holeMid ?? [128, 128];
  // (the camera over the sea there, at its level: the rings pressed no lower than the sea)
  await p.evaluate((t, sz) => (window.reclaimed.camera.target = [t[0], t[1] * (Math.sqrt(3) / 2), sz]), t, r.seaZ);
  for (const zz of zooms) {
    await p.evaluate((z) => (window.reclaimed.camera.zoom = z), zz);
    await sleep(3000);
    await p.screenshot({ path: `${out}-z${zz}.png` });
  }
  const fatal = await p.$eval('.fatal', (e) => e.textContent).catch(() => null);
  if (fatal) console.log('FATAL', fatal);
} finally {
  await browser.close();
}
