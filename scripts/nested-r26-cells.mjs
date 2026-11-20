// Nested scales (round 26, step A): the field mesh's sparse selection on the generated terrain, per level. Opens the four
// levels over the root window's steepest step (as r25's zoom-L3 pose) and runs the CPU reference (fieldsel.ts, through
// nested.fieldCells: a readback) on every live window: candidate cells and crossed cells a cell column.
// node scripts/nested-r26-cells.mjs --chromeargs ignore-certificate-errors --port 5461 [--warp 0.45] [--margin 0]
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'r26-cells', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`[page ${m.type()}] ${m.text()}`);
  });
  await page.goto(`https://localhost:${port}/nested.html?smooth=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.pipesReady && nested.app.genReady && nested.app.frameCount > 30, { timeout: 300000, polling: 200 });
  const spot = await page.evaluate(async () => {
    const a = nested.app;
    const s = await a.nest.readAll();
    const w = a.nest.wins[0];
    const top = (X, Y) => {
      const c = s.column(0, X, Y);
      return c.z1[c.z1.length - 1];
    };
    let best = { x: 0, y: 0, step: 0, dir: [1, 0] };
    for (let y = w.gy + 40; y < w.gy + w.n - 40; y++)
      for (let x = w.gx + 40; x < w.gx + w.n - 40; x++)
        for (const d of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
          const st = top(x, y) - top(x + d[0], y + d[1]);
          if (st > best.step) best = { x, y, step: st, dir: d };
        }
    return best;
  });
  // (--at centre: the root window's centre, the default view's ground, instead of the steepest step)
  const centre = R.opt('at', 'step') === 'centre';
  const w0 = await page.evaluate(() => nested.app.nest.wins[0]);
  const zx = centre ? w0.gx + w0.n / 2 : spot.x + 0.5 - spot.dir[0] * 1.5;
  const zy = centre ? w0.gy + w0.n / 2 : spot.y + 0.5 - spot.dir[1] * 1.5;
  console.log(centre ? 'at the root window centre' : `at the steepest step (${(spot.step * 128).toFixed(0)} m over a root column)`);
  await page.evaluate((v) => nested.setView(v), { tx: zx, ty: zy, d: 0.3 * 0.5, pitch: 0.95, yaw: Math.atan2(spot.dir[1], spot.dir[0]) + 0.5 });
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const st = await page.evaluate(() => ({ live: nested.app.nest.live, settled: nested.app.nest.settled }));
    if (st.live === 4 && st.settled && i > 8) break;
  }
  // (held still: the levels' ops stop while the readback is taken)
  await page.evaluate(() => (nested.app.frozen = true));
  await sleep(1500);
  if (R.opt('debug', '0') === '1') {
    const d = await page.evaluate(async () => {
      const a = nested.app;
      const s = await a.nest.readAll();
      const L = a.nest.live - 1;
      const w = a.nest.wins[L];
      const out = { L, w, zo: s.zOrigin(L), cols: [] };
      for (const [dx, dy] of [[128, 128], [100, 60], [30, 200]]) out.cols.push({ X: w.gx + dx, Y: w.gy + dy, rec: s.records(L, w.gx + dx, w.gy + dy), rec1: s.records(L, w.gx + dx + 1, w.gy + dy) });
      return out;
    });
    console.log(JSON.stringify(d));
  }
  for (const warp of [0, Number(R.opt('warp', '0.45'))]) {
    const t = Date.now();
    const rows = await page.evaluate((o) => nested.fieldCells(o.warp, o.margin, true), { warp, margin: Number(R.opt('margin', '0')) });
    for (const r of rows) console.log(`warp ${warp}: level ${r.level}: ${r.cols} cell columns, candidate cells ${r.perCol.toFixed(2)} a column (max ${r.maxSel}), crossed ${r.crossedPerCol.toFixed(2)} a column`);
    console.log(`(${((Date.now() - t) / 1000).toFixed(1)} s)`);
  }
});
