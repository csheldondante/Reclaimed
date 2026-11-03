// (merge128, INT16 second mechanism; diagnosis) A claimed column's top lowered in an awake chunk: which change did it.
// Logs every Edit event (kind, op, where, radius, strength) and every ColumnApply stage (what kind, which columns), and on
// a building's loss prints those within 24 cells of its first bad column, with the GPU's column as it is then.
//   node scripts/hallprobe2.mjs [--town 1] [--secs 30]
import { run } from './lib/runner.mjs';

await run({ name: 'hallprobe2', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const town = R.opt('town', '1');
  const secs = Number(R.opt('secs', '30'));
  const p = await R.level({ level: 'atlas', town, tod: '0.38', day: '100000' });
  const hook = () =>
    p.evaluate(() => {
      const api = window.reclaimed;
      const ig = api.integrity?.();
      const ext = ig?.external;
      if (!ext || ext.__hooked2) return !!ext;
      ext.__hooked2 = true;
      const log = (window.__log = []);
      const tick = () => api.core.globals.tick;
      api.core.sim.eventTaps.push((sent) => {
        for (const e of sent) log.push({ t: tick(), what: `event kind ${e.kind} z ${e.z} op ${((e.z ?? 0) & 511) >> 5} tag ${(e.z ?? 0) >> 10}`, x: e.x, y: e.y, r: e.radius, s: e.strength });
      });
      const ap = api.core.columnApply;
      const run0 = ap.run.bind(ap);
      ap.run = (cols, stages, target) => {
        for (const st of stages) {
          const kinds = [];
          const at = [];
          if (st.cuts.length) kinds.push(`cuts ${st.cuts.length}`), at.push(...st.cuts.map((c) => [c.x, c.y, JSON.stringify(c.cuts)]));
          if (st.spill?.length) kinds.push(`spill ${st.spill.length}`);
          if (st.deposits?.length) kinds.push(`deposits ${st.deposits.length}`), at.push(...st.deposits.map((d) => [d.x, d.y, `dep ${d.amount.toFixed(2)} m${d.mat}`]));
          if (st.release?.length) kinds.push(`release ${st.release.length}`), at.push(...st.release.map((c) => [c.x, c.y, `rel ${c.z0.toFixed(2)}-${c.z1.toFixed(2)}`]));
          if (st.claim?.length) kinds.push(`claim ${st.claim.length}`);
          log.push({ t: tick(), what: `apply ${kinds.join(', ')}`, at });
        }
        return run0(cols, stages, target);
      };
      const w0 = ig.cols.write.bind(ig.cols);
      ig.cols.write = (x, y, col, cpu = true, gpu = true) => {
        log.push({ t: tick(), what: `copy.write cpu ${cpu} gpu ${gpu}`, at: [[x, y, col.map((iv) => `${iv.z0.toFixed(2)}-${iv.z1.toFixed(2)}:${iv.mat}`).join(' ')]] });
        return w0(x, y, col, cpu, gpu);
      };
      const o = ext.owners.get(2);
      const prev = o.onLost;
      window.__losses = [];
      o.onLost = (inst, why) => {
        let bad = null;
        for (const c of inst.cols) {
          const col = ext.cols.read(c.x, c.y);
          let z = c.z0;
          for (const iv of col) if (iv.mat === 39 && iv.z0 <= z + 1e-3 && iv.z1 > z + 1e-3) z = iv.z1;
          if (z < c.z1 - 1e-3) {
            bad = { c, col: col.map((iv) => `${iv.z0.toFixed(2)}-${iv.z1.toFixed(2)}:${iv.mat}${iv.aux ? '/' + iv.aux : ''}`).join(' ') };
            break;
          }
        }
        window.__losses.push({ t: tick(), why, id: inst.id, bad });
        return prev(inst, why);
      };
      return true;
    });
  let ok = false;
  for (let i = 0; i < 100 && !(ok = await hook()); i++) await R.sleep(100);
  R.log(`hooked: ${ok}`);
  await R.simSeconds(p, secs);
  const out = await p.evaluate(() => {
    const losses = window.__losses;
    const res = [];
    for (const l of losses) {
      if (!l.bad) {
        res.push({ l, near: [] });
        continue;
      }
      const { x, y } = l.bad.c;
      const near = window.__log.filter((e) => {
        if (e.at) return e.at.some(([ax, ay]) => Math.abs(ax - x) <= 24 && Math.abs(ay - y) <= 24);
        return e.x !== undefined && Math.hypot(e.x - x, (e.y ?? 0) / 0.866 - y) <= 40;
      });
      res.push({ l, near: near.map((e) => ({ ...e, at: e.at?.filter(([ax, ay]) => Math.abs(ax - x) <= 3 && Math.abs(ay - y) <= 3) })) });
    }
    const kinds = {};
    for (const e of window.__log) kinds[e.what.split(' ').slice(0, 4).join(' ')] = (kinds[e.what.split(' ').slice(0, 4).join(' ')] ?? 0) + 1;
    return { res, kinds };
  });
  R.log(`log kinds ${JSON.stringify(out.kinds)}`);
  for (const { l, near } of out.res) {
    R.log(`LOST tick ${l.t} ${l.why} inst ${l.id}: ${l.bad ? `${l.bad.c.x},${l.bad.c.y} ${l.bad.c.z0.toFixed(2)}-${l.bad.c.z1.toFixed(2)} now ${l.bad.col}` : '(no bad column found)'}`);
    for (const e of near.slice(-60)) R.log(`   t${e.t} ${e.what}${e.x !== undefined ? ` at ${e.x?.toFixed?.(1)},${e.y?.toFixed?.(1)} r ${e.r} s ${e.s}` : ''}${e.at?.length ? ' ' + JSON.stringify(e.at) : ''}`);
  }
});
