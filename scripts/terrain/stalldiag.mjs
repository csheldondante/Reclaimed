// Terrain perf (TR24): why a play-zoom spot never finishes drawing — poll the coverage check's undrawn pieces and,
// for each region, the tile cache's why (whyMissing), with the render-only land maker's counters and the frame time,
// every --every ms for --secs. Flag off and on at the same spot.
//   node scripts/terrain/stalldiag.mjs --at 13629,6487 [--params "a.rivers2=1"] [--secs 90] [--every 3000] [--json out.json]
import fs from 'node:fs';
import { run, sleep } from '../lib/runner.mjs';

await run({ name: 'terrain-stalldiag', kind: 'behaviour', size: '1200x800' }, async (R) => {
  const at = R.opt('at', '13629,6487');
  const extra = Object.fromEntries((R.opt('params', '') || '').split('&').filter(Boolean).map((kv) => kv.split('=')));
  const secs = Number(R.opt('secs', '90'));
  const every = Number(R.opt('every', '3000'));
  const p = await R.level({ level: 'atlas', q: 'high', tod: '0.35', fresh: '1', at, ...extra }, { noDefaultQ: true });
  const t0 = Date.now();
  const rows = [];
  while (Date.now() - t0 < secs * 1000) {
    const row = await p.evaluate(() => {
      const r = window.reclaimed;
      const T = r.renderer?.tiles;
      const c = T?.coverCheck ? T.coverCheck(r.camera) : null;
      const L = T?.land;
      const why = {};
      for (const u of c?.undrawn ?? []) {
        if (u[0] !== 'r') continue;
        const [rx, ry] = u.slice(1).split(',').map(Number);
        const w = T.whyMissing(rx * 64 - T.origin[0], ry * 64 - T.origin[1], r.camera.azimuth);
        why[w] = (why[w] ?? 0) + 1;
      }
      // (an undrawn window chunk: the window's drawn state for it, its region's tile — kept? its skip? drawn?)
      const chunks = {};
      const wd = T?.host?.windowDrawn?.();
      const grid = T?.host?.win?.mesh?.chunkGrid;
      for (const u of c?.undrawn ?? []) {
        if (u[0] !== 'c' || !grid) continue;
        const [cx, cy] = u.slice(1).split(',').map(Number);
        const side = grid[2];
        const rx = Math.floor(T.origin[0] / 64) + Math.floor((cx * side) / 64);
        const ry = Math.floor(T.origin[1] / 64) + Math.floor((cy * side) / 64);
        const t = T.tiles.get(T.key(rx, ry, r.camera.azimuth));
        chunks[u] = { wd: wd ? wd[cy * grid[0] + cx] : null, region: `${rx},${ry}`, tile: t ? { skip: t.skip ?? null, gpu: !!t.gpu, stale: !!t.stale } : null, drawn: T.drawnSet.has(`${rx},${ry}`), land: L?.stateOf?.(`${rx},${ry}`) ?? null };
      }
      // (the coverage check's CPU time a call — tilecache wanted() runs it every frame)
      const t0 = performance.now();
      for (let k = 0; k < 50; k++) T?.coverCheck?.(r.camera);
      const coverMs = +((performance.now() - t0) / 50).toFixed(3);
      const prof = r.renderer?.profiler;
      return {
        loading: r.scene?.loading?.() ?? null,
        share: c ? +c.share.toFixed(4) : null,
        chunksUndrawn: c?.chunksUndrawn ?? null,
        regionsUndrawn: c?.regionsUndrawn ?? null,
        undrawn: (c?.undrawn ?? []).slice(0, 10),
        why,
        coverMs,
        chunks,
        land: L ? { ...L.stats, wanted: L.firstWanted?.size ?? null } : null,
        tiles: T ? T.tiles.size : null,
        frameMs: prof?.frameMs ?? prof?.cpuMs ?? null,
      };
    });
    row.t = Math.round((Date.now() - t0) / 1000);
    rows.push(row);
    R.log(JSON.stringify(row));
    await sleep(every);
  }
  const out = R.opt('json', '');
  if (out) fs.writeFileSync(out, JSON.stringify(rows, null, 1));
  await p.close();
});
