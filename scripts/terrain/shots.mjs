// Terrain track: pictures of rivers, falls and cliffs from the atlas level (the deployed page's systems, 1x speed).
// Finds spots from the atlas's river nodes (a tall fall near a cliff, a wide lowland river, a river by a plateau's
// edge), opens the level there and shoots the fixed view (and the free camera beside the spot).
//   node scripts/terrain/shots.mjs [--server URL] [--spots '{"fall":[6108,14009]}'] --out C:/Projects/shots88/terrain/base [--which fall,wide] [--wait 35000] [--size 1200x800]
import { run, sleep } from '../lib/runner.mjs';

await run({ name: 'terrain-shots', kind: 'behaviour', size: '1200x800' }, async (R) => {
  const out = R.opt('out', 'C:/Projects/shots88/terrain/shot');
  const which = R.opt('which', 'fall,wide,mid').split(',');
  const wait = Number(R.opt('wait', '35000'));
  const extra = Object.fromEntries((R.opt('params', '') || '').split('&').filter(Boolean).map((kv) => kv.split('=')));
  // (--spots '{"fall":[x,y],…}': the same places as an earlier run — the rivers' nodes move as their shape changes)
  const given = R.opt('spots', null);
  const p0 = given ? null : await R.level({ level: 'atlas', ...extra });
  const spots = given ? Object.fromEntries(Object.entries(JSON.parse(given)).map(([k, at]) => [k, { at }])) : await p0.evaluate(() => {
    const a = window.reclaimed.atlas;
    const u = a.riverNodes;
    const f = new Float32Array(u.buffer, u.byteOffset, u.length);
    const W = 8;
    const n = u.length / W;
    const warmAt = (y) => 0.5 - 0.5 * Math.cos((2 * Math.PI * y) / a.worldH);
    let fall = null, wide = null, mid = null;
    for (let k = 0; k < n; k++) {
      const o = k * W;
      const next = u[o + 4];
      if (u[o + 5] & 1) continue;
      const drop = f[o + 2] - f[next * W + 2];
      const warm = warmAt(f[o + 1]);
      const temperate = warm > 0.45 && warm < 0.85;
      const at = [Math.floor(f[o]), Math.floor(f[o + 1] / 0.866)];
      if (temperate && drop > 20 && (!fall || drop > fall.drop)) fall = { at, drop: +drop.toFixed(1), w: +f[o + 3].toFixed(1) };
      if (temperate && f[o + 2] > a.p.sea + 6 && (!wide || f[o + 3] > wide.w)) wide = { at, w: +f[o + 3].toFixed(1) };
      if (temperate && f[o + 3] > 5 && f[o + 3] < 7 && f[o + 2] > a.p.sea + 20 && drop < 1 && !mid) mid = { at, w: +f[o + 3].toFixed(1) };
    }
    // cliffs facing the view (the high side up the screen, the low side below it, dry land): the plateaus' feet, where
    // caves open (round 117, terrain/cave.wgsl)
    const tn = a.p.n;
    const h = a.hmac;
    const cliffs = [];
    for (let ty = 8; ty < tn - 8 && cliffs.length < 4; ty += 3)
      for (let tx = 8; tx < tn - 8 && cliffs.length < 4; tx += 3) {
        const t = ty * tn + tx;
        const lo = h[t + 3 * tn];
        if (h[t] - lo > 35 && lo > a.p.sea + 8 && h[t + 6 * tn] - lo < 4 && warmAt(((ty + 0.5) / tn) * a.worldH) > 0.45 && cliffs.every((c) => Math.hypot(c[0] - tx, c[1] - ty) > 200)) cliffs.push([tx, ty]);
      }
    const cl = (i) => cliffs[i] && { at: [Math.floor(((cliffs[i][0] + 0.5) / tn) * a.worldW), Math.floor((((cliffs[i][1] + 4) / tn) * a.worldH) / 0.866)] };
    // gorges (round 117, terrain/gorge.wgsl): a plateau's texel well under the plateau a few texels either side
    const gorges = [];
    const plat = (t) => {
      const lf = a.landformOf[a.regionOf[t]];
      return lf >= 0 && a.landforms[lf]?.tier === 2;
    };
    for (let ty = 8; ty < tn - 8 && gorges.length < 3; ty += 2)
      for (let tx = 8; tx < tn - 8 && gorges.length < 3; tx += 2) {
        const t = ty * tn + tx;
        if (!plat(t) || !plat(t - 5) || !plat(t + 5)) continue;
        if (h[t - 5] - h[t] > 25 && h[t + 5] - h[t] > 25 && warmAt(((ty + 0.5) / tn) * a.worldH) > 0.4 && gorges.every((c) => Math.hypot(c[0] - tx, c[1] - ty) > 300)) gorges.push([tx, ty]);
      }
    const gg = (i) => gorges[i] && { at: [Math.floor(((gorges[i][0] + 0.5) / tn) * a.worldW), Math.floor((((gorges[i][1] + 0.5) / tn) * a.worldH) / 0.866)] };
    // sea cliffs facing the view: land 30+ over the sea, the sea a few texels below it on the screen
    const seas = [];
    for (let ty = 8; ty < tn - 8 && seas.length < 3; ty += 3)
      for (let tx = 8; tx < tn - 8 && seas.length < 3; tx += 3) {
        const t = ty * tn + tx;
        if (h[t] - a.p.sea > 30 && h[t + 3 * tn] < a.p.sea - 2 && h[t + 6 * tn] < a.p.sea - 2 && warmAt(((ty + 0.5) / tn) * a.worldH) > 0.45 && seas.every((c) => Math.hypot(c[0] - tx, c[1] - ty) > 200)) seas.push([tx, ty]);
      }
    const sc = (i) => seas[i] && { at: [Math.floor(((seas[i][0] + 0.5) / tn) * a.worldW), Math.floor((((seas[i][1] + 4) / tn) * a.worldH) / 0.866)] };
    return { fall, wide, mid, cliff0: cl(0), cliff1: cl(1), cliff2: cl(2), cliff3: cl(3), gorge0: gg(0), gorge1: gg(1), gorge2: gg(2), sea0: sc(0), sea1: sc(1), sea2: sc(2) };
  });
  R.log(JSON.stringify(spots));
  await p0?.close();
  for (const k of which) {
    const s = spots[k];
    if (!s) continue;
    const p = await R.level({ level: 'atlas', q: R.opt('q', 'high'), tod: '0.35', at: s.at.join(','), ...extra });
    await sleep(wait);
    // (the roads near the spot: a river's reshaping moves the macro ground the roads are planned on)
    const roads = await p.evaluate((at) => {
      const a = window.reclaimed.atlas;
      const x = at[0] + 0.5;
      const y = at[1] * 0.8660254;
      let n = 0;
      let near = 1e9;
      for (const r of a.settlement.roads)
        for (let i = 0; i < r.path.length; i += 2) {
          const d = Math.hypot(r.path[i] - x, r.path[i + 1] - y);
          near = Math.min(near, d);
          if (d < 200) n++;
        }
      return { pointsWithin200: n, nearest: Math.round(near) };
    }, s.at);
    R.log(`${k} roads: ${JSON.stringify(roads)}`);
    await p.evaluate(() => {
      const ui = document.getElementById('ui');
      if (ui) ui.style.visibility = 'hidden';
    });
    await p.screenshot({ path: `${out}-${k}.png` });
    // (--fly "x,y,z,lookX,lookY,lookZ": world units; the free camera there, looking at the second point — a cave's mouth)
    const fly = R.opt('fly', null);
    if (fly) {
      const st = await p.evaluate(async (f) => {
        const [x, y, z, lx, ly, lz] = f.split(',').map(Number);
        const Rc = window.reclaimed;
        Rc.toggleFly();
        const S = Rc.stream;
        const ox = S.origin[0];
        const oy = S.origin[1] * 0.8660254;
        const oz = S.oz ?? 0;
        Rc.camera.fly.pos = [x - ox, y - oy, z - oz];
        Rc.camera.fly.yaw = Math.atan2(ly - y, lx - x);
        Rc.camera.fly.pitch = Math.atan2(lz - z, Math.hypot(lx - x, ly - y));
        await new Promise((r) => setTimeout(r, 3000));
        return { origin: [ox, oy], oz };
      }, fly);
      R.log(`fly ${JSON.stringify(st)}`);
      await p.screenshot({ path: `${out}-${k}-fly.png` });
    }
    R.log(`${out}-${k}.png`);
  }
});
