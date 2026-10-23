// Layer pulls (round 52, BACKLOG E2): world.terrain.pull / pullLayer in the
// sandbox. Checks: a one-shot stone pull under sand (the stone rises, the
// sand rides up on it: its volume unchanged); a drag with a growing height,
// called every frame on overlapping spots (no double counting: the ridge is
// as high as asked, not the sum); through (bricks on the stone crack to
// rubble); pulled down (the run shrinks, what's on it sinks). Prints the
// measures, saves shots.
//
//   node scripts/pulltest.mjs [--url http://localhost:5181] [--out pull]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5181');
const out = opt('out', 'pull');
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
  await page.goto(`${url}/?skipmenu=1&level=sandbox&tutorial=0&tod=0.4`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.api, { timeout: 90000 });
  await wait(3000);
  // a helper in the page: totals over a disc (each material's thickness summed, the top heights)
  await page.evaluate(() => {
    window.__disc = async (x, y, r) => {
      const T = window.reclaimed.api.terrain;
      await T.refresh();
      const tot = {};
      let maxTop = -1;
      let sumTop = 0;
      let n = 0;
      for (let dy = -r; dy <= r; dy += 0.5)
        for (let dx = -r; dx <= r; dx += 0.5) {
          if (dx * dx + dy * dy > r * r) continue;
          const ls = T.layersAt(x + dx, y + dy) ?? [];
          for (const l of ls) tot[l.material] = (tot[l.material] ?? 0) + (l.z1 - l.z0);
          const top = ls.length ? ls[ls.length - 1].z1 : 0;
          maxTop = Math.max(maxTop, top);
          sumTop += top;
          n++;
        }
      for (const k in tot) tot[k] = +(tot[k] / n).toFixed(3);
      return { perColumn: tot, maxTop: +maxTop.toFixed(2), meanTop: +(sumTop / n).toFixed(2) };
    };
  });
  const site = await page.evaluate(async () => {
    const R = window.reclaimed;
    const { cellPos } = await import('/src/world/lattice.ts');
    const { w, h } = R.core.dims;
    const [x, y] = cellPos(Math.floor(w / 2) + 30, Math.floor(h / 2) - 25);
    R.camera.target[0] = x;
    R.camera.target[1] = y;
    R.camera.zoom *= 3;
    // (still: no wind or rain to move the sand while it's measured)
    return { x, y };
  });
  // 1. a one-shot pull of stone, 6 high, radius 8
  const before = await page.evaluate((s) => window.__disc(s.x, s.y, 12), site);
  const centreB = await page.evaluate((s) => window.__disc(s.x, s.y, 0.6), site);
  await page.screenshot({ path: `${out}-0.png` });
  await page.evaluate((s) => window.reclaimed.api.terrain.pullLayer('stone', s.x, s.y, { radius: 8, height: 6 }), site);
  await wait(400);
  const after = await page.evaluate((s) => window.__disc(s.x, s.y, 12), site);
  const centreA = await page.evaluate((s) => window.__disc(s.x, s.y, 0.6), site);
  const looseB = Object.entries(before.perColumn).filter(([k]) => k !== 'stone').reduce((a, [, v]) => a + v, 0);
  const looseA = Object.entries(after.perColumn).filter(([k]) => k !== 'stone').reduce((a, [, v]) => a + v, 0);
  // (the disc's mean rise is the dome's volume: 6 × (8/12)² / 3 ≈ 0.89 with no roughness)
  check('pull: stone rises ~6 at the centre, ~0.9 on average over the disc', centreA.meanTop - centreB.meanTop > 4.5 && centreA.meanTop - centreB.meanTop < 7.5 && Math.abs(after.meanTop - before.meanTop - 0.89) < 0.3, { centre: [centreB.meanTop, centreA.meanTop], mean: [before.meanTop, after.meanTop] });
  check('pull lift: what lay on it rode up, its volume kept', Math.abs(looseA - looseB) < 0.05, { looseBefore: +looseB.toFixed(3), looseAfter: +looseA.toFixed(3) });
  await wait(2500);
  await page.screenshot({ path: `${out}-1-pulled.png` });
  // 1b. shaken off: the same pull twice on sand, unshaken and shaken hard; the sand left on top after 3 s
  const pair = [{ x: site.x - 25, y: site.y - 15, shake: 0 }, { x: site.x + 5, y: site.y - 30, shake: 1 }];
  const onTop0 = [];
  for (const q of pair) onTop0.push(await page.evaluate((q) => window.__disc(q.x, q.y, 2.5), q));
  await page.evaluate((pair) => {
    for (const q of pair) window.reclaimed.api.terrain.pullLayer('stone', q.x, q.y, { radius: 7, height: 6, shake: q.shake });
  }, pair);
  await wait(3000);
  const onTop = [];
  for (const q of pair) onTop.push(await page.evaluate((q) => window.__disc(q.x, q.y, 2.5), q));
  const looseOf = (d) => Object.entries(d.perColumn).filter(([k]) => k !== 'stone' && k !== 'concrete').reduce((a, [, v]) => a + v, 0);
  const kept = onTop.map((d, k) => +(looseOf(d) / Math.max(looseOf(onTop0[k]), 1e-3)).toFixed(2));
  check('shaken: less loose cover stays on the pulled top', kept[1] < kept[0] - 0.1, { keptUnshaken: kept[0], keptShaken: kept[1] });
  // 2. a drag: 40 frames along 24 cells, the height growing 0 → 5, each frame overlapping the last
  const ridge = { x: site.x - 30, y: site.y + 20 };
  const ridgeBefore = await page.evaluate((s) => window.__disc(s.x + 12, s.y, 1), ridge);
  const endBefore = await page.evaluate((s) => window.__disc(s.x + 24, s.y, 1), ridge);
  await page.evaluate(async (s) => {
    const T = window.reclaimed.api.terrain;
    const st = T.pull('stone');
    for (let k = 0; k <= 40; k++) {
      st.to(s.x + (24 * k) / 40, s.y, { radius: 4, height: (5 * k) / 40 });
      // (and the same spot again: overlapping calls must not stack)
      st.to(s.x + (24 * k) / 40, s.y, { radius: 4, height: (5 * k) / 40 });
      await new Promise((r) => requestAnimationFrame(r));
    }
    st.end();
  }, ridge);
  await wait(400);
  const ridgeMid = await page.evaluate((s) => window.__disc(s.x + 12, s.y, 1), ridge);
  const ridgeEnd = await page.evaluate((s) => window.__disc(s.x + 24, s.y, 1), ridge);
  const midRise = ridgeMid.meanTop - ridgeBefore.meanTop;
  const endRise = ridgeEnd.meanTop - endBefore.meanTop;
  check('drag: a ridge rising along it (mid ~2.5, end ~5), no double counting', midRise > 1.5 && midRise < 3.5 && endRise > 3.5 && endRise < 6.2, { midRise: +midRise.toFixed(2), endRise: +endRise.toFixed(2) });
  // 3. through: bricks built on the ground, stone pulled up through them
  const wall = { x: site.x + 30, y: site.y + 10 };
  await page.evaluate((s) => window.reclaimed.api.terrain.build(s.x, s.y, 'brick', { radius: 4, layers: 2 }), wall);
  await wait(1500);
  const bricks = await page.evaluate((s) => window.__disc(s.x, s.y, 2), wall);
  await page.evaluate((s) => window.reclaimed.api.terrain.pullLayer('stone', s.x, s.y, { radius: 5, height: 4, mode: 'through' }), wall);
  await wait(300);
  const cracked = await page.evaluate((s) => window.__disc(s.x, s.y, 2), wall);
  check('through: the bricks on it crack to rubble', (bricks.perColumn.brick ?? 0) > 0.5 && (cracked.perColumn.brick ?? 0) < 0.1 && (cracked.perColumn.rubble ?? 0) > 0.5, { bricks: bricks.perColumn, cracked: cracked.perColumn });
  // 4. pulled down: the stone of the first pull sinks back 3
  await page.evaluate((s) => window.reclaimed.api.terrain.pullLayer('stone', s.x, s.y, { radius: 8, height: -3 }), site);
  await wait(400);
  const sunk = await page.evaluate((s) => window.__disc(s.x, s.y, 12), site);
  check('pulled down: the stone sinks', sunk.maxTop < after.maxTop - 2 && (sunk.perColumn.stone ?? 0) < (after.perColumn.stone ?? 0), { after: after.maxTop, sunk: sunk.maxTop, stone: [after.perColumn.stone, sunk.perColumn.stone] });
  await wait(2000);
  await page.evaluate((s) => {
    window.reclaimed.camera.target[0] = s.x;
    window.reclaimed.camera.target[1] = s.y + 10;
  }, site);
  await wait(500);
  await page.screenshot({ path: `${out}-2-all.png` });
} finally {
  await browser.close();
}
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
if (failed) process.exit(1);
