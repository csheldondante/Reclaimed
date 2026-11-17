// (loop round 9) The street strip: the same town from the same cameras at phone size, so a change to the streets, the
// units or the buildings is judged against the one before. Three stills (and a fourth, later in the parade):
//   town  — the whole town over the sheet (the loop's own `showTown`, 60°)
//   street — the market at the parade's zoom (16) and pitch (55°)
//   parade — `gate-parade` played now (`rungame.measureEvent`), its own camera, `--at` seconds in (and `--at2`)
//   node scripts/lab/streetshots.mjs --out <dir> --tag before [--walls] [--params "&parade=30"] [--at 22] [--at2 40]
// `--walls`: the town's ring raised at once first (citygen.wallStart + wallStage(0, 1, at once)), as a walls card does.
// `--event`: another live event in place of the parade (the raid: `--event raid`).
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../lib/runner.mjs';

await run({ name: 'streetshots', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const out = R.opt('out', 'streetshots');
  const tag = R.opt('tag', 'shot');
  const walls = R.flag('walls');
  const ev = R.opt('event', 'gate-parade');
  const at = Number(R.opt('at', '22'));
  const at2 = Number(R.opt('at2', '40'));
  const name = (k) => path.join(out, `${tag}${walls ? '-walls' : ''}-${k}.png`);
  fs.mkdirSync(out, { recursive: true });
  const p = await R.page();
  p.on('console', (m) => {
    const t = m.text();
    if (/^\[(live|loop|forces|streets)\]/.test(t)) R.log(t.slice(0, 300));
  });
  await p.goto(`${R.url}/?skipmenu=1&level=atlas&town=1&loop=1&fresh=1&q=low&warmcache=0${R.opt('params', '')}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.rungame?.phase === 'leader' || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(p);
  await p.evaluate(() => (window.rungame.pick('ysolt'), window.rungame.closePanel()));
  await p.waitForFunction(() => window.rungame.phase === 'city', { timeout: 60000, polling: 250 });
  await R.sleep(3000);
  if (walls) {
    const ok = await p.evaluate(() => {
      const id = [...window.citygen.live.keys()][0];
      return window.citygen.wallStart(id) && window.citygen.wallStage(id, 0, 1, true);
    });
    R.check('walls raised', ok);
    await R.sleep(6000);
  }
  const town = await p.evaluate(() => {
    const t = [...window.citygen.live.values()][0];
    const p = t?.params ?? {};
    return { id: t?.site.id, R: t?.box.R, roads: t?.roadCount, lots: t?.times?.lots, verts: t?.times?.verts, gpuMs: t?.times?.total, stages: t?.times?.stage, widths: [p.majorWidth, p.minorWidth, p.artWidth], blockLen: p.blockLen, maxLot: p.maxLot, plazaR: p.plazaR };
  });
  R.log(`town ${JSON.stringify(town)}`);
  // the whole town
  await p.evaluate(() => {
    window.reclaimed.core.camera.elevation = Math.PI / 3;
    window.rungame.showTown();
  });
  await R.sleep(3500);
  await R.fatal(p);
  await p.screenshot({ path: name('town') });
  // (`--quick`: the overview and the numbers only — a parameter's trial)
  if (R.flag('quick')) return;
  // the market up close at the parade's zoom and pitch
  await p.evaluate(() => {
    window.reclaimed.core.camera.elevation = (55 * Math.PI) / 180;
    window.rungame.lookAt('market', 16);
  });
  await R.sleep(3500);
  await R.fatal(p);
  await p.screenshot({ path: name('street') });
  // the parade (or another event), its own camera
  const ok = await p.evaluate((t) => window.rungame.measureEvent(t), ev);
  R.check(`${ev} begun`, ok);
  const view = () =>
    p.evaluate(() => {
      const r = window.rungame.liveDebug().runs[0];
      const figs = window.rungame.deadAt();
      const on = figs.filter(([x, y]) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight);
      return { phase: window.rungame.phase, zoom: +window.reclaimed.camera.zoom.toFixed(1), t: r?.t, step: r?.entry?.step, figures: figs.length, onScreen: on.length, spread: figs.length ? [Math.round(Math.min(...figs.map((f) => f[0]))), Math.round(Math.max(...figs.map((f) => f[0]))), Math.round(Math.min(...figs.map((f) => f[1]))), Math.round(Math.max(...figs.map((f) => f[1])))] : null, arrived: r && Object.fromEntries(Object.entries(r.state.groups).map(([k, g]) => [k, `${g.alive}/${g.made}${g.arrived ? ' arrived' : ''}`])) };
    });
  await R.sleep(at * 1000);
  await R.fatal(p);
  R.log(`${ev} at ${at}s: ${JSON.stringify(await view())}`);
  await p.screenshot({ path: name(ev === 'gate-parade' ? 'parade' : ev) });
  if (at2 > at) {
    await R.sleep((at2 - at) * 1000);
    await R.fatal(p);
    R.log(`${ev} at ${at2}s: ${JSON.stringify(await view())}`);
    await p.screenshot({ path: name(`${ev === 'gate-parade' ? 'parade' : ev}2`) });
  }
});
