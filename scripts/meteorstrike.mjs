// Round 112 (BACKLOG MF5, MF6; the user: "Also can we make much bigger meteor strikes?", "I want to know what an atlas
// sized strike looks like"). On the atlas level at a page size: an atlas-sized strike at the camera's focus
// (reclaimed.coarse.strike: the strike button's path — the coarse crater, the window's showcase, the camera flown out),
// filmed, with the frame rate a second while the regions and tiles are made again, the window's edit (ms) and the
// tiles remade.
//   node scripts/meteorstrike.mjs [--url http://localhost:5241] [--size 1600x900] [--dpr 1] [--r 1000] [--gif out.gif]
//     [--out still.png] [--secs 14] [--every 250] [--params &...]
import puppeteer from 'puppeteer-core';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import fs from 'node:fs';
const { GIFEncoder, quantize, applyPalette } = gifenc;
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5241');
const [W, H] = opt('size', '1600x900').split('x').map(Number);
const dpr = Number(opt('dpr', 1));
const R = Number(opt('r', 1000));
const secs = Number(opt('secs', 14));
const every = Number(opt('every', 250));
const gifOut = opt('gif', '');
const still = opt('out', '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${W},${H}`],
  defaultViewport: { width: W, height: H, deviceScaleFactor: dpr },
  protocolTimeout: 900000,
});
let errors = 0;
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => {
    errors++;
    console.log('pageerror', e.message);
  });
  p.on('console', (m) => m.type() === 'error' && !m.text().includes('404') && console.log('console', m.text()));
  await p.goto(`${url}/?skipmenu=1&tutorial=0&level=atlas${opt('params', '')}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.coarse && window.reclaimed?.camera, { timeout: 240000 });
  await sleep(32000);
  // (frames counted by the page's own rAF)
  await p.evaluate(() => {
    window.__fr = [];
    const f = (t) => {
      window.__fr.push(t);
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
  const remade0 = await p.evaluate(() => window.reclaimed.renderer.tiles?.stats?.remade ?? -1);
  await p.evaluate(async (R) => {
    const Rc = window.reclaimed;
    const L = await import('/src/world/lattice.ts');
    const [x, y] = L.cellAt(Rc.camera.target[0], Rc.camera.target[1]);
    window.__t0 = performance.now();
    Rc.coarse.strike(x, y, R);
  }, R);
  const shots = [];
  const times = [];
  const t0 = Date.now();
  while (Date.now() - t0 < secs * 1000) {
    shots.push(await p.screenshot({ type: 'png' }));
    times.push((Date.now() - t0) / 1000);
    const w = t0 + shots.length * every - Date.now();
    if (w > 0) await sleep(w);
  }
  const res = await p.evaluate(() => {
    const t0 = window.__t0;
    const fr = window.__fr.filter((t) => t >= t0);
    const per = [];
    for (let s = 0; s < 14; s++) per.push(fr.filter((t) => t >= t0 + s * 1000 && t < t0 + (s + 1) * 1000).length);
    let worst = 0;
    for (let k = 1; k < fr.length; k++) worst = Math.max(worst, fr[k] - fr[k - 1]);
    return { per, worst, zoom: window.reclaimed.camera.zoom, edit: window.reclaimed.editLiveMs?.() ?? null, remade: window.reclaimed.renderer.tiles?.stats?.remade ?? -1 };
  });
  console.log(`${W}x${H} dpr ${dpr}, strike R ${R}: frames a second ${res.per.join(' ')}; worst frame ${res.worst.toFixed(0)} ms; zoom now ${res.zoom.toFixed(2)}; tiles remade ${res.remade - remade0}; the window's edit ${res.edit?.toFixed?.(0)} ms`);
  if (still)
    for (const t of [0.5, 2, 5, 8, 12]) {
      let k = 0;
      while (k + 1 < times.length && times[k] < t) k++;
      fs.writeFileSync(still.replace(/\.png$/, `-${t}s.png`), shots[k]);
    }
  if (gifOut) {
    const enc = GIFEncoder();
    for (const b of shots) {
      const png = PNG.sync.read(Buffer.from(b));
      const s = Math.max(1, Math.ceil(png.width / 800));
      const w = Math.floor(png.width / s);
      const h = Math.floor(png.height / s);
      const px = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = (y * s * png.width + x * s) * 4;
          px.set(png.data.subarray(i, i + 4), (y * w + x) * 4);
        }
      const pal = quantize(px, 256);
      enc.writeFrame(applyPalette(px, pal), w, h, { palette: pal, delay: every });
    }
    enc.finish();
    fs.writeFileSync(gifOut, enc.bytes());
    console.log(`gif ${gifOut}`);
  }
} finally {
  await browser.close();
}
process.exit(errors ? 1 : 0);
