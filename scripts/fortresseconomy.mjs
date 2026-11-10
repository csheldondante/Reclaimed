// (fortress milestone 3) The economy feeds the building. A town is planned by the API on flat dry ground near the start
// town: a warehouse, houses, a farm, a quarry, and a lumber camp toward the nearest trees. Build is pressed and the sim
// runs fast (?speed=): the builders raise it from the stores; then the quarry's pit deepens (the ground the miners stand
// on, read in the agents' field), trees in the camp's reach fall, carriers haul to the warehouse and the stocks grow,
// people arrive up to the beds. Every bar and card line is printed (docs/WRITING.md) and shots are taken at play zoom.
//   node scripts/fortresseconomy.mjs [--out C:/Projects/shots88/fortress] [--secs 240]
import { run, sleep } from './lib/runner.mjs';

const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? process.argv[outArg + 1] : null;
const SPEED = 6;
await run({ name: 'fortresseconomy', kind: 'behaviour', size: '412x915', dpr: 1, echo: !!process.env.DBG }, async (R) => {
  const secs = Number(R.opt('secs', 300));
  const page = await R.page();
  await page.goto(`${R.url}/?skipmenu=1&level=atlas&town=1&fortress=1&tod=0.3&day=30000&speed=${SPEED}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(page);
  await page.waitForFunction(() => window.reclaimed?.fortress?.ready || document.querySelector('.fatal'), { timeout: 120000, polling: 250 });
  await sleep(2000);
  const info = await page.evaluate(async () => {
    const Rc = window.reclaimed;
    const f = Rc.fortress;
    const st = Rc.settlements;
    const rec = st.settlement(st.pinnedId);
    const [tx, ty] = st.toWindow(rec.at);
    // (the ground the units stand on — agents' reader of the quarry's field: its z is the surface, the river's bed not its water)
    const rd0 = Rc.units.agents.reader(2);
    await rd0.refresh();
    // (the world API's mirror: the plants' trees and the terrain read)
    await Rc.api.refresh(true);
    const groundAt = (x, y) => {
      const r = Math.round(y / (Math.sqrt(3) / 2));
      const k = Math.round(x);
      const { w, h } = Rc.core.dims;
      if (k < 40 || r < 40 || k >= w - 40 || r >= h - 40) return NaN;
      if (f.windowToBoxCol(r * w + k) < 0) return NaN;
      const q = rd0.sample(x, y);
      return q && q.z > 0 ? q.z : NaN;
    };
    const wet = (x, y) => (Rc.api.water.depthAt(x, y) ?? 0) > 0.05;
    // a flat dry site 30-70 from the town's middle: every point within 18 of it within 1.5 of its height
    // (of those, the one with the most trees within 60: the lumber camp needs some in reach)
    let site = null;
    let best = 4;
    for (let r = 30; r <= 90; r += 10)
      for (let a = 0; a < 16; a++) {
        const x = tx + Math.cos((a / 16) * Math.PI * 2) * r;
        const y = ty + Math.sin((a / 16) * Math.PI * 2) * r;
        const g0 = groundAt(x, y);
        let ok = Number.isFinite(g0);
        for (let dx = -18; dx <= 18 && ok; dx += 3) for (let dy = -18; dy <= 18 && ok; dy += 3) ok = Math.abs(groundAt(x + dx, y + dy) - g0) < 1.5 && !wet(x + dx, y + dy);
        const n = ok ? (await Rc.api.plants.treesNear(x, y, 60)).length : 0;
        if (n > best) {
          best = n;
          site = [x, y];
        }
      }
    if (!site) throw new Error('no flat dry site near the town');
    const [cx, cy] = site;
    const g = f.town.grid;
    const paintAt = (x, y, type, levels = 1) => {
      const c = f.cellAt(x, y);
      if (c < 0) return -1;
      for (let l = 0; l < levels; l++) f.paint(c, l, type);
      return c;
    };
    // the trees' way (u) and across it (v): the lumber camp toward the nearest trees, the quarry away from them in the
    // open, the houses and the farm either side
    const trees = (await Rc.api.plants.treesNear(cx, cy, 70)).map((t) => [t.x, t.y]).sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
    if (trees.length < 5) throw new Error(`too few trees near the site: ${trees.length}`);
    const near = trees.slice(0, 10);
    const mx = near.reduce((a, p) => a + p[0], 0) / near.length;
    const my = near.reduce((a, p) => a + p[1], 0) / near.length;
    const d = Math.hypot(mx - cx, my - cy);
    const u = [(mx - cx) / d, (my - cy) / d];
    const v = [-u[1], u[0]];
    const at = (a, b) => [cx + u[0] * a + v[0] * b, cy + u[1] * a + v[1] * b];
    const store = paintAt(cx, cy, 'warehouse', 2);
    const houses = [paintAt(...at(-3, 11), 'house', 2), paintAt(...at(3, 11), 'house', 2)];
    const farm = [];
    for (const [a, b] of [[-3, -11], [2, -11], [-3, -16], [2, -16]]) farm.push(paintAt(...at(a, b), 'farm'));
    const quarry = [];
    for (const [a, b] of [[-13, -3], [-13, 3], [-18, 0]]) quarry.push(paintAt(...at(a, b), 'quarry'));
    const k = Math.min(18, Math.max(8, d - 12)) / d;
    let lx = cx + (mx - cx) * k;
    let ly = cy + (my - cy) * k;
    // (not on a cell already planned)
    for (let tries = 0; tries < 6 && f.plan.owner[f.cellAt(lx, ly)] >= 0; tries++) {
      lx += ((mx - cx) / d) * 5;
      ly += ((my - cy) / d) * 5;
    }
    const lumber = [paintAt(lx, ly, 'lumber')];
    const ln = g.nbr[lumber[0] * 4 + 0];
    if (ln >= 0 && f.plan.owner[ln] < 0) {
      f.paint(ln, 0, 'lumber');
      lumber.push(ln);
    }
    window.__m3 = { cx, cy, store, houses, farm, quarry, lumber, lx, ly };
    Rc.camera.target[0] = cx;
    Rc.camera.target[1] = cy + 8;
    Rc.camera.zoom = 4;
    return {
      site: [Math.round(cx - tx), Math.round(cy - ty)],
      trees: trees.length,
      nearTree: Math.round(Math.hypot(near[0][0] - lx, near[0][1] - ly)),
      structures: f.plan.structures().map((s) => `${s.type}:${s.cells.size}`),
      stores: f.stores(),
    };
  });
  console.log('plan', JSON.stringify(info));
  await sleep(1500);
  console.log('onscreen', JSON.stringify(await page.evaluate(() => {
    const Rc = window.reclaimed;
    const f = Rc.fortress;
    const m = window.__m3;
    const [x, y] = f.centre(m.store);
    return { store: Rc.camera.project(x, y, f.town.floorZ(m.store, 0)).map(Math.round), target: [...Rc.camera.target].map(Math.round), xy: [Math.round(x), Math.round(y)], zoom: Rc.camera.zoom, pieces: Rc.scene?.settlementsView?.extra?.() ? 'yes' : 'no' };
  })));
  const barText = () => page.evaluate(() => [...document.querySelectorAll('.fort-top div, .fort-info p')].map((e) => e.textContent));
  console.log('bar plan', JSON.stringify(await barText()));
  if (OUT) await page.screenshot({ path: `${OUT}/m3-plan.png` });
  // the quarry's ground and the trees in the camp's reach before
  const probe = () =>
    page.evaluate(async () => {
      const Rc = window.reclaimed;
      const f = Rc.fortress;
      const m = window.__m3;
      // (the ground at each quarry cell's middle — the nature grid's, structures aside — against what it was at first)
      await Rc.api.refresh(true);
      const now = m.quarry.map((c) => Rc.api.terrain.groundAt(...f.centre(c)) ?? NaN);
      m.ground0 ??= now;
      const depth = now.map((z, i) => +(m.ground0[i] - z).toFixed(2));
      const life = Rc.fortressCrowd();
      return {
        depth,
        // (window coordinates move when the window slides: from the cells, now)
        trees: (await Rc.api.plants.treesNear(...f.centre(m.lumber[0]), 36)).length,
        felledAt: life ? life.felledAt.map(([x, y]) => [Math.round(x - f.centre(m.lumber[0])[0]), Math.round(y - f.centre(m.lumber[0])[1]), !!Rc.api.plants.treeAt(x, y)]) : [],
        stores: Object.fromEntries(Object.entries(f.stores()).map(([k, v]) => [k, +v.toFixed(1)])),
        people: f.status.people,
        beds: f.beds(),
        room: f.room(),
        jobs: f.status.jobs,
        full: f.status.full,
        hungry: f.status.hungry,
        progress: f.progress(),
        stats: life ? { ...life.stats, dug: +life.stats.dug.toFixed(2) } : null,
        awake: Rc.core.sleep?.awake,
      };
    });
  const before = await probe();
  console.log('before', JSON.stringify(before));
  await page.evaluate(() => [...document.querySelectorAll('.fort-bar button')].find((b) => b.textContent === 'Build').click());
  const t0 = Date.now();
  let last = before;
  let shotBuild = false;
  const log = [];
  while ((Date.now() - t0) / 1000 < secs) {
    await sleep(5000);
    await R.fatal(page);
    last = await probe();
    const s = last.stats;
    log.push(last);
    console.log(`t ${Math.round((Date.now() - t0) / 1000)}s`, JSON.stringify({ built: `${last.progress.built}/${last.progress.total}`, people: `${last.people}/${last.beds}`, jobs: last.jobs, stores: last.stores, depth: last.depth, trees: last.trees, s, awake: last.awake }));
    if (!shotBuild && last.progress.built > 3 && OUT) {
      shotBuild = true;
      await page.screenshot({ path: `${OUT}/m3-building.png` });
      console.log('bar building', JSON.stringify(await barText()));
    }
    const pit = Math.max(...last.depth.map((d) => d ?? 0));
    if (last.progress.built === last.progress.total && pit > 0.6 && s.felled >= 2 && s.hauled >= 10 && last.people >= last.beds) break;
  }
  console.log('bar end', JSON.stringify(await barText()));
  // (FT-46) roads cost less: the warehouse's field at the far house's door, with the roads and without them
  const roads = await page.evaluate(async () => {
    const Rc = window.reclaimed;
    const f = Rc.fortress;
    const m = window.__m3;
    const rd = Rc.units.agents.reader(5);
    const doors = m.houses.map((c) => f.doorOf(f.plan.owner[c]));
    const read = async () => {
      await new Promise((r) => setTimeout(r, 4000));
      await rd.refresh();
      return doors.map((d) => +rd.sample(...d).dist.toFixed(1));
    };
    const withRoads = await read();
    // (round 128i: the road shapes stamped on the GPU — none while `without` is read)
    const keep = f.roadShapes;
    const none = new Float32Array(0);
    f.roadShapes = () => none;
    const without = await read();
    f.roadShapes = keep;
    return { withRoads, without, roads: f.roadShapes().length / 12 };
  });
  console.log('roads', JSON.stringify(roads));
  // (the camera on a cell, its middle read at the time: the window slides as the camera goes, and window coordinates
  // with it — aimed again after the slide)
  const shot = async (name, key, zoom) => {
    const aim = () =>
      page.evaluate(
        (key, zoom) => {
          const Rc = window.reclaimed;
          const f = Rc.fortress;
          const m = window.__m3;
          const c = Array.isArray(m[key]) ? m[key][0] : m[key];
          const [x, y] = f.centre(c);
          Rc.camera.zoom = zoom;
          Rc.camera.target[0] = x;
          Rc.camera.target[1] = y + 60 / zoom;
          return [x, y];
        },
        key,
        zoom,
      );
    await aim();
    await sleep(2000);
    const [x, y] = await aim();
    await sleep(1500);
    // (where each structure's cells are on the shot, to look at them)
    const marks = await page.evaluate(() => {
      const Rc = window.reclaimed;
      const f = Rc.fortress;
      const m = window.__m3;
      const P = (c) => {
        const [x, y] = f.centre(c);
        return Rc.camera.project(x, y, Rc.api.terrain.groundAt(x, y) ?? 0).map(Math.round).join(',');
      };
      return Object.fromEntries(['store', 'houses', 'farm', 'quarry', 'lumber'].map((k) => [k, [m[k]].flat().map(P).join(' ')]));
    });
    console.log('shot', name, JSON.stringify(marks));
    if (OUT) await page.screenshot({ path: `${OUT}/${name}.png` });
  };
  await shot('m3-town', 'store', 4);
  await shot('m3-quarry', 'quarry', 8);
  await shot('m3-quarry-near', 'quarry', 14);
  console.log('quarry trees', JSON.stringify(await page.evaluate(async () => {
    const Rc = window.reclaimed;
    const f = Rc.fortress;
    return Promise.all(
      window.__m3.quarry.map(async (c) => {
        const [x, y] = f.centre(c);
        return { trees: (await Rc.api.plants.treesNear(x, y, 4)).map((t) => +Math.hypot(t.x - x, t.y - y).toFixed(1)), ground: Rc.api.terrain.groundAt(x, y) };
      }),
    );
  })));
  console.log('people', JSON.stringify(await page.evaluate(async () => {
    const Rc = window.reclaimed;
    const f = Rc.fortress;
    const life = Rc.fortressCrowd();
    const q = f.centre(window.__m3.quarry[0]);
    const home = Rc.units.agents.reader(3);
    await home.refresh();
    // (round 128p, U1: where they stand asked of the GPU — a unit's place isn't read unless observed)
    const where = new Map((await Rc.units.query([0, 0], 1e7)).map((v) => [v.id, v.at]));
    return life.ids.map((id) => {
      const u = Rc.units.recs.get(id);
      const p = where.get(id);
      if (!p) return `${id}: not found`;
      const h = home.sample(p[0], p[1], p[2]);
      return `${u.work?.job ?? '-'}/${u.work?.phase}@${Math.round(Math.hypot(p[0] - q[0], p[1] - q[1]))} g${u.group} ${u.v.state} home ${h ? Math.round(h.dist) : '?'}`;
    }).join(' | ');
  })));
  await shot('m3-lumber', 'lumber', 6);
  await shot('m3-farm', 'farm', 7);
  // Inspect cards: the quarry, the farm, the warehouse, the lumber camp, a house
  await page.evaluate(() => [...document.querySelectorAll('.fort-bar button')].find((b) => b.textContent === 'Inspect').click());
  const cards = {};
  for (const k of ['quarry', 'farm', 'store', 'lumber', 'houses']) {
    cards[k] = await page.evaluate(async (k) => {
      const f = window.reclaimed.fortress;
      const m = window.__m3;
      const c = Array.isArray(m[k]) ? m[k][0] : m[k];
      f.inspect(f.plan.owner[c]);
      await new Promise((r) => setTimeout(r, 800));
      return [...document.querySelectorAll('.fort-info p')].map((e) => e.textContent);
    }, k);
    console.log('card', k, JSON.stringify(cards[k]));
  }
  await shot('m3-inspect', 'quarry', 5);
  await page.evaluate(() => {
    const f = window.reclaimed.fortress;
    f.inspect(f.plan.owner[window.__m3.store]);
  });
  await shot('m3-inspect-store', 'store', 5);
  // Erase a built house block: half its cost back
  const refund = await page.evaluate(() => {
    const Rc = window.reclaimed;
    const f = Rc.fortress;
    const m = window.__m3;
    const st0 = { ...f.stores() };
    const ok = f.erase(m.houses[0], 1);
    const st1 = { ...f.stores() };
    return { ok, log: +(st1.log - st0.log).toFixed(2), stone: +(st1.stone - st0.stone).toFixed(2) };
  });
  console.log('refund', JSON.stringify(refund));
  const pit = Math.max(...last.depth.map((d) => d ?? 0));
  R.check('everything planned was built', last.progress.built === last.progress.total, JSON.stringify(last.progress));
  R.check("the quarry's pit deepens (the ground under its cells is lower)", pit > 0.5, JSON.stringify({ before: before.depth, after: last.depth, dug: last.stats.dug }));
  R.check("trees in the camp's reach fall", last.stats.felled >= 2 && last.trees < before.trees, JSON.stringify({ before: before.trees, after: last.trees, felled: last.stats.felled }));
  R.check('carriers haul to the warehouse', last.stats.hauled >= 10, JSON.stringify(last.stats));
  R.check('stone and ore grew from the quarry', log.some((p, i) => i > 0 && p.stores.stone > log[i - 1].stores.stone) && (last.stores.ore ?? 0) > 0, JSON.stringify(last.stores));
  R.check('people arrive up to the beds', last.people > before.people && last.people <= last.beds, JSON.stringify({ before: before.people, after: last.people, beds: last.beds }));
  R.check('Erase gives back half a built house block', refund.ok && refund.log === Math.floor(4 * 0.5) && refund.stone === Math.floor(2 * 0.5), JSON.stringify(refund));
  R.check('a road costs less to walk (the field to the warehouse is shorter with the roads)', roads.roads > 0 && roads.withRoads.every((d, i) => d < roads.without[i]), JSON.stringify(roads));
  R.check('the cards show live workers', /Workers: [1-9]/.test(cards.quarry.join(' ')) && /Brought to the stores so far/.test(cards.quarry.join(' ')), JSON.stringify(cards.quarry));
});
