// The town's plan mode (round 65): blocks planned, not placed; a crew of
// workers carries bricks from a pile to them and each stands once it has
// had its cost; a block planned away is taken down and its worth carried
// back to the pile. Prints the measures; shots to <out>-*.png.
//
//   node scripts/buildtest.mjs [--url http://localhost:5195] [--out build] [--level sandbox] [--secs 90]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5195');
const out = opt('out', 'build');
const level = opt('level', 'sandbox');
const secs = Number(opt('secs', '90'));
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
  await page.goto(`${url}/?skipmenu=1&level=${level}&tutorial=0&tod=0.4${opt('extra', '')}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.api?.agents, { timeout: 90000 });
  await wait(3000);
  const run = async (stage) =>
    page.evaluate(
      async (secs, stage) => {
        const R = window.reclaimed;
        const api = R.api;
        const A = api.agents;
        const T = api.terrain;
        const { cellPos } = await import('/src/world/lattice.ts');
        const { w, h } = R.core.dims;
        const town = api.town({ seed: 3 });
        const g = town.grid;
        let s = window.__b;
        if (!s) {
          await T.refresh();
          // flat dry ground near the middle: a pile of bricks, the house 12 cells off
          let site = null;
          for (let r = 0; r < 60 && !site; r += 4) {
            for (let k = 0; k < 16 && !site; k++) {
              const [x, y] = cellPos(w / 2 + Math.cos(k * 0.39) * r, h / 2 + Math.sin(k * 0.39) * r);
              const z = T.heightAt(x, y);
              let flat = true;
              for (const [dx, dy] of [[6, 0], [-6, 0], [0, 6], [0, -6], [14, 0], [18, 4]]) if (Math.abs((T.heightAt(x + dx, y + dy) ?? -99) - z) > 1.5 || T.materialAt(x + dx, y + dy) === 'water') flat = false;
              if (flat && T.materialAt(x, y) !== 'water') site = { x, y };
            }
          }
          if (!site) return { error: 'no flat ground' };
          const pile = { x: site.x, y: site.y };
          let laid = 0;
          for (let k = 0; k < 9; k++) laid += await T.put(pile.x + (k % 3) - 1, pile.y + Math.floor(k / 3) - 1, 'brick', 4);
          const c0 = g.cellAtWorld(site.x + 14, site.y);
          const c1 = g.nbr[c0 * 4] >= 0 ? g.nbr[c0 * 4] : g.nbr[c0 * 4 + 1];
          town.plan(c0, 0, true);
          town.plan(c1, 0, true);
          town.plan(c0, 1, true);
          const ids = A.spawn(6, pile.x + 2, pile.y + 2, { kind: 'worker', group: 10, spread: 0.8 });
          const crew = api.buildCrew({ units: ids, groups: [10, 11, 12], fields: [0, 1], town, pile: { ...pile, radius: 2.5 }, materials: ['brick'] });
          s = window.__b = { crew, pile, laid, cells: [c0, c1], planned: town.delta().length };
          R.camera.target = [site.x + 8, site.y, T.heightAt(site.x, site.y) + 2];
          R.camera.zoom = 9;
        }
        const { crew } = s;
        if (stage === 'down') {
          town.plan(s.cells[0], 1, false);
          crew.done = false;
        }
        const t0 = performance.now();
        const seen = [];
        while (performance.now() - t0 < secs * 1000) {
          const { units } = await A.sync();
          window.__lastUnits = units;
          crew.update(units);
          if (performance.now() - t0 > 2000 && crew.done && !town.delta().length && ![...crew.workers.values()].some((wk) => wk.step === 'home' || wk.step === 'busy')) break;
          if (seen.length < 1 && crew.stats.built === 1) seen.push(+((performance.now() - t0) / 1000).toFixed(1));
          await new Promise((r) => requestAnimationFrame(r));
        }
        return {
          secs: +((performance.now() - t0) / 1000).toFixed(1),
          firstBlockAt: seen[0] ?? null,
          laid: +s.laid.toFixed(2),
          planned: s.planned,
          left: town.delta().length,
          stats: JSON.parse(JSON.stringify(crew.stats)),
          stands: s.cells.map((c) => town.mask[c]),
          workers: [...crew.workers.entries()].map(([id, wk]) => {
            const u = (window.__lastUnits ?? []).find((u) => u.id === id);
            const [cx, cy] = wk.job ? g.centre(wk.job.cell) : [NaN, NaN];
            return { step: wk.step, t: +wk.t.toFixed(1), state: u?.state, dPile: u ? +Math.hypot(u.x - s.pile.x, u.y - s.pile.y).toFixed(1) : null, dJob: u ? +Math.hypot(u.x - cx, u.y - cy).toFixed(1) : null, carry: A.carrying(id)?.amount ?? 0 };
          }),
        };
      },
      secs,
      stage,
    );
  const up = await run('up');
  console.log(JSON.stringify(up));
  if (up.error) throw new Error(up.error);
  await wait(1500);
  await page.screenshot({ path: `${out}-built.png` });
  check('the plan is built: three blocks, nothing left', up.left === 0 && up.stats.built === 3, { left: up.left, built: up.stats.built, stands: up.stands, secs: up.secs });
  check('it used the pile: 6 cells³ of brick a block', Math.abs((up.stats.used.brick ?? 0) - 18) < 1e-3, up.stats.used);
  check('nothing stood before its bricks came (the first block after trips)', up.firstBlockAt !== null && up.firstBlockAt > 2, { firstBlockAt: up.firstBlockAt });
  const down = await run('down');
  console.log(JSON.stringify(down));
  check('a block planned away is taken down, its worth back on the pile', down.left === 0 && down.stats.takenDown === 1 && down.stats.returned > 5.9, { left: down.left, takenDown: down.stats.takenDown, returned: down.stats.returned, stands: down.stands });
  await wait(1500);
  await page.screenshot({ path: `${out}-down.png` });
} finally {
  await browser.close();
}
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
if (failed) process.exit(1);
