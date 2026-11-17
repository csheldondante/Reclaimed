// Terrain rivers, step 3 (docs/design/TERRAIN_RIVERS.md §10.4, §9.8): the lakes and the river mouths at raised coasts —
// numbers and spots from one atlas build in the viewer, then stills of each spot.
//   node scripts/terrain/step3.mjs --tag on --params "a.rivers2=1" --dir local/terrain3 [--mode ground] [--scales 3,1.2]
// Writes <dir>/<tag>-step3.json (hashes, lakes, falls at the coast, the build's timings) and <dir>/<tag>-<spot>-<k>.png.
// (The viewer renders at half the page's pixels: a still spans 500 × scale world units.)
import fs from 'node:fs';
import { run, sleep } from '../lib/runner.mjs';

await run({ name: 'terrain-step3', kind: 'behaviour', size: '1000x1000' }, async (R) => {
  const tag = R.opt('tag', 'on');
  const dir = R.opt('dir', 'local/terrain3');
  fs.mkdirSync(dir, { recursive: true });
  const p = await R.page();
  await p.goto(`${R.url}/?atlas=view&mode=${R.opt('mode', 'ground')}&overlay=0&${R.opt('params', '')}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.reclaimed?.atlas || document.querySelector('.fatal'), { timeout: 400000, polling: 250 });
  await R.fatal(p);
  await sleep(1500);
  await p.evaluate(() => document.querySelectorAll('#ui > div').forEach((d) => (d.style.display = 'none')));
  const out = await p.evaluate(() => {
    const a = window.reclaimed.atlas;
    const fnv = (arr) => {
      const b = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
      let h = 0x811c9dc5;
      for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 0x01000193) >>> 0;
      return h.toString(16);
    };
    const u = a.riverNodes;
    const f = new Float32Array(u.buffer, u.byteOffset, u.length);
    const W = 8;
    const n = u.length / W;
    const sea = a.p.sea;
    // mouths at a raised coast: the last land node before a still mouth node — its fall to the sea, the ground beside it
    const falls = [];
    for (let k = 0; k < n; k++) {
      const j = u[k * W + 4];
      if (j === k || u[k * W + 5] & 1) continue;
      if (u[j * W + 4] !== j) continue;
      const lv = f[k * W + 2];
      const x = f[k * W];
      const y = f[k * W + 1];
      // (the ground 40 cells to either side across the river: the notch's walls)
      const dx = f[j * W] - x;
      const dy = f[j * W + 1] - y;
      const l = Math.hypot(dx, dy) || 1;
      const g1 = a.macroAt(x - (dy / l) * 40, y + (dx / l) * 40);
      const g2 = a.macroAt(x + (dy / l) * 40, y - (dx / l) * 40);
      falls.push({ x: Math.round(x), y: Math.round(y), fall: +(lv - sea).toFixed(1), notch: +(Math.min(g1, g2) - lv).toFixed(1), width: +f[k * W + 3].toFixed(1) });
    }
    // (the best mouth falls: a real fall first, then a deep notch)
    falls.sort((p, q) => Math.min(q.fall, 40) * 2 + Math.min(q.notch, 60) - (Math.min(p.fall, 40) * 2 + Math.min(p.notch, 60)));
    const fallN = { over3: falls.filter((m) => m.fall > 3).length, over10: falls.filter((m) => m.fall > 10).length, notched20: falls.filter((m) => m.notch > 20).length, both: falls.filter((m) => m.fall > 3 && m.notch > 10).length, mouths: falls.length };
    // (levels never rise downstream: any that do, with their neighbours' flags)
    const rises = [];
    for (let k = 0; k < n && rises.length < 8; k++) {
      const j = u[k * W + 4];
      if (j === k || u[j * W + 4] === j) continue;
      if (f[j * W + 2] > f[k * W + 2] + 1e-4) rises.push({ k, j, lk: +f[k * W + 2].toFixed(2), lj: +f[j * W + 2].toFixed(2), x: Math.round(f[k * W]), y: Math.round(f[k * W + 1]), lavaK: u[k * W + 5], lavaJ: u[j * W + 5], lakeJ: a.lakes.some((L) => L.outflow === j), lakeK: a.lakes.some((L) => L.outflow === k) });
    }
    // (each lake's tier — the landform of its first region — and whether a crater holds it)
    const cr = [];
    const cu = new Uint32Array(a.craters.buffer);
    for (let o = 0; o < a.craters.length; o += 8) if (cu[o + 6] === 0) cr.push([a.craters[o], a.craters[o + 1], a.craters[o + 2]]);
    const lakes = a.lakes.map((L) => {
      const lf = a.landformOf[L.regions[0]];
      const crater = cr.some(([x, y, R]) => Math.hypot(L.at[0] - x, L.at[1] - y) < R * 0.8);
      return { id: L.id, level: L.level, texels: L.texels, depth: L.depth, at: L.at, outlet: L.outlet, tier: lf >= 0 && a.landforms[lf] ? a.landforms[lf].tier : -1, crater, overSea: +(L.level - sea).toFixed(1) };
    });
    const bySize = lakes.slice().sort((p, q) => q.texels - p.texels);
    const plainLake = bySize.find((L) => L.tier === 0 && !L.crater && L.depth < 25) ?? null;
    const craterLake = bySize.find((L) => L.crater) ?? null;
    const lakeN = { all: lakes.length, crater: lakes.filter((L) => L.crater).length, byTier: [0, 1, 2, 3].map((t) => lakes.filter((L) => L.tier === t).length), over20texels: lakes.filter((L) => L.texels >= 20).length, medianTexels: bySize.length ? bySize[bySize.length >> 1].texels : 0 };
    return { hashes: { hmac: fnv(a.hmac), nodes: fnv(a.riverNodes), regionOf: fnv(a.regionOf) }, nodes: n, rises, plainLake, craterLake, lakeN, lakes: lakes.length, walk: a.walkStats ?? null, timings: a.timings, fallN, topFalls: falls.slice(0, 12), bigLakes: lakes.sort((p, q) => q.texels - p.texels).slice(0, 12) };
  });
  R.log(JSON.stringify({ hashes: out.hashes, rises: out.rises, lakeN: out.lakeN, plainLake: out.plainLake, craterLake: out.craterLake, mouth: out.topFalls[0], lakes: out.lakes, fallN: out.fallN, walk: out.walk && { lakesFound: out.walk.lakesFound, lakesPlaced: out.walk.lakesPlaced, lakeJoins: out.walk.lakeJoins, cyclesRefused: out.walk.cyclesRefused, lakeFloated: out.walk.lakeFloated, rises: out.walk.rises, stranded: out.walk.stranded } }));
  fs.writeFileSync(`${dir}/${tag}-step3.json`, JSON.stringify(out, null, 1));
  // stills: --spots "name:x,y;…" or the picks (the biggest lake, the best mouth fall)
  const scales = R.opt('scales', '3,1.2').split(',').map(Number);
  const given = R.opt('spots', '');
  // ("name:x,y" or "name:x,y,s1/s2" — that spot's own scales)
  const spots = given ? given.split(';').filter(Boolean).map((s) => { const [k, v] = s.split(':'); const [x, y, sc] = v.split(','); return { k, x: Number(x), y: Number(y), sc: sc ? sc.split('/').map(Number) : scales }; }) : [];
  if (R.flag('picks') || !given) {
    if (out.plainLake) spots.push({ k: 'lake', x: out.plainLake.at[0], y: out.plainLake.at[1], sc: scales });
    if (out.craterLake) spots.push({ k: 'craterlake', x: out.craterLake.at[0], y: out.craterLake.at[1], sc: scales });
    if (out.topFalls[0]) spots.push({ k: 'mouth', x: out.topFalls[0].x, y: out.topFalls[0].y, sc: scales });
  }
  fs.writeFileSync(`${dir}/${tag}-spots.json`, JSON.stringify(spots, null, 1));
  for (const s of spots)
    for (let i = 0; i < s.sc.length; i++) {
      await p.evaluate((x, y, sc) => {
        window.reclaimed.view.vc = [x, y];
        window.reclaimed.view.scale = sc;
      }, s.x, s.y, s.sc[i]);
      await sleep(1200);
      await p.screenshot({ path: `${dir}/${tag}-${s.k}-${i}.png` });
    }
});
