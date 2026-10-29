// Round 108 (simtiers, BACKLOG SM1): the sims' tiers, headless. The atlas level as the phone runs it (q=low, 412x915,
// every system on, 1x), a rain storm and a dust storm over the camera; the map read before and after:
//   - baked (the default in play): the layers and the plants mustn't change from rain, wind or growth (what still
//     may: the agents' work, collapse — live), while the storm looks alive (a GIF: rain, water, blowing dust);
//   - ?tiers=live: as before the tiers — the storm works the ground;
//   - baked, then core.tiers.bake('all', every process, S s): the bake changes it.
//   node scripts/simtierstest.mjs [--url http://localhost:5291] [--secs 20] [--bake 120] [--out C:/Projects/shots88/simtiers]
//     [--modes baked,live,bake] [--wait 45000]
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
const url = opt('url', 'http://localhost:5291');
const secs = Number(opt('secs', 20));
const bakeS = Number(opt('bake', 120));
const out = opt('out', 'C:/Projects/shots88/simtiers');
const wait = Number(opt('wait', 45000));
const modes = opt('modes', 'baked,live,bake').split(',');
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
  defaultViewport: { width: 412, height: 915, deviceScaleFactor: 1 },
  protocolTimeout: 900000,
});
let bad = false;
// the map now: the layers' words and the plants, kept in the page
const SNAP = `(async () => {
  const R = window.reclaimed;
  const layers = new Uint32Array((await R.readBuffer('layers')).buffer).slice();
  const veg = (await R.readBuffer('veg')).slice();
  const water = (await R.readBuffer('water')).slice();
  return { layers, veg, water };
})()`;
const DIFF = `((a, b) => {
  let lw = 0, vc = 0, vsum = 0, wsum = 0;
  for (let i = 0; i < a.layers.length; i++) if (a.layers[i] !== b.layers[i]) lw++;
  for (let i = 0; i < a.veg.length; i++) { const d = b.veg[i] - a.veg[i]; if (Math.abs(d) > 1e-4) { vc++; vsum += d; } }
  for (let i = 0; i < a.water.length; i++) wsum += Math.abs(b.water[i] - a.water[i]);
  return { layerWords: lw, vegCols: vc, vegSum: +vsum.toFixed(2), waterMoved: +wsum.toFixed(1) };
})`;
const results = {};
try {
  for (const mode of modes) {
    const p = await browser.newPage();
    p.on('pageerror', (e) => {
      bad = true;
      console.log('pageerror', e.message, e.stack);
    });
    p.on('console', (m) => {
      if (m.type() !== 'error' || m.text().includes('404')) return;
      // (a GPU validation error is fatal: GpuErrors logs it)
      if (/WebGPU error|GPUValidationError|WGSL/.test(m.text())) bad = true;
      console.log('console.error', m.text().slice(0, 300));
    });
    const tiers = mode === 'live' ? '&tiers=live' : '';
    await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=low&at=15024,14337&win=512&world=st-${Date.now().toString(36)}${tiers}`, { waitUntil: 'load' });
    await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
    await sleep(wait);
    const fatal = await p.evaluate(() => document.body.innerText.includes('GPU validation') || !!document.querySelector('.fatal'));
    if (fatal) {
      bad = true;
      console.log(mode, 'FATAL overlay');
    }
    const info = await p.evaluate((calm) => {
      const R = window.reclaimed;
      const t = R.camera.target;
      R.camera.zoom = 4;
      // (the shots without the HUD: only the canvas)
      for (const e of document.body.querySelectorAll('*')) {
        if (e.tagName === 'CANVAS' || e.querySelector('canvas')) continue;
        const pos = getComputedStyle(e).position;
        if (pos === 'fixed' || pos === 'absolute') e.style.display = 'none';
      }
      const st = calm ? null : R.weather.spawn(t[0], t[1]);
      const ds = calm ? null : R.weather.placeDust(t[0] + 10, t[1]);
      const T = R.core.tiers;
      return { at: t.map((v) => v | 0), storm: !!st, dust: !!ds, riverWet: R.globals.riverWet, tiers: ['rainErosion', 'windErosion', 'vegetation'].map((k) => `${k}:${T.tier(k)}`).join(' ') };
    }, ['calm', 'interact', 'fatal'].includes(mode));
    console.log(mode, JSON.stringify(info));
    // (the storm grows in for a few seconds first)
    await sleep(4000);
    await p.evaluate(`(async () => { window.__a = await ${SNAP}; return 0; })()`);
    if (mode === 'interact') {
      // (SM2) a player's power wakes erosion round it, and it goes back to baked once the area settles
      const rate = () => p.evaluate(() => { const R = window.reclaimed; const t = R.camera.target; return R.core.tiers.rateAt(t[0], t[1]).join(','); });
      const before = await rate();
      await p.evaluate(() => { const R = window.reclaimed; const t = R.camera.target; R.globals.events.push({ kind: 6, x: t[0], y: t[1], radius: 6, strength: 5 }); });
      await sleep(1000);
      const during = await rate();
      await sleep(Number(opt('settle', 30000)));
      const after = await rate();
      results.interact = { before, during, after };
      console.log('interact', JSON.stringify(results.interact));
      if (!(before === '0,0,0' && during === '1,1,0' && after === '0,0,0')) bad = true;
      await p.close();
      continue;
    }
    if (mode === 'fatal') {
      // (the contract: a GPU validation error shows the fatal overlay) a broken shader module on purpose
      const wasBad = bad;
      await p.evaluate(() => window.reclaimed.core.host.gpu.device.createShaderModule({ label: 'simtiers-fatal-probe', code: 'fn broken( {' }));
      await sleep(1500);
      const shown = await p.evaluate(() => {
        const el = document.querySelector('.fatal');
        if (!el) return 'no overlay';
        const top = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
        return el.contains(top) ? 'shown on top' : `under ${top?.tagName}#${top?.id}.${top?.className}`;
      });
      await p.screenshot({ path: `${out}/fatal_probe.png` });
      results.fatal = shown;
      console.log('fatal probe:', shown);
      bad = wasBad || shown !== 'shown on top';
      await p.close();
      continue;
    }
    if (mode === 'river') {
      const at = () => p.evaluate(`(async () => { const R = window.reclaimed; const w = await R.readBuffer('water'); let s = 0; for (const v of w) s += v; return { riverWet: +R.globals.riverWet.toFixed(3), water: +s.toFixed(0), storms: R.weather.storms.map((x) => +x.intensity.toFixed(2)) }; })()`);
      await p.screenshot({ path: `${out}/river_t0.png` });
      const a = await at();
      for (let k = 1; k <= 4; k++) {
        await sleep(15000);
        // (kept raining over the camera)
        await p.evaluate(() => { const R = window.reclaimed; const t = R.camera.target; if (!R.weather.storms.length) R.weather.spawn(t[0], t[1]); });
        console.log('river', `${k * 15} s`, JSON.stringify(await at()));
      }
      await p.screenshot({ path: `${out}/river_t60.png` });
      results.river = { start: a, end: await at() };
      console.log('river start', JSON.stringify(a), 'end', JSON.stringify(results.river.end));
      await p.close();
      continue;
    }
    const t0 = Date.now();
    if (mode === 'baked') {
      // the GIF: the storm alive over baked ground
      const enc = GIFEncoder();
      for (let f = 0; f < 40; f++) {
        const png = PNG.sync.read(Buffer.from(await p.screenshot({ type: 'png' })));
        const pal = quantize(png.data, 256);
        enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: 120 });
        await sleep(120);
      }
      enc.finish();
      fs.writeFileSync(`${out}/storm_baked.gif`, enc.bytes());
      console.log('gif', `${out}/storm_baked.gif`);
      await p.screenshot({ path: `${out}/storm_baked.png` });
    } else await sleep(secs * 1000);
    // (the baked run: the GIF's time counts toward the storm's seconds)
    if (mode === 'baked') await sleep(Math.max(0, secs * 1000 - (Date.now() - t0)));
    let d = await p.evaluate(`(async () => (${DIFF})(window.__a, await ${SNAP}))()`);
    results[mode] = { ...d, secs };
    console.log(mode, `after ${secs} s of storm:`, JSON.stringify(d));
    if (mode === 'live') await p.screenshot({ path: `${out}/storm_live.png` });
    if (mode === 'bake') {
      await p.evaluate(`(async () => { window.__a = await ${SNAP}; return 0; })()`);
      await sleep(500);
      const rep = await p.evaluate((s) => window.reclaimed.core.tiers.bake('all', ['rainErosion', 'windErosion', 'vegetation'], s), bakeS);
      d = await p.evaluate(`(async () => (${DIFF})(window.__a, await ${SNAP}))()`);
      results.bakeRun = { ...d, report: rep };
      console.log('bake', JSON.stringify(rep), '->', JSON.stringify(d));
      await p.screenshot({ path: `${out}/after_bake.png` });
    }
    await p.close();
  }
} finally {
  await browser.close();
}
fs.writeFileSync(`${out}/simtiers.json`, JSON.stringify(results, null, 1));
console.log(JSON.stringify(results));
process.exit(bad ? 1 : 0);
