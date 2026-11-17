// Terrain rivers, step 2: the streaming path's per-column cost, toggle diff — the same batches of columns (the
// streamer's atlas.columns: ground() and the finish) timed in a world with the flag and without. Wall time of each
// batch to its readback, after a warm-up; the median over the batches. Desktop proxy only (the phone bench is the
// owner's).
//   node scripts/terrain/colcost.mjs --tag on --params "a.rivers2=1" [--batches 24] [--size 128] --dir local/terrain2
import fs from 'node:fs';
import { run, sleep } from '../lib/runner.mjs';

await run({ name: 'terrain-colcost', kind: 'behaviour', size: '400x400' }, async (R) => {
  const tag = R.opt('tag', 'on');
  const dir = R.opt('dir', 'local/terrain2');
  const extra = R.opt('params', '');
  const B = Number(R.opt('batches', '24'));
  const S = Number(R.opt('size', '128'));
  const p = await R.page();
  await p.goto(`${R.url}/?atlas=view&mode=ground&overlay=0&${extra}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.atlas || document.querySelector('.fatal'), { timeout: 400000, polling: 250 });
  await R.fatal(p);
  await sleep(500);
  const res = await p.evaluate(
    async (B, S) => {
      const a = window.reclaimed.atlas;
      // (the same places in both worlds: a fixed lattice of batch corners over the land's latitudes)
      const at = [];
      for (let k = 0; k < B; k++) at.push([Math.floor(((k * 0.618034) % 1) * (a.worldW - S)), Math.floor((0.3 + 0.4 * ((k * 0.414214) % 1)) * (a.worldH / 0.8660254 - S))]);
      for (let k = 0; k < 3; k++) await a.columns(at[k][0], at[k][1], S, S);
      const ms = [];
      for (const [x, y] of at) {
        const t = performance.now();
        await a.columns(x, y, S, S);
        ms.push(performance.now() - t);
      }
      ms.sort((p, q) => p - q);
      return { batches: B, size: S, median: +ms[ms.length >> 1].toFixed(2), p25: +ms[ms.length >> 2].toFixed(2), p75: +ms[(3 * ms.length) >> 2].toFixed(2) };
    },
    B,
    S,
  );
  R.log(JSON.stringify({ tag, ...res, perColumnUs: +((res.median * 1000) / (S * S)).toFixed(3) }));
  fs.writeFileSync(`${dir}/${tag}-colcost.json`, JSON.stringify(res, null, 1));
});
