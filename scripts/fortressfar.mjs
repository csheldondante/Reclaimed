// (round 128f) The user, from the phone: "agents seem to not be able to path through the city or farms to buildings at
// the peripheral". From the start menu at the phone's size: house blocks planned round the town — just past its edge and
// out past its farms, on every side — then Build and Skip (by finger). The check at placement (fortress/reach.ts) refuses
// the spots the stores can't reach, saying why; every block it lets be planned must be built (the GPU field agrees with
// it). The stores' field is read at each block left, printed.
//   node scripts/fortressfar.mjs [--out C:/Projects/shots88/fortress]
import { run, sleep } from './lib/runner.mjs';

const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? process.argv[outArg + 1] : null;
const WAIT_S = Number(process.env.WAIT ?? 150);
await run({ name: 'fortressfar', kind: 'behaviour', size: '412x915', dpr: 1, echo: !!process.env.DBG }, async (R) => {
  const page = await R.page();
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const tap = async (x, y) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 0 }] });
    await sleep(60);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(700);
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
  await page.goto(`${R.url}/${process.env.Q ? `?q=${process.env.Q}` : ''}`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('[data-a="fortress"]') || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(page);
  await sleep(1500);
  const fb = await where('[data-a="fortress"]', null);
  if (!fb) throw new Error('no Fortress button on the start menu');
  await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 120000 }), tap(...fb)]);
  await page.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(page);
  await page.waitForFunction(() => window.reclaimed?.fortress?.ready || document.querySelector('.fatal'), { timeout: 120000, polling: 250 });
  await page.waitForFunction(() => !!window.reclaimed.fortress.reachKnown, { timeout: 60000, polling: 250 });
  await sleep(2000);
  // the plan: a house block on dry ground on every side, just past the town's edge and past its farms
  const plan = await page.evaluate(async () => {
    const Rc = window.reclaimed;
    const f = Rc.fortress;
    const st = Rc.settlements;
    const rec = st.settlement(st.pinnedId);
    const [tx, ty] = st.toWindow(rec.at);
    const rd = Rc.units.agents.reader(9);
    await rd.refresh();
    const { w, h } = Rc.core.dims;
    const dry = (x, y) => {
      const r = Math.round(y / (Math.sqrt(3) / 2));
      const k = Math.round(x);
      if (k < 30 || r < 30 || k >= w - 30 || r >= h - 30 || f.windowToBoxCol(r * w + k) < 0) return false;
      // (no water over the ground there: the probe's water)
      const q = rd.sample(x, y);
      return !!q && q.z > 0;
    };
    const R0 = rec.radius ?? 40;
    const blocks = [];
    const refused = [];
    for (const r of [R0 + 8, R0 + 30])
      for (let a = 0; a < 8; a++) {
        const x = tx + Math.cos((a / 8) * Math.PI * 2) * r;
        const y = ty + Math.sin((a / 8) * Math.PI * 2) * r;
        if (!dry(x, y)) continue;
        const c = f.cellAt(x, y);
        if (c < 0 || f.plan.owner[c] >= 0) continue;
        // (the check at placement: a spot the stores can't reach is refused, with why)
        if (f.paint(c, 0, 'house')) blocks.push({ cell: c, r: Math.round(r), a: a * 45 });
        else refused.push({ r: Math.round(r), a: a * 45, why: f.refusal });
      }
    // (stores enough for every block: the test is the walking, not the economy)
    return { blocks, refused, town: [tx, ty], radius: R0 };
  });
  console.log('plan', JSON.stringify(plan));
  if (OUT) await page.screenshot({ path: `${OUT}/far-plan.png` });
  await tapButton('Build');
  await sleep(1500);
  const skip = await where('.fort-bar button', 'Skip to done');
  if (skip) await tap(...skip);
  const t0 = Date.now();
  let state = null;
  while (Date.now() - t0 < WAIT_S * 1000) {
    await sleep(5000);
    state = await page.evaluate(async (blocks) => {
      const Rc = window.reclaimed;
      const f = Rc.fortress;
      const life = Rc.fortressLife();
      const rd = life.reach;
      const left = blocks.filter((b) => !f.town.has(b.cell, 0));
      return {
        built: blocks.length - left.length,
        of: blocks.length,
        cutOff: f.cutOff,
        note: f.note,
        crew: f.crew,
        heap: life.heap().map((v) => Math.round(v)),
        stores: f.stores(),
        left: left.map((b) => {
          const [x, y] = f.centre(b.cell);
          const q = rd.sample(x, y);
          return { ...b, at: [Math.round(x), Math.round(y)], dist: q && isFinite(q.dist) && q.dist < 1e8 ? Math.round(q.dist) : null, z: q ? +q.z.toFixed(1) : null };
        }),
      };
    }, plan.blocks);
    console.log(`t ${Math.round((Date.now() - t0) / 1000)}s`, JSON.stringify({ built: state.built, of: state.of, cutOff: state.cutOff, note: state.note, crew: state.crew }));
    if (state.built === state.of) break;
  }
  console.log('final', JSON.stringify(state));
  if (state.built !== state.of) {
    // (who is stuck where: each builder's phase, where it is, the leg's field there, how far its block's stands are)
    const who = await page.evaluate(async () => {
      const Rc = window.reclaimed;
      const f = Rc.fortress;
      const life = Rc.fortressLife();
      const A = Rc.units.agents;
      const rs = A.reader(6);
      const rw = A.reader(4);
      await rs.refresh();
      await rw.refresh();
      return life.people().map((id) => {
        const u = Rc.units.recs.get(id);
        const w = u.work;
        if (!w || !w.load) return null;
        const p = u.v.at;
        const r = w.load.good === 'log' ? rw : rs;
        const q = r.sample(p[0], p[1]);
        const stands = w.block ? life.standsFor(w.block) : [];
        const near = stands.length ? Math.min(...stands.map(([x, y]) => Math.hypot(x - p[0], y - p[1]))) : null;
        return { id, phase: w.phase, good: w.load.good, at: [Math.round(p[0]), Math.round(p[1]), +p[2].toFixed(1)], field: q && q.dist < 1e8 ? Math.round(q.dist) : null, dir: q?.dir?.map((v) => +v.toFixed(2)), block: w.block?.cell, blockAt: w.block ? f.centre(w.block.cell).map(Math.round) : null, near: near && Math.round(near) };
      }).filter(Boolean);
    });
    console.log('stuck', JSON.stringify(who));
  }
  if (OUT) await page.screenshot({ path: `${OUT}/far-built.png` });
  if (state.built !== state.of) throw new Error(`${state.of - state.built} of ${state.of} blocks round the town never built`);
});
