// Round 125 (forest): the forest's costs on the phone proxy (412x915 dpr 2.6, q=low, uncapped: the frame interval is
// the GPU's cost), every system in play at 1x, parked in the forest station's stand under the canopy. The user's rule:
// per-pass timestamps are unreliable on tiler GPUs, so each treatment is toggled on and off (A/B/A/B windows) and the
// mean frame intervals compared; the wind's modes (a pipeline constant) by reloading, the cycle run twice for drift.
//   node scripts/forestcost.mjs [--window 4] [--rounds 3] [--modes static,sway,1A,1C,1A1C] [--out C:/Projects/shots88/forest]
//     [--skip-wind] [--skip-under]
import fs from 'node:fs';
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'forestcost', kind: 'timing', size: '412x915', dpr: 2.6, chromeArgs: ['--disable-gpu-vsync', '--disable-frame-rate-limit'] }, async (R) => {
  const out = R.opt('out', 'C:/Projects/shots88/forest');
  const win = Number(R.opt('window', '4'));
  const rounds = Number(R.opt('rounds', '3'));
  const at = R.opt('at', '13728,4768');
  const modes = R.opt('modes', 'static,sway,1A,1C,1A1C').split(',');
  const rows = [];
  const mean = async (p) => {
    return p.evaluate(async (s) => {
      const t = [];
      await new Promise((res) => {
        const f = (now) => {
          t.push(now);
          if (now - t[0] < s * 1000) requestAnimationFrame(f);
          else res();
        };
        requestAnimationFrame(f);
      });
      const d = t.slice(1).map((x, i) => x - t[i]);
      const m = d.reduce((a, b) => a + b, 0) / d.length;
      const sd = [...d].sort((a, b) => a - b);
      return { mean: m, p50: sd[Math.floor(sd.length / 2)], p95: sd[Math.floor(sd.length * 0.95)], frames: d.length };
    }, win);
  };
  const open = async (fwind) => {
    const p = await R.level({ level: 'atlas', at, play: 'lich', forest: 'lab', fseason: '0.5', fwind, fride: '0' });
    await p.waitForFunction(() => window.reclaimed?.forest?.stand, { timeout: 120000, polling: 500 });
    await p.evaluate(() => {
      const r = window.reclaimed;
      r.play.session.hero.place(r.forest.stand.park ?? r.forest.stand.at);
      r.forest.d.driver.force = 1;
    });
    await sleep(25000);
    return p;
  };
  const T = ['canopy', 'dither', 'dapple', 'rays', 'mist', 'leaves'];
  const setT = (p, on) =>
    p.evaluate(
      ({ on, T }) => {
        for (const k of T) window.reclaimed.forest.d.driver.treatments[k] = on.includes(k) ? 1 : 0;
      },
      { on, T },
    );
  /** A/B/A/B: `a` and `b` set the page's state; the means of each side */
  const ab = async (p, label, a, b) => {
    const A = [];
    const B = [];
    for (let r = 0; r < rounds; r++) {
      await a();
      await sleep(800);
      A.push(await mean(p));
      await b();
      await sleep(800);
      B.push(await mean(p));
    }
    const m = (xs, k) => xs.reduce((s, x) => s + x[k], 0) / xs.length;
    const row = { label, a: +m(A, 'mean').toFixed(2), b: +m(B, 'mean').toFixed(2), diff: +(m(B, 'mean') - m(A, 'mean')).toFixed(2), aP95: +m(A, 'p95').toFixed(1), bP95: +m(B, 'p95').toFixed(1) };
    R.log(JSON.stringify(row));
    rows.push(row);
  };
  if (!R.flag('skip-under')) {
    const p = await open('1A1C');
    await ab(p, 'understory: off -> all', () => setT(p, []), () => setT(p, T));
    for (const k of T) await ab(p, `understory: ${k} off -> on`, () => setT(p, T.filter((x) => x !== k)), () => setT(p, T));
    await ab(p, 'look held out -> in (zoom and all)', () => p.evaluate(() => (window.reclaimed.forest.d.driver.force = 0)), () => p.evaluate(() => (window.reclaimed.forest.d.driver.force = 1)));
    // the foliage scene against none (the trees' draw left out: renderer SKIP), the understory held in
    await ab(p, 'trees: none -> drawn', () => p.evaluate(() => window.reclaimed.core.renderer.constructor.skip.add("trees")), () => p.evaluate(() => window.reclaimed.core.renderer.constructor.skip.delete("trees")));
    await p.close();
  }
  if (!R.flag('skip-wind')) {
    // the wind's modes, each a reload; the cycle twice (thermal and baseline drift: the matrix's "rerunning static baselines")
    for (let cyc = 0; cyc < 2; cyc++)
      for (const m of modes) {
        const p = await open(m);
        const s = await mean(p);
        const s2 = await mean(p);
        const row = { label: `fwind ${m} (cycle ${cyc + 1})`, mean: +((s.mean + s2.mean) / 2).toFixed(2), p95: +((s.p95 + s2.p95) / 2).toFixed(1) };
        R.log(JSON.stringify(row));
        rows.push(row);
        await p.close();
      }
  }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(`${out}/forest-cost.json`, JSON.stringify(rows, null, 1));
  R.log(`saved ${out}/forest-cost.json`);
});
