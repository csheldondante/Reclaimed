// The town (round 65): blocks on the irregular grid stand as real matter —
// walls, floors, a window, a roof over the top, arches under a block over
// nothing; removing a block takes its matter away; dust that was in the way
// ends up on top. Prints the measures; shots to <out>-*.png.
//
//   node scripts/towntest.mjs [--url http://localhost:5195] [--out town] [--level sandbox]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5195');
const out = opt('out', 'town');
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
  const r = await page.evaluate(async () => {
    const R = window.reclaimed;
    const api = R.api;
    const T = api.terrain;
    await T.refresh();
    const t0 = performance.now();
    const town = api.town({ seed: 3 });
    const gridMs = performance.now() - t0;
    const g = town.grid;
    const { cellPos } = await import('/src/world/lattice.ts');
    const { w } = R.core.dims;
    // a cell near the middle, and a row of its neighbours
    let c = g.cellAtWorld(...cellPos(w / 2, R.core.dims.h / 2));
    const row = [c];
    for (let k = 0; k < 2; k++) {
      const n = g.nbr[row[row.length - 1] * 4 + 1];
      if (n >= 0) row.push(n);
    }
    // a house: two levels in the first, one beside it, and a block over
    // nothing two cells along (its first level over a gap: an arch)
    town.set([{ cell: row[0], level: 0 }, { cell: row[0], level: 1 }, { cell: row[1], level: 0 }], true);
    if (row[2] !== undefined) town.add(row[2], 1);
    await new Promise((res) => setTimeout(res, 1000));
    await T.refresh();
    await T.refresh();
    const mats = (col) => T.layersAt(...cellPos(col % w, Math.floor(col / w))).map((l) => `${l.material}:${l.z0.toFixed(1)}-${l.z1.toFixed(1)}`);
    const cols = g.columns[row[0]];
    // a column in the middle (a floor, a floor, a roof) and one at its edge (a wall)
    const [cx, cy] = g.centre(row[0]);
    let mid = cols[0];
    let edge = cols[0];
    let md = Infinity;
    let ed = -1;
    for (const col of cols) {
      const [x, y] = cellPos(col % w, Math.floor(col / w));
      const d = Math.hypot(x - cx, y - cy);
      if (d < md) [md, mid] = [d, col];
      if (d > ed) [ed, edge] = [d, col];
    }
    const base = town.base[row[0]];
    const midL = T.layersAt(...cellPos(mid % w, Math.floor(mid / w)));
    const plaster = midL.filter((l) => l.material === 'plaster' && l.z0 >= base - 0.01);
    const roof = midL.filter((l) => l.material === 'tile');
    const all = cols.map((col) => T.layersAt(...cellPos(col % w, Math.floor(col / w))));
    const tiles = all.filter((ls) => ls.some((l) => l.material === 'tile')).length;
    const walls = all.filter((ls) => ls.some((l) => l.material === 'plaster' && l.z1 - l.z0 > 2)).length;
    // the gap cell under the block over nothing
    let arch = null;
    if (row[2] !== undefined) {
      const a = g.columns[row[2]].map((col) => T.layersAt(...cellPos(col % w, Math.floor(col / w))));
      const b2 = town.base[row[2]];
      arch = {
        pillars: a.filter((ls) => ls.some((l) => l.material === 'plaster' && l.z0 <= b2 + 0.01 && l.z1 >= b2 + 3.9)).length,
        open: a.filter((ls) => !ls.some((l) => l.z0 < b2 + 2 && l.z1 > b2 + 0.5 && l.material === 'plaster')).length,
        n: a.length,
      };
    }
    R.camera.target = [cx, cy, base + 4];
    R.camera.zoom = 14;
    return { gridMs: +gridMs.toFixed(1), cells: g.count, colsPerCell: +(g.columns.reduce((s, c) => s + c.length, 0) / g.count).toFixed(1), row, base, mid: mats(mid), edge: mats(edge), floors: plaster.length, roof: roof.length, tiles, walls, n: cols.length, arch };
  });
  console.log(JSON.stringify(r));
  await wait(1500);
  await page.screenshot({ path: `${out}-house.png` });
  check('grid: cells of 20-60 columns', r.colsPerCell > 15 && r.colsPerCell < 70, { cells: r.cells, colsPerCell: r.colsPerCell, ms: r.gridMs });
  check('a middle column: two floors and a roof', r.floors >= 2 && r.roof === 1, r.mid);
  check('an edge column: a wall', r.edge.some((s) => s.startsWith('plaster') && +s.split(':')[1].split('-')[1] - +s.split(':')[1].split('-')[0] > 2), r.edge);
  check('the roof covers the cell', r.tiles === r.n, { tiles: r.tiles, n: r.n });
  if (r.arch) check('a block over nothing: pillars at its corners, open under the rest', r.arch.pillars >= 2 && r.arch.open > r.arch.n / 2, r.arch);

  // remove: the top block goes, the lower one gets the roof
  const rm = await page.evaluate(async (row) => {
    const R = window.reclaimed;
    const T = R.api.terrain;
    const town = R.api.town();
    const { cellPos } = await import('/src/world/lattice.ts');
    const { w } = R.core.dims;
    const g = town.grid;
    town.remove(row[0], 1);
    await new Promise((res) => setTimeout(res, 1000));
    await T.refresh();
    await T.refresh();
    const cols = g.columns[row[0]];
    const top = Math.max(...cols.map((col) => T.layersAt(...cellPos(col % w, Math.floor(col / w))).filter((l) => l.material === 'tile' || l.material === 'plaster').reduce((m, l) => Math.max(m, l.z1), 0)));
    return { base: town.base[row[0]], top: +top.toFixed(2) };
  }, r.row);
  check('removing the upper block: the roof comes down a level', rm.top < rm.base + 4 + 4.5, rm);
  await page.screenshot({ path: `${out}-removed.png` });
} finally {
  await browser.close();
}
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
if (failed) process.exit(1);
