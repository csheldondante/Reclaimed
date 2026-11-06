// (round 128d) The fortress bakes its own ways (fortress/ways.ts; the user: "buildings are supposed to bake their own
// paths so we probably want roads and squares between structures and the stairs up onto the walls"). A walled ring with
// a gate, the keep, a house and a warehouse inside are planned by the API on open ground near the town, then built at
// once. Checked in the GPU field the units follow (agents.reader): a field seeded on the wall-walk of the wall cell
// farthest from the stair is reached from the ground inside (up the stair) and from outside (in by the gate, up the
// stair); the ways have a door a structure, a stair a run, no structure cut off. Shots at play zoom; the warehouse's
// Inspect card read.
//   node scripts/fortressroads.mjs [--out C:/Projects/shots88/fortress]
import { run, sleep } from './lib/runner.mjs';

const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? process.argv[outArg + 1] : null;
const FIELD = 9;
await run({ name: 'fortressroads', kind: 'behaviour', size: '412x915', dpr: 1, echo: !!process.env.DBG }, async (R) => {
  const page = await R.page();
  await page.goto(`${R.url}/?skipmenu=1&level=atlas&town=1&fortress=1&tod=0.3&day=30000&speed=6`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(page);
  await page.waitForFunction(() => window.reclaimed?.fortress?.ready || document.querySelector('.fatal'), { timeout: 120000, polling: 250 });
  await sleep(2000);
  const info = await page.evaluate(async (FIELD) => {
    const Rc = window.reclaimed;
    const f = Rc.fortress;
    const st = Rc.settlements;
    const rec = st.settlement(st.pinnedId);
    const [tx, ty] = st.toWindow(rec.at);
    // (a site of flat dry ground near the town: every column within 20 of its middle within 1.5 m of its height — the
    // first tries ran into the river by the town, the ground 30 m down outside the gate)
    // (the solid ground's top as the units' surfaces have it — the river's bed, not its water: agents' reader)
    const rd0 = Rc.units.agents.reader(FIELD);
    await rd0.refresh();
    const groundAt = (x, y) => {
      const r = Math.round(y / (Math.sqrt(3) / 2));
      const k = Math.round(x);
      const { w, h } = Rc.core.dims;
      // (in the window, away from its edges: the claims and the field are the window's)
      if (k < 40 || r < 40 || k >= w - 40 || r >= h - 40) return NaN;
      if (f.windowToBoxCol(r * w + k) < 0) return NaN;
      const q = rd0.sample(x, y);
      return q && q.z > 0 ? q.z : NaN;
    };
    let site = null;
    for (let r = 30; r <= 70 && !site; r += 10)
      for (let a = 0; a < 16 && !site; a++) {
        const x = tx + Math.cos((a / 16) * Math.PI * 2) * r;
        const y = ty + Math.sin((a / 16) * Math.PI * 2) * r;
        const g0 = groundAt(x, y);
        let ok = Number.isFinite(g0);
        for (let dx = -28; dx <= 28 && ok; dx += 2) for (let dy = -44; dy <= 28 && ok; dy += 2) ok = Math.abs(groundAt(x + dx, y + dy) - g0) < 1.5;
        if (ok) site = [x, y];
      }
    if (!site) throw new Error('no flat dry site near the town');
    const [cx, cy] = site;
    const ring = f.ringCells(cx, cy, 18);
    for (const c of ring) f.paint(c, 0, 'wall');
    const byX = [...ring].sort((a, b) => f.centre(b)[0] - f.centre(a)[0]);
    const gate = byX.find((c) => f.setGate(c, true));
    if (gate === undefined) throw new Error('no straight wall cell for a gate');
    const keep = f.cellAt(cx, cy);
    f.paint(keep, 0, 'fortress');
    f.paint(keep, 1, 'fortress');
    const house = f.cellAt(cx - 8, cy + 5);
    f.paint(house, 0, 'house');
    f.paint(house, 1, 'house');
    const store = f.cellAt(cx + 4, cy - 9);
    f.paint(store, 0, 'warehouse');
    // a straight wall north of the ring (its own run): its stair runs south, toward the keep — and toward the camera,
    // which looks from the south (the ring's stairs climb its inner faces, out of sight behind the near wall)
    const line = [];
    {
      let c = f.cellAt(cx - 12, cy - 36);
      const g = f.town.grid;
      let e = [0, 1, 2, 3].sort((a, b) => f.centre(g.nbr[c * 4 + b])[0] - f.centre(g.nbr[c * 4 + a])[0])[0];
      for (let k = 0; k < 7 && c >= 0; k++) {
        line.push(c);
        const n = g.nbr[c * 4 + e];
        if (n < 0) break;
        const into = [0, 1, 2, 3].find((s) => g.nbr[n * 4 + s] === c);
        e = (into + 2) % 4;
        c = n;
      }
      for (const c of line) f.paint(c, 0, 'wall');
    }
    const w = f.ways();
    window.__fr = { cx, cy, ring, gate, keep, house, store, line };
    Rc.camera.target[0] = cx;
    Rc.camera.target[1] = cy;
    Rc.camera.zoom = 3.2;
    return {
      ring: ring.length,
      doors: w.doors.length,
      structures: f.plan.structures().length,
      stairs: w.stairs.map((s) => ({ wall: s.wall, cells: s.cells.length, line: line.includes(s.wall) })),
      squares: [...w.way].filter((x) => x === 2).length,
      site: [cx - tx, cy - ty],
      // (round 128p: the roads' reach — townroads.ts — every structure on it)
      cutOff: [...f.cutCells()].map((c) => f.plan.typeAt(c)),
      doorsAt: w.doors.map((d) => [f.plan.structure(d.structure).type, d.cell, d.side]),
    };
  }, FIELD);
  console.log('ways', JSON.stringify(info));
  await sleep(1500);
  if (OUT) await page.screenshot({ path: `${OUT}/roads-plan.png` });
  // Build, and every block stands at once
  await page.evaluate(() => [...document.querySelectorAll('.fort-bar button')].find((b) => b.textContent === 'Build').click());
  await page.evaluate(() => {
    const f = window.reclaimed.fortress;
    for (const s of f.plan.structures()) for (const c of s.cells.keys()) for (const l of f.plan.levels.each(c)) if (!f.town.has(c, l)) f.markBuilt(c, l);
  });
  await sleep(5000);
  const field = await page.evaluate(async (FIELD) => {
    const Rc = window.reclaimed;
    const f = Rc.fortress;
    const A = Rc.units.agents;
    const { ring, keep, gate } = window.__fr;
    const w = f.ways();
    const stair = w.stairs.find((s) => !window.__fr.line.includes(s.wall));
    // the wall cell farthest from the stair: its middle's top surface (the wall-walk)
    const [sx, sy] = f.centre(stair.wall);
    const far = [...ring].filter((c) => c !== gate).sort((a, b) => Math.hypot(f.centre(b)[0] - sx, f.centre(b)[1] - sy) - Math.hypot(f.centre(a)[0] - sx, f.centre(a)[1] - sy))[0];
    const [wx, wy] = f.centre(far);
    const rd = A.reader(FIELD);
    await rd.refresh();
    // (the claims reach the units' surfaces a moment after they're made: wait for the wall's top)
    let top = rd.sample(wx, wy);
    const doorOut = f.ways().doors.find((d) => d.structure === f.plan.owner[keep]).out;
    for (let k = 0; k < 40 && !(top && top.z > rd.sample(...f.centre(doorOut)).z + 2); k++) {
      await new Promise((r) => setTimeout(r, 250));
      await rd.refresh();
      top = rd.sample(wx, wy);
    }
    const keepDoor = w.doors.find((d) => d.structure === f.plan.owner[keep]);
    const [ix, iy] = f.centre(keepDoor.out);
    const ground = rd.sample(ix, iy);
    A.seed(FIELD, [{ x: wx, y: wy, z: top.z }]);
    // outside the ring, beyond the gate
    const [gx0, gy0] = f.centre(gate);
    const cs0 = ring.map((c) => f.centre(c));
    const mx0 = cs0.reduce((a, p) => a + p[0], 0) / cs0.length;
    const my0 = cs0.reduce((a, p) => a + p[1], 0) / cs0.length;
    const ox0 = gx0 + (gx0 - mx0) * 0.6;
    const oy0 = gy0 + (gy0 - my0) * 0.6;
    // (the field relaxes a few sweeps a tick, outward from its seed: let it settle as far as outside the gate)
    let last = -1;
    for (let k = 0; k < 60; k++) {
      await new Promise((r) => setTimeout(r, 500));
      await rd.refresh();
      const d = rd.sample(ox0, oy0).dist + rd.sample(ix, iy, ground.z).dist;
      if (k > 6 && Math.abs(d - last) < 0.01) break;
      last = d;
    }
    const at = (x, y, z) => {
      const s = rd.sample(x, y, z);
      return s ? { d: isFinite(s.dist) && s.dist < 1e8 ? +s.dist.toFixed(1) : null, z: +s.z.toFixed(2) } : null;
    };
    const [ox, oy] = [ox0, oy0];
    // up the stair: its foot, its middle
    const [fx, fy] = f.centre(stair.foot);
    const [mx2, my2] = f.centre(stair.cells[0]);
    const n = f.nav();
    return {
      wallWalk: { z: +rd.sample(wx, wy).z.toFixed(2), ground: +ground.z.toFixed(2) },
      gateClaims: (() => {
        const RH = Math.sqrt(3) / 2;
        const [gx, gy] = f.centre(gate);
        const out = [];
        for (const cols of Rc.fortressClaims().claimed().values())
          for (const c of cols) if (Math.hypot(c.x + (c.y & 1) * 0.5 - gx, c.y * RH - gy) < 1.2) out.push([c.x, c.y, +c.z0.toFixed(1), +c.z1.toFixed(1), at(c.x + (c.y & 1) * 0.5, c.y * RH, c.z0 - 0.6)?.z]);
        return out;
      })(),
      inside: at(ix, iy, ground.z),
      outside: at(ox, oy),
      stairFoot: at(fx, fy, ground.z),
      stairMid: at(mx2, my2, 1e4),
      claims: { ...Rc.fortressClaims().stats },
      nav: { nodes: n.nodes.length, stairs: n.links.filter((l) => l.kind === 'stairs').length, ramparts: n.nodes.filter((x) => x.surface === 'rampart').length },
      straight: +Math.hypot(wx - ix, wy - iy).toFixed(1),
      // (the field along the wall-walk, from the seed round the ring; and up the stair's axis)
      seed: at(wx, wy, top.z),
      // (out through the gate: its middle under the lintel, then outward every 2 m)
      gateRay: [0, 2, 4, 6, 8, 10, 12, -2, -4, -6].map((t) => {
        const [gx, gy] = f.centre(gate);
        const l = Math.hypot(gx - mx0, gy - my0);
        const q = at(gx + ((gx - mx0) / l) * t, gy + ((gy - my0) / l) * t, ground.z + 1);
        return q ? `${t}:${q.z}/${q.d}` : '-';
      }).join(' '),
      walk: ring.map((c) => {
        const [x, y] = f.centre(c);
        const q = at(x, y);
        return q ? `${c === far ? '*' : ''}${q.z}/${q.d}` : '-';
      }).join(' '),
      stairAxis: stair.axis.length && (() => {
        const out = [];
        const [ax, ay] = f.toWindow(...stair.axis[0]);
        const [bx, by] = f.toWindow(...stair.axis[stair.axis.length - 1]);
        for (let t = 0; t <= 1.0001; t += 0.1) {
          const q = at(ax + (bx - ax) * t, ay + (by - ay) * t);
          out.push(q ? `${q.z}/${q.d}` : '-');
        }
        return out.join(' ');
      })(),
    };
  }, FIELD);
  console.log('field', JSON.stringify(field));
  // shots at play zoom: the stair onto the wall, the keep's door and its road; the whole
  const shot = async (name, cell, zoom) => {
    await page.evaluate(
      (cell, zoom) => {
        const Rc = window.reclaimed;
        const [x, y] = Rc.fortress.centre(cell);
        Rc.camera.zoom = zoom;
        Rc.camera.target[0] = x;
        // (a little south: the cell sits above the middle, clear of the bar — fortressinspect.mjs)
        Rc.camera.target[1] = y + 60 / zoom;
      },
      cell,
      zoom,
    );
    await sleep(2500);
    if (OUT) await page.screenshot({ path: `${OUT}/${name}.png` });
    // (where things are on the shot: the stair's ends, the doors, the gate — to look at them)
    const marks = await page.evaluate(() => {
      const Rc = window.reclaimed;
      const f = Rc.fortress;
      const w = f.ways();
      const P = (c) => {
        const [x, y] = f.centre(c);
        return Rc.camera.project(x, y, f.town.floorZ(c, 0) || f.town.base[c] || f.groundAt(f.grid.columns[c][0])).map(Math.round);
      };
      return { stairs: w.stairs.map((s) => [P(s.wall), P(s.foot)]), gate: P(window.__fr.gate), doors: w.doors.map((d) => P(d.cell)) };
    });
    console.log('marks', name, JSON.stringify(marks));
  };
  const cells = await page.evaluate(() => {
    const f = window.reclaimed.fortress;
    const w = f.ways();
    const ls = w.stairs.find((s) => window.__fr.line.includes(s.wall));
    return { lineStair: ls ? ls.cells[0] : -1, stair: w.stairs[0].cells[0], keepDoor: w.doors.find((d) => d.structure === f.plan.owner[window.__fr.keep]).out, gate: window.__fr.gate };
  });
  await shot('roads-stair', cells.stair, 7);
  await shot('roads-stair-near', cells.stair, 18);
  if (cells.lineStair >= 0) {
    await shot('roads-stair-line', cells.lineStair, 7);
    await shot('roads-stair-line-near', cells.lineStair, 18);
  }
  await shot('roads-door-near', cells.keepDoor, 18);
  await shot('roads-gate-near', cells.gate, 18);
  await shot('roads-built', cells.keepDoor, 4);
  // the warehouse's card
  await page.evaluate(() => [...document.querySelectorAll('.fort-bar button')].find((b) => b.textContent === 'Inspect').click());
  const card = await page.evaluate(async () => {
    const f = window.reclaimed.fortress;
    f.inspect(f.plan.owner[window.__fr.store]);
    await new Promise((r) => setTimeout(r, 800));
    return document.querySelector('.fort-bar')?.innerText ?? '';
  });
  console.log('card', JSON.stringify(card));
  await shot('roads-inspect', cells.keepDoor, 4);
  R.check('every block structure has a door', info.doors === 3, JSON.stringify(info));
  R.check('each wall run has a stair (the ring and the straight wall)', info.stairs.length >= 2 && info.stairs.some((s) => s.line) && info.stairs.some((s) => !s.line), JSON.stringify(info.stairs));
  R.check('no door or stair cut off from the roads', info.cutOff.length === 0, JSON.stringify(info.cutOff));
  R.check('the wall-walk stands a wall high', field.wallWalk.z > field.wallWalk.ground + 3, JSON.stringify(field.wallWalk));
  // (the seed is the wall cell farthest from the stair: the way runs to the stair, up it and half round the walk)
  R.check('from the keep\'s door, the field reaches the wall-walk (up the stair)', field.inside?.d !== null && field.inside.d < 200, JSON.stringify([field.inside, field.straight]));
  R.check('from outside, in by the gate and up the stair', field.outside?.d !== null && field.outside.d > field.inside.d, JSON.stringify(field.outside));
  // (up the stair's axis from the wall to its foot: every point in the field, the height falling a wall's height in steps)
  const axis = field.stairAxis.split(' ').map((q) => q.split('/').map(Number));

  R.check('the stair climbs: in the field all the way, a wall high, nearer the walk the higher', axis.every((q) => Number.isFinite(q[1])) && axis[0][0] - axis[axis.length - 1][0] > 2 && axis[0][1] < axis[axis.length - 1][1], field.stairAxis);
  R.check('the card: the town\'s stores against the warehouses\' room', /town's stores hold/.test(card) && /room for/.test(card), card);
});
