// Agents thrown, held and burning (round 52, the units session's 4-6): a
// crowd of standing workers; an ogre thrown into it (knock-overs: they
// tumble, then get up); a blast throwing the crowd (hard landings hurt);
// one held, carried up and lobbed far (it lands where aimed); one set
// alight in the crowd (the fire spreads by touch). Prints states per phase.
//
//   node scripts/throwtest.mjs [--url http://localhost:5185] [--n 40] [--out throw]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5185');
const out = opt('out', 'throw');
const n = Number(opt('n', 40));
const browser = await puppeteer.launch({
  executablePath: opt('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'),
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1200,800'],
  defaultViewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
  protocolTimeout: 10 * 60 * 1000,
});
let failed = false;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => {
    failed = true;
    console.log('pageerror:', e.message);
  });
  page.on('console', (m) => {
    if (m.type() === 'warn' && m.text().startsWith('lob')) console.log(m.text());
    if (m.type() === 'error' && !m.text().includes('404')) {
      failed = true;
      console.log('console.error:', m.text().slice(0, 800));
    }
  });
  await page.goto(`${url}/?skipmenu=1&level=sandbox&tutorial=0&tod=0.4`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.agents, { timeout: 90000 });
  await wait(3000);
  await page.evaluate(async (n) => {
    const R = window.reclaimed;
    const A = R.agents;
    const { cellPos } = await import('/src/world/lattice.ts');
    const { w, h } = R.core.dims;
    const [px, py] = cellPos(Math.floor(w / 2) - 10, Math.floor(h / 2) + 10);
    window.__t = { px, py, log: [], units: [] };
    // a crowd standing (group 5 follows nothing)
    window.__t.crowd = A.spawn(n, px, py, { group: 5, spread: 3 });
    A.follow(5, -1);
    R.camera.target[0] = px;
    R.camera.target[1] = py;
    R.camera.zoom *= 4;
    const loop = async () => {
      if (window.__stop) return;
      const s = await A.sync();
      for (const e of s.events) window.__t.log.push(e);
      window.__t.units = s.units;
      requestAnimationFrame(loop);
    };
    loop();
  }, n);
  const tally = () =>
    page.evaluate(() => {
      const t = window.__t;
      const st = {};
      for (const u of t.units) st[u.state] = (st[u.state] ?? 0) + 1;
      const ev = {};
      for (const e of t.log) {
        const k = e.type + (e.type === 'hurt' || e.type === 'death' ? ':' + (e.hit ?? e.by) : '');
        ev[k] = (ev[k] ?? 0) + 1;
      }
      return { live: t.units.length, states: st, alight: t.units.filter((u) => u.alight).length, events: ev };
    });
  await wait(1500);
  console.log('crowd:', JSON.stringify(await tally()));
  // an ogre thrown into the crowd from 12 cells off
  await page.evaluate(() => {
    const t = window.__t;
    const A = window.reclaimed.agents;
    const [og] = A.spawn(1, t.px - 7, t.py, { kind: 'ogre', group: 6, spread: 0 });
    A.follow(6, -1);
    t.ogre = og;
    setTimeout(() => A.launch(og, [18, 0, 2]), 300);
  });
  await wait(900);
  console.log('ogre thrown in:', JSON.stringify(await tally()));
  await page.screenshot({ path: `${out}-1-knocked.png` });
  await wait(3000);
  console.log('got up:', JSON.stringify(await tally()));
  // a blast in the crowd: thrown hard
  await page.evaluate(() => {
    const t = window.__t;
    window.reclaimed.agents.hit({ x: t.px, y: t.py, radius: 4, push: 22, outward: true });
  });
  await wait(500);
  console.log('blasted:', JSON.stringify(await tally()));
  await page.screenshot({ path: `${out}-2-blasted.png` });
  await wait(3500);
  console.log('after the blast:', JSON.stringify(await tally()));
  // one held, carried up 6 cells over a second, then lobbed 15 cells east
  const lob = await page.evaluate(async (argv) => {
    const t = window.__t;
    const A = window.reclaimed.agents;
    const u = t.units.find((u) => u.group === 5 && u.state !== 'tumble');
    const id = u.id;
    for (let k = 0; k <= 20; k++) {
      A.hold(id, u.x, u.y, u.z + (6 * k) / 20);
      await new Promise((r) => setTimeout(r, 50));
    }
    const held = t.units.find((v) => v.id === id);
    const from = [u.x, u.y, u.z + 6];
    const to = [u.x + 15, u.y, u.z];
    const v = A.lob(id, from, to);
    const path = [];
    for (let k = 0; k < 25; k++) {
      await new Promise((r) => setTimeout(r, 100));
      const p = t.units.find((w) => w.id === id);
      if (p) path.push([+(p.x - u.x).toFixed(1), +(p.z - u.z).toFixed(1), p.state[0]]);
    }
    if (argv.includes('--debug')) console.warn('lob v', JSON.stringify(v), JSON.stringify(path));
    const after = t.units.find((v) => v.id === id);
    return { heldState: held?.state, heldZ: held && +(held.z - u.z).toFixed(1), landedOff: after && +Math.hypot(after.x - to[0], after.y - to[1]).toFixed(1), state: after?.state ?? 'dead' };
  }, argv);
  console.log('held and lobbed:', JSON.stringify(lob));
  // fire in a fresh crowd of 30: one set alight, the rest catch by touch
  await page.evaluate(() => {
    const t = window.__t;
    const A = window.reclaimed.agents;
    A.spawn(30, t.px + 20, t.py + 12, { group: 7, spread: 3 });
    A.follow(7, -1);
    setTimeout(() => A.hit({ x: t.px + 20, y: t.py + 12, radius: 0.6, fire: true }), 600);
    window.reclaimed.camera.target[0] = t.px + 20;
    window.reclaimed.camera.target[1] = t.py + 12;
  });
  await wait(1600);
  console.log('one alight:', JSON.stringify(await tally()));
  await wait(4000);
  console.log('spread:', JSON.stringify(await tally()));
  await page.screenshot({ path: `${out}-3-fire.png` });
  await page.evaluate(() => (window.__stop = true));
} finally {
  await browser.close();
}
if (failed) process.exit(1);
