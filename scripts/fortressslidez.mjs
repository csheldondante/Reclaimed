// (round 128m, quarry; BACKLOG QY-7) The fortress through a slide of the window in z, in the atlas game: the start
// town as the fortress, a house planned and built beside the stores, the window slid down a tier (under world z 0 —
// the world's floor rule, layout.ts WORLD_FLOOR), then back up. Checks: no page error, Fortress.zShift follows, the
// house's ground floor keeps its world height, the column under the camera holds stone from the window's floor (the
// floor's stone under z 0). Shots before / down / back (--out dir).
//   node scripts/fortressslidez.mjs [--out C:/tmp/slidez]
import { run, sleep } from './lib/runner.mjs';

const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? process.argv[outArg + 1] : null;
await run({ name: 'fortressslidez', kind: 'behaviour', size: '412x915', dpr: 1 }, async (R) => {
  const page = await R.page();
  await page.goto(`${R.url}/?skipmenu=1&level=atlas&town=1&fortress=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(page);
  await page.waitForFunction(() => window.reclaimed?.fortress?.ready || document.querySelector('.fatal'), { timeout: 120000, polling: 250 });
  await sleep(3000);
  const shot = async (name) => OUT && (await page.screenshot({ path: `${OUT}/${name}.png` }));
  const before = await page.evaluate(() => {
    const Rc = window.reclaimed;
    const f = Rc.fortress;
    const [hx, hy] = f.storesAt();
    // (a house a few cells from the stores, built at once)
    let cell = -1;
    for (let c = 0; c < f.grid.count && cell < 0; c++) {
      const [x, y] = f.centre(c);
      const d = Math.hypot(x - hx, y - hy);
      if (d > 14 && d < 30 && f.paint(c, 0, 'house')) cell = c;
    }
    if (cell < 0) return { error: 'no house placed' };
    f.markBuilt(cell, 0);
    const [x, y] = f.centre(cell);
    Rc.camera.target[0] = x;
    Rc.camera.target[1] = y;
    window.__slidez = { cell };
    return { cell, oz: Rc.stream.oz, floor: f.town.floorZ(cell, 0), zShift: f.zShift };
  });
  if (before.error) throw new Error(before.error);
  await sleep(1500);
  await shot('before');
  const at = async () =>
    page.evaluate(() => {
      const Rc = window.reclaimed;
      const f = Rc.fortress;
      const c = window.__slidez.cell;
      const [x, y] = f.centre(c);
      const lay = Rc.scene.worldApi?.terrain?.layersAt(x, y) ?? null;
      return { oz: Rc.stream.oz, floor: f.town.floorZ(c, 0), zShift: f.zShift, bottom: lay?.[0] ?? null };
    });
  await page.evaluate(() => window.reclaimed.stream.slideZ(-32));
  await sleep(4000);
  await R.fatal(page);
  const down = await at();
  await shot('down');
  await page.evaluate(() => window.reclaimed.stream.slideZ(32));
  await sleep(4000);
  await R.fatal(page);
  const back = await at();
  await shot('back');
  R.log(JSON.stringify({ before, down, back }));
  const world = (s) => s.floor + s.oz;
  if (down.oz !== before.oz - 32 || down.zShift !== -32) throw new Error(`the slide: ${JSON.stringify(down)}`);
  if (Math.abs(world(down) - world(before)) > 1e-3 || Math.abs(world(back) - world(before)) > 1e-3) throw new Error('the house moved in the world');
  if (before.oz <= 0 && !(down.bottom && down.bottom.z0 === 0 && down.bottom.material !== 'air')) throw new Error(`no floor under z 0: ${JSON.stringify(down.bottom)}`);
});
