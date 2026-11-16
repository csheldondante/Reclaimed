// (loop-skeleton round 2; BACKLOG LS-16) The raid's spawn points on the loop's own page: for the town the loop opens on,
// the place table's spawn entries (status, where) read at each camera the loop uses — the leader screen, the town framed
// after the pick, a petition's zoom — with why a refused nominal candidate fails (outside the window, the ground's top
// away from the table's z, water). Prints a line a spawn point a camera; fails when no spawn point is valid at any of
// them (the raid would find no road).
//   node scripts/loopspawn.mjs [--query ...]
import { run } from './lib/runner.mjs';

await run({ name: 'loopspawn', kind: 'behaviour', size: '412x915', dpr: 1, echo: true }, async (R) => {
  const opt = (k, d) => {
    const i = R.argv.indexOf(`--${k}`);
    return i >= 0 ? R.argv[i + 1] : d;
  };
  const query = opt('query', 'skipmenu=1&level=atlas&town=1&loop=1&fresh=1&q=low');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const page = await R.page();
  page.on('console', (m) => {
    const t = m.text();
    if (/^\[(loop|forces)\]/.test(t)) R.log(t.slice(0, 300));
  });
  const phase = (p, ms = 240000) => page.waitForFunction((q) => q.split('|').includes(window.rungame?.phase), { timeout: ms, polling: 200 }, p);
  const read = (label) =>
    page.evaluate(async (label) => {
      const s = window.reclaimed.scene;
      const tc = s.townContracts;
      const g = window.rungame;
      const id = g.season.town;
      const i = tc.townIndex(id);
      const TOWN_WORDS = 42240;
      const words = await tc.debugRead('places', TOWN_WORDS * 4 * (i + 1));
      const f = new Float32Array(words.buffer);
      const o = i * TOWN_WORDS;
      const off = [f[o + 4], f[o + 5], f[o + 6]];
      const dims = s.core.dims;
      const water = await window.reclaimed.readBuffer('water').catch(() => null);
      const wf = water ? new Float32Array(water.buffer ?? water) : null;
      const out = [];
      const names = { 0: 'muster', 1: 'stores', 2: 'barracks', 3: 'market', 4: 'keep' };
      for (let p = 0; p < 23; p++) {
        const e = o + 16 + p * 8;
        const st = words[e + 3];
        if (p >= 5 && p < 15) continue;
        if (st === 1 && p >= 15) continue;
        const why = (x, y, z) => {
          const inWin = x >= 0 && y >= 0 && x < dims.w && y < dims.h;
          const top = inWin ? s.heightAt(x, y) : null;
          const wet = inWin && wf ? wf[Math.floor(y) * dims.w + Math.floor(x)] : null;
          return `(${x.toFixed(0)},${y.toFixed(0)},${z.toFixed(1)}) ${inWin ? 'in' : 'OUT'} top ${top === null ? '-' : top.toFixed(1)} water ${wet === null ? '-' : wet.toFixed(2)}`;
        };
        out.push(`${names[p] ?? `spawn${p - 15}`} status ${['ok', 'none', 'rising', 'water', 'noTown'][st]} at ${why(f[e] + off[0], f[e + 1] + off[1], f[e + 2] + off[2])} approach ${why(f[e + 4] + off[0], f[e + 5] + off[1], f[e + 6] + off[2])}`);
      }
      const t = s.fieldTowns?.live.get(id) ?? g.towns?.live.get(id);
      const c = t?.centreInWindow();
      return { label, town: id, window: `${dims.w}x${dims.h}`, centre: c?.map((v) => Math.round(v)), R: t?.box.R, cam: s.core.camera.target.map((v) => Math.round(v)), zoom: +s.core.camera.zoom.toFixed(2), places: out };
    }, label);
  const show = (r) => {
    R.log(`${r.label}: town ${r.town} window ${r.window} centre ${r.centre} R ${r.R} camera ${r.cam} zoom ${r.zoom}`);
    for (const l of r.places) R.log(`  ${l}`);
    return r.places.some((l) => /^spawn\d status ok/.test(l));
  };

  await page.goto(`${R.url}/?${query}`, { waitUntil: 'load' });
  await phase('leader', 300000);
  await wait(3000);
  const ok = [];
  ok.push(show(await read('leader screen')));
  await page.evaluate(() => window.rungame.pick('ysolt'));
  await phase('city');
  await wait(5000);
  ok.push(show(await read('town framed')));
  await page.evaluate(() => window.rungame.open(window.rungame.run.hand[0].id));
  await wait(5000);
  ok.push(show(await read('petition zoom')));
  await page.evaluate(() => window.rungame.back());
  await wait(5000);
  ok.push(show(await read('back to the town')));
  R.check('a spawn point stands at every camera the loop uses', ok.every(Boolean), JSON.stringify(ok));
});
