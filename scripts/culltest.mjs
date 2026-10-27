// Round 85 (simcull, sim/cull.ts): what sleeping chunks hold while the passes aren't dispatched over them.
// The atlas level at rest (every chunk asleep): its water, flux, fire, veg, moisture and contamination read; a flood
// and a fire set near the camera (their chunks wake); read again while they're awake, once they've fallen asleep,
// and a few seconds later. Asleep, nothing may change (the flows frozen, drawn moving from their flux); what the
// flood and fire left must still be there; the chunks never woken must hold what they held at the start.
//   node scripts/culltest.mjs [--url http://localhost:5207] [--extra "&simcull=0"]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5207');
const extra = opt('extra', '');
let failed = false;
const check = (name, ok, info) => {
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(info)}`);
};
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
  defaultViewport: { width: 412, height: 915 },
  protocolTimeout: 600000,
});
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => {
    failed = true;
    console.log('pageerror', e.message);
  });
  p.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) {
      failed = true;
      console.log('console.error:', m.text().slice(0, 800));
    }
  });
  await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=low${extra}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream && window.reclaimed?.api, { timeout: 240000 });
  await new Promise((r) => setTimeout(r, 8000));
  const r = await p.evaluate(async () => {
    const R = window.reclaimed;
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const { w, h } = R.core.dims;
    const names = ['water', 'flux', 'fire', 'veg', 'moisture', 'contam', 'lava', 'oil'];
    const read = async () => Object.fromEntries(await Promise.all(names.map(async (n) => [n, new Float32Array((await R.core.readBuffer(n)).slice().buffer)])));
    const per = (n, a) => a[n].length / (w * h);
    const chunkOf = (i) => Math.floor(Math.floor(i / w) / 16) * (w / 16) + Math.floor((i % w) / 16);
    /** columns that differ between two reads, by field — `only`: chunks to look at (null: all) */
    const diff = (a, b, only) => {
      const out = {};
      for (const n of names) {
        const s = per(n, a);
        let d = 0;
        for (let i = 0; i < w * h; i++) {
          if (only && !only.has(chunkOf(i))) continue;
          for (let k = 0; k < s; k++) if (a[n][i * s + k] !== b[n][i * s + k]) { d++; break; }
        }
        out[n] = d;
      }
      return out;
    };
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    const awake = () => R.core.sleep?.awake ?? -1;
    const A = await read();
    const awake0 = awake();
    const t = R.core.camera.target;
    const W = R.api.water;
    W.flood(t[0], t[1], { radius: 5, depth: 3 });
    // (the grassiest dry column within 40 of the camera)
    const { cellPos } = await import('/src/world/lattice.ts');
    const cx0 = Math.floor(t[0]), cy0 = Math.floor(t[1] / 0.866);
    let best = -1;
    for (let y = Math.max(0, cy0 - 40); y < Math.min(h, cy0 + 40); y++)
      for (let x = Math.max(0, cx0 - 40); x < Math.min(w, cx0 + 40); x++) {
        const i = y * w + x;
        if (A.water[i] < 0.01 && (best < 0 || A.veg[i] > A.veg[best])) best = i;
      }
    const [fx, fy] = cellPos(best % w, Math.floor(best / w));
    R.api.fire.ignite(fx, fy, { radius: 3 });
    await sleep(2500);
    const awake1 = awake();
    // (the chunks woken: their bits clear in the mask now)
    const woke = new Set();
    const mask = R.core.globals.sleep;
    for (let c = 0; c < (w / 16) * (h / 16); c++) if (mask && !((mask[c >> 5] >>> (c & 31)) & 1)) woke.add(c);
    const M = await read();
    // (8 s an event's, and the drowse)
    await sleep(11000);
    const awake2 = awake();
    const B = await read();
    await sleep(4000);
    const C = await read();
    const never = new Set();
    for (let c = 0; c < (w / 16) * (h / 16); c++) if (!woke.has(c)) never.add(c);
    // (the woken chunks' neighbours take water in through the frozen flux edge: left out of the "never" check)
    const far = new Set([...never].filter((c) => {
      const cx = c % (w / 16), cy = Math.floor(c / (w / 16));
      for (const d of woke) if (Math.abs((d % (w / 16)) - cx) <= 1 && Math.abs(Math.floor(d / (w / 16)) - cy) <= 1) return false;
      return true;
    }));
    return {
      tiles: R.core.world.tiles ? R.core.world.tiles.chunks : null,
      awake0, awake1, awake2, woke: woke.size,
      waterA: +sum(A.water).toFixed(1), waterM: +sum(M.water).toFixed(1), waterB: +sum(B.water).toFixed(1), waterC: +sum(C.water).toFixed(1),
      fireM: +sum(M.fire).toFixed(1), fireB: +sum(B.fire).toFixed(1),
      asleepChanged: diff(B, C, null),
      farChanged: diff(A, C, far),
      flowingB: (() => { let n = 0; for (let i = 0; i < w * h; i++) { let s = 0; for (let k = 0; k < 6; k++) s += Math.abs(B.flux[i * 6 + k]); if (s > 1e-3) n++; } return n; })(),
    };
  });
  console.log(JSON.stringify(r));
  check('the flood and the fire woke their chunks', r.awake1 > 0 && r.woke > 0, { awake0: r.awake0, awake1: r.awake1, woke: r.woke });
  check('the flood raised the water while awake', r.waterM > r.waterA + 1 && r.fireM > 0, { A: r.waterA, M: r.waterM, fireM: r.fireM });
  check('then everything fell asleep', r.awake2 === 0, { awake2: r.awake2 });
  check('asleep, nothing changes (water, flux, fire, veg, moisture, contam, lava, oil)', Object.values(r.asleepChanged).every((d) => d === 0), r.asleepChanged);
  check('what the flood left is still there asleep', r.waterC > r.waterA + 1 && r.waterC === r.waterB, { A: r.waterA, B: r.waterB, C: r.waterC });
  // (veg left out: leaves and seeds land on it everywhere — particles write it, asleep or not)
  check('the chunks never woken (nor next to one) hold what they held', Object.entries(r.farChanged).every(([n, d]) => n === 'veg' || d === 0), r.farChanged);
  check('rivers still flow asleep (frozen flux kept)', r.flowingB > 100, { flowing: r.flowingB });
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
