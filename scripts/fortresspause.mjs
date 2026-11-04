// (round 128d) Fortress input while planning (time stopped) and while building (time runs), with a finger as on a phone:
// a one-finger drag pans the camera, a tap plans a block (or erases one), a pinch zooms; the frame draws the plan; the
// sim's tick doesn't move while planning. The user: "I think pause prevents both panning and building in build mode" —
// the planning frame took every press (ui/style.css's `#ui > *` outranked its pointer-events: none) and a one-finger
// drag was a gust — and "did it add the single finger drag to move the camera in build mode?".
//   node scripts/fortresspause.mjs [--out C:/Projects/shots88/fortress]
import { run, sleep } from './lib/runner.mjs';

const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? process.argv[outArg + 1] : null;
await run({ name: 'fortresspause', kind: 'behaviour', size: '412x915', dpr: 1, echo: !!process.env.DBG }, async (R) => {
  const page = await R.page();
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await page.goto(`${R.url}/?skipmenu=1&level=atlas&town=1&fortress=1&tod=0.3&day=30000`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(page);
  await page.waitForFunction(() => window.reclaimed?.fortress?.ready || document.querySelector('.fatal'), { timeout: 120000, polling: 250 });
  await sleep(3000);
  // fingers: each a list of [x, y] per step (all the same length); down, moved through the steps, up
  const touch = async (fingers) => {
    const pts = (k) => fingers.map((f, id) => ({ x: f[k][0], y: f[k][1], id }));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(0) });
    for (let k = 1; k < fingers[0].length; k++) {
      await sleep(30);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(k) });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(900);
  };
  const line = (x0, y0, x1, y1, n = 10) => Array.from({ length: n + 1 }, (_, k) => [x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
  const state = () =>
    page.evaluate(() => {
      const Rc = window.reclaimed;
      return { t: [Rc.camera.target[0], Rc.camera.target[1]], z: Rc.camera.zoom, tick: Rc.globals.tick, mode: Rc.fortress.mode, blocks: Rc.fortress.plan.totals({}).blocks, drawn: Rc.settlementsView().last?.module.length ?? 0 };
    });
  const moved = (a, b) => Math.hypot(b.t[0] - a.t[0], b.t[1] - a.t[1]);
  // (a tap at the screen's middle above the bar: the camera brought back over the town first, so it lands on ground)
  const home = () =>
    page.evaluate(() => {
      const Rc = window.reclaimed;
      const st = Rc.settlements;
      const [x, y] = st.toWindow(st.settlement(st.pinnedId).at);
      Rc.camera.target[0] = x + 30;
      Rc.camera.target[1] = y - 30;
      Rc.camera.zoom = 6;
    });

  for (const mode of ['plan', 'build']) {
    if (mode === 'build') {
      await page.evaluate(() => [...document.querySelectorAll('.fort-bar button')].find((b) => b.textContent === 'Build').click());
      await sleep(1500);
    }
    await home();
    await sleep(800);
    const a = await state();
    await touch([line(200, 300, 300, 380)]);
    const b = await state();
    await home();
    await sleep(800);
    const b2 = await state();
    await touch([[[206, 330]]]);
    const c = await state();
    if (OUT) await page.screenshot({ path: `${OUT}/pause-${mode}.png` });
    await touch([line(206, 330, 150, 260), line(206, 400, 262, 470)]);
    const d = await state();
    R.check(`${mode}: the mode`, a.mode === mode, a.mode);
    R.check(`${mode}: a one-finger drag pans`, moved(a, b) > 1, JSON.stringify([a.t, b.t]));
    R.check(`${mode}: a one-finger drag plans nothing`, b.blocks === a.blocks, `${a.blocks} -> ${b.blocks}`);
    R.check(`${mode}: a tap plans a block`, c.blocks > b2.blocks, `${b2.blocks} -> ${c.blocks}`);
    R.check(`${mode}: the frame draws the plan`, c.drawn > 0, String(c.drawn));
    R.check(`${mode}: a pinch zooms`, d.z > c.z * 1.2, `${c.z.toFixed(2)} -> ${d.z.toFixed(2)}`);
    R.check(`${mode}: a pinch plans nothing`, d.blocks === c.blocks, `${c.blocks} -> ${d.blocks}`);
    if (mode === 'plan') R.check('plan: time stays stopped', d.tick === a.tick, `${a.tick} -> ${d.tick}`);
    else R.check('build: time runs', d.tick > a.tick, `${a.tick} -> ${d.tick}`);
  }
  // erase: a tap on the block just planned takes it away
  await page.evaluate(() => [...document.querySelectorAll('.fort-bar button')].find((b) => b.textContent === 'Plan').click());
  await page.evaluate(() => [...document.querySelectorAll('.fort-bar button')].find((b) => b.textContent === 'Erase').click());
  await home();
  await sleep(800);
  const e0 = await state();
  // (a tap on a planned block: its cell's middle, half a level up, on screen)
  const at = await page.evaluate(() => {
    const Rc = window.reclaimed;
    const f = Rc.fortress;
    const c = [...f.plan.structures()[0].cells.keys()][0];
    const [x, y] = f.centre(c);
    return Rc.camera.project(x, y, f.town.floorZ(c, 0) + 2);
  });
  await touch([[at]]);
  const e1 = await state();
  R.check('erase: a tap takes a block away', e1.blocks < e0.blocks, `${e0.blocks} -> ${e1.blocks}`);
});
