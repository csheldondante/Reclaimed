// (round 128l) The user, on the phone: "The city has ports and a wall but I don't see any gate so the only exit does look
// like it is into the sea"; "I mean towns should always have gates". The starting town of the fortress link (?town=1): its
// wall's runs, the gaps between them, which gaps are on land, and a shot of the town at play zoom.
//   node scripts/fortressgates.mjs [--out dir]
import { run, sleep } from './lib/runner.mjs';

const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? process.argv[outArg + 1] : null;
await run({ name: 'fortressgates', kind: 'behaviour', size: '412x915', dpr: Number(process.env.DPR ?? 1) }, async (R) => {
  const page = await R.page();
  await page.goto(`${R.url}/?skipmenu=1&level=atlas&town=1&fortress=1${process.env.Q ? `&q=${process.env.Q}` : ''}${process.env.SPEED ? `&speed=${process.env.SPEED}` : ''}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(page);
  await page.waitForFunction(() => window.reclaimed?.fortress?.ready || document.querySelector('.fatal'), { timeout: 120000, polling: 250 });
  await sleep(Number(process.env.WAIT ?? 2000));
  const info = await page.evaluate(() => {
    const Rc = window.reclaimed;
    const st = Rc.settlements;
    const id = st.pinnedId;
    const p = st.plan(id);
    const c = p.city;
    const walls = c.linear.filter((f) => f.kind === 'wall').map((f) => ({ n: f.points.length, closed: !!f.closed, a: f.points[0].slice(0, 2).map(Math.round), b: f.points[f.points.length - 1].slice(0, 2).map(Math.round) }));
    const roads = c.linear.filter((f) => f.kind !== 'wall').map((f) => ({ kind: f.kind, a: f.points[0].slice(0, 2).map(Math.round), n: f.points.length }));
    const uses = {};
    for (const u of c.tiles.use) uses[u] = (uses[u] ?? 0) + 1;
    return { id, rec: { size: p.rec.size, purpose: p.rec.purpose?.kind }, spec: { system: c.spec.system, roads: c.spec.roads, walls: c.spec.walls, radius: c.spec.radius, at: c.spec.at.map(Math.round) }, walls, roads, uses, posts: p.spots.filter((s) => s.kind === 'post').map((s) => s.at.map(Math.round)) };
  });
  console.log('town', JSON.stringify(info));
  // the fortress's own check (reach.ts on the columns read back): which ground round the town the stores reach, by
  // direction and distance from the stores (. not reached, # reached, ~ water, x no cell)
  await page.evaluate(() => window.reclaimed.scene?.fortressReadCols?.());
  await sleep(1500);
  const ring = await page.evaluate(() => {
    const f = window.reclaimed.fortress;
    const cols = f.columnsNow();
    const m = f.reachMap();
    const at = f.storesAt();
    const rows = [];
    for (const dist of [40, 55, 70, 90]) {
      let s = '';
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        const c = f.cellAt(at[0] + Math.cos(a) * dist, at[1] + Math.sin(a) * dist);
        if (c < 0) { s += 'x'; continue; }
        const wet = cols && f.grid.columns[c].some((col) => { const wc = f.boxToWindowCol(col); return wc >= 0 && cols.water(wc % cols.w, Math.floor(wc / cols.w)) > 0.3; });
        s += wet ? '~' : m && f.reachedIn(m, c) ? '#' : '.';
      }
      rows.push(`${dist} m ${s}`);
    }
    return rows;
  });
  console.log('reach round the stores (24 directions from +x):\n' + ring.join('\n'));
  if (process.env.STRICT && ring.every((r) => !r.includes('#'))) throw new Error('nothing outside the town is reached from the stores');
  if (OUT) {
    await page.evaluate(() => {
      const Rc = window.reclaimed;
      const at = Rc.fortress.storesAt();
      Rc.camera.target[0] = at[0];
      Rc.camera.target[1] = at[1];
      Rc.camera.zoom = 3.2;
    });
    await sleep(3000);
    await page.screenshot({ path: `${OUT}/town-gates.png` });
    // (GATE_DEG=a: closer, on the wall's ring at that angle round the town's middle, in the plan's frame)
    if (process.env.GATE_DEG) {
      await page.evaluate((deg) => {
        const Rc = window.reclaimed;
        const st = Rc.settlements;
        const p = st.plan(st.pinnedId);
        const s0 = st.spotsOf(st.pinnedId)[0];
        const s0l = p.spots.find((s) => s.ref === s0.ref && s.kind === s0.kind);
        const [cx, cy] = p.city.spec.at;
        const r = p.city.spec.radius * 1.06;
        const a = (deg / 180) * Math.PI;
        Rc.camera.target[0] = cx + Math.cos(a) * r + s0.w[0] - s0l.at[0];
        Rc.camera.target[1] = cy + Math.sin(a) * r + s0.w[1] - s0l.at[1];
        Rc.camera.zoom = 6;
      }, Number(process.env.GATE_DEG));
      await sleep(3000);
      await page.screenshot({ path: `${OUT}/town-gate-near.png` });
    }
  }
});
