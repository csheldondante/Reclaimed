// Terrain rivers, step 2: the walks' input of a real atlas (seed 1, n 2048) saved for Node — the CPU build's profile
// (scripts/terrain/walkprof.mjs) and tests on real ground without a browser. The page needs ?walkdump=1 (build.ts keeps
// Atlas.walkInput then).
//   node scripts/terrain/walkdump.mjs --out local/terrain2/walkin [--params "a.rivers2=1"]
// Writes <out>/meta.json (n, seed, sea, worldW, worldH, extra, lavaTops) and G.f32, coast.f32, water.u8, tier.u8,
// landform.i32.
import fs from 'node:fs';
import { run, sleep } from '../lib/runner.mjs';

await run({ name: 'terrain-walkdump', kind: 'behaviour', size: '400x400' }, async (R) => {
  const out = R.opt('out', 'local/terrain2/walkin');
  fs.mkdirSync(out, { recursive: true });
  const extra = R.opt('params', 'a.rivers2=1');
  const p = await R.page();
  await p.goto(`${R.url}/?atlas=view&mode=ground&overlay=0&walkdump=1&${extra}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.atlas || document.querySelector('.fatal'), { timeout: 400000, polling: 250 });
  await R.fatal(p);
  await sleep(300);
  const meta = await p.evaluate(() => {
    const w = window.reclaimed.atlas.walkInput;
    if (!w) return null;
    return { n: w.n, seed: w.seed, sea: w.sea, worldW: w.worldW, worldH: w.worldH, extra: w.extra, lavaTops: w.lavaTops, timings: window.reclaimed.atlas.timings, walk: window.reclaimed.atlas.walkStats };
  });
  if (!meta) throw new Error('no walkInput: the page needs a.rivers2=1 and walkdump=1');
  fs.writeFileSync(`${out}/meta.json`, JSON.stringify(meta));
  for (const k of ['G', 'coast', 'water', 'tier', 'landform']) {
    const parts = [];
    const CH = 1 << 22;
    for (let off = 0; ; off += CH) {
      const s = await p.evaluate(
        (k, off, CH) => {
          const a = window.reclaimed.atlas.walkInput[k];
          const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
          if (off >= b.length) return null;
          const c = b.subarray(off, Math.min(b.length, off + CH));
          let s = '';
          for (let i = 0; i < c.length; i += 0x8000) s += String.fromCharCode.apply(null, c.subarray(i, i + 0x8000));
          return btoa(s);
        },
        k,
        off,
        CH,
      );
      if (s === null) break;
      parts.push(Buffer.from(s, 'base64'));
    }
    const buf = Buffer.concat(parts);
    const ext = { G: 'f32', coast: 'f32', water: 'u8', tier: 'u8', landform: 'i32' }[k];
    fs.writeFileSync(`${out}/${k}.${ext}`, buf);
    R.log(`${k}: ${buf.length} bytes`);
  }
});
