// (round 128d) Inspect, with a finger as on a phone (412x915): the user, "Maybe an inspect to highlight a continuous
// section of structure and see its output input workers and stockpiles if applicable". A warehouse, a wall run and a
// keep are planned by the heap; Inspect pressed; a tap on the warehouse picks it (highlighted, its card: type, size,
// what the stores hold); a tap on bare ground closes the card; after Build, a tap on the keep shows how far it's built
// and its power; another tool closes it.
//   node scripts/fortressinspect.mjs [--out C:/Projects/shots88/fortress]
import { run, sleep } from './lib/runner.mjs';

const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? process.argv[outArg + 1] : null;
await run({ name: 'fortressinspect', kind: 'behaviour', size: '412x915', dpr: 1, echo: !!process.env.DBG }, async (R) => {
  const page = await R.page();
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await page.goto(`${R.url}/?skipmenu=1&level=atlas&town=1&fortress=1&tod=0.3&day=30000&speed=8`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(page);
  await page.waitForFunction(() => window.reclaimed?.fortress?.ready || document.querySelector('.fatal'), { timeout: 120000, polling: 250 });
  await sleep(2000);
  const tap = async (x, y) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 0 }] });
    await sleep(40);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(900);
  };
  const button = (label) => page.evaluate((label) => [...document.querySelectorAll('.fort-bar button')].find((b) => b.textContent === label).click(), label);
  const panel = () => page.evaluate(() => document.querySelector('.fort-info').innerText);
  const plan = await page.evaluate(() => {
    const Rc = window.reclaimed;
    const f = Rc.fortress;
    const st = Rc.settlements;
    const piles = st.spotsOf(st.pinnedId).filter((s) => s.kind === 'pile');
    const h = (piles.find((s) => s.what !== 'log') ?? piles[0]).w;
    // (on open ground beside the town — the town's own houses stand on its middle — fortresspath's spot)
    const [tx, ty] = st.toWindow(st.settlement(st.pinnedId).at);
    const g = [tx - 40, ty + 30];
    const c0 = f.cellAt(g[0] + 6, g[1]);
    const nb = (c, e) => f.grid.nbr[c * 4 + e];
    // a warehouse of two cells, two levels; a keep of one cell two levels across from it; a wall of three cells
    const w2 = nb(c0, 0);
    for (const c of [c0, w2]) for (const l of [0, 1]) f.paint(c, l, 'warehouse');
    const k = f.cellAt(g[0] - 8, g[1]);
    for (const l of [0, 1]) f.paint(k, l, 'fortress');
    let w = f.cellAt(g[0] - 4, g[1] + 12);
    const walls = [w, nb(w, 1), nb(nb(w, 1), 1)];
    for (const c of walls) f.paint(c, 0, 'wall');
    const id = (c) => f.plan.owner[c];
    Rc.camera.target[0] = g[0];
    Rc.camera.target[1] = g[1] + 4;
    Rc.camera.zoom = 7;
    return { heap: h, warehouse: c0, keep: k, ids: { warehouse: id(c0), keep: id(k), wall: id(walls[0]) } };
  });
  console.log('plan', JSON.stringify(plan));
  await sleep(1200);
  // a cell's block on screen: its middle, a level up
  const onScreen = (cell, up = 2) =>
    page.evaluate(
      (cell, up) => {
        const Rc = window.reclaimed;
        const f = Rc.fortress;
        const [x, y] = f.centre(cell);
        return Rc.camera.project(x, y, f.town.floorZ(cell, 0) + up);
      },
      cell,
      up,
    );
  await button('Inspect');
  const hint = await panel();
  let at = await onScreen(plan.warehouse);
  await tap(at[0], at[1]);
  const w = await page.evaluate(() => ({ id: window.reclaimed.fortress.inspected }));
  const wText = await panel();
  const flagged = await page.evaluate(() => {
    const L = window.reclaimed.settlementsView().last;
    let n = 0;
    for (let i = 0; i < L.module.length; i++) if (L.data[i * 16 + 15] & 64) n++;
    return n;
  });
  R.check('the picked structure is drawn highlighted (its pieces flagged)', flagged > 0, String(flagged));
  if (OUT) await page.screenshot({ path: `${OUT}/inspect-plan.png` });
  if (OUT) {
    // (close on it: the highlight at play zoom)
    const z = await page.evaluate((c) => {
      const Rc = window.reclaimed;
      const [x, y] = Rc.fortress.centre(c);
      const was = [Rc.camera.target[0], Rc.camera.target[1], Rc.camera.zoom];
      Rc.camera.target[0] = x;
      Rc.camera.target[1] = y;
      Rc.camera.zoom = 12;
      return was;
    }, plan.warehouse);
    await sleep(1200);
    await page.screenshot({ path: `${OUT}/inspect-plan-close.png` });
    await page.evaluate((z) => {
      const Rc = window.reclaimed;
      [Rc.camera.target[0], Rc.camera.target[1], Rc.camera.zoom] = z;
    }, z);
    await sleep(1200);
  }
  console.log('warehouse card:', JSON.stringify(wText));
  R.check('Inspect asks for a tap', /Tap a block to see what it is/.test(hint), hint);
  R.check('a tap on the warehouse picks it', w.id === plan.ids.warehouse, JSON.stringify([w.id, plan.ids]));
  R.check('its card: type and size', /Warehouse: 4 blocks, 2 levels high/.test(wText), wText);
  // (round 128d ways commit: the stores are the town's — held and room both the town's, then this one's part)
  R.check('its card: what the town\'s stores hold, the room it will give (none built yet)', /town's stores hold .*wood.*This one gives room for 200 goods once built\./s.test(wText) && /Not built yet/.test(wText), wText);
  R.check('the types are hidden while inspecting (the bar stays small)', await page.evaluate(() => getComputedStyle(document.querySelector('.fort-grid')).display === 'none'), '');
  // a tap on bare ground beside the heap closes it
  at = await page.evaluate((keep) => {
    const Rc = window.reclaimed;
    // (bare ground north of the heap, at about the keep's ground height)
    return Rc.camera.project(Rc.camera.target[0] + 4, Rc.camera.target[1] - 22, Rc.fortress.town.floorZ(keep, 0));
  }, plan.keep);
  await tap(at[0], at[1]);
  const closed = await page.evaluate(() => window.reclaimed.fortress.inspected);
  R.check('a tap on bare ground closes the card', closed === null, String(closed));
  // Build: time runs; a tap on the keep while it goes up
  await button('Build');
  await sleep(1000);
  for (let k = 0; k < 40; k++) {
    await sleep(1000);
    const p = await page.evaluate(() => window.reclaimed.fortress.progress());
    if (p.built >= 3) break;
  }
  at = await onScreen(plan.keep);
  await tap(at[0], at[1]);
  const kid = await page.evaluate(() => window.reclaimed.fortress.inspected);
  await sleep(600);
  const kText = await panel();
  console.log('keep card:', JSON.stringify(kText));
  if (OUT) await page.screenshot({ path: `${OUT}/inspect-build.png` });
  R.check('while building, a tap on the keep picks it', kid === plan.ids.keep, JSON.stringify([kid, plan.ids]));
  R.check('its card: power, and build progress or done', /Power: \+\d+ a day\. \d+ stored\./.test(kText) && /Fortress: 2 blocks, 2 levels high/.test(kText), kText);
  // the warehouse again, later: its blocks built, its room
  at = await onScreen(plan.warehouse);
  await tap(at[0], at[1]);
  await sleep(600);
  const w2Text = await panel();
  console.log('warehouse card, building:', JSON.stringify(w2Text));
  if (OUT) await page.screenshot({ path: `${OUT}/inspect-warehouse-build.png` });
  // Inspect off: the card closes, the highlight with it
  await button('Inspect');
  const off = await page.evaluate(() => window.reclaimed.fortress.inspected);
  R.check('Inspect off closes the card', off === null, String(off));
});
