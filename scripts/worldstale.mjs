// (round 114, `worldstore`) A world saved by one build, opened by another: what the store does with records made by
// another land generator. One browser profile (--profile: the IndexedDB the user's phone keeps), one origin (--url:
// IndexedDB is per origin, so serve each build on the same port in turn):
//   node scripts/worldstale.mjs --url http://localhost:5291 --profile <dir> --mode save --out a.png   // every region of the window touched and saved
//   node scripts/worldstale.mjs --url http://localhost:5291 --profile <dir> --mode load --out b.png   // opened again: restored / mismatched / dropped
// --q extra query (e.g. "&world=new"). Prints the streamer's store stats and every [worldsave] line.
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5291');
const profile = opt('profile');
const mode = opt('mode', 'load');
const out = opt('out');
const wait = Number(opt('wait', 35000));
const q = opt('q', '');
const at = opt('at', '11956,15471');
if (!profile) throw new Error('--profile <dir> (a browser profile kept between runs)');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  userDataDir: profile,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
  defaultViewport: { width: 412, height: 915, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
  protocolTimeout: 900000,
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
      console.log('console.error', t.slice(0, 400));
    } else if (t.startsWith('[worldsave]')) console.log('  page:', t.slice(0, 300));
  });
  await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=low&at=${at}${q}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream?.store, { timeout: 240000 });
  await sleep(wait);
  const fatal = await p.$eval('.fatal', (e) => e.textContent).catch(() => null);
  if (fatal) throw new Error(`fatal: ${fatal}`);
  if (mode === 'save') {
    const n = await p.evaluate(async () => {
      const S = window.reclaimed.stream;
      S.touch(0, 0, S.W, S.H);
      await S.saveAll();
      return S.store.totals();
    });
    console.log('saved', JSON.stringify(n));
  }
  const s = await p.evaluate(() => {
    const S = window.reclaimed.stream;
    const st = S.stats;
    const q = (a, f) => (a.length ? +[...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * f))].toFixed(1) : null);
    const ss = S.store.stats;
    // (a region from disk: `load` the whole of it — the worker's IndexedDB read and inflate, waited for, and the decode;
    // `worker` the worker's own ms a get)
    const load = { n: S.times.load.length, p50: q(S.times.load, 0.5), max: q(S.times.load, 1), workerMsPerGet: ss.gets ? +(ss.getMs / ss.gets).toFixed(1) : null };
    return { world: S.store.world, origin: [...S.origin], restored: st.restored, loaded: st.loaded, mismatched: st.mismatched, saved: st.saved, deleted: ss.deleted, store: S.store.totals(), load };
  });
  console.log('stats', JSON.stringify(s));
  if (out) await p.screenshot({ path: out });
} finally {
  await browser.close();
}
if (failed) {
  console.log(`${failed} errors`);
  process.exit(1);
}
