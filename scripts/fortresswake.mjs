// (round 128d) What wakes the ground's systems while the fortress's builders work? The user: "Is the terrain simulation
// or wind or erosion waking up because of agents? We might want to keep that frozen outside of collapse, spells, or
// weather events." Houses are planned by the heap, Build pressed, and for a while every wake of the sleep (sim/sleep.ts)
// is counted by its caller (a stack's first frame outside sleep.ts) and every world event by its kind, with the chunks
// awake sampled each second.
//   node scripts/fortresswake.mjs [--dev] [--secs 40]
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'fortresswake', kind: 'behaviour', size: '412x915', dpr: 1, echo: !!process.env.DBG }, async (R) => {
  const secs = Number(R.opt('secs', 40));
  const page = await R.page();
  await page.goto(`${R.url}/?skipmenu=1&level=atlas&town=1&fortress=1&tod=0.3&day=30000&speed=8`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(page);
  await page.waitForFunction(() => window.reclaimed?.fortress?.ready || document.querySelector('.fatal'), { timeout: 120000, polling: 250 });
  await sleep(2000);
  const plan = await page.evaluate(() => {
    const Rc = window.reclaimed;
    const f = Rc.fortress;
    const st = Rc.settlements;
    const piles = st.spotsOf(st.pinnedId).filter((s) => s.kind === 'pile');
    const h = (piles.find((s) => s.what !== 'log') ?? piles[0]).w;
    // three houses of two storeys a few cells from the heap
    const out = [];
    for (const [dx, dy] of [[12, 0], [-12, 0], [0, 12]]) {
      const c = f.cellAt(h[0] + dx, h[1] + dy);
      if (c < 0) continue;
      f.paint(c, 0, 'house');
      f.paint(c, 1, 'house');
      out.push(c);
    }
    // wakes counted by their caller; events by kind
    const S = Rc.core.sleep;
    const W = (window.__wakes = { by: {}, events: {}, awake: [] });
    const wake = S.wake.bind(S);
    S.wake = (x, y, r, s, now) => {
      const st = (new Error().stack ?? '').split('\n').slice(2).map((l) => l.trim());
      const at = st.find((l) => !/sleep\.ts|Sleep\.wake/.test(l)) ?? '?';
      const key = at.replace(/\(?https?:\/\/[^/]+\//, '(').replace(/\?[^:)]*/, '').slice(0, 140);
      W.by[key] = (W.by[key] ?? 0) + 1;
      return wake(x, y, r, s, now);
    };
    const upd = S.update.bind(S);
    const seen = new WeakSet();
    S.update = (now, near, events, storms, tick) => {
      for (const e of events) {
        if (seen.has(e)) continue;
        seen.add(e);
        const k = `${e.kind}${e.quiet ? ' quiet' : ''}`;
        W.events[k] = (W.events[k] ?? 0) + 1;
      }
      return upd(now, near, events, storms, tick);
    };
    // who pushes each world event (its op: (z mod 512) / 32 for an edit)
    W.pushers = {};
    const G = Rc.globals;
    const patch = () => {
      const ev = G.events;
      if (ev && !ev.__p) {
        ev.__p = true;
        const push = ev.push;
        ev.push = function (...items) {
          const st = (new Error().stack ?? '').split('\n').slice(2).map((l) => l.trim());
          const at = (st[0] ?? '?').replace(/\(?https?:\/\/[^/]+\//, '(').replace(/\?[^:)]*/, '').slice(0, 120);
          for (const e of items) {
            const key = `kind ${e.kind} op ${Math.floor(((e.z ?? 0) % 512) / 32)} r ${(+e.radius).toFixed(1)} ← ${at}`;
            W.pushers[key] = (W.pushers[key] ?? 0) + 1;
          }
          return push.apply(this, items);
        };
      }
      requestAnimationFrame(patch);
    };
    patch();
    // the plants on the houses' cells (cleared by plants.clear, a quiet edit: still applied with the chunks asleep)
    window.__vegAt = async () => {
      const veg = await Rc.readBuffer('veg');
      const { w } = Rc.core.dims;
      const RH = Math.sqrt(3) / 2;
      return out.map((c) => {
        const [x, y] = f.centre(c);
        const r = Math.round(y / RH);
        return +veg[r * w + Math.round(x - (r & 1) * 0.5)].toFixed(2);
      });
    };
    return { heap: h, planned: out.length, blocks: f.plan.totals({}).blocks };
  });
  console.log('plan', JSON.stringify(plan));
  const veg0 = await page.evaluate(() => window.__vegAt());
  // before Build: what's awake with time stopped
  await page.evaluate(() => [...document.querySelectorAll('.fort-bar button')].find((b) => b.textContent === 'Build').click());
  // (what woke while planning is the plan's: counted from Build on)
  await page.evaluate(() => {
    const W = window.__wakes;
    W.by = {};
    W.events = {};
    W.pushers = {};
    W.touched0 = window.reclaimed.core.sleep.touched;
  });
  for (let s = 0; s < secs; s++) {
    await sleep(1000);
    await page.evaluate(() => window.__wakes.awake.push(window.reclaimed.core.sleep.awake));
  }
  const res = await page.evaluate(async () => {
    const L = window.reclaimed.fortressCrowd();
    return { veg: await window.__vegAt(), wakes: window.__wakes, stats: L?.stats, progress: window.reclaimed.fortress.progress(), touched: window.reclaimed.core.sleep.touched - window.__wakes.touched0 };
  });
  console.log('progress', JSON.stringify(res.progress), 'stats', JSON.stringify(res.stats));
  console.log('events by kind', JSON.stringify(res.wakes.events));
  console.log('awake chunks per second', res.wakes.awake.join(' '));
  for (const [k, n] of Object.entries(res.wakes.pushers).sort((a, b) => b[1] - a[1])) console.log('event', String(n).padStart(6), k);
  for (const [k, n] of Object.entries(res.wakes.by).sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(6), k);
  console.log('veg on the houses', JSON.stringify(veg0), '->', JSON.stringify(res.veg));
  R.check('the cells of the houses are cleared of trees (veg at most a felled column, 2.2)', res.veg.every((v) => v <= 2.2), JSON.stringify(res.veg));
  const woke = Object.values(res.wakes.by).reduce((a, b) => a + b, 0);
  console.log('touched (quiet edits)', res.touched);
  R.check('nothing the builders do wakes the ground (no wakes while building)', woke === 0, JSON.stringify(res.wakes.by));
  R.check('their edits touch their chunks instead', res.touched > 0, String(res.touched));
  R.check('builders built something', res.progress.built > 0, JSON.stringify(res.progress));
});
