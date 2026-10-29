// Round 110 (playwater): the playground's water is the game's — its river held at an authored river table as the atlas's
// rivers are (world/rivertable.ts → riverFlow, riverheld.wgsl), sleep and settle-then-freeze — headless, every system in
// play, the phone proxy (412 x 915, dpr 2.6, q=low, 1x). Checks and pictures:
//   atlas   a fall on the atlas level (found as rivershot.mjs does, a modest one): its picture and GIF, awake chunks
//   river   the playground's river station: asleep once settled, its water steady (lip, ramp, foot, the run out);
//           the fall close up (GIF); rain over it (it wakes, then freezes again); a surge at its head; its reset
//   breach  the pool drained by the breach and refilled by the reset, its plug back (GIF)
//   cost    the frame at the river station, still and with rain over it
//   node scripts/playwater.mjs [--url http://localhost:5291] [--out C:/Projects/shots88/playwater] [--skip atlas]
//     [--base] (the places build: no river table — the flow model's playground; only the cost and the pictures)
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
const url = opt('url', 'http://localhost:5291');
const out = opt('out', 'C:/Projects/shots88/playwater');
const [W, H] = opt('size', '412x915').split('x').map(Number);
const dpr = Number(opt('dpr', '2.6'));
const q = opt('q', 'low');
const skip = opt('skip', '').split(',');
const base = argv.includes('--base');
const tag = base ? 'base-' : '';
const measureS = Number(opt('measure', '20'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(out, { recursive: true });

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
const page = async () => {
  const p = await browser.newPage();
  p.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[console.${m.type()}] ${m.text().slice(0, 600)}`);
  });
  p.on('pageerror', (e) => fail(`pageerror ${e.message}`));
  return p;
};
const gif = async (p, name, frames, every) => {
  const enc = GIFEncoder();
  for (let i = 0; i < frames; i++) {
    const t = Date.now();
    const png = PNG.sync.read(Buffer.from(await p.screenshot({ type: 'png' })));
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
const fatalCheck = async (p) => {
  const fatal = await p.$eval('.fatal', (e) => e.textContent).catch(() => null);
  if (fatal) throw new Error(`fatal overlay: ${fatal}`);
};
/** the frame's cost over `secs` (the perf overlay open: the GPU's timings) */
const cost = async (p, secs) => {
  await p.evaluate(() => {
    const R = window.reclaimed;
    R.core.host.profiler.resetTotals();
    window.__all = [];
    const tick = () => {
      window.__all.push(performance.now());
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await sleep(secs * 1000);
  return p.evaluate(() => {
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
      gpu: +(pr.gpuTotalMs / n).toFixed(2),
      top: Object.fromEntries([...pr.totalMs].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => [k, +(v / n).toFixed(3)])),
      awake: R.scene.sleep?.awake ?? -1,
    };
  });
};

try {
  // ---- atlas: a fall as the game has it
  if (!skip.includes('atlas')) {
    const v = await page();
    await v.goto(`${url}/?atlas=view`, { waitUntil: 'load' });
    await v.waitForFunction(() => window.reclaimed?.atlas, { timeout: 180000 });
    const fall = await v.evaluate(() => {
      const a = window.reclaimed.atlas;
      const u = a.riverNodes;
      const f = new Float32Array(u.buffer);
      const warmAt = (y) => 0.5 - 0.5 * Math.cos((2 * Math.PI * y) / a.worldH);
      let best = null;
      for (let k = 0; k < u.length / 8; k++) {
        const o = k * 8;
        const nx = u[o + 4];
        const drop = f[o + 2] - f[nx * 8 + 2];
        const warm = warmAt(f[o + 1]);
        // (a modest fall, as the playground's: 6 to 25 cells, in a temperate land, not lava)
        if (u[o + 5] & 1 || warm < 0.45 || warm > 0.85 || drop < 6 || drop > 25 || f[o + 2] > 200) continue;
        if (!best || Math.abs(drop - 10) < Math.abs(best.drop - 10)) best = { at: [Math.floor(f[o]), Math.floor(f[o + 1] / 0.866)], drop: +drop.toFixed(1), w: +f[o + 3].toFixed(1), from: [f[o], f[o + 1], f[o + 2]], to: [f[nx * 8], f[nx * 8 + 1], f[nx * 8 + 2]] };
      }
      return best;
    });
    await v.close();
    console.log(`[atlas] fall ${JSON.stringify(fall)}`);
    if (fall) {
      const p = await page();
      await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&tod=0.35&q=${q}&at=${fall.at.join(',')}`, { waitUntil: 'load' });
      await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
      await sleep(40000);
      await fatalCheck(p);
      const st = await p.evaluate((fall) => {
        const R = window.reclaimed;
        R.stream.auto = false;
        document.getElementById('ui').style.visibility = 'hidden';
        const S = R.stream;
        const m = [(fall.from[0] + fall.to[0]) / 2 - S.origin[0], (fall.from[1] + fall.to[1]) / 2 - S.origin[1] * 0.8660254, (fall.from[2] + fall.to[2]) / 2 - S.oz];
        R.camera.target = m;
        R.camera.zoom = 5;
        return { target: m.map((x) => +x.toFixed(1)), awake: R.scene.sleep?.awake, mode: R.scene.level.rivers };
      }, fall);
      await sleep(3000);
      console.log(`[atlas] ${JSON.stringify(st)}`);
      await p.screenshot({ path: path.join(out, `${tag}atlas-fall.png`) });
      await gif(p, `${tag}atlas-fall.gif`, 16, 250);
      await p.close();
    }
  }

  // ---- the playground
  const p = await page();
  const t0 = Date.now();
  await p.goto(`${url}/?skipmenu=1&level=playground&tutorial=0&q=${q}&perf=1`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.scene?.stationsBar, { timeout: 240000 });
  console.log(`[playground] up in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await sleep(35000);
  await fatalCheck(p);
  await p.evaluate(() => window.reclaimed.scene.tunePanel?.toggle(false));
  const stations = await p.evaluate(() => window.reclaimed.scene.level.stations.map((s) => ({ id: s.id, actions: s.actions.map((a) => a.label) })));
  const pick = (id) => p.evaluate((i) => window.reclaimed.scene.stationsBar.pick(i), stations.findIndex((s) => s.id === id));
  const click = (label) =>
    p.evaluate((label) => {
      const b = [...document.querySelectorAll('.stations button')].find((x) => x.textContent === label);
      if (!b) throw new Error(`no button ${label}`);
      b.click();
    }, label);
  // the river's columns (storage): its head, the ramp, the lip, the foot, the run out, the edge
  const cols = { head: [118, 139], ramp: [160, 132], lip: [195, 137], foot: [200, 137], run: [230, 138], edge: [255, 129] };
  const water = () =>
    p.evaluate(async (cols) => {
      const R = window.reclaimed;
      const f = await R.readBuffer('water');
      const o = {};
      for (const [k, [x, y]] of Object.entries(cols)) {
        let best = 0;
        // (the deepest over the channel's rows there: its middle)
        // (readBuffer gives window order: y · w + x)
        for (let yy = y - 4; yy <= y + 4; yy++) best = Math.max(best, f[yy * R.core.dims.w + x]);
        o[k] = +best.toFixed(3);
      }
      const ex = R.scene.catchWet?.ex;
      return { w: o, awake: R.scene.sleep?.awake ?? -1, wet: +(R.globals.riverWet ?? 1).toFixed(3), shed: ex ? +Math.max(0, ...ex).toFixed(3) : null };
    }, cols);
  const mode = await p.evaluate(() => window.reclaimed.scene.level.rivers ?? 'sim');
  console.log(`[playground] river mode ${mode}; flow model ${await p.evaluate(() => !!window.reclaimed.scene.flow)}`);
  if (!base && mode !== 'table') fail('the playground is not on the held rivers');
  // (settled: asleep)
  const settled = async (maxS) => {
    const t = Date.now();
    let s;
    do {
      await sleep(2000);
      s = await water();
    } while (s.awake > 0 && Date.now() - t < maxS * 1000);
    return { ...s, secs: +((Date.now() - t) / 1000).toFixed(0) };
  };
  await pick('river');
  const s0 = await settled(60);
  await sleep(10000);
  const s1 = await water();
  console.log(`[river] settled ${JSON.stringify(s0)}; 10 s later ${JSON.stringify(s1)}`);
  if (!base) {
    if (s0.awake !== 0) fail(`the river station never fell asleep (${s0.awake} chunks awake)`);
    for (const k of Object.keys(cols)) {
      if (!(s1.w[k] > 0.1)) fail(`the river's ${k} is dry (${s1.w[k]})`);
      if (Math.abs(s1.w[k] - s0.w[k]) > 0.05) fail(`the river's ${k} isn't steady (${s0.w[k]} -> ${s1.w[k]})`);
    }
    if (!(s1.w.lip < 0.45)) fail(`the lip isn't a sheet (${s1.w.lip})`);
  }
  await p.evaluate(() => document.getElementById('ui') && (document.getElementById('ui').style.visibility = 'hidden'));
  await p.screenshot({ path: path.join(out, `${tag}river-station.png`) });
  // the fall close up
  await p.evaluate(() => {
    const R = window.reclaimed;
    R.camera.target = [196, 137.5 * 0.8660254, 16];
    R.camera.zoom = 7;
  });
  await sleep(2500);
  await p.screenshot({ path: path.join(out, `${tag}river-fall.png`) });
  await gif(p, `${tag}river-fall.gif`, 16, 250);
  // (?perf=1: the overlay open, the GPU's timings read)
  const still = await cost(p, measureS);
  console.log(`[cost] river still: ${JSON.stringify(still)}`);
  await p.evaluate(() => document.getElementById('ui') && (document.getElementById('ui').style.visibility = 'visible'));

  // rain over it: wakes, rises, freezes again
  await click('rain');
  await sleep(3000);
  await p.evaluate(() => document.getElementById('ui') && (document.getElementById('ui').style.visibility = 'hidden'));
  const rainCost = await cost(p, measureS);
  console.log(`[cost] river in the rain: ${JSON.stringify(rainCost)}`);
  await gif(p, `${tag}river-rain.gif`, 20, 300);
  const sr = await water();
  console.log(`[river] in the rain ${JSON.stringify(sr)}`);
  if (!base && !(sr.awake > 0)) fail('rain over the river woke nothing');
  if (!base && !(sr.shed > 0.05)) fail(`rain on the river's catchment raised nothing (${sr.shed})`);
  await p.evaluate(() => (window.reclaimed.weather.storms.length = 0));
  const s2 = await settled(120);
  console.log(`[river] after the rain, settled ${JSON.stringify(s2)}`);
  if (!base && s2.awake !== 0) fail(`after the rain the river never froze again (${s2.awake} awake)`);
  await p.evaluate(() => document.getElementById('ui') && (document.getElementById('ui').style.visibility = 'visible'));

  // a surge at its head
  if (stations.find((s) => s.id === 'river').actions.includes('surge')) {
    await pick('river');
    await click('surge');
    await sleep(1500);
    await p.evaluate(() => document.getElementById('ui') && (document.getElementById('ui').style.visibility = 'hidden'));
    await gif(p, `${tag}river-surge.gif`, 24, 400);
    const ss = await water();
    console.log(`[river] surging ${JSON.stringify(ss)}`);
    const s3 = await settled(90);
    console.log(`[river] after the surge, settled ${JSON.stringify(s3)}`);
    if (!base && s3.awake !== 0) fail(`after the surge the river never froze again (${s3.awake} awake)`);
    await p.evaluate(() => document.getElementById('ui') && (document.getElementById('ui').style.visibility = 'visible'));
  }
  // its reset: back as it opened
  await pick('river');
  await click('↺ reset');
  const s4a = await settled(90);
  // (asleep, a held river relaxes to its table — riverheld.wgsl, water_depth.wgsl G.tune.pipesRiverRelax — a while)
  await sleep(15000);
  const s4 = await water();
  console.log(`[river] reset, settled ${JSON.stringify(s4a)}; 15 s later ${JSON.stringify(s4)}`);
  if (!base) for (const k of Object.keys(cols)) if (Math.abs(s4.w[k] - s1.w[k]) > 0.08) fail(`the reset didn't put the river's ${k} back (${s1.w[k]} -> ${s4.w[k]})`);

  // ---- breach: drained, refilled by the reset, its plug back
  {
    await pick('breach');
    await click('↺ reset');
    await sleep(3000);
    const probe = () => p.evaluate(() => window.reclaimed.probe('water', 32, 144, 2));
    const wet0 = await probe();
    await click('breach');
    await sleep(1000);
    await p.evaluate(() => document.getElementById('ui') && (document.getElementById('ui').style.visibility = 'hidden'));
    await gif(p, `${tag}breach.gif`, 30, 400);
    await p.evaluate(() => document.getElementById('ui') && (document.getElementById('ui').style.visibility = 'visible'));
    // (round 112: the water runs at its real speed now — the wait from the flow expected, not the old pipes' rush. The
    // notch (6 rows, 0.866 apart) is a weir under the pool's head over its floor, 1.6: q = sqrt(g) (2h/3)^1.5 a unit
    // width; the pool (radius 9) falls 0.3 in 0.3 A / Q; its water runs the ~20 cells from the lip to the basin's
    // probe at ~2 cells/s. Twice the sum, from the click.)
    const weirQ = 6 * 0.866 * Math.sqrt(9.8) * Math.pow((2 / 3) * 1.6, 1.5);
    const drainS = (0.3 * Math.PI * 81) / weirQ;
    const waitS = 2 * (drainS + 20 / 2);
    console.log(`[breach] expected: weir ${weirQ.toFixed(1)} cells³/s, the pool down 0.3 in ${drainS.toFixed(1)} s; waiting ${waitS.toFixed(0)} s`);
    await sleep(Math.max(0, waitS * 1000 - 13000));
    const wet1 = await probe();
    // (round 112) the dig leaves none of the plug standing: its columns (x 52, 53, rows 141..146) down to the notch's
    // floor (G + 22) or lower
    const stray = await p.evaluate(async () => {
      const R = window.reclaimed;
      const s = new Uint32Array((await R.readBuffer('surface')).buffer);
      const o = [];
      for (let y = 141; y < 147; y++) for (const x of [52, 53]) if ((s[y * R.core.dims.w + x] & 0x1ffff) / 256 > 32.01) o.push([x, y, (s[y * R.core.dims.w + x] & 0x1ffff) / 256]);
      return o;
    });
    if (stray.length) fail(`the breach left the plug standing in ${JSON.stringify(stray)}`);
    const basin = await p.evaluate(() => window.reclaimed.probe('water', 74, 144, 10));
    await click('↺ reset');
    await sleep(2000);
    const wet2 = await probe();
    const plug = await p.evaluate(async () => {
      const R = window.reclaimed;
      const f = new Uint32Array((await R.readBuffer('layers')).buffer);
      const t = R.packed.chunkTable;
      const ci = Math.floor(144 / 16) * R.packed.chunksX + Math.floor(53 / 16);
      const k = t[ci * 2 + 1];
      const b0 = t[ci * 2] + ((144 % 16) * 16 + (53 % 16)) * k;
      const o = [];
      for (let s = 0; s < k; s++) if (f[(b0 + s) * 4 + 1]) o.push(f[(b0 + s) * 4 + 2] & 255);
      return o;
    });
    console.log(`[breach] pool ${wet0.toFixed(2)} -> breached ${wet1.toFixed(2)} (basin ${basin.toFixed(2)}) -> reset ${wet2.toFixed(2)}; plug column mats ${JSON.stringify(plug)}`);
    if (!(wet1 < wet0 - 0.3)) fail(`the breach didn't drain the pool (${wet0} -> ${wet1})`);
    if (!(basin > 0.05)) fail(`nothing reached the basin (${basin})`);
    if (!(wet2 > wet1 + 0.3)) fail(`the reset didn't refill the pool (${wet1} -> ${wet2})`);
    if (!plug.includes(5)) fail("the reset didn't put the plug back");
    await p.screenshot({ path: path.join(out, `${tag}breach-reset.png`) });
  }
  await p.close();
} catch (e) {
  fail(e.stack ?? String(e));
} finally {
  await browser.close();
}
console.log(failed ? 'PLAYWATER: FAILED' : 'PLAYWATER: OK');
process.exit(failed ? 1 : 0);
