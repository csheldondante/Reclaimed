// (loop round 9, job 5) What still works with the building generator on (`?arch=1`) in the loop's town: the build
// time-lapse (every district not begun rising), a mutator on the town (burned, flooded), the markers. Stills at phone
// size from the same cameras as streetshots.mjs:
//   node scripts/lab/archcheck.mjs --out local/round9 --tag r9e-arch [--params "&arch=1"]
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../lib/runner.mjs';

await run({ name: 'archcheck', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const out = R.opt('out', 'archcheck');
  const tag = R.opt('tag', 'arch');
  const name = (k) => path.join(out, `${tag}-${k}.png`);
  fs.mkdirSync(out, { recursive: true });
  const p = await R.page();
  p.on('console', (m) => {
    const t = m.text();
    if (/^\[(mutate|mutators|arch|citygen)\]/.test(t)) R.log(t.slice(0, 300));
  });
  await p.goto(`${R.url}/?skipmenu=1&level=atlas&town=1&loop=1&fresh=1&q=low&warmcache=0${R.opt('params', '')}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.rungame?.phase === 'leader' || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(p);
  await p.evaluate(() => (window.rungame.pick('ysolt'), window.rungame.closePanel()));
  await p.waitForFunction(() => window.rungame.phase === 'city', { timeout: 60000, polling: 250 });
  await R.sleep(3000);
  // (the generator's instances and vertices, a debugging read: TownBuildings.counts)
  R.log(`arch counts: ${JSON.stringify(await p.evaluate(async () => (globalThis.archTowns ? await globalThis.archTowns.counts() : null)))}`);
  const town = () => p.evaluate(() => {
    window.reclaimed.core.camera.elevation = Math.PI / 3;
    window.rungame.showTown();
  });
  // the time-lapse: every district not begun rises over 12 s of the town's clock
  R.check('time-lapse begun', await p.evaluate(() => window.citygen.timelapse(12)));
  await town();
  await R.sleep(5000);
  await R.fatal(p);
  await p.screenshot({ path: name('timelapse-mid') });
  await R.sleep(16000);
  await R.fatal(p);
  await p.screenshot({ path: name('timelapse-end') });
  // a mutator on the town: its west half burned
  const applied = await p.evaluate(() => {
    const t = [...window.citygen.live.values()][0];
    const r = window.mutators.apply({ kind: 'burned', place: t.site.id, radius: 60, strength: 0.7, seed: 3 });
    return { kind: r?.mutation?.kind ?? r?.kind ?? null, lots: r?.lots ?? r?.mutation?.lots ?? null };
  });
  R.log(`burned: ${JSON.stringify(applied)}`);
  await R.sleep(4000);
  await town();
  await R.sleep(3500);
  await R.fatal(p);
  await p.screenshot({ path: name('burned-town') });
  await p.evaluate(() => {
    window.reclaimed.core.camera.elevation = (55 * Math.PI) / 180;
    window.rungame.lookAt('market', 16);
  });
  await R.sleep(3500);
  await p.screenshot({ path: name('burned-street') });
  const marks = await p.evaluate(() => window.rungame.markers().map((m) => m.label || m.kind));
  R.log(`markers: ${JSON.stringify(marks)}`);
});
