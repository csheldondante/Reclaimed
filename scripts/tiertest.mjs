// The window slides in z (round 69): at an escarpment (cliffs taller than the window), the
// window slides up a tier and back, and every column's solid intervals (world z: what's in the
// window joined with what's outside it) come back as they were; a region frozen at one oz and
// thawed at another is cut again; the water that runs off the cliff's top into columns with
// nothing in the window drains.
//   node scripts/tiertest.mjs [--url http://localhost:5203] [--out tier] [--kind escarpment]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5203');
const out = opt('out', 'tier');
// (round 78: 'plateau' — any region on a plateau landform, whose edges are its cliffs; or a kind's name)
const kind = opt('kind', 'plateau');
const results = [];
let failed = false;
const check = (name, ok, info) => {
  results.push(ok);
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(info)}`);
};
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1200,800'],
  defaultViewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
  protocolTimeout: 10 * 60 * 1000,
});
try {
  // where: the edge of the largest temperate region of the kind (its centre, then towards a border)
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto(`${url}/?atlas=view`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.atlas, { timeout: 180000 });
  const at = await page.evaluate((kind) => {
    const a = window.reclaimed.atlas;
    let best = null;
    a.defs.forEach((d) => {
      if (kind === 'plateau' ? d.words[49] !== 2 : d.kind !== kind) return;
      const warm = 0.5 - 0.5 * Math.cos(2 * Math.PI * d.stat.cy);
      const score = d.stat.area * (warm > 0.45 && warm < 0.85 ? 4 : 1);
      if (!best || score > best.score) best = { score, cx: d.stat.cx, cy: d.stat.cy };
    });
    if (!best) return null;
    // walk out from its middle (each way in turn) until the ground 3 texels on is 120 or more below: the cliff's top
    const n = a.p.n;
    const ty0 = Math.floor(best.cy * n);
    const tx0 = Math.floor(best.cx * n);
    const H = (x, y) => a.hmac[(((y % n) + n) % n) * n + (((x % n) + n) % n)];
    for (const [ex, ey] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let tx = tx0;
      let ty = ty0;
      for (let k = 0; k < 400; k++) {
        if (H(tx + 3 * ex, ty + 3 * ey) < H(tx, ty) - 120) {
          return { at: [Math.floor(((tx + 0.5) / n) * a.p.cols), Math.floor(((ty + 0.5) / n) * a.p.rows)], top: H(tx, ty), foot: H(tx + 3 * ex, ty + 3 * ey) };
        }
        tx += ex;
        ty += ey;
      }
    }
    return null;
  }, kind);
  await page.close();
  if (!at) throw new Error(`no ${kind} in this atlas`);
  console.log('cliff at', JSON.stringify(at));

  const lv = await browser.newPage();
  lv.on('pageerror', (e) => console.log('pageerror:', e.message));
  lv.on('console', (m) => m.type() === 'error' && console.log('console:', m.text().slice(0, 300)));
  await lv.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&tod=0.35&q=high&at=${at.at.join(',')}`, { waitUntil: 'load' });
  await lv.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  await new Promise((r) => setTimeout(r, 4000));
  await lv.evaluate(() => (document.getElementById('ui').style.visibility = 'hidden'));
  await lv.screenshot({ path: `${out}-0.png` });
  const r = await lv.evaluate(async () => {
    const R = window.reclaimed;
    const S = R.stream;
    S.auto = false;
    const L = await import('/src/world/layout.ts');
    const { w, h, zMax } = R.core.dims;
    // every column's solid intervals in world z (loose ground left out: it slumps while the sim runs)
    const solid = (m) => m === 1 || m === 23 || m === 30 || m === 33 || m === 35;
    const snap = async () => {
      const buf = await R.core.readBuffer('layers');
      const slots = new Uint32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      const cols = [];
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const ins = L.readColumn(R.packed, slots, x, y);
          cols.push(L.joinColumn(ins, S.oz, S.outside[y * w + x]).filter((iv) => solid(iv.mat)));
        }
      return cols;
    };
    const diff = (a, b) => {
      let cols = 0;
      let worst = 0;
      for (let i = 0; i < a.length; i++) {
        const A = a[i];
        const B = b[i];
        let d = A.length === B.length ? 0 : 99;
        if (!d) for (let k = 0; k < A.length; k++) d = Math.max(d, Math.abs(A[k].z0 - B[k].z0), Math.abs(A[k].z1 - B[k].z1), A[k].mat === B[k].mat ? 0 : 99);
        if (d > 0.01) cols++;
        worst = Math.max(worst, d);
      }
      return { cols, worst: +worst.toFixed(3) };
    };
    let tall = 0;
    let empty = 0;
    for (let i = 0; i < w * h; i++) {
      if (S.outside[i].some((iv) => iv.z0 >= S.oz + zMax - 1e-4)) tall++;
      if (R.map.surface[i] === 0) empty++;
    }
    const oz0 = S.oz;
    const a0 = await snap();
    const t0 = performance.now();
    await S.slideZ(32);
    const upMs = performance.now() - t0;
    const a1 = await snap();
    await S.slideZ(-32);
    const a2 = await snap();
    // a region frozen at one oz, thawed at another: east, up, west
    await S.slide(64, 0);
    await S.slideZ(32);
    const before = { ...S.stats };
    await S.slide(-64, 0);
    await new Promise((r) => setTimeout(r, 500));
    const after = { ...S.stats };
    await S.slideZ(-32);
    const a3 = await snap();
    return { oz0, ozNow: S.oz, tall, empty, upMs: +upMs.toFixed(1), up: diff(a0, a1), back: diff(a0, a2), round: diff(a0, a3), resliced: after.resliced - before.resliced, fitted: after.fitted, stats: after };
  });
  console.log(JSON.stringify(r));
  check('at a tall cliff, the land is taller than the window: columns reach above it or lie below it', r.tall + r.empty > 0, { oz: r.oz0, tall: r.tall, empty: r.empty });
  check('up a tier: every column the same in world z', r.up.cols === 0, r.up);
  check('and back: the same', r.back.cols === 0, { ...r.back, ms: r.upMs });
  check('a region left at one oz comes back cut at another, the same in world z', r.resliced > 0 && r.round.cols === 0, { resliced: r.resliced, ...r.round });
  // up again by hand and look
  await lv.evaluate(async () => {
    await window.reclaimed.stream.slideZ(32);
    window.reclaimed.camera.zoom *= 0.6;
  });
  await new Promise((r) => setTimeout(r, 2500));
  await lv.screenshot({ path: `${out}-up.png` });
  await lv.close();
} finally {
  await browser.close();
}
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
if (failed) process.exit(1);
