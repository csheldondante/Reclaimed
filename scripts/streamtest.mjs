// The streamed world (round 66): the window slides a region at a time; what
// leaves is frozen and comes back exactly as it was left; what's new is
// generated and meets the land beside it without a seam; the camera's view
// is the same across a slide. Prints the measures; shots to <out>-*.png.
//
//   node scripts/streamtest.mjs [--url http://localhost:5199] [--out stream]
import puppeteer from 'puppeteer-core';
// (perfopt: --extra "&flag=v" appended to the page's URL)
const EXTRA = process.argv.includes('--extra') ? process.argv[process.argv.indexOf('--extra') + 1] : '';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5199');
const out = opt('out', 'stream');
const browser = await puppeteer.launch({
  executablePath: opt('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'),
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1200,800'],
  defaultViewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
  protocolTimeout: 10 * 60 * 1000,
});
let failed = false;
const results = [];
const check = (name, ok, data) => {
  results.push(ok);
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(data)}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => {
    failed = true;
    console.log('pageerror:', e.message);
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) {
      failed = true;
      console.log('console.error:', m.text().slice(0, 800));
    }
  });
  await page.goto(`${url}/?skipmenu=1&level=stream&tutorial=0&tod=0.4${EXTRA}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.stream, { timeout: 120000 });
  await wait(3000);
  await page.evaluate(() => (window.reclaimed.stream.auto = false));

  // a brick tower and a pool in the region at window cells 32,128 (the left column of regions)
  const mark = await page.evaluate(async () => {
    const R = window.reclaimed;
    const T = R.api.terrain;
    const { cellPos } = await import('/src/world/lattice.ts');
    const [x, y] = cellPos(32, 128);
    await T.refresh();
    const g0 = T.heightAt(x, y);
    await T.put(x, y, 'brick', 9);
    await new Promise((r) => setTimeout(r, 1500));
    await T.refresh();
    R.camera.target = [128, 128 * 0.866, g0 + 4];
    R.camera.zoom = 4;
    return { x, y, g0: +g0.toFixed(2), top: +T.heightAt(x, y).toFixed(2), layers: T.layersAt(x, y).map((l) => `${l.material}:${l.z0.toFixed(1)}-${l.z1.toFixed(1)}`), world: R.stream.toWorld(32, 128) };
  });
  console.log(JSON.stringify(mark));
  check('the brick tower stands before the slide', mark.top > mark.g0 + 3, mark);
  await page.screenshot({ path: `${out}-0.png` });

  // two slides east: the tower's region is frozen, two new columns of regions are made
  const east = await page.evaluate(async () => {
    const R = window.reclaimed;
    const S = R.stream;
    const T = R.api.terrain;
    const before = [...R.camera.target];
    const t0 = performance.now();
    await S.slide(64, 0);
    const first = performance.now() - t0;
    await S.slide(64, 0);
    await new Promise((r) => setTimeout(r, 2500));
    await T.refresh();
    // the seam: the land on either side of where the last generated column of regions begins (local x 191 | 192)
    const { cellPos } = await import('/src/world/lattice.ts');
    let worst = 0;
    let sum = 0;
    for (let y = 8; y < 248; y += 4) {
      const a = T.heightAt(...cellPos(190, y));
      const b = T.heightAt(...cellPos(191, y));
      const c = T.heightAt(...cellPos(192, y));
      const d = T.heightAt(...cellPos(193, y));
      // a step across the seam against the steps on either side of it
      const step = Math.abs(c - b) - Math.max(Math.abs(b - a), Math.abs(d - c));
      worst = Math.max(worst, step);
      sum += Math.abs(c - b);
    }
    return { origin: [...S.origin], stats: { ...S.stats }, firstMs: +first.toFixed(1), frozen: S.frozen.size, camera: [before.map((v) => +v.toFixed(1)), R.camera.target.map((v) => +v.toFixed(1))], seamWorst: +worst.toFixed(2), seamMean: +(sum / 60).toFixed(2) };
  });
  console.log(JSON.stringify(east));
  check('two slides east: the origin moved 128, four regions a slide frozen and made', east.origin[0] === 128 && east.stats.frozen === 8 && east.stats.generated === 8, east);
  check('the camera moved with the land', Math.abs(east.camera[0][0] - east.camera[1][0] - 128) < 0.01, east.camera);
  check('no seam where new land meets the old', east.seamWorst < 2.5, { worst: east.seamWorst, mean: east.seamMean });
  await page.screenshot({ path: `${out}-east.png` });

  // the view across one slide: the same picture (camera and land move together)
  const same = await page.evaluate(async () => {
    const R = window.reclaimed;
    const S = R.stream;
    R.camera.target[0] = 128 + 20;
    await new Promise((r) => setTimeout(r, 1500));
    return null;
  });
  await page.screenshot({ path: `${out}-pre.png` });
  await wait(1500);
  await page.screenshot({ path: `${out}-pre2.png` });
  await page.evaluate(async () => {
    await window.reclaimed.stream.slide(64, 0);
    await new Promise((r) => setTimeout(r, 1500));
  });
  await page.screenshot({ path: `${out}-post.png` });

  // back west three times: the tower's region is thawed where it was
  const back = await page.evaluate(async () => {
    const R = window.reclaimed;
    const S = R.stream;
    const T = R.api.terrain;
    for (let k = 0; k < 3; k++) await S.slide(-64, 0);
    await new Promise((r) => setTimeout(r, 2500));
    await T.refresh();
    const { cellPos } = await import('/src/world/lattice.ts');
    const [x, y] = cellPos(32, 128);
    R.camera.target = [x + 6, y, T.heightAt(x, y)];
    R.camera.zoom = 10;
    return { origin: [...S.origin], stats: { ...S.stats }, world: S.toWorld(32, 128), top: +T.heightAt(x, y).toFixed(2), layers: T.layersAt(x, y).map((l) => `${l.material}:${l.z0.toFixed(1)}-${l.z1.toFixed(1)}`) };
  });
  console.log(JSON.stringify(back));
  check('back where it began: the tower is there, as it was left', back.origin[0] === 0 && back.layers.some((l) => l.startsWith('brick')) && Math.abs(back.top - mark.top) < 0.6, { before: mark.layers, after: back.layers });
  check('it came back from the frozen store (thawed, not made again)', back.stats.thawed >= 4, back.stats);
  await wait(1500);
  await page.screenshot({ path: `${out}-back.png` });

  // the sim runs on across slides (no errors, stats come back)
  const run = await page.evaluate(async () => {
    const R = window.reclaimed;
    const t0 = R.globals.tick;
    await new Promise((r) => setTimeout(r, 3000));
    return { ticks: R.globals.tick - t0 };
  });
  check('the sim keeps ticking', run.ticks > 60, run);

  // on its own: the camera pans south-west far enough for three slides, the window follows
  const auto = await page.evaluate(async () => {
    const R = window.reclaimed;
    const S = R.stream;
    R.camera.target[0] = 128;
    R.camera.target[1] = 128 * 0.866;
    S.auto = true;
    const n0 = S.stats.slides;
    const o0 = [...S.origin];
    let moved = 0;
    for (let f = 0; f < 600 && S.stats.slides - n0 < 3; f++) {
      R.camera.target[1] += 1.5;
      moved += 1.5;
      await new Promise((r) => requestAnimationFrame(r));
    }
    await new Promise((r) => setTimeout(r, 2000));
    return { slides: S.stats.slides - n0, origin: [...S.origin], from: o0, moved: +moved.toFixed(1), y: +(R.camera.target[1] / 0.866).toFixed(1), lastMs: S.stats.lastMs, frozenHeld: S.frozen.size };
  });
  console.log(JSON.stringify(auto));
  check('panning: the window follows on its own, the camera stays inside it', auto.slides === 3 && auto.origin[1] === auto.from[1] + 192 && auto.y > 64 && auto.y < 192, auto);
  await page.screenshot({ path: `${out}-auto.png` });
} finally {
  await browser.close();
}
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
if (failed) process.exit(1);
