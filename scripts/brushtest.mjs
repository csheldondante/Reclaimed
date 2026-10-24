// Landform brushes (round 64): a range dragged along a line rises over a
// second or two (peaks and spurs, highest on the line); a mesa painted over
// an area comes up flat-topped at its level with steep banded cliffs.
// Prints the measures; shots to <out>-{range,mesa}.png.
//
//   node scripts/brushtest.mjs [--url http://localhost:5195] [--out brush] [--level sandbox]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5195');
const out = opt('out', 'brush');
const level = opt('level', 'sandbox');
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
  await page.goto(`${url}/?skipmenu=1&level=${level}&tutorial=0&tod=0.4`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.api?.terrain, { timeout: 90000 });
  await wait(3000);
  // a range: dragged 40 cells east over a second
  const range = await page.evaluate(async () => {
    const R = window.reclaimed;
    const T = R.api.terrain;
    const { cellPos } = await import('/src/world/lattice.ts');
    const { w, h } = R.core.dims;
    const [x0, y0] = cellPos(Math.floor(w / 2) - 20, Math.floor(h / 2) + 40);
    await T.refresh();
    const line = (dx) => [x0 + dx, y0];
    const before = [0, 10, 20, 30, 40].map((dx) => T.heightAt(...line(dx)));
    const off = T.heightAt(x0 + 20, y0 + 16);
    const s = T.raise('range', { radius: 8, height: 22 });
    for (let k = 0; k <= 30; k++) {
      s.to(...line((40 * k) / 30));
      await new Promise((r) => requestAnimationFrame(r));
      await new Promise((r) => setTimeout(r, 25));
    }
    s.end();
    await T.refresh();
    const mid = [0, 10, 20, 30, 40].map((dx, k) => +(T.heightAt(...line(dx)) - before[k]).toFixed(1));
    await new Promise((r) => setTimeout(r, 3000));
    await T.refresh();
    const after = [0, 10, 20, 30, 40].map((dx, k) => +(T.heightAt(...line(dx)) - before[k]).toFixed(1));
    // across the line: highest on it
    const across = [-12, -6, 0, 6, 12].map((dy) => +(T.heightAt(x0 + 20, y0 + dy) - (T.heightAt(x0 + 20, y0 + 16) ?? 0)).toFixed(1));
    const top = T.layersAt(x0 + 20, y0).at(-1);
    R.camera.target = [x0 + 20, y0, before[2] + 8];
    R.camera.zoom = 9;
    return { justAfterDrag: mid, settled: after, across, offLine: +(T.heightAt(x0 + 20, y0 + 16) - off).toFixed(2), top: top.material };
  });
  await wait(1200);
  await page.screenshot({ path: `${out}-range.png` });
  check('range: it rises over time (not all at once), 10+ cells along the line', range.settled.slice(1, 4).every((v) => v > 10) && range.settled[2] > range.justAfterDrag[2] + 1, range);
  check('range: highest on the line, falling off across it', range.across[2] >= range.across[0] && range.across[2] >= range.across[4] && range.across[2] > 8, range.across);

  // a mesa: dabs over a 10-cell area
  const mesa = await page.evaluate(async () => {
    const R = window.reclaimed;
    const T = R.api.terrain;
    const { cellPos } = await import('/src/world/lattice.ts');
    const { w, h } = R.core.dims;
    const [cx, cy] = cellPos(Math.floor(w / 2) - 10, Math.floor(h / 2) - 70);
    await T.refresh();
    const g0 = T.heightAt(cx, cy);
    const s = T.raise('mesa', { radius: 7, level: g0 + 12 });
    for (let k = 0; k <= 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      s.to(cx + Math.cos(a) * 4, cy + Math.sin(a) * 4);
      await new Promise((r) => requestAnimationFrame(r));
    }
    s.end();
    await new Promise((r) => setTimeout(r, 3500));
    await T.refresh();
    const tops = [];
    for (let dy = -4; dy <= 4; dy += 2) for (let dx = -4; dx <= 4; dx += 2) tops.push(T.heightAt(cx + dx, cy + dy));
    const mean = tops.reduce((a, b) => a + b, 0) / tops.length;
    const spread = Math.max(...tops) - Math.min(...tops);
    // the edge: the steepest drop along a line out of it
    let steep = 0;
    for (let r = 6; r < 16; r += 1) steep = Math.max(steep, T.heightAt(cx + r, cy) - T.heightAt(cx + r + 1, cy));
    const mats = new Set(T.layersAt(cx, cy).filter((l) => l.z1 > g0 - 1).map((l) => l.material));
    R.camera.target = [cx, cy, g0 + 6];
    R.camera.zoom = 11;
    return { level: +(g0 + 12).toFixed(1), meanTop: +mean.toFixed(2), spread: +spread.toFixed(2), steepest: +steep.toFixed(2), mats: [...mats] };
  });
  await wait(1200);
  await page.screenshot({ path: `${out}-mesa.png` });
  check('mesa: flat at its level', Math.abs(mesa.meanTop - mesa.level) < 1.2 && mesa.spread < 1.5, mesa);
  check('mesa: cliffs at the edge (a drop of 3+ in one cell)', mesa.steepest >= 3, mesa);
  check('mesa: banded (sandstone and stone)', mesa.mats.includes('sandstone') && mesa.mats.includes('stone'), mesa.mats);
} finally {
  await browser.close();
}
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
if (failed) process.exit(1);
