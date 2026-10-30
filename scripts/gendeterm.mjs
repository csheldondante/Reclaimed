// (round 114, `worldstore`) Is a region's land a function of the seed alone? The user (DECISIONS round 114): places
// "regenerated from the atlas data the first time you visit each run (as long as it can be deterministic from seed)".
// On the atlas level as the phone runs it (q=low 412x915, every system on), a few regions made as the window makes
// them (Streamer.genHash: regionInto into a spare slot, hashed) — in one order, in another, after a warp far away, and
// on a second page load that starts somewhere else and visits them in reverse — and every hash compared.
//   node scripts/gendeterm.mjs [--url http://localhost:5293] [--wait 35000]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5293');
const wait = Number(opt('wait', 35000));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
  defaultViewport: { width: 412, height: 915, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
  protocolTimeout: 900000,
});
let failed = 0;
const R = 64;
// (world corners: the spawn's window, a region at its edge, one 20 regions east, one with a settlement's stamps
// round the spawn — 11956,15471 is the default spawn of seed 1)
const A = [11776 + 2 * R, 15296 + 2 * R];
const E = [11776, 15296];
const F = [11776 + 20 * R, 15296 + 4 * R];
const G = [11776 + 3 * R, 15296 + 1 * R];
const spots = { A, E, F, G };

async function open(at) {
  const p = await browser.newPage();
  p.on('pageerror', (e) => {
    failed++;
    console.log('pageerror', e.message);
  });
  p.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) {
      failed++;
      console.log('console.error', m.text().slice(0, 400));
    }
  });
  await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=low&worldsave=0&at=${at}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream?.store, { timeout: 240000 });
  await sleep(wait);
  return p;
}
const hashes = (p, order) =>
  p.evaluate(async (order, spots) => {
    const S = window.reclaimed.stream;
    const out = {};
    for (const k of order) {
      while (S.busy) await new Promise((r) => setTimeout(r, 30));
      out[k] = await S.genHash(spots[k][0], spots[k][1]);
    }
    return { oz: S.oz, out };
  }, order, spots);

const runs = [];
try {
  const p = await open('11956,15471');
  runs.push(['page 1, A E F G', await hashes(p, ['A', 'E', 'F', 'G'])]);
  runs.push(['page 1, G F E A', await hashes(p, ['G', 'F', 'E', 'A'])]);
  // (for the prefetch note: how much of a region's bytes are zero — what a sparse upload would skip)
  const nz = await p.evaluate(async (A) => {
    const c = await window.reclaimed.stream.compareGen(A[0], A[1]);
    return { words: c.words, nonzero: c.nonzero, regionMb: +(window.reclaimed.stream.layout.bytes / 1048576).toFixed(2) };
  }, A);
  console.log('region A bytes', JSON.stringify(nz), `nonzero ${((100 * nz.nonzero) / nz.words).toFixed(1)}%`);
  await p.evaluate(async () => {
    const S = window.reclaimed.stream;
    await S.warp(S.origin[0] + 40 * S.R, S.origin[1] + 12 * S.R, S.oz, true);
  });
  await sleep(8000);
  runs.push(['page 1 after a warp 40 regions away, F A G E', await hashes(p, ['F', 'A', 'G', 'E'])]);
  await p.close();
  const q = await open(`${F[0] + 32},${F[1] + 32}`);
  runs.push(['page 2 (spawned at F), G F E A', await hashes(q, ['G', 'F', 'E', 'A'])]);
  await q.close();
} finally {
  await browser.close();
}
for (const [what, r] of runs) console.log(what, `oz ${r.oz}`, Object.entries(r.out).map(([k, v]) => `${k}: cols ${v.cols.toString(16)} bytes ${v.bytes.toString(16)}`).join(' | '));
for (const k of Object.keys(spots)) {
  const cols = new Set(runs.map(([, r]) => r.out[k].cols));
  const bytesSameOz = new Map();
  for (const [, r] of runs) (bytesSameOz.get(r.oz) ?? bytesSameOz.set(r.oz, new Set()).get(r.oz)).add(r.out[k].bytes);
  const same = cols.size === 1 && [...bytesSameOz.values()].every((s) => s.size === 1);
  if (!same) failed++;
  console.log(`${same ? 'ok  ' : 'FAIL'} region ${k} (${spots[k]}): ${cols.size} column hash(es), bytes per oz ${[...bytesSameOz].map(([oz, s]) => `${oz}:${s.size}`).join(' ')}`);
}
if (failed) {
  console.log(`${failed} failures`);
  process.exit(1);
}
