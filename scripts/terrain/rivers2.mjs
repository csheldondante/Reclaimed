// Terrain rivers, step 1 (docs/design/TERRAIN_RIVERS.md): one atlas build in the atlas viewer, its numbers and stills.
//   node scripts/terrain/rivers2.mjs --tag off|on [--params "a.rivers2=1"] --dir local/terrain1
//        [--shots "name:x,y,unitsPerPixel;…"] (default: the whole map) [--rows "name:x0,row,w;…"] (columns along a row)
//        [--river k] (the long profile of the river through node k; default: the longest water river)
// Writes <dir>/<tag>-stats.json (timings, river stats, falls, levee probe) and <dir>/<tag>-<name>.png.
import fs from 'node:fs';
import { run, sleep } from '../lib/runner.mjs';

await run({ name: 'terrain-rivers2', kind: 'behaviour', size: '1000x1000' }, async (R) => {
  const tag = R.opt('tag', 'off');
  const dir = R.opt('dir', 'local/terrain1');
  fs.mkdirSync(dir, { recursive: true });
  const extra = R.opt('params', '');
  const p = await R.page();
  await p.goto(`${R.url}/?atlas=view&mode=${R.opt('mode', 'ground')}&overlay=0&${extra}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.atlas || document.querySelector('.fatal'), { timeout: 400000, polling: 250 });
  await R.fatal(p);
  await sleep(1500);
  await p.evaluate(() => document.querySelectorAll('#ui > div').forEach((d) => (d.style.display = 'none')));
  const stats = await p.evaluate(() => {
    const a = window.reclaimed.atlas;
    const u = a.riverNodes;
    const f = new Float32Array(u.buffer, u.byteOffset, u.length);
    const W = 8;
    const n = u.length / W;
    let water = 0, lava = 0, up = 0, f35 = 0, f12 = 0, f30 = 0, maxFall = 0, sumFall = 0;
    for (let k = 0; k < n; k++) {
      const o = k * W;
      const nx = u[o + 4];
      if (u[o + 5] & 1) lava++;
      else water++;
      if (nx === k) continue;
      const d = f[o + 2] - f[nx * W + 2];
      if (d < -0.01) up++;
      if (u[o + 5] & 1) continue;
      if (d >= 3.49) f35++;
      if (d > 12) f12++;
      if (d > 30) f30++;
      if (d > maxFall) maxFall = d;
      if (d >= 3.49) sumFall += d;
    }
    const cu = new Uint32Array(a.craters.buffer);
    const volcanoes = [];
    for (let o = 0; o < a.craters.length; o += 8) if (cu[o + 6] === 4) volcanoes.push([Math.round(a.craters[o]), Math.round(a.craters[o + 1]), Math.round(a.craters[o + 2]), Math.round(a.craters[o + 3])]);
    return { walk: a.walkStats ?? null, volcanoes, timings: a.timings, riverStats: a.riverStats, nodes: n, water, lava, risesDownstream: up, falls: { over3_5: f35, over12: f12, over30: f30, max: +maxFall.toFixed(1), meanOver3_5: +(sumFall / Math.max(1, f35)).toFixed(1) }, lakes: a.lakes.length, sites: a.settlement.sites.length, worldW: a.worldW, worldH: a.worldH, n: a.p.n };
  });
  R.log(JSON.stringify(stats));
  // --pick: places to look at, from this world's rivers (a lowland river, the tallest temperate fall, a volcano)
  if (R.flag('pick')) {
    const spots = await p.evaluate(() => {
      const a = window.reclaimed.atlas;
      const u = a.riverNodes;
      const f = new Float32Array(u.buffer, u.byteOffset, u.length);
      const W = 8;
      const n = u.length / W;
      const tn = a.p.n;
      const tierAt = (x, y) => {
        const t = (Math.floor((y / a.worldH) * tn) % tn) * tn + (Math.floor((x / a.worldW) * tn) % tn);
        const lf = a.landformOf[a.regionOf[t]];
        return lf >= 0 ? a.landforms[lf].tier : -1;
      };
      const warmAt = (y) => 0.5 - 0.5 * Math.cos((2 * Math.PI * y) / a.worldH);
      let plain = null, fall = null;
      for (let k = 0; k < n; k++) {
        const o = k * W;
        if (u[o + 5] & 1) continue;
        const nx = u[o + 4];
        const x = f[o], y = f[o + 1];
        const warm = warmAt(y);
        if (warm < 0.45 || warm > 0.85) continue;
        const drop = f[o + 2] - f[nx * W + 2];
        if (!plain && tierAt(x, y) === 0 && f[o + 3] > 7 && f[o + 3] < 10 && f[o + 2] > a.p.sea + 12 && drop < 0.5) plain = { x: Math.round(x), y: Math.round(y), w: f[o + 3] };
        if (f[nx * W + 2] > a.p.sea + 5 && (!fall || drop > fall.drop)) fall = { x: Math.round(x), y: Math.round(y), drop: +drop.toFixed(1), level: +f[o + 2].toFixed(1) };
      }
      const cu = new Uint32Array(a.craters.buffer);
      let volcano = null;
      for (let o = 0; o < a.craters.length && !volcano; o += 8) if (cu[o + 6] === 4) volcano = { x: Math.round(a.craters[o]), y: Math.round(a.craters[o + 1]), R: Math.round(a.craters[o + 2]) };
      return { plain, fall, volcano };
    });
    R.log('spots', JSON.stringify(spots));
    fs.writeFileSync(`${dir}/spots.json`, JSON.stringify(spots, null, 1));
  }
  // --levee: the ground of 16×16 columns round sampled water nodes (compare a ?levee=0 run with a levee run: the
  // columns the levee raised; the page needs &rivers=table)
  if (R.flag('levee')) {
    stats.levee = await p.evaluate(async () => {
      const a = window.reclaimed.atlas;
      const u = a.riverNodes;
      const f = new Float32Array(u.buffer, u.byteOffset, u.length);
      const W = 8;
      const n = u.length / W;
      const out = [];
      const stride = Math.max(1, Math.floor(n / 240));
      for (let k = 0; k < n && out.length < 240; k += stride) {
        const o = k * W;
        if (u[o + 5] & 1 || f[o + 2] < a.p.sea + 2 || u[o + 4] === k) continue;
        const x0 = Math.floor(f[o]) - 8;
        const y0 = Math.floor(f[o + 1] / 0.8660254) - 8;
        const c = await a.columns(x0, y0, 16, 16);
        const g = [];
        let rcols = 0;
        for (let i = 0; i < 256; i++) {
          g.push(+c.f[i * 16 + 11].toFixed(2));
          if (c.f[i * 16 + 15] > 0) rcols++;
        }
        out.push({ k, g, rcols });
      }
      return out;
    });
  }
  const spotsFile = R.opt('spots', null);
  if (spotsFile) {
    const s = JSON.parse(fs.readFileSync(spotsFile, 'utf8'));
    const views = [];
    if (s.plain) views.push(`plain:${s.plain.x},${s.plain.y},0.6`, `plainwide:${s.plain.x},${s.plain.y},2.5`);
    if (s.fall) views.push(`fall:${s.fall.x},${s.fall.y},0.6`, `fallwide:${s.fall.x},${s.fall.y},2.5`);
    if (s.volcano) views.push(`volcano:${s.volcano.x},${s.volcano.y},1.6`);
    R.argv.push('--shots', `map:fit;${views.join(';')}`);
    const rows = [];
    if (s.plain) rows.push(`plain:${s.plain.x - 200},${Math.round(s.plain.y / 0.8660254)},400`);
    if (s.fall) rows.push(`fall:${s.fall.x - 200},${Math.round(s.fall.y / 0.8660254)},400`);
    if (s.volcano) rows.push(`volcano:${s.volcano.x - s.volcano.R - 100},${Math.round(s.volcano.y / 0.8660254)},${2 * s.volcano.R + 200}`);
    R.argv.push('--rows', rows.join(';'));
  }
  const shots = (R.opt('shots', 'map:fit') || '').split(';').filter(Boolean);
  for (const s of shots) {
    const [name, v] = s.split(':');
    await p.evaluate((v) => {
      const view = window.reclaimed.view;
      const a = window.reclaimed.atlas;
      if (v === 'fit') {
        view.vc = [a.worldW / 2, a.worldH / 2];
        view.scale = Math.max(a.worldW, a.worldH) / 1000;
      } else {
        const [x, y, sc] = v.split(',').map(Number);
        view.vc = [x, y];
        view.scale = sc;
      }
    }, v);
    await sleep(1200);
    await p.screenshot({ path: `${dir}/${tag}-${name}.png` });
  }
  // cross-sections: columns along a row (exact ground, the streamed columns' own)
  const rows = (R.opt('rows', '') || '').split(';').filter(Boolean);
  stats.rows = {};
  for (const s of rows) {
    const [name, v] = s.split(':');
    const [x0, row, w] = v.split(',').map(Number);
    stats.rows[name] = await p.evaluate(async (x0, row, w) => {
      const a = window.reclaimed.atlas;
      const c = await a.columns(x0, row, w, 2);
      const out = { x0, row, ground: [], water: [], rd: [] };
      for (let i = 0; i < w; i++) {
        out.ground.push(+c.f[i * 16 + 11].toFixed(2));
        out.water.push(+c.f[i * 16 + 3].toFixed(2));
        out.rd.push(+c.f[i * 16 + 15].toFixed(2));
      }
      return out;
    }, x0, row, w);
  }
  // the long profile: from a source down to the sea along `next` (levels, and the macro ground under each node)
  stats.long = await p.evaluate((pick) => {
    const a = window.reclaimed.atlas;
    const u = a.riverNodes;
    const f = new Float32Array(u.buffer, u.byteOffset, u.length);
    const W = 8;
    const n = u.length / W;
    const hasUp = new Uint8Array(n);
    for (let k = 0; k < n; k++) if (u[k * W + 4] !== k) hasUp[u[k * W + 4]] = 1;
    const path = (k) => {
      const out = [k];
      while (u[k * W + 4] !== k && out.length < 5000) out.push((k = u[k * W + 4]));
      return out;
    };
    let best = null;
    if (pick >= 0) best = path(pick);
    else
      for (let k = 0; k < n; k++) {
        if (hasUp[k] || u[k * W + 5] & 1) continue;
        const pth = path(k);
        const drop = f[k * W + 2] - f[pth[pth.length - 1] * W + 2];
        if (!best || drop * Math.sqrt(pth.length) > best.score) best = Object.assign(pth, { score: drop * Math.sqrt(pth.length) });
      }
    if (!best) return null;
    let s = 0;
    const pts = [];
    for (let i = 0; i < best.length; i++) {
      const k = best[i];
      if (i) s += Math.hypot(f[k * W] - f[best[i - 1] * W], f[k * W + 1] - f[best[i - 1] * W + 1]);
      pts.push([+s.toFixed(1), +f[k * W + 2].toFixed(2), +a.macroAt(f[k * W], f[k * W + 1]).toFixed(2), Math.round(f[k * W]), Math.round(f[k * W + 1])]);
    }
    return { source: best[0], pts };
  }, Number(R.opt('river', '-1')));
  fs.writeFileSync(`${dir}/${tag}-stats.json`, JSON.stringify(stats, null, 1));
});
