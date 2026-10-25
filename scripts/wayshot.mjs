// Round 79: the ways (atlas/ways.ts) — what was built (points of each kind, lifts), then walks in at a lift,
// switchbacks, a tunnel, a bridge and a plaza (temperate ones) and shoots each.
//   node scripts/wayshot.mjs [--url http://localhost:5207] [--out way] [--which lift,switchbacks,tunnel,bridge,plaza] [--zoom 1.1] [--win 256]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5207');
const out = opt('out', 'way');
const which = opt('which', 'lift,switchbacks,tunnel,bridge,plaza').split(',');
const zoom = Number(opt('zoom', 1.1));
const win = opt('win', '');
const pick = Number(opt('pick', 0));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1200,800'],
  defaultViewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`${url}/?atlas=view`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.atlas, { timeout: 180000 });
  const spots = await page.evaluate((pick) => {
    const a = window.reclaimed.atlas;
    const W = a.ways;
    const warm = (y) => 0.5 - 0.5 * Math.cos((2 * Math.PI * y) / a.worldH);
    const ok = (y) => warm(y) > 0.55 && warm(y) < 0.95;
    const cell = (x, y) => [Math.floor(x), Math.floor(y / 0.866)];
    const names = ['road', 'tunnel', 'bridge', 'switchbacks', 'lift', 'plaza'];
    const first = {};
    const seen = {};
    for (const p of W.points) {
      const k = names[p.kind];
      if (!ok(p.y)) continue;
      seen[k] = (seen[k] ?? 0) + 1;
      // (the pick-th way of the kind: a point well into its stretch)
      if (!first[k] || (first[k].way !== p.way && (first[k].n ?? 0) < pick)) first[k] = { at: cell(p.x, p.y), z: +p.z.toFixed(1), way: p.way, n: (first[k]?.n ?? -1) + 1 };
    }
    const l = W.lifts.filter((l) => ok(l.y))[pick] ?? W.lifts[0];
    if (l) first.lift = { at: cell(l.x, l.y), z: [+l.z0.toFixed(1), +l.z1.toFixed(1)] };
    return { counts: W.counts, lifts: W.lifts.length, ms: W.ms, spots: first, timings: a.timings['ways (cpu)'] };
  }, pick);
  console.log(JSON.stringify(spots));
  await page.close();
  for (const k of which) {
    const s = spots.spots[k];
    if (!s) continue;
    const lv = await browser.newPage();
    lv.on('pageerror', (e) => console.log(k, 'pageerror', e.message));
    await lv.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&tod=0.35&q=high&at=${s.at.join(',')}${win ? `&win=${win}` : ''}`, { waitUntil: 'load' });
    await lv.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
    await new Promise((r) => setTimeout(r, 6000));
    const st = await lv.evaluate(async (zoom) => {
      document.getElementById('ui').style.visibility = 'hidden';
      const R = window.reclaimed;
      R.stream.auto = false;
      R.camera.zoom = zoom;
      await new Promise((r) => setTimeout(r, 2500));
      return { oz: R.stream.oz };
    }, zoom);
    console.log(k, JSON.stringify(st));
    await lv.screenshot({ path: `${out}-${k}.png` });
    await lv.close();
  }
} finally {
  await browser.close();
}
