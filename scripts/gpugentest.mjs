// Round 102 (`gpugen`): the GPU's region finishing (atlas/finish.wgsl) against the CPU's (?gpugen=0: landFrom, the
// geysers, stampWays, the stamps, cutRegion, toBody). On the atlas level as the phone runs it (q=low 412x915, every
// system on), each region is made both ways at the window's oz (Streamer.compareGen) and the pool slot's bytes compared
// word by word — the pages, every kept buffer and texture — and what the CPU keeps (tops, ground, outside, relief, the
// structural box). Regions: ones round the start, ones under the nearest settlements (their plans' stamps), ones on
// the ways (roads, bridges, tunnels, plazas), ones with geysers' sinter. Then the raw ground a settlement is planned on
// (Atlas.rawGround on the GPU against regionLand's raw land on the CPU).
//   node scripts/gpugentest.mjs [--url http://localhost:5293] [--wait 35000] [--n 40] [--extra "&gpugen=0"]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5293');
const wait = Number(opt('wait', 35000));
const at = opt('at', '11956,15471');
const extra = opt('extra', '');
const n = Number(opt('n', 40));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
  defaultViewport: { width: 412, height: 915, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
  protocolTimeout: 1800000,
});
let failed = 0;
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => {
    failed++;
    console.log('pageerror', e.message);
  });
  p.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !t.includes('404')) {
      failed++;
      console.log('console.error', t.slice(0, 600));
    }
  });
  await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=low&perf=1&worldsave=0&at=${at}${extra}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream?.store || document.querySelector('.fatal'), { timeout: 240000 });
  await sleep(wait);
  const fatal = await p.$eval('.fatal', (e) => e.textContent).catch(() => null);
  if (fatal) throw new Error(`fatal: ${fatal}`);
  const res = await p.evaluate(async (n) => {
    const R = window.reclaimed;
    const S = R.stream;
    const A = R.atlas;
    const RG = S.R;
    const cols = A.p.cols;
    const rows = A.p.rows;
    const snap = (x, y) => [((Math.floor(x / RG) * RG) % cols + cols) % cols, ((Math.floor(y / RG) * RG) % rows + rows) % rows];
    const spots = new Map();
    const add = (why, x, y) => {
      const [a, b] = snap(x, y);
      const k = `${a},${b}`;
      if (!spots.has(k)) spots.set(k, { why, x: a, y: b });
    };
    const [ox, oy] = S.origin;
    // round the start (outside the window: never made yet)
    for (let k = 0; k < 8; k++) add('near', ox + (k % 4) * RG - 2 * RG, oy + S.H + RG * (1 + Math.floor(k / 4)));
    // under the nearest settlements
    const ss = R.settlements?.seeds ?? [];
    const d = (s) => Math.hypot(((s.box.x0 - ox + cols * 1.5) % cols) - cols / 2, ((s.box.y0 - oy + rows * 1.5) % rows) - rows / 2);
    for (const s of [...ss].sort((a, b) => d(a) - d(b)).slice(0, 6)) add(`settlement:${s.rec.id}`, s.box.x0 + s.box.w / 2, s.box.y0 + s.box.h / 2);
    // on the ways: a point of each kind (the nearest of each)
    const ROW_H = Math.sqrt(3) / 2;
    const byKind = new Map();
    for (const q of A.ways.points) {
      const dd = Math.hypot(((q.x - ox + cols * 1.5) % cols) - cols / 2, ((q.y / ROW_H - oy + rows * 1.5) % rows) - rows / 2);
      const b = byKind.get(q.kind);
      if (!b || dd < b[0]) byKind.set(q.kind, [dd, q]);
    }
    for (const [kind, [, q]] of byKind) add(`way:${kind}`, q.x, q.y / ROW_H);
    // geysers: the regions near the start with vents
    for (let r = 2; r < 60 && [...spots.values()].filter((v) => v.why === 'geyser').length < 3; r++)
      for (let k = 0; k < 8; k++) {
        const x = ox + Math.round(Math.cos(k * 0.785 + r) * r * RG);
        const y = oy + Math.round(Math.sin(k * 0.785 + r) * r * RG);
        const [a, b] = snap(x, y);
        if (A.geysersIn(a, b, RG, RG).length) add('geyser', a, b);
      }
    // and others further out till there are n
    for (let k = 0; spots.size < n; k++) add('far', ox + Math.cos(k * 2.399963) * (8 + (k % 17)) * RG, oy + Math.sin(k * 2.399963) * (8 + (k % 17)) * RG);
    const out = [];
    for (const v of spots.values()) {
      const w0 = A.waysStamped;
      const st0 = R.settlements?.stats.stamped ?? 0;
      const r = await S.compareGen(v.x, v.y);
      out.push({ ...v, ...r, waysCols: A.waysStamped - w0, stampCols: (R.settlements?.stats.stamped ?? 0) - st0 });
    }
    // the raw ground a settlement is planned on
    const raw = [];
    for (const v of [...spots.values()].filter((v) => v.why.startsWith('settlement') || v.why.startsWith('way')).slice(0, 6)) {
      const cpu = await A.regionLand(v.x, v.y, 64, 64, Infinity, false, true);
      const gpu = await A.rawGround(v.x, v.y, 64, 64);
      let dg = 0;
      let dw = 0;
      let dt = 0;
      let dv = 0;
      for (let i = 0; i < 64 * 64; i++) {
        const c = cpu.cols[i];
        if (!Object.is(Math.fround(c.length ? c[c.length - 1].z1 : 0), gpu.ground[i])) dg++;
        if (!Object.is(cpu.water[i], gpu.water[i])) dw++;
        if ((c.length ? c[c.length - 1].mat : 0) !== gpu.top[i]) dt++;
        if (!Object.is(cpu.vegetation[i], gpu.veg[i])) dv++;
      }
      raw.push({ at: [v.x, v.y], why: v.why, ground: dg, water: dw, top: dt, veg: dv });
    }
    return { out, raw, stats: S.stats, plans: R.settlements?.stats };
  }, n);
  // the world API reads land made on the GPU: a warp (every region of the window made by finish.wgsl), then the
  // terrain module's heightAt / floorAt / layersAt against the layers read back
  const api = await p.evaluate(async () => {
    const R = window.reclaimed;
    const S = R.stream;
    const made0 = S.stats.gpuMade;
    const [ox, oy] = S.origin;
    await S.warp(ox + 30 * S.R, oy + 12 * S.R, S.oz);
    const madeByWarp = S.stats.gpuMade - made0;
    await new Promise((r) => setTimeout(r, 3000));
    const T = R.api.terrain;
    await T.refresh();
    const { readColumn } = await import('/src/world/layout.ts');
    const slots = new Uint32Array((await R.core.readBuffer('layers')).buffer);
    const ROW_H = Math.sqrt(3) / 2;
    let n = 0;
    let badH = 0;
    let badF = 0;
    let badL = 0;
    const first = [];
    for (let k = 0; k < 600; k++) {
      const cx = 8 + ((k * 97) % (S.W - 16));
      const cy = 8 + ((k * 57) % (S.H - 16));
      const x = cx + 0.5 + 0.5 * (cy & 1);
      const y = (cy + 0.5) * ROW_H;
      const col = readColumn(R.core.packed, slots, cx, cy);
      if (!col.length) continue;
      n++;
      const top = col[col.length - 1].z1;
      const h = T.heightAt(x, y);
      const fl = T.floorAt(x, y, top);
      const ls = T.layersAt(x, y);
      if (h === null || h < top - 1e-3) badH++;
      if (fl === null || Math.abs(fl - top) > 1e-3) badF++;
      if (!ls || ls.length !== col.length || Math.abs(ls[ls.length - 1].z1 - top) > 1e-6) badL++;
      if ((h === null || h < top - 1e-3 || fl === null || Math.abs(fl - top) > 1e-3) && first.length < 5) first.push({ cx, cy, top, h, fl });
    }
    return { madeByWarp, n, badH, badF, badL, first };
  });
  console.log(`world API on a warped (GPU-made) window: ${api.madeByWarp} regions made on the GPU; ${api.n} columns: heightAt under the top ${api.badH}, floorAt off ${api.badF}, layersAt off ${api.badL} ${JSON.stringify(api.first)}`);
  if (!api.madeByWarp || api.badF || api.badL) failed++;
  let bad = 0;
  let words = 0;
  for (const r of res.out) {
    words += r.words;
    const okR = r.diff === 0 && Object.keys(r.meta).length === 0;
    if (!okR) bad++;
    console.log(`${okR ? 'same' : 'DIFF'} ${r.why.padEnd(22)} ${r.x},${r.y}  cpu ${r.cpuMs} ms gpu ${r.gpuMs} ms  ${(100 * r.nonzero / r.words).toFixed(0)}% words set, ways ${r.waysCols} stamps ${r.stampCols} cols${okR ? '' : `  words ${r.diff} ${JSON.stringify(r.parts)} meta ${JSON.stringify(r.meta)}\n     ${JSON.stringify(r.first)}`}`);
  }
  for (const r of res.raw) {
    const okR = !r.ground && !r.water && !r.top && !r.veg;
    if (!okR) bad++;
    console.log(`${okR ? 'same' : 'DIFF'} raw ${r.why.padEnd(18)} ${r.at}  ${okR ? '' : JSON.stringify(r)}`);
  }
  console.log(`\n${res.out.length} regions (${(words * 4 / 1e6).toFixed(1)} MB of slots) and ${res.raw.length} raw tiles compared: ${bad ? `${bad} DIFFER` : 'all identical'}`);
  console.log('plans', JSON.stringify(res.plans));
  if (bad) failed++;
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
