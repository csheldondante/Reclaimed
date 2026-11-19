// Nested scales (round 15, NS-116): where the smooth bake's time goes in a dug world. The selftest's sandbox, the pit
// suite's shafts with the box draw (the world the full selftest loses the device in), then the smooth switch (a whole
// rebake of every live window, a chunk row a submit) timed with both passes, the cache pass only and the exception bake
// only (GpuNest.skip, measurement only: the result is then wrong), each row's GPU time (GpuNest.rowTimes), and then
// (--suite 1) the 40-pose watertight suite with the smooth draw on.
// node scripts/nested-dug.mjs --chromeargs ignore-certificate-errors [--port 5461] [--suite 0]
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'nested-dug', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning' || m.text().startsWith('[dug]')) console.log(`[page ${m.type()}] ${m.text()}`);
  });
  await page.goto(`https://localhost:${port}/nested.html?k=8&d=8&pitch=0.3&yaw=0&tx=100&ty=140`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.frameCount > 60, { timeout: 120000, polling: 100 });
  await sleep(1500);
  const modes = R.opt('modes', '1') === '1';
  const box = R.opt('box', '0') === '1';
  const res = await page.evaluate(async ({ modes, box }) => {
    const { pitAndCave } = await import('/src/nested/suite.ts');
    await pitAndCave(nested, { shaftsOnly: true, diag: false, log: () => {} });
    const a = nested.app;
    if (!modes) {
      await nested.smooth(!box);
      return { live: a.nest.live };
    }
    const out = { live: a.nest.live, wins: a.nest.wins.filter(Boolean).map((w) => w.n), modes: {} };
    // (the first switch makes the pipelines; 'exceptions only' would find the cache pass's skip word of the last run)
    // ('boxes': the switch off, which bakes every window's boxes the same way)
    for (const mode of ['both (pipelines made)', 'both', 'boxes', 'cache only, a chunk a submit', 'both, a chunk a submit', 'boxes, a chunk a submit']) {
      const box = mode.startsWith('boxes');
      await nested.smooth(box);
      a.nest.skip.clear();
      if (mode.startsWith('cache only')) a.nest.skip.add('ex');
      a.nest.chunkTimes = mode.includes('chunk');
      a.nest.rowTimes = [];
      const t0 = performance.now();
      await nested.smooth(!box);
      await a.device.queue.onSubmittedWorkDone();
      const rows = a.nest.rowTimes;
      a.nest.rowTimes = null;
      a.nest.chunkTimes = false;
      a.nest.skip.clear();
      const sorted = rows.sort((x, y) => y.ms - x.ms);
      out.modes[mode] = { ms: Math.round(performance.now() - t0), rows: rows.length, worstRow: Math.round(sorted[0].ms), worst: sorted.slice(0, 6).map((r) => `L${r.L} ${r.x ?? '-'},${r.y}: ${r.ms.toFixed(0)} ms`) };
      console.log(`[dug] ${mode}: ${JSON.stringify(out.modes[mode])}`);
      if (mode.includes('chunk')) {
        // the worst chunks' columns: records a column (most, sum), bottoms, whether a rim line of a child or parent
        const s = await a.nest.readAll();
        out.worstChunks = sorted.slice(0, 6).map((r) => {
          let most = 0;
          let sum = 0;
          let lowBot = 0;
          for (let Y = r.y * 16; Y < r.y * 16 + 16; Y++)
            for (let X = r.x * 16; X < r.x * 16 + 16; X++) {
              const c = s.records(r.L, X, Y);
              most = Math.max(most, c.top.length);
              sum += c.top.length;
            }
          const kid = a.nest.wins[r.L + 1];
          const k = a.nest.k;
          const nearKid = kid && r.x * 16 <= (kid.gx + kid.n) / k + 1 && (r.x + 1) * 16 >= kid.gx / k - 1 && r.y * 16 <= (kid.gy + kid.n) / k + 1 && (r.y + 1) * 16 >= kid.gy / k - 1;
          const w = a.nest.wins[r.L];
          const edge = r.x * 16 === w.gx || r.y * 16 === w.gy || (r.x + 1) * 16 === w.gx + w.n || (r.y + 1) * 16 === w.gy + w.n;
          return { chunk: `L${r.L} ${r.x},${r.y}`, ms: Math.round(r.ms), most, sum, nearKid: !!nearKid, edge, lowBot };
        });
        console.log(`[dug] worst chunks: ${JSON.stringify(out.worstChunks)}`);
      }
    }
    return out;
  }, { modes, box });
  console.log(JSON.stringify(res));
  if (R.opt('rebake', '0') === '1') await page.evaluate(() => (window.__rebakeOn = true));
  if (R.opt('suite', '1') === '1') {
    const s = await page.evaluate(async (screen) => {
      const { watertightSuite } = await import('/src/nested/suite.ts');
      window.__rebake = new URLSearchParams(location.search).has('x') || window.__rebakeOn;
      const log = (s) => {
        console.log(`[dug] ${s}`);
        const m = /^scene at (\S+), (\S+), (\S+);/.exec(s);
        if (m) {
          const [hx, hy, hz] = [+m[1], +m[2], +m[3]];
          const w1 = nested.app.nest.wins[1];
          const k = nested.app.nest.k;
          window.__rebakeViews = [
            { yaw: 0, pitch: 0.0, eye: [hx + 0.3, hy, hz + 1.2] },
            { yaw: 0, pitch: 0.6, eye: [w1.gx / k + 3, w1.gy / k + w1.n / k / 2 - 3, hz + 4] },
            { yaw: 0.6, pitch: 0.7, eye: [hx + 60, hy + 40, hz + 70] },
          ];
        }
      };
      const r = await watertightSuite(window.nested, { manifold: true, screen, log });
      // (--rebake 1) the rim faults at each eye where the suite saw them, then again after every window is baked anew
      // (the smooth switch twice): gone = a stale bake (a region an op did not bake), still there = the arithmetic
      if (window.__rebake) {
        const out = [];
        const rimN = async () => (await nested.manifold()).reduce((s, x) => s + (x.rim ? x.rim.junctions + x.rim.unflagged : 0), 0);
        for (const v of window.__rebakeViews) {
          nested.setView(v);
          for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
          const before = await rimN();
          const on = nested.app.nest.smooth;
          await nested.smooth(!on);
          await nested.smooth(on);
          for (let i = 0; i < 10; i++) await new Promise((r) => requestAnimationFrame(r));
          out.push({ v: v.eye.map((x) => +x.toFixed(1)), before, after: await rimN() });
        }
        console.log(`[dug] rebake: ${JSON.stringify(out)}`);
      }
      const m = await nested.manifold();
      const rim = m.filter((x) => x.rim).map((x) => ({ L: x.depth, lines: x.rim.lines, junctions: x.rim.junctions, unflagged: x.rim.unflagged, where: x.rim.where.slice(0, 4) }));
      return { r: r.checks.map((c) => `${c.pass ? 'PASS' : 'FAIL'} ${c.name.slice(0, 60)}: ${c.detail}`).join('\n'), rim: JSON.stringify(rim), fatal: document.querySelector('.fatal')?.textContent ?? '' };
    }, R.opt('screen', '1') === '1');
    console.log(`suite (${box ? 'boxes' : 'smooth'}) in the dug world:\n${s.r}\nrim lines at the last eye: ${s.rim}\nfatal: ${s.fatal}`);
    R.check('no fatal overlay (device kept)', !s.fatal, s.fatal);
  }
});
