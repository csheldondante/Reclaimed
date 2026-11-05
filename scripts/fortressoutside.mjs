// (round 128k) The user, on the phone (015d09e): "It doesn't look like there is a way for the workers to exit the
// starting city at all. They fail to reach anything I build." The way a player does it, by finger at the phone's size
// (412x915): a lumber camp, a house and a farm planned on open ground outside the starting town's walls, Build, 16x —
// do the builders get out of the town and put them up? Each structure's first block must stand within LIMIT_S
// seconds (wall clock at 16x); the script fails otherwise. Every 10 s: blocks built, the builders' doings, the panel.
//   node scripts/fortressoutside.mjs [--out C:/Projects/Reclaimed-fortress/fortress]
import { run, sleep } from './lib/runner.mjs';

const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? process.argv[outArg + 1] : null;
const LIMIT_S = Number(process.env.LIMIT_S ?? 150);
/** (round 128l) a land gate's way through the wall: no deeper water than this (m) from 5 m in to 16 m out */
const GATE_DRY = Number(process.env.GATE_DRY ?? 0.3);
await run({ name: 'fortressoutside', kind: 'behaviour', size: '412x915', dpr: Number(process.env.DPR ?? 1), echo: !!process.env.DBG }, async (R) => {
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
  const panel = () => page.evaluate(() => (document.querySelector('.fort-bar')?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 300));
  if (process.env.MENU) {
    // (from the start menu's Fortress button, as the player comes in)
    await page.goto(`${R.url}/${process.env.Q ? `?q=${process.env.Q}` : ''}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('[data-a="fortress"]') || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
    await R.fatal(page);
    await sleep(1500);
    const fb = await where('[data-a="fortress"]', null);
    await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 120000 }), tap(...fb)]);
  } else await page.goto(`${R.url}/?skipmenu=1&level=atlas&town=1&fortress=1${process.env.Q ? `&q=${process.env.Q}` : ''}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(page);
  await page.waitForFunction(() => window.reclaimed?.fortress?.ready || document.querySelector('.fatal'), { timeout: 120000, polling: 250 });
  await sleep(3000);
  // (round 128l) the starting town's wall has a gate on land: round its ring a degree at a time, the gaps between its
  // wall's runs whose ground the fortress's columns read dry (water under 0.3 m) from 5 m inside to 16 m out. Before,
  // the user's town (a port in a river's fork, walled, no roads of its own) had its gaps only in the river and the sea:
  // "the only exit does look like it is into the sea" — wading deeper than 0.9 m, no builder got out
  const gates = await page.evaluate(() => {
    const Rc = window.reclaimed;
    const st = Rc.settlements;
    const f = Rc.fortress;
    const p = st.plan(st.pinnedId);
    const walls = p.city.linear.filter((l) => l.kind === 'wall');
    if (!walls.length && !p.city.tiles.use.includes('gate')) return { walled: false };
    const s0 = st.spotsOf(st.pinnedId)[0];
    const s0l = p.spots.find((s) => s.ref === s0.ref && s.kind === s0.kind);
    const off = [s0.w[0] - s0l.at[0], s0.w[1] - s0l.at[1]];
    const cols = f.columnsNow();
    const waterAt = (lx, ly) => {
      const c = f.cellAt(lx + off[0], ly + off[1]);
      if (c < 0) return 99;
      return Math.max(...f.grid.columns[c].map((col) => {
        const wc = f.boxToWindowCol(col);
        return wc < 0 ? 99 : cols.water(wc % cols.w, Math.floor(wc / cols.w));
      }));
    };
    const near = (x, y) => walls.some((l) => l.points.some((a, i) => {
      if (i === l.points.length - 1 && !l.closed) return false;
      const b = l.points[(i + 1) % l.points.length];
      const vx = b[0] - a[0];
      const vy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((x - a[0]) * vx + (y - a[1]) * vy) / (vx * vx + vy * vy || 1)));
      return Math.hypot(a[0] + vx * t - x, a[1] + vy * t - y) < 3;
    }));
    const [cx, cy] = p.city.spec.at;
    const R = p.city.spec.radius;
    // per degree: in the wall, or the deepest water on the way through (5 m in to 16 m out)
    const deg = [];
    for (let k = 0; k < 360; k++) {
      const a = (k / 360) * Math.PI * 2;
      let wall = false;
      for (let rr = R; rr <= R * 1.12 && !wall; rr += 0.5) wall = near(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
      let w = 0;
      if (!wall) for (let d = R * 1.06 - 5; d <= R * 1.06 + 16; d += 1.5) w = Math.max(w, waterAt(cx + Math.cos(a) * d, cy + Math.sin(a) * d));
      deg.push(wall ? -1 : w);
    }
    // the gaps (runs of open degrees), each with its driest way through
    const k0 = deg.findIndex((v) => v < 0);
    const gaps = [];
    let g = null;
    for (let i = 1; i <= 360; i++) {
      const k = (k0 + i) % 360;
      if (deg[k] >= 0) {
        g ??= { from: k, n: 0, driest: 99 };
        g.n++;
        g.driest = Math.min(g.driest, +deg[k].toFixed(2));
      } else if (g) {
        gaps.push(g);
        g = null;
      }
    }
    if (g) gaps.push(g);
    // (a gate is a gap centred on land: the water on the way through its middle degree — a gap the planner left for a
    // river or the sea is centred on the water, its dry edge a bank)
    for (const q of gaps) q.mid = +deg[(q.from + Math.floor(q.n / 2)) % 360].toFixed(2);
    return { walled: true, runs: walls.length, gaps };
  });
  console.log('town gates', JSON.stringify(gates));
  if (process.env.GATES_ONLY) return;
  if (gates.walled && !gates.gaps.some((g) => g.mid <= GATE_DRY)) throw new Error("the starting town's wall has no gate on land: its only ways out are by water");
  // open ground outside the old town: dry, free of the town's things, three cells in a row with a free ring round them
  const open = await page.evaluate(([K0, DISTS]) => {
    const Rc = window.reclaimed;
    const f = Rc.fortress;
    const st = Rc.settlements;
    const cols = f.columnsNow();
    const at = f.storesAt();
    const free = (c) => {
      if (c < 0 || f.plan.owner[c] >= 0) return false;
      const [x, y] = f.centre(c);
      if (st.thingAt(st.pinnedId, [x, y])) return false;
      return !cols || f.grid.columns[c].every((col) => {
        const wc = f.boxToWindowCol(col);
        return wc >= 0 && cols.water(wc % cols.w, Math.floor(wc / cols.w)) < 0.05;
      });
    };
    for (const dist of (DISTS ?? [50, 60, 70, 80]))
      for (let k0 = 0; k0 < 24; k0++) {
        const k = (k0 + K0) % 24;
        const a = (k / 24) * Math.PI * 2;
        const p = [at[0] + Math.cos(a) * dist, at[1] + Math.sin(a) * dist];
        const c0 = f.cellAt(p[0], p[1]);
        if (c0 < 0) continue;
        const [cx, cy] = f.centre(c0);
        if (![c0, ...f.ringCells(cx, cy, 14)].every(free)) continue;
        // the three sites: the camp in the middle, the house and the farm a cell and a half either side
        const dir = [Math.cos(a + Math.PI / 2), Math.sin(a + Math.PI / 2)];
        const sites = { lumber: c0, house: f.cellAt(cx + dir[0] * 9, cy + dir[1] * 9), farm: f.cellAt(cx - dir[0] * 9, cy - dir[1] * 9) };
        if (!Object.values(sites).every(free)) continue;
        Rc.camera.target[0] = cx;
        Rc.camera.target[1] = cy;
        Rc.camera.target[2] = Math.max(...f.grid.columns[c0].map((col) => f.groundAt(col)));
        Rc.camera.zoom = 6;
        return { sites, dist, at, k };
      }
    return null;
  }, [Number(process.env.K0 ?? 0), process.env.DISTS ? process.env.DISTS.split(",").map(Number) : null]);
  if (!open) throw new Error('no open ground outside the town');
  console.log('open', JSON.stringify(open));
  await sleep(2500);
  // each site by finger: the screen point whose press picks its cell at level 0
  const pointFor = (c) =>
    page.evaluate((c) => {
      const Rc = window.reclaimed;
      const f = Rc.fortress;
      const [x, y] = f.centre(c);
      const z = Math.max(...f.grid.columns[c].map((col) => f.groundAt(col))) + 0.2;
      const [sx, sy] = Rc.camera.project(x, y, z);
      for (let r = 0; r <= 30; r += 2)
        for (let a = 0; a < 12; a++) {
          const px = sx + Math.cos(a) * r;
          const py = sy + Math.sin(a) * r;
          const b = f.pick(Rc.camera.ray(px, py), -1);
          if (b && b.cell === c && b.level === 0) return [px, py];
        }
      return null;
    }, c);
  for (const [type, label] of [['lumber', 'Lumber camp'], ['house', 'Houses'], ['farm', 'Farms']]) {
    const p = await pointFor(open.sites[type]);
    if (!p) throw new Error(`no screen point for the ${type}`);
    await tapButton(label);
    await tap(p[0], p[1]);
    console.log('planned', type, JSON.stringify(await page.evaluate((c) => window.reclaimed.fortress.plan.typeAt(c), open.sites[type])), await panel());
  }
  if (OUT) await page.screenshot({ path: `${OUT}/outside-plan.png` });
  // (round 128k) what the fortress's check reads at the sites: dry ground (the river read under a site meant a read from
  // before a slide looked up where the window had moved) and reached from the stores
  const check = await page.evaluate((sites) => {
    const f = window.reclaimed.fortress;
    const cols = f.columnsNow();
    const m = f.reachMap();
    return Object.fromEntries(Object.entries(sites).map(([k, c]) => [k, {
      water: Math.max(...f.grid.columns[c].map((col) => { const wc = f.boxToWindowCol(col); return cols.water(wc % cols.w, Math.floor(wc / cols.w)); })),
      reached: m ? f.reachedIn(m, c) : null,
    }]));
  }, open.sites);
  console.log('check', JSON.stringify(check));
  if (Object.values(check).some((v) => v.water > 0.3 || v.reached === false)) throw new Error(`the fortress reads a site outside the walls as water or cut off: ${JSON.stringify(check)}`);
  console.log('roads planned', JSON.stringify(await page.evaluate(() => {
    const L = window.reclaimed.fortress.lanes();
    return { segs: L.segs.length, tiles: L.tiles.length, joined: L.joined.length, unjoined: L.unjoined.length };
  })));
  // (PAN=1: the camera panned far off and back before Build, the way a player looks round — the window slides)
  if (process.env.PAN) {
    for (const d of [[160, 0], [0, 0], [0, 160], [0, 0]]) {
      await page.evaluate(([dx, dy, sites]) => {
        const Rc = window.reclaimed;
        const [x, y] = Rc.fortress.centre(sites.lumber);
        Rc.camera.target[0] = x + dx;
        Rc.camera.target[1] = y + dy;
      }, [...d, open.sites]);
      await sleep(4000);
    }
    console.log('panned', JSON.stringify(await page.evaluate(() => ({ cutOff: window.reclaimed.fortress.cutOff, slides: window.reclaimed.streamer?.slides }))));
  }
  await tapButton('Build');
  await tapButton(process.env.SPEEDBTN ?? '16x');
  // (why a builder takes its load back: each unload that isn't a delivery, with the block's state then)
  await page.evaluate(() => {
    const L = window.reclaimed.fortressLife();
    const orig = L.unload.bind(L);
    window.__unloads = [];
    L.unload = (u, w, ok) => {
      if (!ok && w.block) {
        const b = w.block;
        window.__unloads.push({ t: Math.round(L.t), cell: b.cell, cut: L.isCutOff(b), todo: L.todo().some((x) => x.cell === b.cell && x.level === b.level), cutCells: L.cutCells.size, at: u.v.at.map(Math.round) });
      }
      return orig(u, w, ok);
    };
  });
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < LIMIT_S * 1000) {
    await sleep(10000);
    await R.fatal(page);
    last = await page.evaluate((sites) => {
      const Rc = window.reclaimed;
      const f = Rc.fortress;
      const life = Rc.fortressLife();
      const built = Object.fromEntries(Object.entries(sites).map(([k, c]) => [k, f.town.has(c, 0)]));
      const at = f.storesAt();
      const people = life ? life.people().map((id) => Rc.units.get(id)).filter(Boolean) : [];
      const far = people.map((u) => Math.round(Math.hypot(u.at[0] - at[0], u.at[1] - at[1])));
      const states = {};
      for (const u of people) states[u.state] = (states[u.state] ?? 0) + 1;
      const phases = {};
      for (const u of people) {
        const rec = Rc.units.recs?.get(u.id);
        const w = rec?.work;
        const k = w ? `${w.phase}${w.job ? ':' + w.job : ''}` : '-';
        phases[k] = (phases[k] ?? 0) + 1;
      }
      return { simT: Math.round(life?.t ?? 0), built, far: far.sort((a, b) => a - b), states, phases, riding: life?.riding, cutOff: f.cutOff };
    }, open.sites);
    console.log(`t ${Math.round((Date.now() - t0) / 1000)} s`, JSON.stringify(last), await panel());
    console.log('unloads', JSON.stringify(await page.evaluate(() => window.__unloads.splice(0))));
    // (how far the sites are by the fields from the stores, against as the crow flies)
    console.log('paths', JSON.stringify(await page.evaluate(async (sites) => {
      const Rc = window.reclaimed;
      const f = Rc.fortress;
      const at = f.storesAt();
      const out = {};
      for (const [name, fld] of [['site', 6], ['store', 4], ['pile', 5]]) {
        const rd = Rc.units.agents.reader(fld);
        await rd.refresh();
        const q = rd.sample(at[0], at[1]);
        out[name] = q ? +q.dist.toFixed(1) : null;
      }
      out.crow = Object.fromEntries(Object.entries(sites).map(([k, c]) => [k, Math.round(Math.hypot(f.centre(c)[0] - at[0], f.centre(c)[1] - at[1]))]));
      return out;
    }, open.sites)));
    if (Object.values(last.built).every(Boolean)) break;
  }
  if (OUT) await page.screenshot({ path: `${OUT}/outside-build.png` });
  // (round 128k) the roads at play zoom: between the town's stores and the sites, then closer on the sites
  const roads = await page.evaluate((sites) => {
    const Rc = window.reclaimed;
    const f = Rc.fortress;
    const L = f.lanes();
    return { segs: L.segs.length, tiles: L.tiles.length, joined: L.joined.length, unjoined: L.unjoined.length, kinds: L.segs.reduce((a, s) => ((a[s.kind] = (a[s.kind] ?? 0) + 1), a), {}) };
  }, open.sites);
  console.log('roads', JSON.stringify(roads));
  for (const [name, zoom, t] of [['outside-roads', 3.2, 0.5], ['outside-roads-near', 6, 1]]) {
    await page.evaluate(([sites, zoom, t]) => {
      const Rc = window.reclaimed;
      const f = Rc.fortress;
      const at = f.storesAt();
      const [x, y] = f.centre(sites.lumber);
      const c = Rc.camera;
      c.target[0] = at[0] + (x - at[0]) * t;
      c.target[1] = at[1] + (y - at[1]) * t + (160 / zoom) * 0.5;
      c.zoom = zoom;
    }, [open.sites, zoom, t]);
    await sleep(2500);
    if (OUT) await page.screenshot({ path: `${OUT}/${name}.png` });
  }
  const ok = last && Object.values(last.built).every(Boolean);
  console.log(ok ? 'REACHED: every site outside the walls stands' : 'NOT REACHED', JSON.stringify(last?.built));
  if (!ok) throw new Error('the builders did not reach the sites outside the walls');
});
