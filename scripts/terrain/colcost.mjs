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
  const S = Number(R.opt('cols', '128')); // (not --size: the runner's viewport option)
  const p = await R.page();
  await p.goto(`${R.url}/?atlas=view&mode=ground&overlay=0&${extra}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.atlas || document.querySelector('.fatal'), { timeout: 400000, polling: 250 });
  await R.fatal(p);
  await sleep(500);
  // (the atlas build's phases, ms — Atlas.timings)
  R.log(`build ${tag}: ${JSON.stringify(await p.evaluate(() => window.reclaimed.atlas.timings))}`);
  // (--at "x,row;x,row": one batch at each spot, timed B times — not the lattice)
  const spots = R.opt('at', '') ? R.opt('at', '').split(';').map((s) => s.split(',').map(Number)) : [null];
  const all = {};
  for (const spot of spots) {
  const res = await p.evaluate(
    async (B, S, spot) => {
      const a = window.reclaimed.atlas;
      // (the same places in both worlds: a fixed lattice of batch corners over the land's latitudes)
      const at = [];
      // (--at: the same batch, centred on the spot, B times — its least GPU time is its own cost)
      if (spot) for (let k = 0; k < B; k++) at.push([spot[0] - S / 2, spot[1] - S / 2]);
      else for (let k = 0; k < B; k++) at.push([Math.floor(((k * 0.618034) % 1) * (a.worldW - S)), Math.floor((0.3 + 0.4 * ((k * 0.414214) % 1)) * (a.worldH / 0.8660254 - S))]);
      for (let k = 0; k < 3; k++) await a.columns(at[k][0], at[k][1], S, S);
      // (GPU time by pass: a query set of our own lent as the atlas's profiler — wall time is the shared GPU's too)
      const dev = a.device;
      const tsOn = dev.features.has('timestamp-query');
      const qs = tsOn ? dev.createQuerySet({ type: 'timestamp', count: 256 }) : null;
      const resB = tsOn ? dev.createBuffer({ size: 256 * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }) : null;
      const mapB = tsOn ? dev.createBuffer({ size: 256 * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }) : null;
      let qi = 0;
      let names = [];
      if (tsOn)
        a.profiler = {
          timestamps(name) {
            if (qi + 2 > 256) return undefined;
            names.push(name);
            qi += 2;
            return { querySet: qs, beginningOfPassWriteIndex: qi - 2, endOfPassWriteIndex: qi - 1 };
          },
        };
      const ms = [];
      const gpu = {};
      // (A/B in one page, a.rivers2 worlds only: each batch timed with the flag's ground on, then off at run time — the
      // params' terrain2 0 and the valley block's offset word 0, as the default world has them — so both see the same
      // load on a shared GPU; the ratio of each pair is the flag's cost)
      const ab = a.p.rivers2 === 1;
      let vword = 0;
      const wordAt = (a.p.n * a.p.n + 3) * 4;
      if (ab) {
        const rb = dev.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        const e = dev.createCommandEncoder();
        e.copyBufferToBuffer(a.riverBuf, wordAt, rb, 0, 4);
        dev.queue.submit([e.finish()]);
        await rb.mapAsync(GPUMapMode.READ);
        vword = new Uint32Array(rb.getMappedRange().slice(0))[0];
        rb.unmap();
      }
      const setFlag = (on) => {
        a.p.rivers2 = on ? 1 : 0;
        dev.queue.writeBuffer(a.riverBuf, wordAt, new Uint32Array([on ? vword : 0]));
      };
      const ratios = [];
      const timeOne = async (x, y, tagged) => {
        qi = 0;
        names = [];
        const t = performance.now();
        await a.columns(x, y, S, S);
        ms.push(performance.now() - t);
        if (!tsOn || !qi) return null;
        const enc = dev.createCommandEncoder();
        enc.resolveQuerySet(qs, 0, qi, resB, 0);
        enc.copyBufferToBuffer(resB, 0, mapB, 0, qi * 8);
        dev.queue.submit([enc.finish()]);
        await mapB.mapAsync(GPUMapMode.READ);
        const v = new BigUint64Array(mapB.getMappedRange().slice(0, qi * 8));
        mapB.unmap();
        let h = null;
        names.forEach((nm, k) => {
          const d = Number(v[2 * k + 1] - v[2 * k]) / 1e6;
          (gpu[tagged + nm] ??= []).push(d);
          if (nm === 'atlas-colHeight') h = d;
        });
        return h;
      };
      for (const [x, y] of at) {
        if (!ab) {
          await timeOne(x, y, '');
          continue;
        }
        setFlag(true);
        const hOn = await timeOne(x, y, '');
        setFlag(false);
        const hOff = await timeOne(x, y, 'rtOff:');
        setFlag(true);
        if (hOn && hOff) ratios.push(hOn / hOff);
      }
      if (tsOn) a.profiler = undefined;
      ms.sort((p, q) => p - q);
      const med = (l) => {
        const s = [...l].sort((p, q) => p - q);
        return +s[s.length >> 1].toFixed(2);
      };
      const gpuMed = Object.fromEntries(Object.entries(gpu).map(([k, l]) => [k, med(l)]));
      // (the least: the GPU shared with other work — another browser — inflates a pass's span; with --at the batches
      // are of one place, so the least is the pass's own cost there)
      const gpuMin = Object.fromEntries(Object.entries(gpu).map(([k, l]) => [k, +Math.min(...l).toFixed(2)]));
      return { batches: B, size: S, median: +ms[ms.length >> 1].toFixed(2), p25: +ms[ms.length >> 2].toFixed(2), p75: +ms[(3 * ms.length) >> 2].toFixed(2), gpuMed, gpuMin, onOverOff: ratios.length ? med(ratios) : null };
    },
    B,
    S,
    spot,
  );
  const hUs = (spot ? res.gpuMin : res.gpuMed)?.['atlas-colHeight'];
  R.log(JSON.stringify({ tag, at: spot, onOverOff: res.onOverOff, ...res, perColumnUs: +((res.median * 1000) / (S * S)).toFixed(3), colHeightNsPerCol: hUs ? +((hUs * 1e6) / (S * S)).toFixed(1) : null }));
  all[spot ? spot.join(',') : 'lattice'] = res;
  }
  fs.writeFileSync(`${dir}/${tag}-colcost.json`, JSON.stringify(all, null, 1));
});
