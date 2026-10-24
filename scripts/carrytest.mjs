// Carrying (round 63). Exact ground ops first: take a measured amount off a
// column's top and put it back elsewhere, the totals checked. Prints the
// measures.
//
//   node scripts/carrytest.mjs [--url http://localhost:5185] [--out carry]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5185');
const out = opt('out', 'carry');
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
  await page.waitForFunction(() => window.reclaimed?.api?.terrain, { timeout: 90000 });
  await wait(3000);
  const ops = await page.evaluate(async () => {
    const R = window.reclaimed;
    const T = R.api.terrain;
    const { cellPos } = await import('/src/world/lattice.ts');
    const { w, h } = R.core.dims;
    const [ax, ay] = cellPos(Math.floor(w / 2) - 20, Math.floor(h / 2) + 20);
    const [bx, by] = cellPos(Math.floor(w / 2) + 20, Math.floor(h / 2) + 20);
    await T.refresh();
    const top = (x, y) => T.layersAt(x, y).at(-1);
    const a0 = top(ax, ay);
    const b0 = T.heightAt(bx, by);
    const t0 = performance.now();
    const took = await T.take(ax, ay, 0.4);
    const ms = performance.now() - t0;
    // (brick on top: a solid, so it stays put to be measured)
    const put = await T.put(bx, by, 'brick', 0.75);
    const tooMuch = await T.take(ax, ay, 99);
    await T.refresh();
    return { a0: [a0.material, +(a0.z1 - a0.z0).toFixed(3)], took, ms: Math.round(ms), aAfter: top(ax, ay), put, bRise: +(T.heightAt(bx, by) - b0).toFixed(3), bTop: top(bx, by).material, tooMuch };
  });
  check('take: exactly the amount, its material', Math.abs(ops.took.amount - 0.4) < 1e-4 && ops.took.material === ops.a0[0], ops);
  check('put: exactly the amount, on top', Math.abs(ops.put - 0.75) < 1e-4 && Math.abs(ops.bRise - 0.75) < 1e-3 && ops.bTop === 'brick', { put: ops.put, rise: ops.bRise, top: ops.bTop });
  check('take more than the top holds: just the top interval', ops.tooMuch.amount > 0 && ops.tooMuch.amount < 99, ops.tooMuch);

  // units: pick up, carry, put down, throw; loads shed when knocked down
  await page.evaluate(async () => {
    const R = window.reclaimed;
    const A = R.agents;
    const { cellPos } = await import('/src/world/lattice.ts');
    const { w, h } = R.core.dims;
    const [x, y] = cellPos(Math.floor(w / 2) - 10, Math.floor(h / 2) - 25);
    window.__c = { x, y, log: [] };
    void R.api; // (the world API: hands the terrain to the agents)
    window.__c.ids = A.spawn(4, x, y, { kind: 'worker', group: 5, spread: 0.6 });
    A.follow(5, -1);
    const loop = async () => {
      if (window.__stop) return;
      const s = await A.sync();
      for (const e of s.events) window.__c.log.push(e);
      window.__c.units = s.units;
      requestAnimationFrame(loop);
    };
    loop();
  });
  await wait(1500);
  const carried = await page.evaluate(async () => {
    const R = window.reclaimed;
    const A = R.agents;
    const C = window.__c;
    const got = [];
    for (const id of C.ids) got.push(await A.pickUp(id, 0.5));
    return { got, carrying: C.ids.map((id) => A.carrying(id)) };
  });
  check('pick up: each carries what it took off the ground', carried.got.every((g, i) => g.amount > 0.49 && carried.carrying[i]?.amount === g.amount), carried);
  // a close look at them carrying it
  await page.evaluate(() => {
    const R = window.reclaimed;
    const u = window.__c.units[0];
    R.camera.target = [u.x, u.y, u.z + 1];
    R.camera.zoom = 22;
  });
  await wait(600);
  await page.screenshot({ path: `${out}-held.png` });
  // walk the carriers 6 cells over, then put two down and throw two
  const moved = await page.evaluate(async () => {
    const R = window.reclaimed;
    const A = R.agents;
    const C = window.__c;
    A.goTo(5, C.x + 6, C.y);
    await new Promise((r) => setTimeout(r, 4000));
    const T = R.api.terrain;
    await T.refresh();
    const u = C.units.find((v) => v.id === C.ids[0]);
    const h0 = T.heightAt(u.x, u.y);
    const put = [await A.putDown(C.ids[0]), await A.putDown(C.ids[1])];
    // throw at raiders standing 8 cells off: they're knocked over where it lands
    const [tx, ty] = [C.x + 6, C.y + 8];
    const raiders = A.spawn(5, tx, ty, { kind: 'raider', group: 6, spread: 0.5 });
    A.follow(6, -1);
    await new Promise((r) => setTimeout(r, 1500));
    await T.refresh();
    const tz = T.heightAt(tx, ty);
    const thrown = [A.throwItem(C.ids[2], [tx, ty, tz], { hit: { radius: 2, push: 9, lift: 4, damage: 0 } }), A.throwItem(C.ids[3], [tx + 0.5, ty, tz], { hit: { radius: 2, push: 9, lift: 4, damage: 0 } })];
    const flying = A.inFlight.length;
    await new Promise((r) => setTimeout(r, 2500));
    await T.refresh();
    const landed = C.log.filter((e) => e.type === 'landed');
    const tumbled = new Set(C.log.filter((e) => e.type === 'hurt' || e.type === 'death').map((e) => e.id)).size;
    const states = C.units.filter((v) => raiders.includes(v.id)).map((v) => v.state);
    return { put, rise: +(T.heightAt(u.x, u.y) - h0).toFixed(3), thrown, flying, landed, states, tumbled, carrying: C.ids.map((id) => A.carrying(id)) };
  });
  check('put down: all of it goes back to the ground', moved.put.every((p) => p > 0.49), moved);
  check('thrown: both flew and landed as ground, all of it', moved.thrown.every((t) => t) && moved.flying === 2 && moved.landed.length === 2 && moved.landed.every((l) => l.amount > 0.49), moved.landed);
  check('nothing left carried', moved.carrying.every((c) => c === null), moved.carrying);
  // a carrier blasted: its load falls off and lands as ground
  const shed = await page.evaluate(async () => {
    const R = window.reclaimed;
    const A = R.agents;
    const C = window.__c;
    const id = C.ids[0];
    await A.pickUp(id, 0.5);
    const u = C.units.find((v) => v.id === id);
    const before = C.log.filter((e) => e.type === 'landed').length;
    A.hit({ x: u.x - 1, y: u.y, radius: 3, damage: 0, push: 14, lift: 6 });
    await new Promise((r) => setTimeout(r, 3000));
    const landed = C.log.filter((e) => e.type === 'landed').slice(before);
    return { landed, carrying: A.carrying(id) };
  });
  check('knocked over: the load flies off and lands as ground', shed.carrying === null && shed.landed.length === 1 && shed.landed[0].amount > 0.49, shed);
  await page.evaluate(() => (window.__stop = true));
} finally {
  await browser.close();
}
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
if (failed) process.exit(1);
