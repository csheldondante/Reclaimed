// (loop round 14, LS-108: "I would let any units brawl") A crowd of the town's own workers in the market, turned
// berserk by the spell the loop casts (Units.spell, who: 'any' — the call loop.ts makes for a pack's berserk ability),
// at phone size: stills before, at the cast and after; the crowd's hp counted. The crowd is a fixture (12 workers of
// the town's side spawned at the town's middle); the spell is the game's own.
//   node scripts/lab/crowdshots.mjs [--out dir] [--n 12]
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../lib/runner.mjs';

await run({ name: 'crowdshots', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const out = R.opt('out', 'crowdshots');
  const n = Number(R.opt('n', '12'));
  fs.mkdirSync(out, { recursive: true });
  const p = await R.page();
  p.on('console', (m) => {
    const t = m.text();
    if (/^\[(live|loop)\]/.test(t) || m.type() === 'error') R.log(t.slice(0, 300));
  });
  const shot = async (name) => {
    await p.screenshot({ path: path.join(out, `${name}.png`) });
    R.log(`shot ${name}`);
  };
  await p.goto(`${R.url}/?skipmenu=1&level=atlas&town=1&loop=1&fresh=1&q=low&warmcache=0`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.rungame?.phase === 'leader' || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(p);
  await p.evaluate(() => (window.rungame.pick(window.rungame.leaders?.[0]?.id ?? 'ysolt'), window.rungame.closePanel()));
  await p.waitForFunction(() => window.rungame.phase === 'city', { timeout: 60000, polling: 250 });
  await R.sleep(4000);
  // (the crowd: n workers of the town's side round the camera's ground point — the town's middle in the city view)
  const ids = await p.evaluate((n) => {
    const U = window.reclaimed.units;
    const c = window.reclaimed.camera.target;
    const ids = [];
    for (let k = 0; k < n; k++) ids.push(U.spawn('worker', [c[0] + (k % 4) * 1.5 - 2.25, c[1] + Math.floor(k / 4) * 1.5 - 1.5], 'f-town'));
    U.observe?.(ids);
    window.__crowd = { ids, at: [c[0], c[1], c[2]] };
    return ids;
  }, n);
  R.log(`crowd: ${ids.length} workers`);
  await p.evaluate(() => {
    const q = window.__crowd.at;
    window.rungame.cam.follow(null);
    return window.rungame.cam.look(q, { zoom: 22, ease: 0.3, place: [0.5, 0.45] });
  });
  await R.sleep(3000);
  const hp = () =>
    p.evaluate(() => {
      const U = window.reclaimed.units;
      const v = window.__crowd.ids.map((id) => U.get(id));
      return { alive: v.filter((u) => u && u.alive).length, health: v.map((u) => (u ? +u.health.toFixed(1) : null)) };
    });
  R.log(`before: ${JSON.stringify(await hp())}`);
  await shot('crowd-0-before');
  await p.evaluate(() => {
    const q = window.__crowd.at;
    window.reclaimed.units.spell({ at: [q[0], q[1]], radius: 8, who: 'any', berserk: true });
  });
  await R.sleep(600);
  await shot('crowd-1-cast');
  for (const [k, s] of [[2, 2], [3, 4], [4, 8]]) {
    await R.sleep(s * 1000);
    R.log(`+${s}s: ${JSON.stringify(await hp())}`);
    await shot(`crowd-${k}-after`);
  }
});
