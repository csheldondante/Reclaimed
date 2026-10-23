// Agents' mass and stun (round 56): knockback as plain physics data. A
// worker (mass 1) and an ogre (mass 3) each take the same hit (push along
// dir, lift): the ogre flies a third as fast (a ninth as high). Stuns: a hit
// that only stuns holds a worker where it stands; a thrown one stays down
// longer with a stun; a launch's stun too. Prints the measures.
//
//   node scripts/knocktest.mjs [--url http://localhost:5185]
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
  // each subject alone on open ground, standing (group 5 follows nothing);
  // every frame: its track (time, position, state)
  await page.evaluate(async () => {
    const R = window.reclaimed;
    const A = R.agents;
    const { cellPos } = await import('/src/world/lattice.ts');
    const { w, h } = R.core.dims;
    const spot = (k) => cellPos(Math.floor(w / 2) - 30 + (k % 4) * 14, Math.floor(h / 2) + 10 + Math.floor(k / 4) * 14);
    const names = ['worker', 'ogre', 'stunOnly', 'thrown', 'thrownStun', 'launched', 'launchedStun'];
    window.__k = { ids: {}, track: {} };
    names.forEach((nm, k) => {
      const [x, y] = spot(k);
      window.__k.ids[nm] = A.spawn(1, x, y, { group: 5, kind: nm === 'ogre' ? 'ogre' : 'worker', spread: 0 })[0];
      window.__k.track[nm] = [];
    });
    A.follow(5, -1);
    const loop = async () => {
      if (window.__stop) return;
      const s = await A.sync();
      const t = performance.now() / 1000;
      for (const u of s.units)
        for (const nm in window.__k.ids) if (window.__k.ids[nm] === u.id) window.__k.track[nm].push([t, u.x, u.y, u.z, u.state]);
      requestAnimationFrame(loop);
    };
    loop();
  });
  await wait(2000);
  await page.evaluate(() => {
    const A = window.reclaimed.agents;
    const K = window.__k;
    K.t0 = performance.now() / 1000;
    const at = (nm) => K.track[nm][K.track[nm].length - 1];
    const hitOn = (nm, spec) => {
      const [, x, y, z] = at(nm);
      A.hit({ x: x - 0.5, y, z: z + 0.5, radius: 1.2, ...spec });
    };
    const knock = { dir: [1, 0], push: 6, lift: 8 };
    hitOn('worker', knock);
    hitOn('ogre', knock);
    hitOn('stunOnly', { stun: 2 });
    hitOn('thrown', knock);
    hitOn('thrownStun', { ...knock, stun: 1.5 });
    A.launch(K.ids.launched, [0, 0, 8]);
    A.launch(K.ids.launchedStun, [0, 0, 8], { stun: 1.5 });
  });
  await wait(6000);
  const m = await page.evaluate(() => {
    const K = window.__k;
    const out = {};
    for (const nm in K.track) {
      const tr = K.track[nm];
      const before = tr.filter((p) => p[0] < K.t0);
      const s = before[before.length - 1];
      const after = tr.filter((p) => p[0] >= K.t0);
      const down = after.filter((p) => p[4] === 'tumble');
      // (down from the hit until it's last seen tumbling)
      const upAt = down.length ? down[down.length - 1][0] - K.t0 : 0;
      const end = tr[tr.length - 1];
      out[nm] = {
        rise: +Math.max(...after.map((p) => p[3] - s[3])).toFixed(2),
        // (how far it was carried, to where it got up: a hostile kind wanders off after)
        moved: +Math.hypot(...(down.length ? [down[down.length - 1][1] - s[1], down[down.length - 1][2] - s[2]] : [end[1] - s[1], end[2] - s[2]])).toFixed(2),
        down: +upAt.toFixed(2),
        state: end[4],
      };
    }
    window.__stop = true;
    return out;
  });
  check('mass: the ogre (3) flies a ninth as high, moves under half as far', m.ogre.rise < m.worker.rise / 4 && m.ogre.moved < m.worker.moved / 2 && m.worker.rise > 0.8, { worker: m.worker, ogre: m.ogre });
  check('lift: the worker flies about v²/2g (1.6) high', m.worker.rise > 1 && m.worker.rise < 2.2, { rise: m.worker.rise });
  check('stun only: held where it stands about 2.6 s, then up', m.stunOnly.moved < 0.3 && m.stunOnly.down > 2.2 && m.stunOnly.down < 3.2 && m.stunOnly.state !== 'tumble', m.stunOnly);
  check('thrown with a stun: down about 1.5 s longer', m.thrownStun.down - m.thrown.down > 1.1 && m.thrownStun.down - m.thrown.down < 1.9, { thrown: m.thrown.down, thrownStun: m.thrownStun.down });
  check('launched with a stun: down about 1.5 s longer', m.launchedStun.down - m.launched.down > 1.1 && m.launchedStun.down - m.launched.down < 1.9, { launched: m.launched.down, launchedStun: m.launchedStun.down });
  check('all up again', Object.values(m).every((u) => u.state !== 'tumble'), Object.fromEntries(Object.entries(m).map(([k, u]) => [k, u.state])));
} finally {
  await browser.close();
}
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
if (failed) process.exit(1);
