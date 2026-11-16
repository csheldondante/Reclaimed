// The mutators' stills (docs/design/MUTATORS.md, round 4): one fresh load of the lab, then each sign and mutator in
// turn with a still of it at the default zoom, the panels hidden. For the eye: nothing is asserted but that the page
// lives.
//
//   node scripts/mutators-stills.mjs --dir <folder> [--only ash,dark,dead,crime,withered,dried,founded,map,burned,melted] [--wait 50000]
import fs from 'node:fs';
import path from 'node:path';
import { run, sleep } from './lib/runner.mjs';

const URL0 = '/?skipmenu=1&level=atlas&town=1&mutlab=1&fresh=1&opps=0&livingpanel=0&pace=0';

await run({ name: 'mutators-stills', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const dir = R.opt('dir', '.');
  const only = new Set((R.opt('only', 'ash,dark,dead,crime,withered,dried,founded,map,burned,melted') ?? '').split(','));
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
    // (and close, on the burial ground itself — round 5's close still was framed on the town: the walkers are a cell
    // across)
    const home = await ev(() => [...reclaimed.camera.target]);
    await ev(() => {
      const m = mutateEngine.marksNow[0];
      const o = reclaimed.scene.stream.origin;
      reclaimed.camera.target[0] = m.cell[0] - o[0] + 0.5;
      reclaimed.camera.target[1] = (m.cell[1] - o[1] + 0.5) * 0.8660254;
      reclaimed.camera.zoom = 9;
      return { mark: m.cell, origin: [...o] };
    });
    await shot('deadrise-close.png', 5000);
    await ev((t) => void ((reclaimed.camera.target[0] = t[0]), (reclaimed.camera.target[1] = t[1]), (reclaimed.camera.zoom = 2.6689733724321005)), home);
    await ev(() => void mutators.sign({ kind: 'deadrise', strength: 0 }));
    // (the sign ended: the ground closed again, the dead gone)
    await shot('deadrise-off.png', 8000);
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
  if (only.has('founded')) {
    // (a mining village founded far from home, then travelled to: its streets, houses, pit and spoil heap as the land
    // and the town arrive — BACKLOG MU-6)
    const id = await ev(() => {
      const a = reclaimed.scene.opts.atlas;
      const home = a.settlements.settlement(a.startTown);
      const m = mutators.apply({ kind: 'founded', at: [Math.round(home.at[0]) + Number(new URLSearchParams(location.search).get('fdx') ?? 520), Math.round(home.at[1] / 0.8660254) + 160], name: 'Deepcut', size: 'village', purpose: 'mining', seed: 3 });
      return m.place;
    });
    await ev((id) => void mutlab.go(id), id);
    await page.waitForFunction((id) => mutlab.live().includes(id), { timeout: 180000, polling: 500 }, id);
    await shot('founded.png', Number(R.opt('fwait', 45000)));
    await ev((id) => ({ live: mutlab.live(), place: mutators.place(id) }), id);
    await ev(() => void (reclaimed.camera.zoom = 6));
    await shot('founded-close.png', 4000);
    await ev(() => void (reclaimed.camera.zoom = 2.6689733724321005));
    await ev(() => void mutlab.go(reclaimed.scene.opts.atlas.startTown));
    await sleep(20000);
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
  if (only.has('burned')) {
    // (the burned ground's colour at the default zoom: char, BACKLOG MU-45)
    await ev(() => mutators.apply({ kind: 'burned', place: reclaimed.scene.opts.atlas.startTown, radius: 110, seed: 6 }).resident);
    await shot('burned.png', 12000);
  }
  if (only.has('melted')) {
    await ev(() => mutators.apply({ kind: 'melted', place: reclaimed.scene.opts.atlas.startTown, seed: 5 }).resident);
    await shot('melted.png', 15000);
  }
  if (only.has('edge')) {
    // (round 6, BACKLOG MU-49 / MU-47: a mutator wide enough to cross the window's edge (the window is 320 cells; the
    // view at the default zoom shows ~230 rows past it, top and bottom) — the far tiles must carry it on with no
    // straight line; then a pan across the edge, a still a second into it and one settled.
    // --edgekind burned|withered|dried|buried|flooded|melted, --edger the radius)
    const kind = R.opt('edgekind', 'burned');
    const radius = Number(R.opt('edger', 300));
    const stats = () => ev(() => ({ tiles: { ...reclaimed.renderer.tiles.stats, cal: undefined }, tileDispatches: mutateEngine.host?.gpu?.tileDispatches, origin: [...reclaimed.scene.stream.origin], wetUploads: reclaimed.scene.wetField?.uploads, wetMs: reclaimed.scene.wetField?.msMean, catchMs: reclaimed.scene.catchWet?.msMean }));
    await stats();
    await ev(({ kind, radius }) => mutators.apply({ kind, place: reclaimed.scene.opts.atlas.startTown, radius, seed: 6 }).resident, { kind, radius });
    await shot(`edge-${kind}-1s.png`, 1000);
    await shot(`edge-${kind}.png`, 12000);
    await stats();
    const pan = async (dy, name) => {
      // (a pan, not a jump: 120 world units over two seconds)
      for (let k = 0; k < 24; k++) {
        await ev((d) => void (reclaimed.camera.target[1] += d), dy / 24);
        await sleep(80);
      }
      await shot(`edge-${kind}-${name}-1s.png`, 1000);
      await shot(`edge-${kind}-${name}.png`, 10000);
    };
    await pan(140, 'south');
    await pan(-280, 'north');
    await stats();
  }
});
