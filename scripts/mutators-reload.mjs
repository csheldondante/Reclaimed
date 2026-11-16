// The mutators' reload proof (docs/design/MUTATORS.md, round 4): three places mutated — the loaded home town and two
// places that are not loaded — stills of each and of the map; the page loaded again WITHOUT fresh=1; the same stills
// and the same reads. The place states (the fact layer), the list, the signs and each town's lot conditions must be
// the same; the stills are for the eye.
//
//   node scripts/mutators-reload.mjs --dir <folder for the stills> [--wait 50000] [--settle 25000]
import fs from 'node:fs';
import path from 'node:path';
import { run, sleep } from './lib/runner.mjs';

const BASE = '/?skipmenu=1&level=atlas&town=1&mutlab=1&opps=0&livingpanel=0&pace=0';

await run({ name: 'mutators-reload', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const dir = R.opt('dir', '.');
  const wait = Number(R.opt('wait', 50000));
  const settle = Number(R.opt('settle', 25000));
  fs.mkdirSync(dir, { recursive: true });
  const page = await R.page();
  const boot = async (url) => {
    await page.goto(`${R.url}${url}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
    await R.fatal(page);
    await page.waitForFunction(() => window.__boot?.at.store || document.querySelector('.fatal'), { timeout: 120000, polling: 250 });
    await sleep(wait);
    await R.fatal(page);
  };
  // (the panels hidden for a still: the lab's buttons and the tools cover a third of a phone screen)
  const ui = (on) =>
    page.evaluate((on) => {
      for (const e of document.body.querySelectorAll('div, button, select')) if (!e.querySelector('canvas')) e.style.visibility = on ? '' : 'hidden';
    }, on);
  const shot = async (name) => {
    await ui(false);
    await sleep(300);
    await page.screenshot({ path: path.join(dir, name) });
    await ui(true);
    console.log(`saved ${path.join(dir, name)}`);
  };
  const mapShot = async (name) => {
    await page.evaluate(() => {
      const m = reclaimed.scene.atlasMap;
      m.open();
      m.zoom(0.5);
      m.zoom(0.5);
    });
    await sleep(1500);
    await page.screenshot({ path: path.join(dir, name) });
    await page.evaluate(() => reclaimed.scene.atlasMap.close());
    console.log(`saved ${path.join(dir, name)}`);
  };
  const go = async (id) => {
    await page.evaluate((id) => mutlab.go(id), id);
    // (the land arrives, the town is made, the mutators write both)
    await page.waitForFunction((id) => mutlab.live().includes(id), { timeout: 240000, polling: 500 }, id).catch(() => {});
    await sleep(settle);
    await R.fatal(page);
  };
  const state = (ids) =>
    page.evaluate(async (ids) => {
      await mutateEngine.levels;
      const out = { places: mutators.places().map((p) => ({ ...p, history: p.history.length })), list: mutators.record().list.map((m) => [m.kind, m.place, m.radius, m.strength, m.seed, m.by ?? '']), signs: mutators.signs(), conditions: {} };
      for (const id of ids) out.conditions[id] = await mutlab.conditions(id);
      return out;
    }, ids);

  // ---- the first load: a fresh world, three places mutated
  await boot(`${BASE}&fresh=1`);
  const picked = await page.evaluate(() => {
    const a = reclaimed.scene.opts.atlas;
    const st = a.settlements;
    const home = st.settlement(a.startTown);
    const live = new Set(mutlab.live());
    // (two places that are not loaded and whose land is not in the window: field towns, so their lots show a condition)
    const fields = new Set(a.fieldTowns ?? []);
    const far = st
      .near(home.at, 1e9)
      .filter((q) => !live.has(q.id) && fields.has(q.id) && Math.hypot(q.at[0] - home.at[0], q.at[1] - home.at[1]) > 500)
      .slice(0, 2);
    const w = mutators.world;
    const by = w.facts.find({ kind: 'faction' }).find((f) => f.id !== w.controllerOf(far[0].id))?.id;
    const r = [];
    r.push(mutators.apply({ kind: 'flooded', place: home.id, seed: 1 }));
    r.push(mutators.apply({ kind: 'burned', place: far[0].id, seed: 2 }));
    r.push(mutators.apply({ kind: 'captured', place: far[0].id, by }));
    r.push(mutators.apply({ kind: 'buried', place: far[1].id, seed: 3 }));
    return { home: home.id, far: far.map((q) => q.id), names: [home.name, ...far.map((q) => q.name)], resident: r.map((m) => m.resident), zoom: reclaimed.camera.zoom, zoomFloor: reclaimed.camera.zoomFloor };
  });
  console.log(`[picked] ${JSON.stringify(picked)}`);
  R.check('the home town was written at once, the far places were not', picked.resident[0] === true && picked.resident[1] === false && picked.resident[3] === false, picked.resident);
  const ids = [picked.home, ...picked.far];
  const visit = async (tag) => {
    const got = {};
    await sleep(settle);
    await shot(`${tag}-home.png`);
    got.home = await state([picked.home]);
    await mapShot(`${tag}-map.png`);
    for (const [k, id] of picked.far.entries()) {
      await go(id);
      await shot(`${tag}-far${k + 1}.png`);
      got[`far${k + 1}`] = (await state([id])).conditions;
    }
    return got;
  };
  const one = await visit('before');
  console.log(`[before] ${JSON.stringify(one)}`);
  // (back home before the save, so both loads start at the same place)
  await go(picked.home);
  await page.evaluate(() => reclaimed.stream.saveAll());
  await sleep(1500);

  // ---- the second load: the saved world, no fresh=1
  await boot(BASE);
  const two = await visit('after');
  console.log(`[after] ${JSON.stringify(two)}`);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  R.check('the list is the same after the reload', same(one.home.list, two.home.list), two.home.list);
  R.check('the place states are the same after the reload', same(one.home.places, two.home.places), { before: one.home.places, after: two.home.places });
  R.check('the signs are the same after the reload', same(one.home.signs, two.home.signs));
  R.check("the home town's lot conditions are the same", same(one.home.conditions, two.home.conditions), { before: one.home.conditions, after: two.home.conditions });
  R.check("the first far place's lot conditions are the same", same(one.far1, two.far1), { before: one.far1, after: two.far1 });
  R.check("the second far place's lot conditions are the same", same(one.far2, two.far2), { before: one.far2, after: two.far2 });
  console.log(`[places] ${ids.join(', ')}`);
});
