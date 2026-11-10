// (round 128s, trackA-legible) City readability: the start town planned as a layout variant (`?legible=A|B|C|D`:
// src/structures/legible.ts) on the user's link at the phone's size, people moving; shots at play zoom on the core and
// on an edge of town, one zoomed out, and the main street with its walkers; the paving's share of the play-zoom shots.
//   node scripts/legible.mjs --variant B [--out dir] [--zoom 8] [--settle 30]
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'legible', kind: 'behaviour', size: '412x915', dpr: 1, echo: !!process.env.DBG }, async (R) => {
  const v = R.opt('variant', 'A');
  const out = R.opt('out', path.join('.testcache', 'legible'));
  const zoom = Number(R.opt('zoom', 8));
  fs.mkdirSync(out, { recursive: true });
  const page = await R.level({ level: 'atlas', town: 1, fortress: 1, fresh: 1, legible: v, tod: 0.35, day: 30000, speed: 4 });
  await page.waitForFunction(() => window.reclaimed?.fortress?.ready || document.querySelector('.fatal'), { timeout: 180000, polling: 250 });
  await R.fatal(page);
  R.log('fortress ready');
  // (time runs in build mode: the bar's Build)
  await page.evaluate(() => {
    if (window.reclaimed.fortress.mode === 'plan') document.querySelector('.fort-bar button.go').click();
  });
  // (people out and about: sim seconds at the link's speed)
  await R.simSeconds(page, Number(R.opt('settle', 30)));
  R.log('settled');
  const info = await page.evaluate(() => {
    const Rc = window.reclaimed;
    const st = Rc.settlements;
    const rec = st.settlement(st.pinnedId);
    const [tx, ty] = st.toWindow(rec.at);
    const site = Rc.fortress.site ?? null;
    const roads = site?.plan?.layout?.roads;
    return { id: rec.id, name: rec.name, civ: rec.civ, size: rec.size, at: [tx, ty], grids: rec.grids?.map((g) => g.style), curves: roads?.curves?.map((c) => ({ kind: c.kind, n: c.pts.length, a: c.pts[0], b: c.pts[c.pts.length - 1] })) ?? null };
  });
  R.log(JSON.stringify(info));
  const look = (x, y, z) =>
    page.evaluate(
      ([bx, by, z]) => {
        const Rc = window.reclaimed;
        const cam = Rc.core.camera;
        // (box-local → the window as it is now: the window slides with the camera)
        const [x, y] = Rc.fortress.toWindow(bx, by);
        const { w, h } = Rc.core.dims;
        const cx = Math.max(0, Math.min(w - 1, Math.floor(x)));
        const cy = Math.max(0, Math.min(h - 1, Math.floor(y / (Math.sqrt(3) / 2))));
        cam.target[0] = x;
        cam.target[1] = y;
        cam.target[2] = Rc.core.map.surface[cy * w + cx];
        cam.zoom = z;
      },
      [x, y, z],
    );
  const shot = async (name) => {
    await sleep(1500);
    const f = path.join(out, `${v}-${name}.png`);
    await page.screenshot({ path: f });
    R.log(`shot ${f}`);
    return f;
  };
  // (everything box-local, the plan's; the town's middle: where its spokes start — else its record's place; the game's panels
  // hidden for the shots, so the town fills the frame)
  const geo = await page.evaluate(() => {
    const Rc = window.reclaimed;
    const f = Rc.fortress;
    const roads = f.site.plan.layout.roads;
    const spoke = roads?.curves?.find((c) => c.kind === 'spoke');
    const mid = spoke ? spoke.pts[0] : null;
    const curves = (roads?.curves ?? []).map((c) => ({ kind: c.kind, pts: c.pts }));
    const ui = document.getElementById('ui');
    if (ui) ui.style.visibility = 'hidden';
    const cells = [];
    const TOWN = new Set(['house', 'hut', 'tower', 'temple', 'hall', 'granary', 'warehouse', 'workshop', 'keep', 'fortress']);
    for (const st of f.site.plan.structures()) if (TOWN.has(st.type)) for (const c of st.cells.keys()) cells.push(f.site.grid.centre(c));
    return { mid, curves, cells };
  });
  // (the built town's middle: its buildings' cells within 50 m of the spokes' start, averaged — the start is the stores,
  // which a port town keeps by its shore)
  const m0 = geo.mid;
  const near = geo.cells.filter(([x, y]) => Math.hypot(x - m0[0], y - m0[1]) < 50);
  const cx = near.reduce((s, p) => s + p[0], 0) / Math.max(1, near.length) || m0[0];
  const cy = near.reduce((s, p) => s + p[1], 0) / Math.max(1, near.length) || m0[1];
  R.log(`middle ${[cx, cy].map((v) => v.toFixed(1))} from ${near.length} cells (stores ${m0.map((v) => v.toFixed(1))})`);
  const geoCells = near;
  const shots = {};
  await look(cx, cy, zoom);
  shots.core = await shot('core');
  // (an edge: the built cell 24-36 m out farthest down the screen — the camera's side)
  const rim = geoCells.filter(([x, y]) => Math.hypot(x - cx, y - cy) > 18 && Math.hypot(x - cx, y - cy) < 34).sort((a, b) => b[1] - a[1])[0];
  if (rim) {
    await look(rim[0], rim[1], zoom);
    shots.edge = await shot('edge');
  }
  // (a main street: a point on a main road 10-18 m from the middle — a field street's first, D's)
  const onStreet = [];
  for (const c of geo.curves) for (const p of c.pts) {
    const d = Math.hypot(p[0] - cx, p[1] - cy);
    if (d > 6 && d < 22) onStreet.push({ p, k: c.kind === 'drawn' ? 0 : 1, d });
  }
  onStreet.sort((a, b) => a.k - b.k || a.d - b.d);
  if (onStreet[0]) {
    const [sx, sy] = onStreet[0].p;
    await look(sx, sy, zoom);
    shots.street = await shot('street');
    // (people on it, closer)
    await look(sx, sy, Number(R.opt('close', 14)));
    shots.people = await shot('people');
  }
  // (the foot traffic: where the town's people are thickest — a unit with the most others within 10 m — closer)
  const crowd = await page.evaluate(([bx, by]) => {
    const Rc = window.reclaimed;
    const f = Rc.fortress;
    const [x, y] = f.toWindow(bx, by);
    const us = Rc.units.query([x, y], 70, {}).map((u) => [u.at[0], u.at[1]]);
    let best = null;
    let bn = -1;
    for (const p of us) {
      const n = us.filter((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 10).length;
      if (n > bn) ((bn = n), (best = p));
    }
    return best ? { at: f.toBox(best[0], best[1]), n: bn, all: us.length } : { all: us.length };
  }, [cx, cy]);
  R.log(`people within 70 m: ${crowd.all}; the thickest spot ${crowd.n ?? 0} within 10 m`);
  if (crowd.at) {
    await look(crowd.at[0], crowd.at[1], Number(R.opt('close', 14)));
    shots.crowd = await shot('crowd');
  }
  await look(cx, cy, Number(R.opt('overview', 4)));
  shots.overview = await shot('overview');
  // (the paving's share at play zoom: light, unsaturated, warm-grey pixels — the paths' colour — of the frame)
  const share = (f) => {
    const png = PNG.sync.read(fs.readFileSync(f));
    let n = 0;
    let pave = 0;
    for (let i = 0; i < png.data.length; i += 4) {
      const r = png.data[i];
      const g = png.data[i + 1];
      const b = png.data[i + 2];
      n++;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      if (mx > 150 && mx - mn < 40) pave++;
    }
    return +((100 * pave) / n).toFixed(1);
  };
  const pct = Object.fromEntries(Object.entries(shots).map(([k, f]) => [k, share(f)]));
  R.log(`paving-ish % ${JSON.stringify(pct)}`);
  fs.writeFileSync(path.join(out, `${v}-info.json`), JSON.stringify({ variant: v, info, pct }, null, 1));
});
