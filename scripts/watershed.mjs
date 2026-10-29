// Round 109 (watershed): does a storm raise only the rivers it rains on — its own catchment's, and the reaches downstream
// of them a while later — and not a neighbouring river? The atlas level as the deployed page runs it (every system,
// 1x), at the phone tier. Picks from the kept river nodes (scene.catchWet): river A (a small one: what drains through
// it mostly inside a storm's reach), a node D down A's river past the storm's reach, and river B (on another river
// tree, past the storm's reach); holds a storm over A for --secs, and logs each node's storm water (catchWet.ex), the
// field's and the held water's depth round each (the wet columns within 3 cells), every --every seconds.
//   node scripts/watershed.mjs [--url http://localhost:5241] [--secs 90] [--every 10] [--at 15024,14337] [--win 512]
//     [--size 412x915] [--out C:/Projects/shots88/watershed] [--wait 35000] [--json out.json]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5241');
const secs = Number(opt('secs', 90));
const every = Number(opt('every', 10));
const out = opt('out', '');
const wait = Number(opt('wait', 35000));
const [vw, vh] = opt('size', '412x915').split('x').map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', `--window-size=${vw},${vh}`],
  defaultViewport: { width: vw, height: vh, deviceScaleFactor: 1 },
  protocolTimeout: 900000,
});
let bad = false;
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => {
    bad = true;
    console.log('pageerror', e.message);
  });
  p.on('console', (m) => m.type() === 'error' && console.log('console.error', m.text().slice(0, 300)));
  await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=low&at=${opt('at', '15024,14337')}&win=${opt('win', 512)}&world=ws-${Date.now().toString(36)}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.scene?.catchWet?.live?.length > 0, { timeout: 240000 });
  await sleep(wait);
  const pick = await p.evaluate(() => {
    const R = window.reclaimed;
    const cw = R.scene.catchWet;
    const { w, h } = R.core.dims;
    const RH = Math.sqrt(3) / 2;
    const nodes = R.scene.opts.atlas.atlas.riverNodes;
    const f = new Float32Array(nodes.buffer);
    const ref = R.scene.opts.atlas.atlas.riverCatchments.ref;
    const pos = new Map();
    for (let j = 0; j < cw.live.length; j++) pos.set(cw.live[j], [cw.livePos[j * 2], cw.livePos[j * 2 + 1]]);
    const next = (k) => nodes[k * 8 + 4];
    // (a node's tree: the last kept node down its river)
    const root = (k) => {
      for (let s = 0; s < 5000; s++) {
        const n = next(k);
        if (n === k || !pos.has(n)) return k;
        k = n;
      }
      return k;
    };
    const inner = (k) => {
      const [x, y] = pos.get(k);
      return x > 60 && y > 60 && x < w - 60 && y < h * RH - 60 && !(nodes[k * 8 + 5] & 1) && f[k * 8 + 6] > 0;
    };
    const cand = [...pos.keys()].filter(inner).sort((a, b) => ref[a] - ref[b]);
    const far = (a, b) => Math.hypot(pos.get(a)[0] - pos.get(b)[0], pos.get(a)[1] - pos.get(b)[1]);
    let best = null;
    // (the kept nodes upstream of k, and where the rain on them falls: their catchment samples in the window)
    const upOf = (A) => {
      const up = new Set();
      for (const k of pos.keys()) {
        let j = k;
        for (let s = 0; s < 2000; s++) {
          if (j === A) {
            up.add(k);
            break;
          }
          const n = next(j);
          if (n === j || !pos.has(n)) break;
          j = n;
        }
      }
      return up;
    };
    // A: a river whose catchment lies in the window (the storm at its samples' middle); D: down A, > 170 from the
    // storm, inside; B: another river tree, > 200 from the storm
    for (const A of cand) {
      if (ref[A] < 120) continue;
      const up = upOf(A);
      let sx = 0;
      let sy = 0;
      let sn = 0;
      for (let i = 0; i < cw.sx.length; i++)
        if (up.has(cw.sn[i]) && cw.sx[i] > 0 && cw.sy[i] > 0 && cw.sx[i] < w && cw.sy[i] < h * RH) {
          sx += cw.sx[i];
          sy += cw.sy[i];
          sn++;
        }
      if (sn < 12) continue;
      const st = [sx / sn, sy / sn];
      const fromStorm = (k) => Math.hypot(pos.get(k)[0] - st[0], pos.get(k)[1] - st[1]);
      let D = -1;
      for (let k = A, s = 0; s < 400; s++) {
        const n = next(k);
        if (n === k || !pos.has(n)) break;
        k = n;
        if (inner(k) && fromStorm(k) > 170) {
          D = k;
          break;
        }
      }
      if (D < 0) continue;
      const rA = root(A);
      const B = cand.find((b) => root(b) !== rA && fromStorm(b) > 200 && far(D, b) > 60 && ref[b] >= 120);
      if (B === undefined) continue;
      best = { A, D, B, up: [...up], st, samplesInWindow: sn };
      break;
    }
    if (!best) return null;
    const col = (k) => {
      const [x, y] = pos.get(k);
      const r = Math.floor(y / RH);
      return [Math.floor(x - 0.5 * (r & 1)), r];
    };
    // the others go: one storm, ours
    R.weather.storms.length = 0;
    const [ax, ay] = best.st;
    const s = R.weather.spawn(ax, ay);
    s.hold = { x: ax, y: ay, until: 1e9, strength: 1 };
    window.__ws = { ...best, cols: { A: col(best.A), D: col(best.D), B: col(best.B) }, ref: { A: ref[best.A], D: ref[best.D], B: ref[best.B] }, storm: [ax, ay, s.radius] };
    return window.__ws;
  });
  if (!pick) throw new Error('no pair of rivers found in the window');
  console.log('pick', JSON.stringify(pick));
  const snap = () =>
    p.evaluate(async () => {
      const R = window.reclaimed;
      const ws = window.__ws;
      const cw = R.scene.catchWet;
      const water = await R.readBuffer('water');
      const { w } = R.core.dims;
      const depth = ([cx, cy]) => {
        let s = 0;
        let n = 0;
        for (let y = cy - 3; y <= cy + 3; y++)
          for (let x = cx - 3; x <= cx + 3; x++) {
            const d = water[y * w + x];
            if (d > 0.05) {
              s += d;
              n++;
            }
          }
        return n ? +(s / n).toFixed(3) : 0;
      };
      return {
        t: +R.core.sim.tick,
        base: +R.globals.riverWet.toFixed(3),
        storms: R.weather.storms.length,
        ex: { A: +cw.ex[ws.A].toFixed(3), D: +cw.ex[ws.D].toFixed(3), B: +cw.ex[ws.B].toFixed(3) },
        depth: { A: depth(ws.cols.A), D: depth(ws.cols.D), B: depth(ws.cols.B) },
        ms: +cw.ms.toFixed(3), msMean: +cw.msMean.toFixed(4), live: cw.live.length, fieldMs: +R.scene.wetField.msMean.toFixed(4), uploads: R.scene.wetField.uploads,
        // (debug: where the window is, the storm, the rain on what drains through A, the rain on every kept node)
        origin: [...R.scene.stream.origin],
        storm: R.weather.storms.map((s) => [+s.x.toFixed(1), +s.y.toFixed(1), +s.intensity.toFixed(2), +R.weather.rainAt(s.x, s.y).toFixed(2)]),
        rainUpA: +ws.up.reduce((a, k) => a + cw.rain[k], 0).toFixed(1),
        rainAll: +[...cw.live].reduce((a, k) => a + cw.rain[k], 0).toFixed(1),
        samples: cw.sx.length,
      };
    });
  const shot = async (name) => {
    if (!out) return;
    fs.mkdirSync(out, { recursive: true });
    await p.screenshot({ path: `${out}/${name}.png` });
  };
  const look = (k) =>
    p.evaluate((k) => {
      const R = window.reclaimed;
      const [cx, cy] = window.__ws.cols[k];
      R.scene.drive = null;
      R.scene.pan = null;
      R.camera.target = [cx + 0.5, (cy + 0.5) * (Math.sqrt(3) / 2), R.camera.target[2]];
      R.camera.zoom = 8;
    }, k);
  const rows = [await snap()];
  console.log(JSON.stringify(rows[0]));
  await shot('start');
  for (let t = every; t <= secs; t += every) {
    await sleep(every * 1000);
    const r = await snap();
    rows.push(r);
    console.log(JSON.stringify(r));
    if (t === every) await shot('storm');
  }
  for (const k of ['D', 'B']) {
    await look(k);
    await sleep(1500);
    await shot(`${k}-after`);
  }
  if (opt('json', '')) fs.writeFileSync(opt('json', ''), JSON.stringify({ pick, rows }, null, 1));
} finally {
  await browser.close();
}
if (bad) process.exit(1);
