// (hallfall, diagnosis) Why a town's building is cut in the first seconds: hooks the external registry's settlements
// owner, and on every loss prints the instance's claimed intervals beside what its columns hold now, and the chunk's K.
//   node scripts/hallprobe.mjs [--town 1] [--secs 30]
import { run } from './lib/runner.mjs';

await run({ name: 'hallprobe', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const town = R.opt('town', '1');
  const secs = Number(R.opt('secs', '30'));
  const p = await R.level({ level: 'atlas', town, tod: '0.38', day: '100000' });
  const hook = () =>
    p.evaluate(() => {
      const api = window.reclaimed;
      const ext = api.integrity?.()?.external;
      if (!ext || ext.__hooked) return !!ext;
      ext.__hooked = true;
      window.__losses = [];
      const packed = api.core.packed;
      const colInfo = (x, y) => {
        const C = 16;
        const ci = Math.floor(y / C) * packed.chunksX + Math.floor(x / C);
        const k = packed.chunkTable[ci * 2 + 1];
        const s = api.core.sleep;
        const slot = s ? s.slotOf(ci) : -1;
        const sl = s ? `filter ${s.filter ? s.filter[slot] : '-'} until ${s.until[slot]?.toFixed(1)} now ${(performance.now() / 1000).toFixed(1)}` : 'no sleep';
        return { k, sl, col: ext.cols.read(x, y).map((iv) => `${iv.z0.toFixed(2)}-${iv.z1.toFixed(2)}:${iv.mat}${iv.aux ? '/' + iv.aux : ''}`).join(' ') };
      };
      window.__colInfo = colInfo;
      const o = ext.owners.get(2);
      const prev = o.onLost;
      o.onLost = (inst, why) => {
        const bad = [];
        for (const c of inst.cols) {
          const ci = colInfo(c.x, c.y);
          const col = ext.cols.read(c.x, c.y);
          let z = c.z0;
          for (const iv of col) if (iv.mat === 255 || iv.mat === api.core.constructor?.EXT) void 0;
          bad.push({ c: `${c.x},${c.y} ${c.z0.toFixed(2)}-${c.z1.toFixed(2)}`, ...ci });
        }
        window.__losses.push({ t: api.core.globals.tick, why, id: inst.id, n: inst.cols.length, cols: bad });
        return prev(inst, why);
      };
      return true;
    });
  let ok = false;
  for (let i = 0; i < 100 && !(ok = await hook()); i++) await R.sleep(100);
  R.log(`hooked: ${ok}`);
  const snap = () =>
    p.evaluate(() => {
      const api = window.reclaimed;
      const ext = api.integrity?.()?.external;
      const v = api.settlementsView?.();
      return { tick: api.core.globals.tick, ext: ext ? { ...ext.stats } : null, view: v ? { ...v.stats } : null };
    });
  R.log(`start ${JSON.stringify(await snap())}`);
  for (let t = 0; t < secs; t += 5) {
    await R.simSeconds(p, 5);
    R.log(`t+${t + 5}s ${JSON.stringify(await snap())}`);
  }
  const losses = await p.evaluate(() => window.__losses);
  for (const l of losses) {
    R.log(`LOST tick ${l.t} ${l.why} inst ${l.id} (${l.n} cols)`);
    for (const c of l.cols.slice(0, 40)) R.log(`   ${c.c}  k=${c.k} ${c.sl}  now: ${c.col}`);
  }
});
