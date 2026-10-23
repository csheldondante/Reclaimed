// A horde (round 52, the units session's enemies on Reclaimed's agents):
// raiders and ogres spawned round a standing target (the player) notice it,
// close in down the target field and swing (swing events); then the game's
// hits: a blast that kills the near ones (death events naming the hit), a
// cone that shoves, a fire hit that sets them alight (they burn down); a
// kind with its own voxel model drawn. Prints counts per phase; saves shots.
//
//   node scripts/hordetest.mjs [--url http://localhost:5185] [--raiders 60] [--ogres 10] [--out horde]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5185');
const out = opt('out', 'horde');
const raiders = Number(opt('raiders', 60));
const ogres = Number(opt('ogres', 10));
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
    if ((m.type() === 'error' || m.type() === 'warn') && !m.text().includes('404')) {
      if (m.type() === 'error') failed = true;
      console.log(`console.${m.type()}:`, m.text().slice(0, 800));
    }
  });
  await page.goto(`${url}/?skipmenu=1&level=sandbox&tutorial=0&tod=0.4`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.agents, { timeout: 90000 });
  await wait(3000);
  await page.evaluate(
    async (raiders, ogres) => {
      const R = window.reclaimed;
      const A = R.agents;
      const { cellPos } = await import('/src/world/lattice.ts');
      const { w, h } = R.core.dims;
      const [px, py] = cellPos(Math.floor(w / 2) + 10, Math.floor(h / 2) - 20);
      // (the ground's height there: the agents' own top surface)
      const rd = A.reader(0);
      await rd.refresh();
      const pz = rd.sample(px, py).z;
      window.__t = { px, py, pz, log: [] };
      // a kind with its own model: a 3 × 3 × 7 stack of bricks with a stone head
      const vox = [];
      for (let z = 0; z < 7; z++) for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) if (z < 6 || (x === 0 && y === 0)) vox.push([x, y, z, z === 6 ? 1 : 11]);
      A.defineKind(3, { name: 'brute', height: 1.6, mass: 2, hp: 15, speed: 2.4, reach: 1.5, damage: 3, swingPeriod: 1.2, notice: 30, model: { voxels: vox, voxel: 0.25 } });
      A.spawn(raiders, px - 18, py + 6, { kind: 'raider', group: 1 });
      A.spawn(ogres, px + 16, py + 10, { kind: 'ogre', group: 2 });
      A.spawn(4, px, py + 16, { kind: 'brute', group: 3 });
      for (const g of [1, 2, 3]) A.follow(g, 3);
      A.setTargets([{ x: px, y: py, z: pz, radius: 0.8 }]);
      R.camera.target[0] = px;
      R.camera.target[1] = py;
      R.camera.zoom *= 4;
      // the game's loop: sync each frame, keep the events
      const loop = async () => {
        if (window.__stop) return;
        const s = await A.sync();
        for (const e of s.events) window.__t.log.push(e);
        window.__t.units = s.units;
        requestAnimationFrame(loop);
      };
      loop();
    },
    raiders,
    ogres,
  );
  const tally = () =>
    page.evaluate(() => {
      const t = window.__t;
      const c = { swing: 0, hurt: 0, death: 0, alight: 0 };
      for (const e of t.log) c[e.type]++;
      const states = {};
      for (const u of t.units ?? []) states[u.state] = (states[u.state] ?? 0) + 1;
      const burning = (t.units ?? []).filter((u) => u.alight).length;
      const near = (t.units ?? []).filter((u) => Math.hypot(u.x - t.px, u.y - t.py) < 3).length;
      const zs = (t.units ?? []).slice(0, 3).map((u) => +u.z.toFixed(1));
      return { live: (t.units ?? []).length, states, burning, nearTarget: near, events: c, targetZ: +t.pz.toFixed(1), unitZ: zs };
    });
  await wait(1000);
  console.log('spawned:', JSON.stringify(await tally()));
  await page.screenshot({ path: `${out}-0.png` });
  await wait(9000);
  console.log('closed in:', JSON.stringify(await tally()));
  await page.screenshot({ path: `${out}-1-swinging.png` });
  // a blast at the target: kills the near ones, throws the rest back
  const blast = await page.evaluate(() => {
    const t = window.__t;
    return window.reclaimed.agents.hit({ x: t.px, y: t.py, radius: 3, damage: 30, push: 14, outward: true });
  });
  await wait(1500);
  const afterBlast = await tally();
  const killedByBlast = await page.evaluate((b) => window.__t.log.filter((e) => e.type === 'death' && e.by === b).length, blast);
  console.log('blast:', JSON.stringify({ ...afterBlast, killedByBlast }));
  await page.screenshot({ path: `${out}-2-blast.png` });
  // fire on the ogres' side, a cone of push the other way
  await page.evaluate(() => {
    const t = window.__t;
    const A = window.reclaimed.agents;
    A.hit({ x: t.px + 4, y: t.py + 3, radius: 5, damage: 1, fire: true });
    A.hit({ x: t.px, y: t.py, radius: 10, push: 10, dir: [-1, 0], cone: 90 });
  });
  await wait(1500);
  console.log('fire and cone:', JSON.stringify(await tally()));
  await page.screenshot({ path: `${out}-3-fire.png` });
  await wait(7000);
  console.log('burnt:', JSON.stringify(await tally()));
  await page.screenshot({ path: `${out}-4-after.png` });
  await page.evaluate(() => (window.__stop = true));
} finally {
  await browser.close();
}
if (failed) process.exit(1);
