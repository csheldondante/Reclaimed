// Round 106 (tilephone): the region store's column hash, sliced (world/region-record.ts columnsHashSteps, a few rows a
// turn of Streamer.later), against the hash as it was whole (round 100's columnsHash, copied here as it was) — on the
// window's own regions read back (Streamer.copyOut, as ?rsverify reads them) at the atlas level, every system on.
//   node scripts/hashtest.mjs [--url http://localhost:5341] [--wait 30000]
import puppeteer from 'puppeteer-core';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5341');
const wait = Number(opt('wait', 30000));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=412,915'],
  defaultViewport: { width: 412, height: 915, deviceScaleFactor: 2.6 },
  protocolTimeout: 600000,
});
let fail = 0;
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => {
    console.log('pageerror', e.message);
    fail++;
  });
  await p.goto(`${url}/?skipmenu=1&level=atlas&tutorial=0&q=low&at=11956,15471`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.stream, { timeout: 240000 });
  await new Promise((r) => setTimeout(r, wait));
  const r = await p.evaluate(async () => {
    const rr = await import('/src/world/region-record.ts');
    const lay = await import('/src/world/layout.ts');
    const mats = await import('/src/world/materials.ts');
    const { CHUNK, SLOT_WORDS } = lay;
    const { MATERIALS, MatState } = mats;
    // (round 100's columnsHash, whole, as it was before round 106)
    const whole = (pages, layout, outside, oz) => {
      const { R, K, rc } = layout;
      const pageSlots = K * CHUNK * CHUNK;
      const f = new Float32Array(pages.buffer, pages.byteOffset, pages.length);
      let h = 0x811c9dc5;
      const mix = (v) => {
        h ^= v & 0xffff;
        h = Math.imul(h, 0x01000193);
        h ^= v >>> 16;
        h = Math.imul(h, 0x01000193);
      };
      const q = (z) => Math.round(z * 256) | 0;
      const matter = (m) => {
        const st = MATERIALS[m]?.state;
        return st !== undefined && st !== MatState.Empty && st !== MatState.Liquid;
      };
      for (let y = 0; y < R; y++)
        for (let x = 0; x < R; x++) {
          const page = Math.floor(y / CHUNK) * rc + Math.floor(x / CHUNK);
          const base = (page * pageSlots + ((y % CHUNK) * CHUNK + (x % CHUNK)) * K) * SLOT_WORDS;
          const out = outside[y * R + x];
          let lz1 = NaN;
          let lmat = -1;
          let lz0 = 0;
          let laux = 0;
          const flush = () => {
            mix(q(lz0));
            mix(q(lz1));
            mix(lmat | (laux << 8));
            void matter(lmat);
          };
          const put = (z0, z1, mat, aux) => {
            if (mat === lmat && Math.abs(z0 - lz1) < 1e-4) {
              lz1 = Math.max(lz1, z1);
              return;
            }
            if (lmat >= 0) flush();
            lz0 = z0;
            lz1 = z1;
            lmat = mat;
            laux = aux;
          };
          if (out.length) for (const iv of out.filter((iv) => iv.z0 < oz).sort((a, b) => a.z0 - b.z0)) put(iv.z0, iv.z1, iv.mat, iv.aux ?? 0);
          for (let s = 0; s < K; s++) {
            const o = base + s * SLOT_WORDS;
            if (pages[o + 1] === 0) break;
            const w = pages[o + 2];
            put(f[o] + oz, f[o + 1] + oz, w & 0xff, (w >>> 8) & 0xff);
          }
          if (out.length) for (const iv of out.filter((iv) => iv.z0 >= oz).sort((a, b) => a.z0 - b.z0)) put(iv.z0, iv.z1, iv.mat, iv.aux ?? 0);
          if (lmat >= 0) flush();
          mix(0xfffe);
        }
      return h >>> 0;
    };
    const S = window.reclaimed.stream;
    const dev = window.reclaimed.core.host.gpu.device;
    const L = S.layout;
    const res = [];
    for (let ly = 0; ly < S.H; ly += S.R)
      for (let lx = 0; lx < S.W; lx += S.R) {
        const st = dev.createBuffer({ size: L.bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        const enc = dev.createCommandEncoder();
        S.copyOut(enc, lx, ly, st, 0, false);
        dev.queue.submit([enc.finish()]);
        const out = S.regionOutside(S.core.ring.corner(lx, ly)).map((c) => c.slice());
        await st.mapAsync(GPUMapMode.READ);
        const body = new Uint8Array(st.getMappedRange()).slice();
        st.unmap();
        st.destroy();
        const pages = new Uint32Array(body.buffer, 0, (L.rc * L.rc * L.pageBytes) / 4);
        const a = whole(pages, L, out, S.oz);
        const b = rr.columnsHash(pages, L, out, S.oz);
        const g = rr.columnsHashSteps(pages, L, out, S.oz, undefined, 4);
        let n = 0;
        let s = g.next();
        while (!s.done) {
          n++;
          s = g.next();
        }
        res.push({ at: `${lx},${ly}`, whole: a, hash: b, sliced: s.value, slices: n, same: a === b && a === s.value });
      }
    return res;
  });
  for (const x of r) {
    console.log(`${x.same ? 'ok  ' : 'FAIL'} region ${x.at}: whole ${x.whole} columnsHash ${x.hash} sliced ${x.sliced} (${x.slices + 1} slices)`);
    if (!x.same) fail++;
  }
  console.log(fail ? `hashtest: ${fail} failed` : `hashtest: all ${r.length} the same`);
} finally {
  await browser.close();
}
process.exit(fail ? 1 : 0);
