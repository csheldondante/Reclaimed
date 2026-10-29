// Round 112 (BACKLOG MF1, MF2; the user: "Also, the meteor looks off on the PC and magma still seems to spawn at the
// top of the column I think"). A meteor at a page size and pixel ratio, filmed, and where its lava went.
//   node scripts/meteorlook.mjs [--url http://localhost:5173] [--level playground|atlas] [--size 1600x900] [--dpr 1]
//     [--mode tap|cave] [--at x,y,z] [--gif out.gif] [--out still.png] [--frames 40] [--every 90] [--params &...]
// tap: the sandbox's meteor tool, the screen tapped at its middle (the real path: pick, flight, crater, the blast).
// cave: reclaimed.meteorNow at --at (world x, y, z; by default under the playground's arm off its wall — the arm
//   stays as a roof over the bowl), then the lava read back: how much of it lies on a column standing more than 8
//   over where it hit (on a roof: MF1's failure) and how much in the open. Every system on, 1x, as the page runs.
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
const url = opt('url', 'http://localhost:5173');
const level = opt('level', 'playground');
const [W, H] = opt('size', '1600x900').split('x').map(Number);
const dpr = Number(opt('dpr', 1));
const mode = opt('mode', 'tap');
const gifOut = opt('gif', '');
const still = opt('out', '');
const frames = Number(opt('frames', 40));
const every = Number(opt('every', 90));
const extra = opt('params', '');
const at = opt('at', '');
const zoom = opt('zoom', '');
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
  await p.goto(`${url}/?skipmenu=1&tutorial=0&level=${level}${extra}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.camera && window.reclaimed?.api, { timeout: 240000 });
  // (the first load after a server start is slow)
  await sleep(32000);
  const info = await p.evaluate(() => ({ dpr: devicePixelRatio, canvas: [document.getElementById('world').width, document.getElementById('world').height], css: [innerWidth, innerHeight], zoom: window.reclaimed.camera.zoom }));
  console.log(`page ${W}x${H} dpr ${dpr}: canvas ${info.canvas.join('x')}, zoom ${info.zoom}`);
  let site = null;
  if (mode === 'cave') {
    let [x, y, z] = at ? at.split(',').map(Number) : [54, 28, 10.5];
    // (--tower: a stone tower 9 cells round, 40 high, built at --at by the world API; the meteor hits its foot 5 in
    // from its edge, so the bowl leaves the tower over it as a roof)
    if (opt('tower', '0') === '1') {
      z = await p.evaluate(async (x, y) => {
        const t = window.reclaimed.api.terrain;
        await t.refresh();
        const g = t.heightAt(x, y);
        for (let k = 0; k < 10; k++) t.build(x, y, 'stone', { radius: 9, layers: 4 });
        return g + 1;
      }, x, y);
      await sleep(4000);
      const h = await p.evaluate(async (x, y) => {
        const t = window.reclaimed.api.terrain;
        await t.refresh();
        return t.heightAt(x, y);
      }, x, y);
      console.log(`tower at ${x},${y}: foot ${z - 1} top ${h}`);
      x -= 4;
    }
    site = { x, y, z };
    await p.evaluate((s, zm) => {
      const R = window.reclaimed;
      R.camera.target = [s.x + 6, s.y + 6, s.z + 8];
      if (zm) R.camera.zoom = Number(zm);
    }, site, zoom);
    await sleep(3000);
  } else {
    if (zoom) await p.evaluate((zm) => (window.reclaimed.camera.zoom = Number(zm)), zoom);
    if (level === 'playground') await p.evaluate(() => (window.reclaimed.camera.target = [150, 210, 12]));
    await sleep(3000);
  }
  const shots = [];
  const times = [];
  let t0 = 0;
  const grab = async () => {
    const b = await p.screenshot({ type: 'png' });
    shots.push(b);
    times.push((Date.now() - t0) / 1000);
  };
  if (mode === 'cave') {
    await p.evaluate((s) => window.reclaimed.meteorNow(s.x, s.y, s.z), site);
  } else {
    await p.evaluate(() => window.reclaimed.editor().select('meteor'));
    await p.mouse.click(Math.round(W / 2), Math.round(H * 0.55));
  }
  t0 = Date.now();
  for (let k = 0; k < frames; k++) {
    await grab();
    const wait = t0 + (k + 1) * every - Date.now();
    if (wait > 0) await sleep(wait);
  }
  console.log(`${shots.length} frames over ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  // (stills at set times after the tap: the flight lands at 1.6 s)
  if (still)
    for (const t of [1.0, 1.9, 2.6, 4.0]) {
      let k = 0;
      while (k + 1 < times.length && times[k] < t) k++;
      fs.writeFileSync(still.replace(/\.png$/, `-${t.toFixed(1)}s.png`), shots[k]);
    }
  if (gifOut) {
    const enc = GIFEncoder();
    // (scaled down to at most 900 wide: nearest)
    for (const b of shots) {
      const png = PNG.sync.read(Buffer.from(b));
      const s = Math.max(1, Math.ceil(png.width / 900));
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
  if (mode === 'cave') {
    for (const secs of [2, 6]) {
      const el = (Date.now() - t0) / 1000;
      if (el < secs) await sleep((secs - el) * 1000);
      const r = await p.evaluate(async (s) => {
        const R = window.reclaimed;
        const t = R.api.terrain;
        await t.refresh();
        const L = await R.readBuffer('lava');
        const { w: W } = R.core.dims;
        const L2 = await import('/src/world/lattice.ts');
        const [c0x, c0y] = L2.cellAt(s.x - 20, s.y - 20);
        const [c1x, c1y] = L2.cellAt(s.x + 20, s.y + 20);
        let roof = 0;
        let open = 0;
        let gapCols = 0;
        const roofCols = [];
        for (let y = c0y; y <= c1y; y++)
          for (let x = c0x; x <= c1x; x++) {
            const [px, py] = L2.cellPos(x, y);
            if (Math.hypot(px - s.x, py - s.y) > 20) continue;
            const ls = t.layersAt(px, py);
            if (!ls || !ls.length) continue;
            const top = ls[ls.length - 1].z1;
            let gap = false;
            for (let k = 1; k < ls.length; k++) gap ||= ls[k].z0 > ls[k - 1].z1 + 1e-3;
            if (gap && top > s.z + 8) gapCols++;
            const i = (y * W + x) * 4;
            const d = L[i];
            if (d < 0.02) continue;
            if (top > s.z + 8 && L[i + 3] > s.z + 8) {
              roof += d;
              if (roofCols.length < 6) roofCols.push(`(${px.toFixed(0)},${py.toFixed(0)}) top ${top.toFixed(1)} lava ${d.toFixed(2)} at ${L[i + 3].toFixed(1)}`);
            } else open += d;
          }
        return { roof, open, gapCols, roofCols };
      }, site);
      console.log(`t=${secs}s lava on roofs ${r.roof.toFixed(2)} cells³, in the open ${r.open.toFixed(2)}; roofed gap columns ${r.gapCols} ${r.roofCols.join('; ')}`);
    }
  }
} finally {
  await browser.close();
}
console.log(errors ? `meteorlook: ${errors} page errors` : 'meteorlook: ok');
process.exit(errors ? 1 : 0);
