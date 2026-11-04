// (round 128d, FT-20) Builders sent across a river: in the first headless runs of milestone 2 a site across the river
// from the heap drowned 7 of 8 builders — the agents' fields cost a wet step +3, deep water no more, so the way led
// through it. Here a house is planned across deep water from the heap (the shortest crossing found from the water read
// back), Build pressed, and the builders watched: none may drown; either they reach the site by a ford or a bridge and
// build it, or the site is reported as unreachable (FortressLife.unreachable).
//   node scripts/fortressford.mjs [--out C:/Projects/shots88/fortress] [--secs 120]
import { run, sleep } from './lib/runner.mjs';

const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? process.argv[outArg + 1] : null;
await run({ name: 'fortressford', kind: 'behaviour', size: '412x915', dpr: 1, echo: !!process.env.DBG }, async (R) => {
  const secs = Number(R.opt('secs', 120));
  const page = await R.page();
  await page.goto(`${R.url}/?skipmenu=1&level=atlas&town=1&fortress=1&tod=0.3&day=30000&speed=8`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(page);
  await page.waitForFunction(() => window.reclaimed?.fortress?.ready || document.querySelector('.fatal'), { timeout: 120000, polling: 250 });
  await sleep(2000);
  // time runs (the fields relax only then); nothing planned yet
  await page.evaluate(() => [...document.querySelectorAll('.fort-bar button')].find((b) => b.textContent === 'Build').click());
  await sleep(1500);
  const site = await page.evaluate(async () => {
    const Rc = window.reclaimed;
    const f = Rc.fortress;
    const st = Rc.settlements;
    const piles = st.spotsOf(st.pinnedId).filter((s) => s.kind === 'pile');
    const h = (piles.find((s) => s.what !== 'log') ?? piles[0]).w;
    const water = await Rc.readBuffer('water');
    const { w, h: H } = Rc.core.dims;
    const RH = Math.sqrt(3) / 2;
    const depth = (x, y) => {
      const r = Math.round(y / RH);
      const c = Math.round(x - (r & 1) * 0.5);
      return c < 0 || r < 0 || c >= w || r >= H ? -1 : water[r * w + c];
    };
    // every crossing of deep water (over a worker's height) to dry land, out from the heap
    const cands = [];
    for (let k = 0; k < 48; k++) {
      const a = (k / 48) * Math.PI * 2;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      let wet0 = -1;
      let deep = 0;
      let dry = 0;
      for (let t = 0; t < 90; t += 0.5) {
        const d = depth(h[0] + dx * t, h[1] + dy * t);
        if (d < 0) break;
        if (wet0 < 0) {
          if (d > 0.3) wet0 = t;
          continue;
        }
        deep = Math.max(deep, d);
        if (d < 0.05) dry += 0.5;
        else dry = 0;
        if (dry >= 9) {
          const far = t;
          if (deep > 1.3) cands.push({ a, far, wet0, deep, at: [h[0] + dx * (t + 2), h[1] + dy * (t + 2)] });
          break;
        }
      }
    }
    // each one's way from the heap as the builders' field has it (a field seeded at the site, its gradient followed
    // from the heap): the deepest water it leads through. The worst is the site
    const A = Rc.units.agents;
    const rd = A.reader(9);
    const traced = [];
    for (const c0 of cands.filter((_, i) => i % 2 === 0)) {
      A.seed(9, [{ x: c0.at[0], y: c0.at[1] }]);
      let last = -1;
      for (let k = 0; k < 30; k++) {
        await new Promise((r) => setTimeout(r, 400));
        await rd.refresh();
        const s = rd.sample(h[0], h[1]);
        const d = s ? s.dist : -1;
        if (k > 4 && d < 1e8 && Math.abs(d - last) < 0.01) break;
        last = d;
      }
      let p = [h[0], h[1]];
      let wade = 0;
      let steps = 0;
      for (; steps < 600; steps++) {
        const s = rd.sample(p[0], p[1]);
        if (!s || !isFinite(s.dist) || s.dist < 1) break;
        p = [p[0] + s.dir[0] * 0.5, p[1] + s.dir[1] * 0.5];
        wade = Math.max(wade, depth(p[0], p[1]));
      }
      traced.push({ ...c0, wade, dist: last, steps });
    }
    A.seed(9, []);
    const best = traced.sort((a, b) => b.wade - a.wade)[0];
    console.log('[ford] crossings', JSON.stringify(traced.map((t) => ({ at: t.at.map(Math.round), deep: +t.deep.toFixed(2), wade: +t.wade.toFixed(2), dist: Math.round(t.dist) }))));
    if (!best) return { none: true, heap: h };
    const c = f.cellAt(best.at[0], best.at[1]);
    f.paint(c, 0, 'house');
    window.__ford = { heap: h, site: f.centre(c), deaths: [], built: 0 };
    Rc.units.died.push((u, by) => window.__ford.deaths.push({ by: String(by), at: u.at.map((v) => +v.toFixed(1)) }));
    Rc.camera.target[0] = (h[0] + best.at[0]) / 2;
    Rc.camera.target[1] = (h[1] + best.at[1]) / 2;
    Rc.camera.zoom = 3;
    return { heap: h, site: f.centre(c), crossing: { wetFrom: best.wet0, dryAt: best.far, deepest: +best.deep.toFixed(2), wadesThrough: +best.wade.toFixed(2) }, traced: traced.map((t) => [t.at.map(Math.round), +t.wade.toFixed(2), Math.round(t.dist)]) };
  });
  console.log('site', JSON.stringify(site));
  if (site.none) return R.check('a site across deep water', false, JSON.stringify(site));
  R.check("the builders' way wades no water over a worker's height (1.0)", site.crossing.wadesThrough < 1.0, JSON.stringify(site.traced));
  const t0 = Date.now();
  let shot = false;
  for (;;) {
    await sleep(2000);
    const s = await page.evaluate(() => ({ p: window.reclaimed.fortress.progress(), d: window.__ford.deaths.length, u: window.reclaimed.fortressLife()?.unreachable?.() ?? null, awake: window.reclaimed.core.sleep.awake }));
    if (!shot && OUT && Date.now() - t0 > 20000) {
      shot = true;
      await page.screenshot({ path: `${OUT}/path-ford.png` });
    }
    if (s.p.built === s.p.total || (s.u && s.u.length) || Date.now() - t0 > secs * 1000) break;
  }
  const res = await page.evaluate(() => {
    const L = window.reclaimed.fortressLife();
    return { progress: window.reclaimed.fortress.progress(), deaths: window.__ford.deaths, stats: L?.stats, unreachable: L?.unreachable?.() ?? null, bar: document.querySelector('.fort-bar')?.innerText ?? '' };
  });
  if (OUT) await page.screenshot({ path: `${OUT}/path-ford-end.png` });
  console.log(JSON.stringify(res));
  const drowned = res.deaths.length; // (no foes here: a death is the water's — agents' BY_WATER isn't named in units.died)
  R.check('no builder drowns', drowned === 0, `${drowned} drowned of ${res.deaths.length} deaths`);
  R.check('the site is built, or reported unreachable', res.progress.built === res.progress.total || (res.unreachable?.length ?? 0) > 0, JSON.stringify({ progress: res.progress, unreachable: res.unreachable }));
});
