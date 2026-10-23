// Agents in the world's wind (round 57): units feel windAt past a calm, ÷
// mass. Three crowds of standing workers and one of ogres, each alone: a
// calm control (the map's own wind); a breeze of 12 cells/s along +x (over
// the calm, short of the grip: they drift, none thrown); a blast of 22 (~16
// where they stand: the field smooths it) out from just beside of a crowd of workers and of ogres (the workers are
// thrown, the ogres, three times as heavy, hold). Then all get up. Prints
// the measures.
//
//   node scripts/windtest.mjs [--url http://localhost:5185] [--out wind]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5185');
const out = opt('out', 'wind');
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
  await page.waitForFunction(() => window.reclaimed?.agents && window.reclaimed?.api?.wind, { timeout: 90000 });
  await wait(3000);
  await page.evaluate(async () => {
    const R = window.reclaimed;
    const A = R.agents;
    const { cellPos } = await import('/src/world/lattice.ts');
    const { w, h } = R.core.dims;
    const at = (dx, dy) => cellPos(Math.floor(w / 2) + dx, Math.floor(h / 2) + dy);
    const W = (window.__w = { spots: {}, ids: {}, start: {}, units: [], tumbled: {} });
    const crowd = (nm, dx, dy, kind) => {
      const [x, y] = at(dx, dy);
      W.spots[nm] = [x, y];
      W.ids[nm] = new Set(A.spawn(12, x, y, { group: 5, kind, spread: 2 }));
      W.tumbled[nm] = new Set();
    };
    crowd('calm', -40, 20, 'worker');
    crowd('breeze', -10, 20, 'worker');
    crowd('blastWorkers', 20, 20, 'worker');
    crowd('blastOgres', 20, 45, 'ogre');
    A.follow(5, -1);
    R.camera.target[0] = at(5, 25)[0];
    R.camera.target[1] = at(5, 25)[1];
    R.camera.zoom *= 2;
    const loop = async () => {
      if (window.__stop) return;
      const s = await A.sync();
      W.units = s.units;
      for (const u of s.units) for (const nm in W.ids) if (W.ids[nm].has(u.id) && u.state === 'tumble' && W.armed) W.tumbled[nm].add(u.id);
      requestAnimationFrame(loop);
    };
    loop();
  });
  await wait(2500);
  // where each worker stands before (the ogres wander: only whether they're thrown counts)
  const snap = () =>
    page.evaluate(() => {
      const W = window.__w;
      const o = {};
      for (const u of W.units) for (const nm in W.ids) if (W.ids[nm].has(u.id)) o[u.id] = [u.x, u.y, u.state];
      return o;
    });
  const before = await snap();
  await page.evaluate(() => {
    const W = window.__w;
    const Wd = window.reclaimed.api.wind;
    W.armed = true;
    const b = W.spots.breeze;
    Wd.blow({ x: b[0], y: b[1], radius: 9, strength: 12, dir: [1, 0], time: 3 });
    const k = W.spots.blastWorkers;
    // (4 cells off: at a blast's heart the outward winds cancel)
    Wd.blast(k[0] - 4, k[1], 9, 22);
    const g = W.spots.blastOgres;
    Wd.blast(g[0] - 4, g[1], 9, 22);
  });
  await page.screenshot({ path: `${out}-1.png` });
  await wait(1500);
  const mid = await snap();
  const tally = await page.evaluate(() => Object.fromEntries(Object.entries(window.__w.tumbled).map(([k, s]) => [k, s.size])));
  const ids = await page.evaluate(() => Object.fromEntries(Object.entries(window.__w.ids).map(([k, s]) => [k, [...s]])));
  const drift = (nm) => {
    const d = ids[nm].filter((id) => before[id] && mid[id]).map((id) => Math.hypot(mid[id][0] - before[id][0], mid[id][1] - before[id][1]));
    return +(d.reduce((a, b) => a + b, 0) / Math.max(d.length, 1)).toFixed(2);
  };
  const dx = (nm) => {
    const d = ids[nm].filter((id) => before[id] && mid[id]).map((id) => mid[id][0] - before[id][0]);
    return +(d.reduce((a, b) => a + b, 0) / Math.max(d.length, 1)).toFixed(2);
  };
  check('calm: the map wind moves nobody', drift('calm') < 0.5 && tally.calm === 0, { drift: drift('calm'), thrown: tally.calm });
  check('breeze 12: they drift downwind, none thrown', dx('breeze') > 0.5 && tally.breeze === 0, { dx: dx('breeze'), thrown: tally.breeze });
  check('blast 22 (~16 where they stand): the workers are thrown', tally.blastWorkers >= 8, { thrown: tally.blastWorkers, of: ids.blastWorkers.length, drift: drift('blastWorkers') });
  check('blast 22: the ogres (mass 3) hold', tally.blastOgres <= 2, { thrown: tally.blastOgres });
  await wait(4000);
  const end = await snap();
  const down = Object.values(end).filter((u) => u[2] === 'tumble').length;
  check('all up again', down === 0, { stillDown: down });
  await page.evaluate(() => (window.__stop = true));
} finally {
  await browser.close();
}
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
if (failed) process.exit(1);
