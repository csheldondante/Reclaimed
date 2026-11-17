// (loop round 15, LS-133/134) The points of interest at phone size: the raiders' camp (made at the run's start) and a
// lair put near the town as a card's `poi` effect writes it (fixture: the fact and its record, as season/pois.ts addPoi
// does, 30 cells out so the window holds it). Stills: the atlas map with the pins, the 3D marker where the lair stands.
//   node scripts/lab/poishots.mjs [--out dir] [--far 30]
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../lib/runner.mjs';

await run({ name: 'poishots', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const out = R.opt('out', 'poishots');
  fs.mkdirSync(out, { recursive: true });
  const p = await R.page();
  p.on('console', (m) => {
    if (m.type() === 'error') R.log(m.text().slice(0, 300));
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
  await R.sleep(3000);
  const made = await p.evaluate((far) => {
    const r = window.rungame.realm;
    const home = r.w.settlement(r.home);
    const RH = Math.sqrt(3) / 2;
    const cell = [Math.round(home.at[0] + far), Math.round((home.at[1] + far * 0.4) / RH)];
    r.w.facts.add({ id: 'poi:wolves-den', kind: 'site', name: 'the wolves’ den', at: { region: home.region, at: cell }, attrs: { poi: 'lair' }, cause: 'poishots-fixture' });
    r.w.facts.record({ kind: 'poi-made', by: [], to: ['poi:wolves-den'], about: { opp: 'poishots-fixture' }, note: 'the wolves’ den, a lair, is on the map (fixture)' });
    return r.pois().map((q) => ({ name: q.name, kind: q.kind, state: q.state, cell: q.cell }));
  }, Number(R.opt('far', '30')));
  R.log(`pois: ${JSON.stringify(made)}`);
  R.check('the camp and the lair are POIs', made.some((q) => q.kind === 'camp') && made.some((q) => q.kind === 'lair'), made);
  // (the 3D marker: the camera over the lair, the sheet folded)
  await p.evaluate(() => document.querySelector('.run-sheet button.fold')?.click());
  const at = await p.evaluate(() => {
    const q = window.rungame.realm.pois().find((x) => x.kind === 'lair');
    const o = window.reclaimed.scene.stream?.origin ?? [0, 0];
    const RH = Math.sqrt(3) / 2;
    const x = q.cell[0] - o[0];
    const y = (q.cell[1] - o[1]) * RH;
    window.rungame.cam.follow(null);
    window.rungame.cam.look([x, y, window.reclaimed.scene.heightAt(x, y) ?? window.reclaimed.camera.target[2]], { zoom: 7, ease: 0.3, place: [0.5, 0.45] });
    return [Math.round(x), Math.round(y), window.reclaimed.scene.worldApi.terrain.inWindow(x, y)];
  });
  R.log(`lair in the window at ${JSON.stringify(at)}`);
  await R.sleep(3500);
  R.log(`the lair on screen at ${JSON.stringify(await p.evaluate((q) => window.reclaimed.camera.project(q[0], q[1], window.reclaimed.scene.heightAt(q[0], q[1]) ?? 0)?.map(Math.round), at))}`);
  await shot('poi-3d-a');
  await R.sleep(300);
  await shot('poi-3d-b');
  // (the atlas map, opened as its button opens it)
  await p.evaluate(() => window.reclaimed.scene.atlasMap.open());
  await R.sleep(1500);
  await shot('poi-map');
  // (zoomed in twice by its + button, as a player looks closer)
  for (let k = 0; k < 2; k++) await p.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === '+' && b.offsetParent)?.click());
  await R.sleep(1200);
  await shot('poi-map-near');
});
