// Terrain perf (TR34): how far two builds' macro grounds differ — each world's Atlas.hmac saved, then compared: the
// largest |Δh|, how many texels differ at all and by more than 0.01 / 0.1 cells.
//   node scripts/terrain/hdiff.mjs --a "a.rivers2=1&tr2off=128" --b "a.rivers2=1" [--out local/perf]
import fs from 'node:fs';
import { run, sleep } from '../lib/runner.mjs';

await run({ name: 'terrain-hdiff', kind: 'behaviour', size: '400x400' }, async (R) => {
  const out = R.opt('out', 'local/perf');
  const grab = async (params) => {
    const p = await R.page();
    await p.goto(`${R.url}/?atlas=view&mode=ground&overlay=0&${params}`, { waitUntil: 'load' });
    await p.waitForFunction(() => window.reclaimed?.atlas || document.querySelector('.fatal'), { timeout: 400000, polling: 250 });
    await R.fatal(p);
    await sleep(500);
    const b64 = await p.evaluate(() => {
      const h = window.reclaimed.atlas.hmac;
      const u = new Uint8Array(h.buffer, h.byteOffset, h.byteLength);
      let s = '';
      for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
      return btoa(s);
    });
    await p.close();
    const buf = Buffer.from(b64, 'base64');
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  };
  const A = await grab(R.opt('a', ''));
  const B = await grab(R.opt('b', ''));
  let max = 0;
  let at = -1;
  let n0 = 0;
  let n1 = 0;
  let n2 = 0;
  for (let i = 0; i < A.length; i++) {
    const d = Math.abs(A[i] - B[i]);
    if (d > 0) n0++;
    if (d > 0.01) n1++;
    if (d > 0.1) n2++;
    if (d > max) {
      max = d;
      at = i;
    }
  }
  const n = Math.round(Math.sqrt(A.length));
  // (away from the torus's seams: --band texels from each edge left out)
  const band = Number(R.opt('band', '0'));
  let maxIn = 0;
  let nIn = 0;
  for (let i = 0; i < A.length; i++) {
    const x = i % n;
    const y = (i - x) / n;
    if (x < band || y < band || x >= n - band || y >= n - band) continue;
    const d = Math.abs(A[i] - B[i]);
    if (d > 0.01) nIn++;
    maxIn = Math.max(maxIn, d);
  }
  const res = { texels: A.length, differ: n0, over001: n1, over01: n2, maxAbs: +max.toFixed(4), maxAt: at >= 0 ? [at % n, Math.floor(at / n)] : null, band, inside: { over001: nIn, maxAbs: +maxIn.toFixed(5) } };
  R.log(JSON.stringify(res));
  fs.writeFileSync(`${out}/hdiff.json`, JSON.stringify(res, null, 1));
});
