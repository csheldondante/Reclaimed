// Solver step 2 (BACKLOG AR4): the lab's physics stations, lean — one still and one GIF a station, its buttons pressed
// in turn while the GIF runs (the user: rocks, buildings and metal; deformation, breaking, burial), on the phone proxy
// (412 × 915, q=low, every system in play, 1× speed). The same on places (before) and on solver (after).
//   node scripts/solverlab.mjs --url http://localhost:5211 --out C:/Projects/shots88/solver/after [--only slide,metal]
import puppeteer from 'puppeteer-core';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
const { GIFEncoder, quantize, applyPalette } = gifenc;

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5211');
const out = opt('out', 'C:/Projects/shots88/solver/lab');
const only = opt('only', '');
const variant = opt('solver', 'nodes');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(out, { recursive: true });

// each station's buttons, at the GIF's frame they're pressed (a frame is 300 ms)
const PLAN = {
  rock: [[2, 'nick the legs'], [18, 'cut the towers']],
  build: [[2, 'break bases'], [18, 'break the house']],
  slide: [[2, 'release the slab'], [8, 'nick the spire'], [14, 'undercut the mesa'], [30, 'bury'], [42, 'dig out']],
  house: [[2, 'break a corner'], [12, 'topple the towers']],
  metal: [[2, 'boulder on the bridge'], [12, 'cut the pylon'], [22, 'drop the tanker'], [38, 'bury the tanker']],
};
const FRAMES = 54;

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
  defaultViewport: { width: 412, height: 915, deviceScaleFactor: 2.6 },
  protocolTimeout: 10 * 60 * 1000,
});
let failed = false;
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => {
    failed = true;
    console.log(`FAIL pageerror ${e.message}`);
  });
  p.on('console', (m) => {
    if (m.type() === 'error') console.log(`[console.error] ${m.text().slice(0, 300)}`);
  });
  await p.goto(`${url}/?skipmenu=1&level=playground&tutorial=0&q=low&solver=${variant}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.scene?.bugReport, { timeout: 240000 });
  await sleep(35000);
  const fatal = await p.$eval('.fatal', (e) => e.textContent).catch(() => null);
  if (fatal) throw new Error(`fatal overlay: ${fatal}`);
  await p.evaluate(() => {
    window.reclaimed.scene.tunePanel?.toggle(false);
    // (the tools' panel over the right of a phone's screen: hidden for the pictures)
    for (const el of document.querySelectorAll('.editor')) el.style.display = 'none';
  });
  const stations = await p.evaluate(() => window.reclaimed.scene.level.stations.map((s) => ({ id: s.id, rect: s.rect })));
  for (let i = 0; i < stations.length; i++) {
    const s = stations[i];
    const plan = PLAN[s.id];
    if (!plan || (only && !only.split(',').includes(s.id))) continue;
    await p.evaluate((i) => window.reclaimed.scene.stationsBar.pick(i), i);
    await sleep(3000);
    const enc = GIFEncoder();
    for (let f = 0; f < FRAMES; f++) {
      const t = Date.now();
      for (const [at, label] of plan)
        if (at === f)
          await p.evaluate((label) => {
            const b = [...document.querySelectorAll('.stations button')].find((x) => x.textContent === label);
            if (!b) throw new Error(`no button ${label}`);
            b.click();
          }, label);
      const png = PNG.sync.read(Buffer.from(await p.screenshot({ type: 'png' })));
      // (a third the size, the bottom fifth — the stations' bar — cut)
      const k = 3;
      const w2 = Math.floor(png.width / k);
      const h2 = Math.floor((png.height * 0.8) / k);
      const small = new Uint8Array(w2 * h2 * 4);
      for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) for (let c = 0; c < 4; c++) small[(y * w2 + x) * 4 + c] = png.data[(k * y * png.width + k * x) * 4 + c];
      const pal = quantize(small, 256);
      enc.writeFrame(applyPalette(small, pal), w2, h2, { palette: pal, delay: 300 });
      await sleep(Math.max(0, 300 - (Date.now() - t)));
    }
    enc.finish();
    fs.writeFileSync(path.join(out, `${s.id}.gif`), enc.bytes());
    await p.screenshot({ path: path.join(out, `${s.id}.png`) });
    const st = await p.evaluate(() => ({ rigid: window.reclaimed.scene.integrity?.rigid?.list.length ?? 0, metal: window.reclaimed.scene.integrity?.solver?.bodies.size ?? 0, stats: window.reclaimed.scene.integrity?.stats }));
    console.log(`[${s.id}] saved ${s.id}.gif, ${s.id}.png — rigid ${st.rigid}, solver bodies ${st.metal}, bodies made ${st.stats?.bodies}, metal cells ${st.stats?.metal ?? 0}`);
  }
  // the frame's cost on the phone proxy, with what's left moving
  await p.evaluate(() => window.reclaimed.scene.perf?.toggle?.(true));
} catch (e) {
  failed = true;
  console.log(`FAIL ${e.message}`);
} finally {
  await browser.close();
}
console.log(failed ? 'SOLVERLAB: FAILED' : 'SOLVERLAB: OK');
process.exit(failed ? 1 : 0);
