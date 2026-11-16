// The mutators' stills (docs/design/MUTATORS.md, round 4): one fresh load of the lab, then each sign and mutator in
// turn with a still of it at the default zoom, the panels hidden. For the eye: nothing is asserted but that the page
// lives.
//
//   node scripts/mutators-stills.mjs --dir <folder> [--only ash,dark,dead,crime,withered,dried,map,melted] [--wait 50000]
import fs from 'node:fs';
import path from 'node:path';
import { run, sleep } from './lib/runner.mjs';

const URL0 = '/?skipmenu=1&level=atlas&town=1&mutlab=1&fresh=1&opps=0&livingpanel=0&pace=0';

await run({ name: 'mutators-stills', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const dir = R.opt('dir', '.');
  const only = new Set((R.opt('only', 'ash,dark,dead,crime,withered,dried,map,melted') ?? '').split(','));
  fs.mkdirSync(dir, { recursive: true });
  const page = await R.page();
  await page.goto(`${R.url}${URL0}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(page);
  await page.waitForFunction(() => window.__boot?.at.store || document.querySelector('.fatal'), { timeout: 120000, polling: 250 });
  await sleep(Number(R.opt('wait', 50000)));
  await R.fatal(page);
  const ui = (on) =>
    page.evaluate((on) => {
      for (const e of document.body.querySelectorAll('div, button, select')) if (!e.querySelector('canvas')) e.style.visibility = on ? '' : 'hidden';
    }, on);
  const shot = async (name, wait = 6000) => {
    await sleep(wait);
    await R.fatal(page);
    await ui(false);
    await sleep(300);
    await page.screenshot({ path: path.join(dir, name) });
    await ui(true);
    console.log(`saved ${path.join(dir, name)}`);
  };
  const ev = async (f, arg) => {
    const r = await page.evaluate(f, arg);
    if (r !== undefined) console.log(`[eval] ${JSON.stringify(r)}`);
    return r;
  };
  console.log(`[zoom] ${JSON.stringify(await page.evaluate(() => ({ zoom: reclaimed.camera.zoom, floor: reclaimed.camera.zoomFloor, home: reclaimed.scene.opts.atlas.startTown })))}`);
  await shot('base.png', 500);
  if (only.has('ash')) {
    await ev(() => void mutators.sign({ kind: 'ashfall', strength: 1 }));
    await shot('ash.png');
    await ev(() => void mutators.sign({ kind: 'ashfall', strength: 0.4 }));
    await shot('ash-light.png');
    if (only.has('dark')) {
      await ev(() => void (mutators.sign({ kind: 'ashfall', strength: 1 }), mutators.sign({ kind: 'darkness', strength: 0.8 })));
      await shot('ash-dark.png');
    }
    await ev(() => void (mutators.sign({ kind: 'ashfall', strength: 0 }), mutators.sign({ kind: 'darkness', strength: 0 })));
  }
  if (only.has('dead')) {
    await ev(() => void mutators.sign({ kind: 'deadrise', strength: 1 }));
    await shot('deadrise.png', 12000);
    // (and close: the walkers are a cell across)
    await ev(() => void (reclaimed.camera.zoom = 9));
    await shot('deadrise-close.png', 4000);
    await ev(() => void (reclaimed.camera.zoom = 2.6689733724321005));
    await ev(() => void mutators.sign({ kind: 'deadrise', strength: 0 }));
  }
  if (only.has('crime')) {
    await ev(() => void mutators.sign({ kind: 'crime', strength: 1 }));
    await shot('crime.png');
    await ev(() => void mutators.sign({ kind: 'crime', strength: 0 }));
  }
  if (only.has('withered')) {
    // (--witherr: the radius — 260 takes in the woods south of the home town, to judge the dead trees)
    await ev((radius) => mutators.apply({ kind: 'withered', place: reclaimed.scene.opts.atlas.startTown, radius, seed: 4 }).resident, Number(R.opt('witherr', 110)));
    await shot('withered.png', 12000);
    await ev(() => void (reclaimed.camera.zoom = 9));
    await shot('withered-close.png', 4000);
    await ev(() => void (reclaimed.camera.zoom = 2.6689733724321005));
  }
  if (only.has('dried')) {
    await ev(() => mutators.apply({ kind: 'dried', place: reclaimed.scene.opts.atlas.startTown, radius: 110, seed: 5 }).resident);
    await shot('dried.png', 15000);
    await ev(() => {
      const s = reclaimed.scene;
      const inflow = s.catchWet?.inflow ? Array.from(s.catchWet.inflow) : [];
      return { riverInflow: [...s.riverInflow], nodes: inflow.length, lowered: inflow.filter((v) => v < 1).length, wet: reclaimed.globals.riverWet };
    });
  }
  if (only.has('map')) {
    await ev(() => {
      const a = reclaimed.scene.opts.atlas;
      const st = a.settlements;
      const home = st.settlement(a.startTown);
      const far = st.near(home.at, 1e9).filter((q) => q.id !== home.id && Math.hypot(q.at[0] - home.at[0], q.at[1] - home.at[1]) > 300 && (q.size === 'town' || q.size === 'city' || q.size === 'village')).slice(0, 7);
      const w = mutators.world;
      const other = (id) => w.facts.find({ kind: 'faction' }).find((f) => f.id !== w.controllerOf(id)).id;
      mutators.apply({ kind: 'flooded', place: far[0].id });
      mutators.apply({ kind: 'burned', place: far[1].id });
      mutators.apply({ kind: 'captured', place: far[1].id, by: other(far[1].id) });
      mutators.apply({ kind: 'buried', place: far[2].id });
      mutators.apply({ kind: 'abandoned', place: far[2].id });
      mutators.apply({ kind: 'vassal', place: far[3].id, by: other(far[3].id), tribute: 3 });
      mutators.apply({ kind: 'destroyed', place: far[4].id });
      mutators.apply({ kind: 'captured', place: far[5].id, by: other(far[5].id) });
      mutators.apply({ kind: 'founded', at: [Math.round(home.at[0]) + 260, Math.round(home.at[1] / 0.866) - 200], name: 'New camp', size: 'camp', by: other(home.id) });
      const m = reclaimed.scene.atlasMap;
      m.open();
      m.zoom(0.5);
      m.zoom(0.5);
      return far.map((q) => q.name);
    });
    await sleep(1500);
    await page.screenshot({ path: path.join(dir, 'map.png') });
    console.log(`saved ${path.join(dir, 'map.png')}`);
    await ev(() => void reclaimed.scene.atlasMap.close());
  }
  if (only.has('melted')) {
    await ev(() => mutators.apply({ kind: 'melted', place: reclaimed.scene.opts.atlas.startTown, seed: 5 }).resident);
    await shot('melted.png', 15000);
  }
});
