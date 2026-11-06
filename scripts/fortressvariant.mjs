// (round 128h, V128-13) Placements that would cut planned blocks off from the stores get a variant that keeps the way open
// (the user: "Yeah I would indicate that those will block or introduce block variants so they don't"). From the start
// menu by finger at the phone's size (412x915): plan a house, close a ring of walls round it tap by tap — the last wall
// puts a gate in the ring, the panel says so — then Build: the builders get through the gate and the house goes up.
// Then the refusal (RT-6, round 128m): a warehouse that would wall a house in on every side (no variant can open it) is
// taken out again and the panel names the house.
//   node scripts/fortressvariant.mjs [--out C:/Projects/shots/fortress]
import { run, sleep } from './lib/runner.mjs';

const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? process.argv[outArg + 1] : null;
await run({ name: 'fortressvariant', kind: 'behaviour', size: '412x915', dpr: 1, echo: !!process.env.DBG }, async (R) => {
  const page = await R.page();
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const tap = async (x, y, wait = 500) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 0 }] });
    await sleep(60);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(wait);
  };
  const where = (sel, text) =>
    page.evaluate(
      (sel, text) => {
        const b = [...document.querySelectorAll(sel)].find((e) => (text === null || e.textContent.trim() === text) && e.getBoundingClientRect().width > 0);
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return [r.x + r.width / 2, r.y + r.height / 2];
      },
      sel,
      text,
    );
  const tapButton = async (text, sel = '.fort-bar button') => {
    const p = await where(sel, text);
    if (!p) throw new Error(`no visible button "${text}"`);
    await tap(...p);
  };
  const panel = () => page.evaluate(() => [...document.querySelectorAll('.fort-info p')].map((e) => e.textContent));
  await page.goto(`${R.url}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('[data-a="fortress"]') || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(page);
  await sleep(1500);
  const fb = await where('[data-a="fortress"]', null);
  if (!fb) throw new Error('no Fortress button on the start menu');
  await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 120000 }), tap(...fb)]);
  await page.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(page);
  await page.waitForFunction(() => window.reclaimed?.fortress?.ready || document.querySelector('.fatal'), { timeout: 120000, polling: 250 });
  await sleep(3000);
  const barTop = await page.evaluate(() => document.querySelector('.fort-bar').getBoundingClientRect().top);
  const RING = 11;
  // (open ground for it: out of the old town, dry, in the fortress's box � the camera moved over it)
  const open = await page.evaluate(async (RING) => {
    const Rc = window.reclaimed;
    const f = Rc.fortress;
    const st = Rc.settlements;
    // (round 128l, m4: the fortress reads no columns back any more — the water read here)
    const wbuf = await Rc.core.readBuffer('water'); const cols = { w: Rc.core.dims.w, h: Rc.core.dims.h, water: (x, y) => wbuf[y * Rc.core.dims.w + x] };
    const at = f.storesAt();
    for (const dist of [45, 55, 65, 75])
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        const p = [at[0] + Math.cos(a) * dist, at[1] + Math.sin(a) * dist];
        const c0 = f.cellAt(p[0], p[1]);
        if (c0 < 0) continue;
        const cells = [c0, ...f.ringCells(f.centre(c0)[0], f.centre(c0)[1], RING + 4)];
        const ok = cells.every((c) => {
          if (c < 0 || f.plan.owner[c] >= 0) return false;
          const [x, y] = f.centre(c);
          if (st.thingAt(st.pinnedId, [x, y])) return false;
          // (no water on any of its columns)
          return !cols || f.grid.columns[c].every((col) => {
            const wc = f.boxToWindowCol(col);
            return wc >= 0 && cols.water(wc % cols.w, Math.floor(wc / cols.w)) < 0.05;
          });
        });
        if (!ok) continue;
        const [x, y] = f.centre(c0);
        Rc.camera.target[0] = x;
        Rc.camera.target[1] = y;
        Rc.camera.target[2] = Math.max(...f.grid.columns[c0].map((col) => f.groundAt(col)));
        Rc.camera.zoom = 8;
        return { cell: c0, x, y, dist, a };
      }
    return null;
  }, RING);
  console.log('open ground', JSON.stringify(open));
  await sleep(2500);
  // a spot for the house: on screen, well away from the stores, its ring of cells free and on screen too (found the way a
  // tap finds the ground: the press's own pick)
  // the house on the open ground's cell, the ring round it; the screen point whose press picks the house's cell
  const spot = await page.evaluate(
    ({ open, RING }) => {
      const Rc = window.reclaimed;
      const f = Rc.fortress;
      const cell = open.cell;
      const [cx, cy] = f.centre(cell);
      const ring = f.ringCells(cx, cy, RING);
      const [sx, sy] = Rc.camera.project(cx, cy, Math.max(...f.grid.columns[cell].map((col) => f.groundAt(col))));
      for (let r = 0; r <= 24; r += 2)
        for (let a = 0; a < 12; a++) {
          const b = f.pick(Rc.camera.ray(sx + Math.cos(a) * r, sy + Math.sin(a) * r), -1);
          if (b && b.cell === cell && b.level === 0) return { x: sx + Math.cos(a) * r, y: sy + Math.sin(a) * r, cell, centre: [cx, cy], ring };
        }
      return null;
    },
    { open, RING },
  );
  if (!spot) throw new Error('no spot for a walled house on screen');
  console.log('spot', JSON.stringify({ x: spot.x, y: spot.y, cell: spot.cell, ring: spot.ring.length }));
  await tapButton('Houses');
  await tap(spot.x, spot.y);
  const house = await page.evaluate(() => {
    const f = window.reclaimed.fortress;
    return f.plan.structures().find((s) => s.type === 'house') ? [...f.plan.structures().find((s) => s.type === 'house').cells.keys()][0] : -1;
  });
  // the ring by finger: each cell's screen point (a tap's pick: the ray's first face or the ground)
  await tapButton('Walls');
  const missed = [];
  // (far cells first: a wall standing in front hides the ground behind it from a tap)
  const order = await page.evaluate((ring) => {
    const Rc = window.reclaimed;
    const f = Rc.fortress;
    const sy = (c) => Rc.camera.project(...f.centre(c), Math.max(...f.grid.columns[c].map((col) => f.groundAt(col))))[1];
    return [...ring].sort((a, b) => sy(a) - sy(b));
  }, spot.ring);
  for (const c of order) {
    const p = await page.evaluate((c) => {
      const Rc = window.reclaimed;
      const f = Rc.fortress;
      // (the screen point whose press picks cell c at level 0: searched round the cell's projected middle)
      const [x, y] = f.centre(c);
      const z = Math.max(...f.grid.columns[c].map((col) => f.groundAt(col))) + 0.2;
      const [sx, sy] = Rc.camera.project(x, y, z);
      for (let r = 0; r <= 24; r += 2)
        for (let a = 0; a < 12; a++) {
          const px = sx + Math.cos(a) * r;
          const py = sy + Math.sin(a) * r;
          const b = f.pick(Rc.camera.ray(px, py), -1);
          if (b && b.cell === c && b.level === 0) return [px, py];
        }
      return null;
    }, c);
    if (!p) {
      missed.push(c);
      continue;
    }
    await tap(p[0], p[1], 250);
  }
  await sleep(600);
  const after = await page.evaluate(
    async ({ ring, house }) => {
      const f = window.reclaimed.fortress;
      await f.settled();
      const reached = (await f.probeReach([house]))[0];
      return {
        walls: ring.filter((c) => f.plan.typeAt(c) === 'wall').length,
        gates: ring.filter((c) => f.plan.gate[c]),
        variant: f.variant,
        refusal: f.refusal,
        reached,
      };
    },
    { ring: spot.ring, house },
  );
  const lines = await panel();
  console.log('ring', JSON.stringify({ missed, ...after }), JSON.stringify(lines));
  // the gate, close
  await page.evaluate((g) => {
    const Rc = window.reclaimed;
    const [x, y] = Rc.fortress.centre(g);
    Rc.camera.target[0] = x;
    Rc.camera.target[1] = y;
    Rc.camera.target[2] = Math.max(...Rc.fortress.grid.columns[Rc.fortress.cellAt(x, y)].map((col) => Rc.fortress.groundAt(col)));
    Rc.camera.zoom = 11;
  }, after.gates[0] ?? spot.ring[0]);
  await sleep(2500);
  if (OUT) await page.screenshot({ path: `${OUT}/variant-gate.png` });
  // build: the builders get in through the gate and put the house up
  await tapButton('Build');
  await tapButton('16x');
  const t0 = Date.now();
  await page.waitForFunction((h) => window.reclaimed.fortress.town.has(h, 0), { timeout: 240000, polling: 500 }, house).catch(() => {});
  const built = await page.evaluate((h) => ({ house: window.reclaimed.fortress.town.has(h, 0), progress: window.reclaimed.fortress.progress(), cutOff: window.reclaimed.fortress.cutOff }), house);
  console.log('built', Math.round((Date.now() - t0) / 1000), 's', JSON.stringify(built));
  await page.evaluate((h) => {
    const Rc = window.reclaimed;
    const [x, y] = Rc.fortress.centre(h);
    Rc.camera.target[0] = x;
    Rc.camera.target[1] = y;
    Rc.camera.target[2] = Math.max(...Rc.fortress.grid.columns[Rc.fortress.cellAt(x, y)].map((col) => Rc.fortress.groundAt(col)));
    Rc.camera.zoom = 11;
  }, house);
  await sleep(1500);
  if (OUT) await page.screenshot({ path: `${OUT}/variant-gate-built.png` });
  // the refusal: a house shut in on all four sides by walls and a warehouse — nothing opens it (a builder works a
  // block from beside it): placed, outlined in red, named in the panel
  await tapButton('Plan');
  const warn = await page.evaluate(async () => {
    const Rc = window.reclaimed;
    const f = Rc.fortress;
    const at = f.storesAt();
    // (a free cell with free cells round it, off the ring, near the screen's middle)
    const g = f.grid;
    for (let y = 300; y < 600; y += 25)
      for (let x = 120; x < 300; x += 25) {
        const b = f.pick(Rc.camera.ray(x, y), -1);
        if (!b) continue;
        const c = b.cell;
        // (the fourth side, tapped last, the one nearest the eye: the walls and the house don't hide it)
        const sy = (n) => Rc.camera.project(...f.centre(n), Math.max(...g.columns[n].map((col) => f.groundAt(col))))[1];
        const round = [0, 1, 2, 3].map((e) => g.nbr[c * 4 + e]).sort((a, b) => (a < 0 || b < 0 ? 0 : sy(a) - sy(b)));
        const ring2 = round.flatMap((n) => [0, 1, 2, 3].map((e) => g.nbr[n * 4 + e]));
        if ([c, ...round, ...ring2].some((n) => n < 0 || f.plan.owner[n] >= 0)) continue;
        if (Math.hypot(f.centre(c)[0] - at[0], f.centre(c)[1] - at[1]) < 12) continue;
        if (!f.paint(c, 0, 'house')) continue;
        for (const n of round.slice(0, 3)) f.paint(n, 0, 'wall');
        // (the stores still reach it from its fourth side: else try elsewhere)
        await f.settled();
        if (!(await f.probeReach([c]))[0]) {
          for (const n of [...round.slice(0, 3), c]) f.erase(n, 0);
          continue;
        }
        return { house: c, last: round[3] };
      }
    return null;
  });
  let warned = null;
  if (warn) {
    await tapButton('Warehouse');
    // (the fourth side by finger)
    const p = await page.evaluate((c) => {
      const Rc = window.reclaimed;
      const f = Rc.fortress;
      const [x, y] = f.centre(c);
      const [sx, sy] = Rc.camera.project(x, y, Math.max(...f.grid.columns[c].map((col) => f.groundAt(col))) + 0.2);
      for (let r = 0; r <= 12; r += 2)
        for (let a = 0; a < 8; a++) {
          const b = f.pick(Rc.camera.ray(sx + Math.cos(a) * r, sy + Math.sin(a) * r), -1);
          if (b && b.cell === c && b.level === 0) return [sx + Math.cos(a) * r, sy + Math.sin(a) * r];
        }
      return [sx, sy];
    }, warn.last);
    await tap(p[0], p[1]);
    warned = await page.evaluate(async (w) => {
      const f = window.reclaimed.fortress;
      await f.settled();
      return { refusal: f.refusal, at: f.plan.typeAt(w.last), stands: f.standsOf(w.house).length, tap: w.tap };
    }, { ...warn, tap: p });
    console.log('warn', JSON.stringify(warn), JSON.stringify(warned), JSON.stringify(await panel()));
    await page.evaluate((h) => {
      const Rc = window.reclaimed;
      const [x, y] = Rc.fortress.centre(h);
      Rc.camera.target[0] = x;
      Rc.camera.target[1] = y;
    Rc.camera.target[2] = Math.max(...Rc.fortress.grid.columns[Rc.fortress.cellAt(x, y)].map((col) => Rc.fortress.groundAt(col)));
    Rc.camera.zoom = 11;
    }, warn.house);
    await page.evaluate(() => (window.reclaimed.camera.zoom = 16));
    await sleep(2000);
    if (OUT) await page.screenshot({ path: `${OUT}/variant-warn.png` });
  }
  R.check('the ring was closed by finger', missed.length === 0 && after.walls === spot.ring.length, JSON.stringify({ missed, walls: after.walls, ring: spot.ring.length }));
  R.check('the closing wall put a gate in the ring, and the panel says so', after.gates.length === 1 && after.variant === 'A gate goes in the wall, so builders can get in.' && lines.includes(after.variant) && after.reached, JSON.stringify(after));
  R.check('the builders got in and built the house', built.house, JSON.stringify(built));
  R.check('a warehouse that would shut a house in, no variant opening it, is refused and the panel names the house', !!warned && warned.at === null && /^That would shut the house off from the stores\./.test(warned.refusal ?? ''), JSON.stringify(warned));
});
