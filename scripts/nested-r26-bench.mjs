// Nested scales (round 26, step B): the field mesh against the sheets, back to back in one session. For each variant
// (sheets: ?smooth=1; field: ?smooth=1&field=<L>) a fresh page, the same pose (the root window's steepest step, zoomed
// to level L open, or --at centre), then: the whole window of level L baked again (forced; a warm-up first, then
// --reps timed), a carve at level L's window centre (benchEdit: GPU ms with and without the bakes), the draw alone
// (benchDraw) and a frame (benchFrame), and a still to local/nested/r26-bench-<variant>.png.
// node scripts/nested-r26-bench.mjs --chromeargs ignore-certificate-errors --port 5461 [--level 3] [--at step|centre]
//   [--order sheets,field,sheets,field] [--extra "&warp=0"]
import { run, sleep } from './lib/runner.mjs';
import fs from 'node:fs';

await run({ name: 'r26-bench', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const L = Number(R.opt('level', '3'));
  const at = R.opt('at', 'step');
  const reps = Number(R.opt('reps', '3'));
  const extra = R.opt('extra', '');
  const order = R.opt('order', 'sheets,field').split(',');
  fs.mkdirSync('local/nested', { recursive: true });
  const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const out = [];
  for (const variant of order) {
    const page = await R.page();
    page.on('console', (m) => {
      if (m.type() === 'error' || m.text().startsWith('[field]')) console.log(`[page ${m.type()}] ${m.text()}`);
    });
    // (a variant "field~&warp=0" adds its own URL dials)
    const [kind, vx = ''] = variant.split('~');
    const url = `https://localhost:${port}/nested.html?smooth=1${kind === 'field' ? `&field=${L}` : ''}${extra}${vx}`;
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.nested && nested.app.pipesReady && nested.app.genReady && nested.app.fieldDone && nested.app.frameCount > 30, { timeout: 300000, polling: 200 });
    const pose = await page.evaluate(async (at) => {
      const a = nested.app;
      const w = a.nest.wins[0];
      if (at === 'centre') return { x: w.gx + w.n / 2, y: w.gy + w.n / 2, dir: [1, 0] };
      const s = await a.nest.readAll();
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
      return { x: best.x + 0.5 - best.dir[0] * 1.5, y: best.y + 0.5 - best.dir[1] * 1.5, dir: best.dir };
    }, at);
    const dz = [0.9 * 32, 0.3 * 32, 0.3 * 4, 0.3 * 0.5][L];
    await page.evaluate((v) => nested.setView(v), { tx: pose.x, ty: pose.y, d: dz, pitch: 0.95, yaw: Math.atan2(pose.dir[1], pose.dir[0]) + 0.5 });
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      const st = await page.evaluate(() => ({ live: nested.app.nest.live, settled: nested.app.nest.settled }));
      if (st.live === L + 1 && st.settled && i > 12) break;
    }
    await sleep(1500);
    await page.evaluate(() => (nested.app.frozen = true));
    await sleep(500);
    const file = `local/nested/r26-bench-${variant.replace(/[^a-z0-9]+/gi, '_')}-L${L}-${at}.png`;
    await page.screenshot({ path: file });
    const r = await page.evaluate(
      async ({ L, reps }) => {
        const a = nested.app;
        const w = a.nest.wins[L];
        const bake = [];
        await nested.benchBake(L);
        for (let i = 0; i < reps; i++) bake.push(await nested.benchBake(L));
        const draw = [];
        const frame = [];
        for (let i = 0; i < reps; i++) {
          draw.push(await nested.benchDraw(20));
          frame.push(await nested.benchFrame(20));
        }
        // a carve at the window's centre, about 8 columns of level L across
        const edits = [];
        for (let i = 0; i < reps; i++) edits.push(await nested.benchEdit({ op: 'carve', radius: 8 / a.k ** L, amount: 1, at: { level: L, x: w.n / 2 + 0.5 + i * 3, y: w.n / 2 + 0.5 } }));
        await new Promise((r) => setTimeout(r, 500));
        return { bake, draw, frame, edits, stats: { ...a.nest.stats }, live: a.nest.live };
      },
      { L, reps },
    );
    const row = {
      variant,
      bake: med(r.bake),
      draw: med(r.draw),
      frame: med(r.frame),
      carve: med(r.edits.map((e) => e.withBake)),
      carveNoBake: med(r.edits.map((e) => e.without)),
      bakeAll: r.bake.map((x) => +x.toFixed(1)),
      carves: r.edits.map((e) => `${e.withBake.toFixed(1)}/${e.without.toFixed(1)}`),
      maxCzField: r.stats.maxCzField,
      fieldMiss: r.stats.fieldMiss,
      refused: r.stats.refused,
      pages: r.stats.used,
    };
    out.push(row);
    console.log(`${variant}: level ${L} window rebake ${row.bake.toFixed(1)} ms (${row.bakeAll.join(', ')}); carve ${row.carve.toFixed(1)} ms with bakes, ${row.carveNoBake.toFixed(1)} without (${row.carves.join(', ')}); draw ${row.draw.toFixed(2)} ms, frame ${row.frame.toFixed(2)} ms; pages ${row.pages}, refused ${row.refused}, field miss ${row.fieldMiss}, field cz ${row.maxCzField}; still ${file}`);
    await page.close();
  }
  console.log(JSON.stringify(out));
});
