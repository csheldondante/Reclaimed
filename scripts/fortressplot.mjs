// (round 128e, FT-51) Blocks still to build while building: a loose plot outline on the ground until work starts,
// scaffolding round a block once it has (the user: "The temporary holder would be better as a loose plot outline or
// scaffolding"). Houses (two levels), a wall run and a farm are planned on open ground near the town, Build pressed and
// time held; then one block marked begun, one built with work begun above it. Shots at play zoom.
//   node scripts/fortressplot.mjs [--out C:/Projects/shots88/fortress]
import { run, sleep } from './lib/runner.mjs';

const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? process.argv[outArg + 1] : null;
await run({ name: 'fortressplot', kind: 'behaviour', size: '412x915', dpr: 1, echo: !!process.env.DBG }, async (R) => {
  const page = await R.page();
  await page.goto(`${R.url}/?skipmenu=1&level=atlas&town=1&fortress=1&tod=0.3&day=30000`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(page);
  await page.waitForFunction(() => window.reclaimed?.fortress?.ready || document.querySelector('.fatal'), { timeout: 120000, polling: 250 });
  await sleep(2000);
  const cells = await page.evaluate(async () => {
    const Rc = window.reclaimed;
    const f = Rc.fortress;
    const st = Rc.settlements;
    const [tx, ty] = st.toWindow(st.settlement(st.pinnedId).at);
    await Rc.api.refresh(true);
    // (open dry ground: no town building, no water, within 1.5 m of level, 30-80 from the town)
    const rd = Rc.units.agents.reader(5);
    await rd.refresh();
    const z = (x, y) => rd.sample(x, y)?.z ?? NaN;
    let site = null;
    for (let r = 70; r <= 130 && !site; r += 10)
      for (let a = 0; a < 16 && !site; a++) {
        const x = tx + Math.cos((a / 16) * Math.PI * 2) * r;
        const y = ty + Math.sin((a / 16) * Math.PI * 2) * r;
        let ok = Number.isFinite(z(x, y));
        for (let dx = -14; dx <= 14 && ok; dx += 2) for (let dy = -14; dy <= 14 && ok; dy += 2) ok = Math.abs(z(x + dx, y + dy) - z(x, y)) < 1.5 && (Rc.api.water.depthAt(x + dx, y + dy) ?? 0) < 0.05 && f.plan.owner[f.cellAt(x + dx, y + dy)] < 0;
        if (ok) site = [x, y];
      }
    if (!site) throw new Error('no open site');
    const [cx, cy] = site;
    const g = f.town.grid;
    const a = f.cellAt(cx, cy);
    const b = g.nbr[a * 4];
    for (const c of [a, b]) {
      f.paint(c, 0, 'house');
      f.paint(c, 1, 'house');
    }
    const farm = f.cellAt(cx + 9, cy + 6);
    f.paint(farm, 0, 'farm');
    Rc.camera.target[0] = cx;
    Rc.camera.target[1] = cy + 8;
    Rc.camera.zoom = 9;
    window.__cells = { a, b, farm };
    return { a, b, farm };
  });
  await page.evaluate(() => [...document.querySelectorAll('.fort-bar button')].find((b) => b.textContent === 'Build').click());
  // (no builders: nothing begun; a moment of time for the cells' trees to be cleared — FT-32 — then time held)
  await page.evaluate(() => {
    const Rc = window.reclaimed;
    const life = Rc.fortressLife();
    for (const id of life.ids) Rc.units.remove(id);
    life.ids.length = 0;
  });
  await sleep(3000);
  await page.evaluate(() => {
    const Rc = window.reclaimed;
    Rc.scene.speed = 0;
    // (Build framed the stores: back on the site, close)
    const [x, y] = Rc.fortress.centre(window.__cells.a);
    Rc.camera.target[0] = x;
    Rc.camera.target[1] = y + 5;
    Rc.camera.zoom = 13;
    const life = Rc.fortressLife();
    for (const id of life.ids) Rc.units.remove(id);
    life.ids.length = 0;
  });
  await sleep(2500);
  if (process.argv.includes('--dev')) console.log('near a', JSON.stringify(await page.evaluate(async () => {
    const { library } = await import('/src/structures/modules.ts');
    const lib = library();
    const Rc = window.reclaimed;
    const f = Rc.fortress;
    const [x, y] = f.centre(window.__cells.a);
    const L = Rc.settlementsView().last;
    const out = {};
    for (let i = 0; i < L.module.length; i++) {
      const d = L.data.subarray(i * 16, i * 16 + 16);
      const mx = (d[0] + d[2] + d[4] + d[6]) / 4;
      const my = (d[1] + d[3] + d[5] + d[7]) / 4;
      if (Math.hypot(mx - x, my - y) > 8) continue;
      const k = lib.modules[L.module[i]].name;
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  })));
  console.log('at', JSON.stringify(await page.evaluate(() => {
    const Rc = window.reclaimed;
    const f = Rc.fortress;
    const [x, y] = f.centre(window.__cells.a);
    const v = Rc.settlementsView();
    const lib = v?.last;
    const ghosts = {};
    if (lib) for (let i = 0; i < lib.module.length; i++) if ((lib.data[i * 16 + 13] | 0) & (1 << 23)) ghosts[lib.module[i]] = (ghosts[lib.module[i]] ?? 0) + 1;
    return { a: Rc.camera.project(x, y, f.town.base[window.__cells.a] + 0).map(Math.round), mode: f.mode, base: f.town.base[window.__cells.a], drawn: lib ? lib.module.length : -1, ghosts };
  })));
  if (OUT) await page.screenshot({ path: `${OUT}/plot-outline.png` });
  await page.evaluate(({ a }) => window.reclaimed.fortress.markStarted(a, 0), cells);
  await sleep(2500);
  if (OUT) await page.screenshot({ path: `${OUT}/plot-scaffold.png` });
  await page.evaluate(({ a, b }) => {
    const f = window.reclaimed.fortress;
    f.markBuilt(a, 0);
    f.markBuilt(b, 0);
    f.markStarted(a, 1);
  }, cells);
  await sleep(2500);
  if (OUT) await page.screenshot({ path: `${OUT}/plot-scaffold-up.png` });
  R.check('shots taken', true, JSON.stringify(cells));
});
