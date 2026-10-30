// Round 117 (flora): the flora track's perf test — a dense wood in the real atlas on the phone tier (q=low, 412x915,
// dpr 2.6), at zoom 14 (close: every blade drawn big) and 5 (wide: the most plants on screen), with the flora library
// (?flora=1, the default) and without (?flora=0: the boxes as before) — every system in play, 1x speed. Writes
// data/perf/flora-<adapter>.json.
//   node scripts/perf/flora.mjs [--at 13728,4768] [--zooms 14,5] [--variants 1,0] [--seconds 8] [--size 412x915] [--dpr 2.6]
// --at: a world cell to start at (default: the birch-wood tile florashot.mjs --find birch found on the default atlas).
import fs from 'node:fs';
import path from 'node:path';
import { run, sleep, ROOT } from '../lib/runner.mjs';

await run({ name: 'perf-flora', kind: 'timing', size: '412x915', dpr: 2.6, echo: true }, async (R) => {
  const opt = (k, d) => {
    const i = R.argv.indexOf(`--${k}`);
    return i >= 0 ? R.argv[i + 1] : d;
  };
  const at = opt('at', '13728,4768');
  const zooms = opt('zooms', '14,5').split(',').map(Number);
  const variants = opt('variants', '1,0').split(',');
  const seconds = Number(opt('seconds', 8));
  const rows = [];
  let adapter = 'unknown';
  for (const v of variants) {
    const page = await R.page();
    await page.goto(`${R.url}/?skipmenu=1&level=atlas&tutorial=0&q=low&perf=1&flora=${v}&at=${at}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
    await R.fatal(page);
    await sleep(20000);
    adapter = await page.evaluate(() => window.reclaimed.core.host.gpu.adapterInfo ?? 'unknown');
    // the woodiest 16² block near the start (the succession field read back)
    const spot = await page.evaluate(async () => {
      const r = window.reclaimed;
      const veg = await r.core.readBuffer('veg');
      const { w, h } = r.core.dims;
      const [tx, ty] = r.camera.target;
      const ROW_H = Math.sqrt(3) / 2;
      let best = null;
      for (let by = 2; by < h / 16 - 2; by++)
        for (let bx = 2; bx < w / 16 - 2; bx++) {
          let n = 0;
          for (let y = by * 16; y < by * 16 + 16; y++) for (let x = bx * 16; x < bx * 16 + 16; x++) if (veg[y * w + x] >= 3.6) n++;
          const cx = bx * 16 + 8;
          const cy = by * 16 + 8;
          const s = n - 0.15 * Math.hypot(cx - tx, cy * ROW_H - ty);
          if (!best || s > best.s) best = { x: cx + 0.5, y: cy * ROW_H, n, s };
        }
      return best;
    });
    for (const z of zooms) {
      await page.evaluate(({ s, z }) => {
        const r = window.reclaimed;
        r.camera.target = [s.x, s.y, r.camera.target[2]];
        r.camera.zoom = z;
      }, { s: spot, z });
      await sleep(5000);
      await R.fatal(page);
      await page.evaluate(() => {
        const P = window.reclaimed.core.host.profiler;
        P.resetTotals();
        window.__all = [];
        const tick = () => {
          window.__all.push(performance.now());
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      await sleep(seconds * 1000);
      const r = await page.evaluate(async () => {
        const R = window.reclaimed;
        const t = window.__all;
        const d = [];
        for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
        const f = [...d].sort((a, b) => a - b);
        const q = (x) => +f[Math.min(f.length - 1, Math.floor(x * f.length))].toFixed(1);
        const P = R.core.host.profiler;
        const per = (k) => +((P.totalMs.get(k) ?? 0) / Math.max(P.framesResolved, 1)).toFixed(2);
        const mi = R.renderer.meshInst;
        let plants = null;
        if (mi) {
          const c = await mi.counts(R.renderer.device, R.renderer.indirect);
          const by = {};
          mi.kinds.forEach((k, i) => {
            if (c[i]) by[k.name] = [c[i], Math.round((k.index.length / 3) * c[i])];
          });
          plants = { instances: c.reduce((a, b) => a + b, 0), tris: Math.round(mi.kinds.reduce((a, k, i) => a + (k.index.length / 3) * c[i], 0)), by };
        }
        return {
          fps: +(d.length / ((t[t.length - 1] - t[0]) / 1000)).toFixed(1),
          p50: q(0.5),
          p95: q(0.95),
          gpu: +(P.gpuTotalMs / Math.max(P.framesResolved, 1)).toFixed(2),
          draw: per('draw'),
          gbuffer: per('gbuffer'),
          shadow: per('shadow'),
          renderprep: per('renderprep'),
          passes: Object.fromEntries([...P.totalMs].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => [k, +(v / Math.max(P.framesResolved, 1)).toFixed(2)])),
          plants,
        };
      });
      const row = { flora: v, zoom: z, wood: spot.n, ...r };
      rows.push(row);
      R.log(JSON.stringify(row));
    }
    await page.close();
  }
  const safe = String(adapter).replace(/[^a-z0-9]+/gi, '-').slice(0, 40);
  const out = path.join(ROOT, 'data', 'perf', `flora-${safe}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ at, when: new Date().toISOString(), adapter, rows }, null, 2));
  R.log(`wrote ${out}`);
});
