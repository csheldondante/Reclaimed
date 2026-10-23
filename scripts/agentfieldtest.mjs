// Agents fields for a game's CPU walkers (round 52): a FieldReader's samples
// (distance and the way down the field) checked against the field itself,
// the readback timed; then a field confined to one room of a voronoi plan,
// its goal outside the room: the group stays in its room.
//
//   node scripts/agentfieldtest.mjs [--url http://localhost:5185] [--n 400] [--seconds 16]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5185');
const n = Number(opt('n', 400));
const seconds = Number(opt('seconds', 16));
const out = opt('out', 'agentfield');
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
    if (m.type() === 'error' && !m.text().includes('404')) {
      failed = true;
      console.log('console.error:', m.text().slice(0, 800));
    }
  });
  await page.goto(`${url}/?skipmenu=1&level=sandbox&tutorial=0&tod=0.4`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.agents, { timeout: 90000 });
  await wait(3000);
  // 1. the reader: field 1 seeded at the map centre
  const reader = await page.evaluate(async () => {
    const R = window.reclaimed;
    const { cellPos } = await import('/src/world/lattice.ts');
    const { w, h } = R.core.dims;
    const [gx, gy] = cellPos(Math.floor(w / 2), Math.floor(h / 2));
    R.agents.seed(1, [{ x: gx, y: gy }]);
    await new Promise((r) => setTimeout(r, 4000));
    const rd = R.agents.reader(1);
    const t0 = performance.now();
    await rd.refresh();
    const ms = performance.now() - t0;
    const rows = [];
    let agree = 0;
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const r = 20 + (k % 3) * 20;
      const x = gx + Math.cos(a) * r;
      const y = gy + Math.sin(a) * r;
      const s = rd.sample(x, y);
      // (toward the goal, give or take the hex metric and what's in the way)
      const tx = (gx - x) / Math.hypot(gx - x, gy - y);
      const ty = (gy - y) / Math.hypot(gx - x, gy - y);
      const dot = s.dir[0] * tx + s.dir[1] * ty;
      if (dot > 0.7) agree++;
      if (k < 4) rows.push({ r, dist: +s.dist.toFixed(1), dot: +dot.toFixed(2) });
    }
    return { refreshMs: +ms.toFixed(1), agreeOf24: agree, rows };
  });
  console.log('reader:', JSON.stringify(reader));
  // 2. confined to a room: the goal is outside it
  const room = await page.evaluate(async (n) => {
    const R = window.reclaimed;
    const { cellPos } = await import('/src/world/lattice.ts');
    const { w, h } = R.core.dims;
    R.places.load({ partition: 'voronoi', spacing: 22, group: [1, 3] }, 7);
    const [ax, ay] = cellPos(Math.floor(w / 2) - 30, Math.floor(h / 2));
    const [bx, by] = cellPos(Math.floor(w / 2) + 40, Math.floor(h / 2) + 10);
    const home = R.places.at(ax, ay);
    const goal = R.places.at(bx, by);
    R.agents.confine(0, { id: home.id, kind: 'room' });
    R.agents.spawn(n, ax, ay, { group: 0, spread: 4 });
    R.agents.goTo(0, bx, by);
    R.camera.target[0] = ax;
    R.camera.target[1] = ay;
    R.camera.zoom *= 2;
    return { home: home.id, homeName: home.name, goal: goal?.id, ax, ay, bx, by };
  }, n);
  console.log('room:', JSON.stringify(room));
  const where = () =>
    page.evaluate(async (room) => {
      const R = window.reclaimed;
      const u = await R.agents.read();
      let inside = 0;
      let mean = 0;
      for (let i = 0; i < u.length / 4; i++) {
        if (R.places.at(u[i * 4], u[i * 4 + 1])?.id === room.home) inside++;
        mean += Math.hypot(u[i * 4] - room.bx, u[i * 4 + 1] - room.by);
      }
      return { inHomeRoom: inside, of: u.length / 4, meanToGoal: +(mean / (u.length / 4)).toFixed(1) };
    }, room);
  for (let k = 0; k <= 3; k++) {
    if (k) await wait((seconds * 1000) / 3);
    console.log(`confined t${k}:`, JSON.stringify(await where()));
  }
  await page.screenshot({ path: `${out}-confined.png` });
  // 3. let go: they leave the room for the goal
  await page.evaluate(() => window.reclaimed.agents.confine(0, null));
  await wait(seconds * 1000);
  console.log('released:', JSON.stringify(await where()));
  await page.screenshot({ path: `${out}-released.png` });
} finally {
  await browser.close();
}
if (failed) process.exit(1);
