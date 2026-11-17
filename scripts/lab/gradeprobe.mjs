// (loop-streets) Streets as terrain, measured in the game: Muru made, then the grader's stats (since the town was made),
// its lays, and the water and ground round the square and along each arterial — so a cut that lets a river in, or a
// big move, shows as numbers. `--params "&city=terrainRoads:0"` the ribbons, for the same numbers without grading.
//   node scripts/lab/gradeprobe.mjs [--params ...] [--wait 20]
import { run } from '../lib/runner.mjs';

await run({ name: 'gradeprobe', kind: 'behaviour', size: '412x915', dpr: 1, echo: false }, async (R) => {
  const p = await R.page();
  await p.goto(`${R.url}/?skipmenu=1&level=atlas&town=1&loop=1&fresh=1&q=low&warmcache=0${R.opt('params', '')}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.rungame?.phase === 'leader' || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
  await R.fatal(p);
  await p.evaluate(() => window.rungame.pick('ysolt'));
  await p.waitForFunction(() => window.rungame.phase === 'city', { timeout: 60000, polling: 250 });
  await R.sleep(Number(R.opt('wait', '20')) * 1000);
  const out = await p.evaluate(async () => {
    const t = [...window.citygen.live.values()][0];
    const core = window.reclaimed.core;
    const W = core.dims.w;
    const water = await core.readBuffer('water');
    const [cx, cy] = t.centreInWindow();
    const RH = Math.sqrt(3) / 2;
    const ring = (r0, r1) => {
      let wet = 0;
      let n = 0;
      let depth = 0;
      for (let y = Math.floor((cy - r1) / RH); y <= Math.ceil((cy + r1) / RH); y++)
        for (let x = Math.floor(cx - r1); x <= Math.ceil(cx + r1); x++) {
          const px = x + 0.5 + 0.5 * (y & 1);
          const py = (y + 0.5) * RH;
          const d = Math.hypot(px - cx, py - cy);
          if (d < r0 || d >= r1 || x < 0 || y < 0 || x >= W || y >= core.dims.h) continue;
          n++;
          const w = water[y * W + x];
          if (w > 0.1) wet++;
          depth += w;
        }
      return { n, wet, depth: +depth.toFixed(1) };
    };
    const stats = t.grader ? await t.grader.readStats() : null;
    return { centre: [+cx.toFixed(1), +cy.toFixed(1)], terrainRoads: t.params.terrainRoads, times: t.times, lays: t.grader?.count, stats, square: ring(0, 18), near: ring(18, 30) };
  });
  R.log(JSON.stringify(out));
  // (the generation's cost: the mesh run N times each with the streets graded and drawn — its GPU ms by timestamps;
  // and a lay of the whole box, wall ms to the queue's end, N times)
  const n = Number(R.opt('meshruns', '0'));
  if (n > 0) {
    const cost = await p.evaluate(async (n) => {
      const t = [...window.citygen.live.values()][0];
      const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
      const res = {};
      const was = t.params.terrainRoads;
      for (const tr of [1, 0, 1, 0]) {
        const ms = [];
        for (let i = 0; i < n; i++) ms.push((await t.gen.run({ ...t.params, terrainRoads: tr }, 'mesh')).stage.mesh);
        res[`mesh terrainRoads=${tr}`] = [...(res[`mesh terrainRoads=${tr}`] ?? []), +med(ms).toFixed(2)];
        // (from the lots: the records made again too — the mesh stage's ms)
        const ml = [];
        for (let i = 0; i < n; i++) ml.push((await t.gen.run({ ...t.params, terrainRoads: tr }, 'lots')).stage.mesh);
        res[`mesh after lots terrainRoads=${tr}`] = [...(res[`mesh after lots terrainRoads=${tr}`] ?? []), +med(ml).toFixed(2)];
      }
      await t.gen.run({ ...t.params, terrainRoads: was }, 'mesh');
      if (t.grader) {
        const dev = t.io.device;
        const p = t.gridPlace();
        const lay = [];
        for (let i = 0; i < n; i++) {
          await dev.queue.onSubmittedWorkDone();
          const t0 = performance.now();
          t.grader.layRects(t.gen.gradeRoads, 129, [[p.dx, p.dy, p.dx + t.box.w, p.dy + t.box.h]], p, [p.dx, p.dy, p.dx + t.box.w, p.dy + t.box.h]);
          await dev.queue.onSubmittedWorkDone();
          lay.push(performance.now() - t0);
        }
        res.layWholeBoxWallMs = +med(lay).toFixed(2);
      }
      return res;
    }, n);
    R.log(`cost ${JSON.stringify(cost)}`);
  }
});
