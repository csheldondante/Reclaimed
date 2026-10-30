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
    return { fall, wide, mid };
  });
  R.log(JSON.stringify(spots));
  await p0?.close();
  for (const k of which) {
    const s = spots[k];
    if (!s) continue;
    const p = await R.level({ level: 'atlas', q: R.opt('q', 'high'), tod: '0.35', at: s.at.join(','), ...extra });
    await sleep(wait);
    await p.evaluate(() => {
      const ui = document.getElementById('ui');
      if (ui) ui.style.visibility = 'hidden';
    });
    await p.screenshot({ path: `${out}-${k}.png` });
    R.log(`${out}-${k}.png`);
  }
});
