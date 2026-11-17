// (loop-skeleton round 7, BACKLOG LS-63) Why `fire.ignite` shows nothing in the atlas town: the cheapest tests first.
// In the loop's own scene (leader picked, the town made): the fire system lit on plain ground round the town (grass,
// woods) and at the market, the fire mirror read for 12 s at each spot. Logs what each spot holds (its material, its
// plants) and the most fire read; a still of the woods spot.
//   node scripts/lab/fireprobe.mjs [--out dir]
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../lib/runner.mjs';

await run({ name: 'fireprobe', kind: 'behaviour', size: '412x915', dpr: 1 }, async (R) => {
  const out = R.opt('out', 'fireprobe');
  fs.mkdirSync(out, { recursive: true });
  const p = await R.page();
  p.on('console', (m) => {
    const t = m.text();
    if (/^\[(fireprobe|live)\]/.test(t)) R.log(t.slice(0, 400));
  });
  await p.goto(`${R.url}/?skipmenu=1&level=atlas&town=1&loop=1&fresh=1&q=low&warmcache=0${R.opt('params', '')}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.rungame?.phase === 'leader' || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(p);
  await p.evaluate(() => window.rungame.pick('ysolt'));
  await R.sleep(4000);
  const spots = await p.evaluate(() => {
    const t = window.citygen.live.get(window.season.town);
    const c = t.centreInWindow();
    const R = t.box.R;
    const out = { market: window.rungame.spot('market'), fields: window.rungame.spot('fields') };
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      out[`ring${k}`] = [c[0] + Math.cos(a) * R * 1.3, c[1] + Math.sin(a) * R * 1.3];
    }
    return { spots: out, R, systems: window.reclaimed.sim.systems?.map((s) => s.name) ?? null };
  });
  R.log(`town R ${spots.R}; systems ${JSON.stringify(spots.systems)}`);
  // (a spot's window point asked for when it is probed: the window slides as the camera goes from one to the next,
  // and a point taken before a slide names other ground after it)
  const pointOf = (name) =>
    p.evaluate((n) => {
      const t = window.citygen.live.get(window.season.town);
      const c = t.centreInWindow();
      if (!n.startsWith('ring')) return window.rungame.spot(n.replace('-canvas', ''));
      const a = (Number(n.slice(4)) / 6) * Math.PI * 2;
      return [c[0] + Math.cos(a) * t.box.R * 1.3, c[1] + Math.sin(a) * t.box.R * 1.3];
    }, name);
  const probe = async (name, at0, how) => {
    // (the camera goes there first; the point is asked for again once the window has settled)
    await p.evaluate((a) => window.rungame.cam.look([a[0], a[1], window.reclaimed.scene.heightAt(a[0], a[1]) ?? 0], { zoom: 10, ease: 0.3 }), at0);
    await R.sleep(2500);
    const at = await pointOf(name);
    // (the camera on the spot: the window holds it, the sim runs there)
    await p.evaluate((a) => window.rungame.cam.look([a[0], a[1], window.reclaimed.scene.heightAt(a[0], a[1]) ?? 0], { zoom: 10, ease: 0.3 }), at);
    await R.sleep(2500);
    const before = await p.evaluate(
      async (a, how) => {
        const w = window.reclaimed.scene.worldApi;
        await w.terrain.load(a[0] - 8, a[1] - 8, a[0] + 8, a[1] + 8);
        const top = w.terrain.surfaceAt(a[0], a[1]);
        const mat = w.terrain.materialAt(a[0], a[1]);
        if (how === 'canvas') w.terrain.build(a[0], a[1], 'canvas', { radius: 1.6, layers: 2 });
        // (the plants field read, its pages asked for: a moment, then again)
        w.plants.vegAt(a[0], a[1]);
        await new Promise((r) => setTimeout(r, 300));
        const veg = w.plants.vegAt(a[0], a[1]);
        let built = null;
        if (how === 'canvas') {
          // (the build lands at the next tick; its page read again)
          await new Promise((r) => setTimeout(r, 600));
          await w.terrain.load(a[0] - 4, a[1] - 4, a[0] + 4, a[1] + 4);
          built = { mat: w.terrain.materialAt(a[0], a[1]), top: w.terrain.surfaceAt(a[0], a[1]) };
        }
        w.fire.ignite(a[0], a[1], { radius: 3, intensity: 0.9 });
        return { top, mat, veg, built };
      },
      at,
      how,
    );
    let most = 0;
    let n = 0;
    for (let k = 0; k < 24; k++) {
      await R.sleep(500);
      const v = await p.evaluate((a) => {
        const f = window.reclaimed.scene.worldApi.fire;
        let m = 0;
        let read = 0;
        for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) {
          const x = f.fireAt(a[0] + dx, a[1] + dy);
          if (x !== null) read++;
          m = Math.max(m, x ?? 0);
        }
        return { m, read };
      }, at);
      most = Math.max(most, v.m);
      n = Math.max(n, v.read);
      if (k === 6) await p.screenshot({ path: path.join(out, `fire-${name}.png`) });
    }
    R.log(`[fireprobe] ${name} at ${at.map((v) => v.toFixed(0))} (${how}): ${JSON.stringify(before)}; most fire read ${most.toFixed(3)} over ${n} columns read`);
    return most;
  };
  const only = R.opt('spots', '').split(',').filter(Boolean);
  for (const name of only.length ? only : Object.keys(spots.spots)) {
    const at = await pointOf(name);
    if (at) await probe(name, at, name.endsWith('-canvas') ? 'canvas' : 'plain');
  }
});
