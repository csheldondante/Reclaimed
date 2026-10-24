// Hits that spare groups (round 63, the hoverbike's lich: its fireball
// spares its raised dead). Two groups of workers mixed on one spot; a blast
// with `spare: [g1]`, then one with `groups: [g1]`: only the other group,
// then only g1, is hurt and thrown (the spared may still be bowled over by
// the others flung into them). Prints the measures.
//
//   node scripts/sparetest.mjs [--url http://localhost:5185]
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
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => {
    failed = true;
    console.log('pageerror:', e.message);
  });
  await page.goto(`${url}/?skipmenu=1&level=sandbox&tutorial=0&tod=0.4`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.reclaimed?.agents, { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 3000));
  const m = await page.evaluate(async () => {
    const R = window.reclaimed;
    const A = R.agents;
    const { cellPos } = await import('/src/world/lattice.ts');
    const { w, h } = R.core.dims;
    const [x, y] = cellPos(Math.floor(w / 2) + 30, Math.floor(h / 2) - 30);
    const g1 = A.spawn(6, x, y, { kind: 'worker', group: 7, spread: 0.8 });
    const g2 = A.spawn(6, x, y, { kind: 'worker', group: 8, spread: 0.8 });
    A.follow(7, -1);
    A.follow(8, -1);
    const log = [];
    let units = [];
    let stop = false;
    const loop = async () => {
      if (stop) return;
      const s = await A.sync();
      log.push(...s.events);
      units = s.units;
      requestAnimationFrame(loop);
    };
    loop();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(1200);
    const blast = async (opts) => {
      log.length = 0;
      const hid = A.hit({ x, y, radius: 4, damage: 1, push: 10, lift: 5, outward: true, ...opts });
      await wait(700);
      // (hurt by the blast itself: a hard landing after being bowled over is 'impact')
      const hurt = new Set(log.filter((e) => e.type === 'hurt' && e.hit === hid).map((e) => e.id));
      const down = new Set(units.filter((u) => u.state === 'tumble').map((u) => u.id));
      const res = { g1Hurt: g1.filter((id) => hurt.has(id)).length, g2Hurt: g2.filter((id) => hurt.has(id)).length, g1Down: g1.filter((id) => down.has(id)).length, g2Down: g2.filter((id) => down.has(id)).length };
      await wait(3500);
      return res;
    };
    const spared = await blast({ spare: [7] });
    const only = await blast({ groups: [7] });
    stop = true;
    return { spared, only };
  });
  // (the spared can still be bowled over by the others flung into them: knock-overs, as ever)
  check('spare: [g1]: only the other group is hurt and thrown', m.spared.g1Hurt === 0 && m.spared.g2Hurt >= 5 && m.spared.g2Down >= 3, m.spared);
  check('groups: [g1]: only g1 is hurt and thrown', m.only.g2Hurt === 0 && m.only.g1Hurt >= 5 && m.only.g1Down >= 3, m.only);
} finally {
  await browser.close();
}
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
if (failed) process.exit(1);
