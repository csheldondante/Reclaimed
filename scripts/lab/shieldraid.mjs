// (loop round 14, docs/design/FRONTS.md "The shield as an energy barrier") Raiders stopped at a shield, at phone size:
// a fixture — a band of hostile raiders spawned out in the fields, after the town's people; a shield raised over the
// town's middle with the Fire ward's numbers (the world API's shields: the loop's own cast raises it the same way).
// Stills before they reach it, at its rim, and as their blows wear it down; its energy and what presses on it logged.
//   node scripts/lab/shieldraid.mjs [--out dir] [--n 12] [--energy 300] [--regen 5]
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../lib/runner.mjs';

await run({ name: 'shieldraid', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const out = R.opt('out', 'shieldraid');
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
  await p.evaluate(() => (window.rungame.pick('ysolt'), window.rungame.closePanel()));
  await p.waitForFunction(() => window.rungame.phase === 'city', { timeout: 60000, polling: 250 });
  await R.sleep(4000);
  const setup = await p.evaluate(
    (o) => {
      const U = window.reclaimed.units;
      const c = window.reclaimed.camera.target;
      const sh = window.reclaimed.scene.worldApi.shields;
      const s = sh.raise(c[0], c[1], { radius: 16, seconds: 120, z: c[2], energy: o.energy, regen: o.regen });
      window.__end = null;
      sh.onEnd.push((x, how) => (window.__end = how));
      // (the town's people inside it; raiders 34 cells out, hostile: they go for the people)
      const folk = [];
      for (let k = 0; k < 6; k++) folk.push(U.spawn('worker', [c[0] + (k % 3) * 2 - 2, c[1] + Math.floor(k / 3) * 2 - 1], 'f-town'));
      const raiders = [];
      for (let k = 0; k < o.n; k++) raiders.push(U.spawn('raider', [c[0] + 34 + (k % 4) * 1.5, c[1] + Math.floor(k / 4) * 1.5 - 3], null, { hostile: true }));
      U.observe?.([...folk, ...raiders]);
      window.__raid = { at: [c[0], c[1], c[2]], raiders, folk, shield: s.id };
      return { at: c, shield: { x: s.x, y: s.y, r: s.radius } };
    },
    { n, energy: Number(R.opt('energy', '300')), regen: Number(R.opt('regen', '5')) },
  );
  R.log(`setup: ${JSON.stringify(setup)}`);
  await p.evaluate(() => {
    const q = window.__raid.at;
    window.rungame.cam.follow(null);
    return window.rungame.cam.look([q[0] + 14, q[1], q[2]], { zoom: 9, ease: 0.3, place: [0.5, 0.45] });
  });
  const state = () =>
    p.evaluate(() => {
      const U = window.reclaimed.units;
      const r = window.__raid;
      const s = window.reclaimed.scene.worldApi.shields.list.find((x) => x.id === r.shield);
      const d = (id) => {
        const u = U.get(id);
        return u?.at && u.alive ? Math.hypot(u.at[0] - r.at[0], u.at[1] - r.at[1]) : null;
      };
      const rd = r.raiders.map(d).filter((x) => x !== null);
      return { energy: s ? +s.energy.toFixed(1) : null, press: s?.press, end: window.__end, raidersIn: rd.filter((x) => x < 16).length, nearest: rd.length ? +Math.min(...rd).toFixed(1) : null, folkAlive: r.folk.map((id) => U.get(id)?.alive).filter(Boolean).length };
    });
  for (let k = 0; k < 40; k++) {
    await R.sleep(1500);
    const s = await state();
    R.log(`${(k + 1) * 1.5}s: ${JSON.stringify(s)}`);
    if ([2, 6, 12, 20, 30].includes(k)) await shot(`raid-${String(k).padStart(2, '0')}`);
    if (s.end) {
      await R.sleep(300);
      await shot('raid-end');
      await R.sleep(3000);
      await shot('raid-after');
      break;
    }
  }
});
