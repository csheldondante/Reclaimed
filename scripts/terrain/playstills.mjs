// Terrain rivers, step 2 (TR9): play-zoom stills that can be judged — taken only once the level has finished building
// (the level's own signal: scene.loading() null — "Building the town" over) and the screen is drawn (the tiles' geometric
// coverage check, render/coverage.ts: the share of the screen neither the window nor a tile draws, ≤ 1 % over 8 polls in
// a row). A spot that never gets there is shot anyway and labelled NOT READY in the log and the json — never silently.
// Flag off and on at the same places.
//   node scripts/terrain/playstills.mjs --spots local/terrain2/spots2.json --out local/terrain2/play [--which plain,upland,fall,volcano,town]
//        [--params "a.rivers2=1"] --tag on [--timeout 240000]
// spots json: { name: { at: [x, row], fly?: [x, y, z, lookX, lookY, lookZ], town?: true } }
import fs from 'node:fs';
import { run, sleep } from '../lib/runner.mjs';

await run({ name: 'terrain-playstills', kind: 'behaviour', size: '1200x800' }, async (R) => {
  const out = R.opt('out', 'local/terrain2/play');
  const tag = R.opt('tag', 'on');
  const spots = JSON.parse(fs.readFileSync(R.opt('spots', 'local/terrain2/spots2.json'), 'utf8'));
  const which = (R.opt('which', Object.keys(spots).join(',')) || '').split(',').filter(Boolean);
  const extra = Object.fromEntries((R.opt('params', '') || '').split('&').filter(Boolean).map((kv) => kv.split('=')));
  const limit = Number(R.opt('timeout', '240000'));
  const report = {};
  for (const k of which) {
    const s = spots[k];
    if (!s) continue;
    const params = s.town ? { level: 'atlas', town: '1', loop: '1', fresh: '1', q: 'high', tod: '0.35', ...extra } : { level: 'atlas', q: 'high', tod: '0.35', fresh: '1', at: s.at.join(','), ...extra };
    const p = await R.level(params, { noDefaultQ: true });
    const t0 = Date.now();
    let ready = false;
    let streak = 0;
    let last = null;
    while (Date.now() - t0 < limit) {
      last = await p.evaluate(() => {
        const r = window.reclaimed;
        const loading = r.scene?.loading?.() ?? null;
        const T = r.renderer?.tiles;
        const c = T?.coverCheck ? T.coverCheck(r.camera) : null;
        return { loading, share: c ? +c.share.toFixed(4) : null, chunksUndrawn: c?.chunksUndrawn ?? null, regionsUndrawn: c?.regionsUndrawn ?? null };
      });
      if (!last.loading && last.share !== null && last.share <= 0.01) streak++;
      else streak = 0;
      if (streak >= 8) {
        ready = true;
        break;
      }
      await sleep(500);
    }
    const waited = Math.round((Date.now() - t0) / 1000);
    const info = await p.evaluate(() => {
      const r = window.reclaimed;
      return { origin: r.stream ? [...r.stream.origin] : null, nodes: r.atlas?.riverStats?.nodes ?? null };
    });
    await p.evaluate(() => {
      const ui = document.getElementById('ui');
      if (ui) ui.style.visibility = 'hidden';
    });
    await p.screenshot({ path: `${out}-${tag}-${k}.png` });
    report[k] = { ready, waited, last, ...info };
    R.log(`${k} ${ready ? 'ready' : 'NOT READY'} after ${waited}s ${JSON.stringify(last)} origin ${JSON.stringify(info.origin)}`);
    // (a low view: the free camera at the given point looking at the other — world units)
    if (s.fly) {
      await p.evaluate(async (f) => {
        const [x, y, z, lx, ly, lz] = f;
        const Rc = window.reclaimed;
        Rc.toggleFly();
        await new Promise((r) => setTimeout(r, 500));
        const S = Rc.stream;
        const ox = S.origin[0];
        const oy = S.origin[1] * 0.8660254;
        const oz = S.oz ?? 0;
        Rc.camera.fly.pos = [x - ox, y - oy, z - oz];
        Rc.camera.fly.yaw = Math.atan2(ly - y, lx - x);
        Rc.camera.fly.pitch = Math.atan2(lz - z, Math.hypot(lx - x, ly - y));
        await new Promise((r) => setTimeout(r, 4000));
      }, s.fly);
      await p.screenshot({ path: `${out}-${tag}-${k}-low.png` });
    }
    await p.close();
  }
  fs.writeFileSync(`${out}-${tag}.json`, JSON.stringify(report, null, 1));
});
