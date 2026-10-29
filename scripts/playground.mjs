// Round 108 (AR5, AR8): the physics and water playground, headless, with every system in play (the page as the phone
// runs it: q=low's flags, 1x speed). Checks: the level opens without errors; each station's buttons do what they say
// (shots before and after, a GIF of each); a tuning change reaches the GPU's Globals and changes what's seen (spray
// off; the rigid rock under 3x gravity falls faster); the bug report (key B) saves its JSON and PNG; a station's reset
// puts it back (the breach's pool refilled, its plug back); the frame's cost on the phone proxy (412 x 915, dpr 2.6).
//   node scripts/playground.mjs [--url http://localhost:5281] [--out C:/Projects/shots88/playground] [--size 412x915]
//     [--dpr 2.6] [--q low] [--only rock,breach] [--skip-gifs] [--measure 20]
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
const url = opt('url', 'http://localhost:5281');
const out = opt('out', 'C:/Projects/shots88/playground');
const [W, H] = opt('size', '412x915').split('x').map(Number);
const dpr = Number(opt('dpr', '2.6'));
const q = opt('q', 'low');
const only = opt('only', '');
const measureS = Number(opt('measure', '20'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(out, { recursive: true });
const dl = path.join(out, 'downloads');
fs.mkdirSync(dl, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${W},${H}`],
  defaultViewport: { width: W, height: H, deviceScaleFactor: dpr },
  protocolTimeout: 10 * 60 * 1000,
});
let failed = false;
const fail = (m) => {
  failed = true;
  console.log(`FAIL ${m}`);
};
try {
  const p = await browser.newPage();
  const cdp = await p.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl, eventsEnabled: true });
  p.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[console.${m.type()}] ${m.text().slice(0, 600)}`);
    if (m.text().startsWith('[tune]')) console.log(m.text());
  });
  p.on('pageerror', (e) => fail(`pageerror ${e.message}`));
  const t0 = Date.now();
  await p.goto(`${url}/?skipmenu=1&level=playground&tutorial=0&q=${q}${opt('extra', '')}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.scene?.bugReport, { timeout: 240000 });
  console.log(`level up in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  // (the first load after a server start is slow: let it settle)
  await sleep(35000);
  const fatal = await p.$eval('.fatal', (e) => e.textContent).catch(() => null);
  if (fatal) throw new Error(`fatal overlay: ${fatal}`);
  const shot = (name) => p.screenshot({ path: path.join(out, name) });
  // (the panel opens on a desktop: shut for the stations' pictures)
  await p.evaluate(() => window.reclaimed.scene.tunePanel.toggle(false));
  await shot('00-open.png');
  const stations = await p.evaluate(() => window.reclaimed.scene.level.stations.map((s) => ({ id: s.id, actions: s.actions.map((a) => a.label) })));
  console.log('stations', stations.map((s) => `${s.id}: ${s.actions.join(' / ')}`).join('; '));
  const pick = (i) => p.evaluate((i) => window.reclaimed.scene.stationsBar.pick(i), i);
  const click = (label) =>
    p.evaluate((label) => {
      const b = [...document.querySelectorAll('.stations button')].find((x) => x.textContent === label);
      if (!b) throw new Error(`no button ${label}`);
      b.click();
    }, label);
  const gif = async (name, frames, every) => {
    if (argv.includes('--skip-gifs')) return sleep(frames * every);
    const enc = GIFEncoder();
    for (let i = 0; i < frames; i++) {
      const t = Date.now();
      const png = PNG.sync.read(Buffer.from(await p.screenshot({ type: 'png' })));
      // (half size: the phone's shot is 1071 x 2379)
      const w2 = png.width >> 1;
      const h2 = png.height >> 1;
      const half = new Uint8Array(w2 * h2 * 4);
      for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) for (let c = 0; c < 4; c++) half[(y * w2 + x) * 4 + c] = png.data[(2 * y * png.width + 2 * x) * 4 + c];
      const pal = quantize(half, 256);
      enc.writeFrame(applyPalette(half, pal), w2, h2, { palette: pal, delay: every });
      await sleep(Math.max(0, every - (Date.now() - t)));
    }
    enc.finish();
    fs.writeFileSync(path.join(out, name), enc.bytes());
    console.log(`saved ${name}`);
  };
  const probe = (field, x, y, r) => p.evaluate((f, x, y, r) => window.reclaimed.probe(f, x, y, r), field, x, y, r);

  // ---- 1. the stations: before, each button, after
  for (let i = 0; i < stations.length; i++) {
    const s = stations[i];
    if (only && !only.split(',').includes(s.id)) continue;
    await pick(i);
    await sleep(2500);
    await shot(`${String(i + 1).padStart(2, '0')}-${s.id}-before.png`);
    for (const a of s.actions) {
      const before = await p.evaluate(() => ({ falling: window.reclaimed.scene.integrity?.falling.list.length ?? 0, rigid: window.reclaimed.scene.integrity?.rigid?.list.length ?? 0, awake: window.reclaimed.scene.sleep?.awake ?? -1 }));
      await click(a);
      await gif(`${String(i + 1).padStart(2, '0')}-${s.id}-${a.replace(/\W+/g, '-')}.gif`, 24, 250);
      const after = await p.evaluate(() => ({ falling: window.reclaimed.scene.integrity?.falling.list.length ?? 0, rigid: window.reclaimed.scene.integrity?.rigid?.list.length ?? 0, stats: window.reclaimed.scene.integrity?.stats, rstats: window.reclaimed.scene.integrity?.rigid?.stats, awake: window.reclaimed.scene.sleep?.awake ?? -1 }));
      console.log(`[${s.id}] ${a}: falling ${before.falling}->${after.falling} rigid ${before.rigid}->${after.rigid} awake ${before.awake}->${after.awake} breaks ${after.rstats?.breaks} settled ${after.stats?.settled} spawned ${after.rstats?.spawned}`);
    }
    await sleep(Number(opt('after', '3000')));
    await shot(`${String(i + 1).padStart(2, '0')}-${s.id}-after.png`);
  }

  // ---- 2. a station's reset: the breach's pool (dry after the breach, then full again), its plug
  {
    const k = stations.findIndex((s) => s.id === 'breach');
    await pick(k);
    // the pool's middle, storage (32, 144) -> world
    const [px, py] = [32.5, 144.5 * 0.8660254];
    // (the tour breached it: put it back first)
    await click('↺ reset');
    await sleep(3000);
    const wet0 = await probe('water', 32, 144, 2);
    await click('breach');
    await sleep(15000);
    const wet1 = await probe('water', 32, 144, 2);
    await click('↺ reset');
    await sleep(1500);
    const wet2 = await probe('water', 32, 144, 2);
    const plug = await p.evaluate(async () => {
      const R = window.reclaimed;
      const f = new Uint32Array((await R.readBuffer('layers')).buffer);
      // column (53, 144)'s intervals: the plug's concrete (5) from 32 to 35
      const t = R.packed.chunkTable;
      const ci = Math.floor(144 / 16) * R.packed.chunksX + Math.floor(53 / 16);
      const k = t[ci * 2 + 1];
      const base = t[ci * 2] + ((144 % 16) * 16 + (53 % 16)) * k;
      const out = [];
      const fl = new Float32Array(f.buffer);
      for (let s = 0; s < k; s++) if (f[(base + s) * 4 + 1]) out.push([+fl[(base + s) * 4].toFixed(2), +fl[(base + s) * 4 + 1].toFixed(2), f[(base + s) * 4 + 2] & 255]);
      return out;
    });
    console.log(`[reset] pool depth ${wet0.toFixed(2)} -> breached ${wet1.toFixed(2)} -> reset ${wet2.toFixed(2)}; plug column ${JSON.stringify(plug)} (${px.toFixed(1)}, ${py.toFixed(1)})`);
    if (!(wet1 < wet0 - 0.3)) fail(`the breach didn't drain the pool (${wet0} -> ${wet1})`);
    if (!(wet2 > wet1 + 0.3)) fail(`the reset didn't refill the pool (${wet1} -> ${wet2})`);
    if (!plug.some((iv) => iv[2] === 5)) fail('the reset didn\'t put the plug back');
    await shot('20-breach-reset.png');
  }

  // ---- 3. the tuning reaches the GPU and changes what's seen
  {
    const k = stations.findIndex((s) => s.id === 'river');
    await pick(k);
    await sleep(3000);
    const slot = await p.evaluate(async () => {
      const R = window.reclaimed;
      R.tune.set('spray.drops', 0);
      R.tune.set('spray.splash', 0);
      R.tune.set('spray.mist', 0);
      R.tune.set('world.gravity', 4.5);
      await new Promise((r) => setTimeout(r, 500));
      const g = new Float32Array((await R.readBuffer('globals')).buffer);
      const d = R.tune.byId.get('world.gravity');
      const s = R.tune.byId.get('spray.drops');
      return { gravity: g[480 + d.slot], drops: g[480 + s.slot] };
    });
    console.log(`[tune] the GPU's Globals: world.gravity ${slot.gravity}, spray.drops ${slot.drops}`);
    if (slot.gravity !== 4.5 || slot.drops !== 0) fail('the tuning didn\'t reach the Globals');
    await sleep(2500);
    await shot('30-river-spray-off-gravity-4.5.png');
    await gif('30-river-spray-off-gravity-4.5.gif', 16, 250);
    await p.evaluate(() => window.reclaimed.tune.reset());
    await sleep(2500);
    await shot('31-river-defaults.png');
    await gif('31-river-defaults.gif', 16, 250);
    // the rigid rock under 3x gravity: the rock station reset, its legs nicked; the fastest fall seen
    const fall = async (g) => {
      const r = stations.findIndex((s) => s.id === 'rock');
      await pick(r);
      await click('↺ reset');
      await sleep(3000);
      // (its top speed out of the way: 14 cells/s caps a fall of 10 cells at either gravity)
      await p.evaluate((g) => (window.reclaimed.tune.set('rigid.gravity', g), window.reclaimed.tune.set('rigid.maxV', 60)), g);
      await click('nick the legs');
      let vmax = 0;
      let n = 0;
      for (let t = 0; t < 40; t++) {
        await sleep(150);
        const v = await p.evaluate(() => {
          const l = window.reclaimed.scene.integrity?.rigid?.list ?? [];
          return { v: Math.max(0, ...l.map((b) => -b.v[2])), n: l.length };
        });
        vmax = Math.max(vmax, v.v);
        n = Math.max(n, v.n);
      }
      return { vmax: +vmax.toFixed(2), bodies: n };
    };
    const g1 = await fall(1);
    const g3 = await fall(3);
    console.log(`[tune] rigid rock's fastest fall: gravity x1 ${g1.vmax} cells/s (${g1.bodies} bodies), x3 ${g3.vmax} cells/s (${g3.bodies} bodies)`);
    if (!(g1.bodies > 0)) fail('nicking the legs freed no rigid rock');
    else if (!(g3.vmax > g1.vmax * 1.2)) fail('3x gravity did not make the rock fall faster');
    await p.evaluate(() => window.reclaimed.tune.reset());
  }

  // ---- 4. the bug report: key B, a note, save
  {
    const before = new Set(fs.readdirSync(dl));
    await p.keyboard.press('b');
    await p.waitForSelector('.bug-dialog textarea', { timeout: 10000 });
    await shot('40-bug-dialog.png');
    await p.type('.bug-dialog textarea', 'headless test: the rock station after nicking its legs');
    await p.click('.bug-dialog button.go');
    await p.waitForFunction(() => !document.querySelector('.bug-dialog'), { timeout: 20000 });
    await sleep(3000);
    const got = fs.readdirSync(dl).filter((f) => !before.has(f));
    console.log(`[bug] downloaded ${got.join(', ') || 'nothing'}`);
    const json = got.find((f) => f.endsWith('.json'));
    if (!json || !got.some((f) => f.endsWith('.png'))) fail('the bug report did not download its JSON and PNG');
    else {
      const r = JSON.parse(fs.readFileSync(path.join(dl, json), 'utf8'));
      const keys = Object.keys(r);
      console.log(`[bug] ${json}: ${keys.join(', ')}; note "${r.note}"; tune ${Object.keys(r.tune.all).length} params; shot ${(r.shot.length / 1024).toFixed(0)} KB; camera ${JSON.stringify(r.camera)}; time ${JSON.stringify(r.time)}`);
      for (const k of ['note', 'shot', 'tune', 'camera', 'time', 'world', 'state']) if (!(k in r)) fail(`the report has no ${k}`);
    }
  }

  // ---- 5. the frame's cost: every station as it is (the river flowing, what fell settling), the tuning panel open
  {
    await p.evaluate(() => window.reclaimed.scene.tunePanel.toggle(true));
    // (the perf overlay: the profiler reads the GPU's timings only while it's open)
    await p.keyboard.press('`');
    await pick(stations.findIndex((s) => s.id === 'river'));
    await sleep(5000);
    await shot('50-panel-open.png');
    await p.evaluate(() => {
      const R = window.reclaimed;
      R.core.host.profiler.resetTotals();
      window.__all = [];
      const tick = () => {
        window.__all.push(performance.now());
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      window.__tick0 = R.core.sim.tick;
    });
    await sleep(measureS * 1000);
    const r = await p.evaluate(() => {
      const R = window.reclaimed;
      const t = window.__all;
      const d = [];
      for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
      const f = [...d].sort((a, b) => a - b);
      const qq = (x) => +f[Math.min(f.length - 1, Math.floor(x * f.length))].toFixed(1);
      const pr = R.core.host.profiler;
      const n = Math.max(pr.framesResolved, 1);
      return {
        fps: +(d.length / ((t[t.length - 1] - t[0]) / 1000)).toFixed(1),
        p50: qq(0.5),
        p95: qq(0.95),
        worst: +f[f.length - 1].toFixed(0),
        gpu: +(pr.gpuTotalMs / n).toFixed(2),
        top: Object.fromEntries([...pr.totalMs].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => [k, +(v / n).toFixed(3)])),
        ticks: R.core.sim.tick - window.__tick0,
        awake: R.scene.sleep?.awake ?? -1,
      };
    });
    console.log(`[cost] ${W}x${H} dpr ${dpr} q=${q}: fps ${r.fps} p50 ${r.p50} p95 ${r.p95} worst ${r.worst} ms; GPU ${r.gpu} ms a frame; ${r.ticks} ticks in ${measureS} s; awake ${r.awake} chunks`);
    console.log(`[cost] passes ${JSON.stringify(r.top)}`);
  }
} catch (e) {
  fail(e.stack ?? String(e));
} finally {
  await browser.close();
}
console.log(failed ? 'PLAYGROUND: FAILED' : 'PLAYGROUND: OK');
process.exit(failed ? 1 : 0);
