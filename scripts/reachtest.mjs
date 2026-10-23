// Agents' reach and sight (round 59: no height band). Raiders chase three
// targets far apart: one on the ground (they swing and it lands), one
// hovering 5 cells up (out of reach: they gather underneath and never swing),
// one hovering just over their heads (within the arms' reach of their
// bodies: they swing). And ogres (reach 1.8) against a brick wall with a
// wide target just behind it: in reach through the wall, but out of sight,
// so no blow from the wrong side (they go round). Prints the measures.
//
//   node scripts/reachtest.mjs [--url http://localhost:5185]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5185');
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
  await page.waitForFunction(() => window.reclaimed?.agents, { timeout: 90000 });
  await wait(3000);
  await page.evaluate(async () => {
    const R = window.reclaimed;
    const A = R.agents;
    const { cellPos } = await import('/src/world/lattice.ts');
    const { w, h } = R.core.dims;
    const rd = A.reader(0);
    await rd.refresh();
    // three sites 50 cells apart: the ground, 5 up, 1.8 up (a raider is 1.2 tall, reach 1.2)
    const sites = [
      [-50, 0, 0],
      [0, 0, 5],
      [50, 0, 1.8],
    ].map(([dx, dy, up]) => {
      const [x, y] = cellPos(Math.floor(w / 2) + dx, Math.floor(h / 2) + 30 + dy);
      return { x, y, z: rd.sample(x, y).z + up };
    });
    window.__r = { sites, log: [], units: [] };
    sites.forEach((s, k) => A.spawn(8, s.x - 10, s.y + 4, { kind: 'raider', group: 1 + k }));
    for (const g of [1, 2, 3]) A.follow(g, 3);
    A.setTargets(sites.map((s) => ({ x: s.x, y: s.y, z: s.z, radius: 0.6, height: 1.5 })));
    const loop = async () => {
      if (window.__stop) return;
      const s = await A.sync();
      for (const e of s.events) window.__r.log.push(e);
      window.__r.units = s.units;
      requestAnimationFrame(loop);
    };
    loop();
  });
  await wait(12000);
  const m = await page.evaluate(() => {
    const r = window.__r;
    const per = r.sites.map((s, t) => ({
      windups: r.log.filter((e) => e.type === 'windup' && e.target === t).length,
      swings: r.log.filter((e) => e.type === 'swing' && e.target === t).length,
      under: r.units.filter((u) => Math.hypot(u.x - s.x, u.y - s.y) < 2.5).length,
    }));
    window.__stop = true;
    return per;
  });
  check('on the ground: they swing and it lands', m[0].swings >= 5, m[0]);
  check('5 up: out of reach, they gather underneath and never swing', m[1].windups === 0 && m[1].swings === 0 && m[1].under >= 4, m[1]);
  check('1.8 up: within reach of their bodies, they swing', m[2].swings >= 5, m[2]);
  // the wall: ogres on one side of a long brick wall, the target just behind it
  await page.evaluate(async () => {
    const R = window.reclaimed;
    const A = R.agents;
    const { cellPos } = await import('/src/world/lattice.ts');
    const { w, h } = R.core.dims;
    A.remove(R.agents ? window.__r.units.map((u) => u.id) : []);
    const [tx, ty] = cellPos(Math.floor(w / 2), Math.floor(h / 2) - 30);
    const wx = tx - 1.8;
    for (let dy = -5; dy <= 5; dy += 0.8) R.api.terrain.build(wx, ty + dy, 'brick', { radius: 0.6, layers: 5 });
    await new Promise((r) => setTimeout(r, 1500));
    const rd = A.reader(0);
    await rd.refresh();
    window.__w = { tx, ty, wx, log: [] };
    A.setTargets([{ x: tx, y: ty, z: rd.sample(tx, ty).z, radius: 1.3, height: 1.5 }]);
    // (right against the wall: in reach of the target through it from the first tick)
    A.spawn(8, wx - 1.0, ty, { kind: 'ogre', group: 4, spread: 0.3 });
    A.follow(4, 3);
    window.__stop = false;
    const loop = async () => {
      if (window.__stop) return;
      const s = await A.sync();
      for (const e of s.events) window.__w.log.push(e);
      window.__w.units = s.units;
      requestAnimationFrame(loop);
    };
    loop();
  });
  await wait(8000);
  const wl = await page.evaluate(() => {
    const W = window.__w;
    const windups = W.log.filter((e) => e.type === 'windup');
    window.__stop = true;
    return {
      wrongSide: windups.filter((e) => e.x < W.wx - 0.5).length,
      rightSide: windups.filter((e) => e.x > W.wx + 0.5).length,
      nearWall: (W.units ?? []).filter((u) => u.x < W.wx && W.wx - u.x < 2.5 && Math.abs(u.y - W.ty) < 4).length,
      ogres: (W.units ?? []).slice(0, 4).map((u) => [u.state, +(Math.hypot(u.x - W.tx, u.y - W.ty) - 1.3).toFixed(2), +u.z.toFixed(1)]),
    };
  });
  check('a wall between: no blow from behind it', wl.wrongSide === 0, wl);
} finally {
  await browser.close();
}
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
if (failed) process.exit(1);
