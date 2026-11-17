// (loop round 13, BACKLOG LS-126; src/weather/presets.ts) One still of each weather over the home town in the real game
// at phone size: the loop opened, a leader picked, the town's sheet folded away, then each weather set as the season's
// (`weatherSet.setSeason`, what a pack's `weather` list does) and, for `storm`, also as a card's sign on the town
// (`mutators.sign`, what `{ "sign": "storm" }` does) — the frame taken once it has had time to form.
//   node scripts/lab/weathershots.mjs [--out dir] [--only rain,fog] [--wait 12000]
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../lib/runner.mjs';

await run({ name: 'weathershots', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const out = R.opt('out', 'weathershots');
  fs.mkdirSync(out, { recursive: true });
  const p = await R.page();
  p.on('console', (m) => {
    const t = m.text();
    if (/^\[(weather|loop)\]/.test(t) || m.type() === 'error') R.log(t.slice(0, 300));
  });
  const until = (fn, ms = 300000) => p.waitForFunction(fn, { timeout: ms, polling: 250 });
  await p.goto(`${R.url}/?skipmenu=1&level=atlas&town=1&loop=1&q=low&warmcache=0&runlen=3&fresh=1&tod=0.42${R.opt('params', '')}`, { waitUntil: 'load' });
  await until(() => window.rungame?.phase === 'leader' || document.querySelector('.fatal'));
  await R.fatal(p);
  await p.evaluate(() => (window.rungame.pick('ysolt'), window.rungame.closePanel()));
  await until(() => window.rungame.phase === 'city', 60000);
  await R.sleep(3000);
  R.check('the level has its weather', await p.evaluate(() => !!window.reclaimed.scene.weatherSet));
  // (the time of day held: every still in the same light)
  await p.evaluate(() => {
    window.reclaimed.core.dayNight.held = true;
    document.querySelector('.run-sheet button.fold')?.click();
    const m = window.rungame.spot('market');
    window.rungame.cam.follow(null);
    return window.rungame.cam.look([m[0], m[1], window.reclaimed.scene.heightAt(m[0], m[1]) ?? window.reclaimed.camera.target[2]], { zoom: 5, ease: 0.3, place: [0.5, 0.5] });
  });
  await R.sleep(2000);
  const wait = Number(R.opt('wait', '12000'));
  const only = R.opt('only', '');
  const ids = ['clear', 'rain', 'storm', 'ashfall', 'fog', 'dark'].filter((k) => !only || only.split(',').includes(k));
  const now = () => p.evaluate(() => {
    const w = window.reclaimed.scene.weatherSet.now;
    const W = window.reclaimed.core.weather;
    return { of: w.of, wind: +w.wind.toFixed(2), storm: w.storm, skyDim: w.skyDim, ash: w.ashFall, fog: w.fog, storms: W.storms.map((s) => +s.intensity.toFixed(2)), windNow: +Math.hypot(W.windX, W.windY).toFixed(2) };
  });
  for (const id of ids) {
    await p.evaluate((x) => window.reclaimed.scene.weatherSet.setSeason(x), id);
    await R.sleep(wait);
    R.log(`${id}: ${JSON.stringify(await now())}`);
    await p.screenshot({ path: path.join(out, `weather-${id}.png`) });
    // (back to clear between: a storm let go thins over 4 s)
    await p.evaluate(() => window.reclaimed.scene.weatherSet.setSeason('clear'));
    await R.sleep(5000);
  }
  if (!only || only.includes('sign')) {
    // (a card's sign: a storm on the home town, as `{ "sign": "storm" }` casts it)
    await p.evaluate(() => {
      const home = window.rungame.realm.home;
      window.mutators.sign({ kind: 'storm', place: home, strength: 1 });
    });
    await R.sleep(wait);
    const w = await now();
    R.log(`storm sign: ${JSON.stringify(w)}`);
    R.check('a storm sign on the town brings the storm', w.of.includes('storm') && w.storms.some((s) => s > 0.5), w);
    await p.screenshot({ path: path.join(out, 'weather-storm-sign.png') });
  }
});
