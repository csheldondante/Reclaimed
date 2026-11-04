// (round 128d) Does the builders' way round the fortress go round its structures? The user: "Does the flow field around
// the city path around structures?" A wall ring with a gate is planned by the API on open ground near the town; a
// field is seeded at the ring's middle and read back (agents.reader), and workers sent there from outside the ring,
// opposite the gate, are watched:
//   planned (unbuilt, the stores emptied so the builders can't raise it): the way runs straight through the ring;
//   built: round the ring and in through the gate, the wall cells no way;
//   the solid footprint: the thin wall's band blocks, the rest of a wall cell (beside the band) is open.
//   node scripts/fortresspath.mjs [--out C:/Projects/shots88/fortress]
import { run, sleep } from './lib/runner.mjs';

const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? process.argv[outArg + 1] : null;
const FIELD = 9;
await run({ name: 'fortresspath', kind: 'behaviour', size: '412x915', dpr: 1, echo: !!process.env.DBG }, async (R) => {
  const page = await R.page();
  if (process.env.FPDBG) await page.evaluateOnNewDocument(() => (window.__FPDBG = 1));
  await page.goto(`${R.url}/?skipmenu=1&level=atlas&town=1&fortress=1&tod=0.3&day=30000&speed=6`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(page);
  await page.waitForFunction(() => window.reclaimed?.fortress?.ready || document.querySelector('.fatal'), { timeout: 120000, polling: 250 });
  await sleep(2000);
  const env = process.env.FP_AT ? process.env.FP_AT.split(',').map(Number) : null;
  const info = await page.evaluate((env) => {
    const Rc = window.reclaimed;
    const f = Rc.fortress;
    const st = Rc.settlements;
    const rec = st.settlement(st.pinnedId);
    // (nothing to build with: the plan stays planned while time runs)
    for (const k of ['stone', 'log']) rec.stores[k] = { stock: 0, rate: 0 };
    const [tx, ty] = st.toWindow(rec.at);
    const [ox, oy] = env ?? [-40, 30];
    const cx = tx + ox;
    const cy = ty + oy;
    const ring = f.ringCells(cx, cy, 13);
    for (const c of ring) for (const l of [0, 1]) f.paint(c, l, 'wall');
    // the gate: the ring cell furthest +x where the run is straight (a gate goes only in a straight run)
    const byX = [...ring].sort((a, b) => f.centre(b)[0] - f.centre(a)[0]);
    const gate = byX.find((c) => f.setGate(c, true));
    if (gate === undefined) throw new Error('no straight wall cell for a gate');
    window.__fp = { cx, cy, ring, gate };
    Rc.camera.target[0] = cx;
    Rc.camera.target[1] = cy;
    Rc.camera.zoom = 3.2;
    return { cx, cy, ring: ring.length, gate: f.centre(gate), blocks: f.plan.totals({}).blocks };
  }, env);
  console.log('ring', JSON.stringify(info));
  // Build: time runs (nothing to build with)
  await page.evaluate(() => [...document.querySelectorAll('.fort-bar button')].find((b) => b.textContent === 'Build').click());
  await sleep(1000);
  const measure = (label) =>
    page.evaluate(
      async (FIELD, label) => {
        const Rc = window.reclaimed;
        const f = Rc.fortress;
        const A = Rc.units.agents;
        const { ring, gate } = window.__fp;
        // (the ring's middle now: the window slides under the camera, the window's coordinates with it)
        const cs = ring.map((c) => f.centre(c));
        const cx = cs.reduce((a, p) => a + p[0], 0) / cs.length;
        const cy = cs.reduce((a, p) => a + p[1], 0) / cs.length;
        A.seed(FIELD, [{ x: cx, y: cy }]);
        const rd = A.reader(FIELD);
        // (let it settle: the field relaxes a few sweeps a tick)
        let last = -1;
        for (let k = 0; k < 40; k++) {
          await new Promise((r) => setTimeout(r, 500));
          await rd.refresh();
          const s = rd.sample(cx - 26, cy);
          const d = s ? s.dist : -1;
          if (k > 6 && Math.abs(d - last) < 0.01) break;
          last = d;
        }
        const out = (x, y, z) => {
          const s = rd.sample(x, y, z);
          return s ? { d: +s.dist.toFixed(1), z: +s.z.toFixed(2) } : null;
        };
        const [gx, gy] = f.centre(gate);
        // a wall cell on the far side from the gate: its middle (the band) and beside it (off the band, still the cell)
        let back = ring[0];
        let bx = Infinity;
        for (const c of ring) {
          const [x] = f.centre(c);
          if (x < bx) {
            bx = x;
            back = c;
          }
        }
        const [wx, wy] = f.centre(back);
        const corner = f.town.grid.corner(back, 0);
        const [kx, ky] = f.toWindow(corner[0], corner[1]);
        // (a profile west from the middle: each half cell's surface height and distance)
        const profile = [];
        for (let t = 0; t <= 26; t += 1) {
          const q = rd.sample(cx - t, cy);
          profile.push(q ? `${t}:${q.z.toFixed(1)}/${isFinite(q.dist) ? q.dist.toFixed(0) : 'x'}` : `${t}:-`);
        }
        const cl = Rc.fortressClaims?.();
        if (window.__FPDBG && cl) {
          const RH = Math.sqrt(3) / 2;
          const set = new Set();
          for (const cols of cl.claimed().values()) for (const c of cols) set.add(`${c.x},${c.y}`);
          const r0 = Math.round(cy / RH);
          const c0 = Math.round(cx);
          const rows = [label];
          const plus = [];
          const cmap = new Map();
          for (const cols of cl.claimed().values()) for (const c of cols) cmap.set(`${c.x},${c.y}`, [+c.z0.toFixed(2), +c.z1.toFixed(2)]);
          for (let r = r0 - 22; r <= r0 + 22; r++) {
            let line = '';
            for (let c = c0 - 24; c <= c0 + 24; c++) {
              const wx = c + (r & 1) * 0.5;
              const wy = r * RH;
              const q = rd.sample(wx, wy, (rd.sample(cx, cy)?.z ?? 0) + 1);
              if (set.has(`${c},${r}`) && q && isFinite(q.dist) && c > c0 + 5 && Math.abs(r - r0) < 8) plus.push([c, r, +q.z.toFixed(2), +q.dist.toFixed(1), ...(cmap.get(`${c},${r}`) ?? [])]);
              line += set.has(`${c},${r}`) ? (q && isFinite(q.dist) ? '+' : '#') : q && isFinite(q.dist) ? (q.dist < 1e8 ? '.' : '?') : ' ';
            }
            rows.push(line);
          }
          for (const r of rows) console.log('[map] ' + r);
          console.log('[map] plus ' + JSON.stringify(plus));
          const [gx0, gy0] = f.centre(gate);
          const near = [];
          for (const cols of cl.claimed().values()) for (const c of cols) if (Math.hypot(c.x + (c.y & 1) * 0.5 - gx0, c.y * RH - gy0) < 1.6) near.push([c.x, c.y, +c.z0.toFixed(1), +c.z1.toFixed(1)]);
          console.log('[map] gate claims ' + JSON.stringify(near) + ' plan.gate ' + f.plan.gate[gate] + ' version ' + JSON.stringify(cl.stats));
        }
        return {
          label,
          profile: profile.join(' '),
          claims: cl ? { ...cl.stats } : null,
          outsideOpposite: out(cx - 26, cy),
          outsideByGate: out(cx + 26, cy),
          // (under the gate's lintel: the passage, at the ground's height inside)
          gate: out(gx, gy, (rd.sample(cx, cy)?.z ?? 0) + 1),
          gateTop: out(gx, gy),
          gateSide: [-1.5, -0.75, 0.75, 1.5].map((o) => out(gx + o, gy, (rd.sample(cx, cy)?.z ?? 0) + 1)),
          wallMiddle: out(wx, wy),
          wallNearCorner: out(wx + (kx - wx) * 0.8, wy + (ky - wy) * 0.8),
          inside: out(cx - 6, cy),
          ground: out(cx - 20, cy),
        };
      },
      FIELD,
      label,
    );
  const walk = (label) =>
    page.evaluate(async (label) => {
      const Rc = window.reclaimed;
      const U = Rc.units;
      const f = Rc.fortress;
      const cs = window.__fp.ring.map((c) => f.centre(c));
      const cx = cs.reduce((a, p) => a + p[0], 0) / cs.length;
      const cy = cs.reduce((a, p) => a + p[1], 0) / cs.length;
      const ids = [];
      for (let k = 0; k < 4; k++) ids.push(U.spawn('worker', [cx - 26, cy + (k - 1.5) * 1.5], null, { job: { kind: 'go', to: [cx, cy] } }));
      const track = ids.map(() => []);
      for (let t = 0; t < 60; t++) {
        await new Promise((r) => setTimeout(r, 500));
        ids.forEach((id, i) => {
          const p = U.get(id)?.at;
          if (p) track[i].push([+(p[0] - cx).toFixed(1), +(p[1] - cy).toFixed(1)]);
        });
      }
      const res = ids.map((id, i) => {
        const tr = track[i];
        const end = tr[tr.length - 1];
        const maxX = Math.max(...tr.map((p) => p[0]));
        return { alive: U.get(id)?.alive ?? false, end, endR: end ? +Math.hypot(end[0], end[1]).toFixed(1) : null, maxX };
      });
      for (const id of ids) U.order(id, { kind: 'idle' });
      return { label, res };
    }, label);

  const planned = await measure('planned');
  console.log(JSON.stringify(planned));
  if (OUT) await page.screenshot({ path: `${OUT}/path-planned.png` });
  const wp = await walk('planned');
  console.log(JSON.stringify(wp));
  // build every block at once
  await page.evaluate(() => {
    const f = window.reclaimed.fortress;
    for (const s of f.plan.structures()) for (const c of s.cells.keys()) for (const l of f.plan.levels.each(c)) if (!f.town.has(c, l)) f.markBuilt(c, l);
  });
  await sleep(4000);
  const built = await measure('built');
  console.log(JSON.stringify(built));
  const wb = await walk('built');
  console.log(JSON.stringify(wb));
  // the gate shut (the plan's gate off: its cell's wall stands whole): the ring is closed
  await page.evaluate(() => {
    const f = window.reclaimed.fortress;
    f.setMode('plan');
    f.setGate(window.__fp.gate, false);
    f.setMode('build');
  });
  await sleep(4000);
  const closed = await measure('closed');
  console.log(JSON.stringify(closed));
  if (OUT) await page.screenshot({ path: `${OUT}/path-built.png` });
  const R2 = 26 + 13;
  R.check('planned: the way runs straight through the ring', planned.outsideOpposite && planned.outsideOpposite.d < R2 * 1.4, JSON.stringify(planned.outsideOpposite));
  R.check('built: the way goes round to the gate', built.outsideOpposite && built.outsideOpposite.d > planned.outsideOpposite.d + 15 && built.outsideOpposite.d < 1e8, `${planned.outsideOpposite?.d} -> ${built.outsideOpposite?.d}`);
  R.check('built: the gate is open (its passage in the field)', built.gate && isFinite(built.gate.d) && built.gate.d < 25, JSON.stringify(built.gate));
  R.check('built: the solid is the thin wall, not the cell (the corner of a wall cell, off the band, is open ground)', built.wallNearCorner && isFinite(built.wallNearCorner.d ?? Infinity) && built.wallMiddle && !isFinite(built.wallMiddle.d ?? Infinity), JSON.stringify([built.wallMiddle, built.wallNearCorner]));
  R.check('closed (the gate shut): no way in from outside', closed.outsideOpposite && !isFinite(closed.outsideOpposite.d ?? Infinity) && !isFinite(closed.outsideByGate.d ?? Infinity), JSON.stringify([closed.outsideOpposite, closed.outsideByGate]));
  R.check('built: walkers end inside the ring', wb.res.filter((r) => r.endR !== null && r.endR < 9).length >= 3, JSON.stringify(wb.res));
  R.check('built: walkers went round by the gate', wb.res.filter((r) => r.maxX > 8).length >= 3, JSON.stringify(wb.res));
});
