// Nested scales: the performance gate on the desktop. Builds the watertight suite's scene (src/nested/suite.ts, checks
// off), then per view: the uncapped draw (ms a draw, GPU done), the frame interval while still, triangles per level and
// the pool; a carve at level 1 with and without its bakes (GPU ms, synced); promote and slide times from the op log.
// node scripts/nested-perf.mjs --chromeargs ignore-certificate-errors [--port 5461]
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'nested-perf', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}] ${m.text()}`);
  });
  await page.goto(`https://localhost:${port}/nested.html?k=8&d=8&pitch=0.3&yaw=0&tx=100&ty=140`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.frameCount > 60, { timeout: 120000, polling: 100 });
  await sleep(1500);
  const h = await page.evaluate(async () => {
    const { watertightSuite } = await import('/src/nested/suite.ts');
    const e = nested.eye();
    const f = nested.app.forward();
    const h = [e.x + f[0] * e.dHit, e.y + f[1] * e.dHit, e.z + f[2] * e.dHit];
    await watertightSuite(window.nested, { manifold: false, screen: false });
    return h;
  });
  const [hx, hy, hz] = h;
  const tz = hz + 1.3;
  const views = {
    'mound outside': { yaw: 0, pitch: 0.03, eye: [hx + 7, hy, tz + 0.2] },
    'tunnel inside': { yaw: 0, pitch: 0.0, eye: [hx + 0.3, hy, tz - 0.1] },
    'tunnel inside, looking back': { yaw: Math.PI, pitch: 0.0, eye: [hx - 0.3, hy, tz - 0.1] },
    'tunnel mouth': { yaw: 0, pitch: 0.05, eye: [hx + 2.6, hy + 0.2, tz] },
    'blob on a stalk': { yaw: 0, pitch: 0.1, eye: [hx + 6, hy + 5, hz + 2.5] },
    'hillside': { yaw: 0.6, pitch: 0.5, eye: [hx + 20, hy + 14, hz + 12] },
    'the map': { yaw: 0.6, pitch: 0.7, eye: [hx + 60, hy + 40, hz + 70] },
  };
  let drawWorst = 0;
  let frameWorst = 0;
  const rows = [];
  for (const [name, v] of Object.entries(views)) {
    await page.evaluate((v) => nested.setView(v), v);
    await sleep(2500);
    const r = await page.evaluate(async () => {
      const draw = await nested.benchDraw(20);
      // frame intervals while still (vsync bound when the frame fits)
      const t = [];
      let last = performance.now();
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        const now = performance.now();
        t.push(now - last);
        last = now;
      }
      t.sort((a, b) => a - b);
      const rep = await nested.manifold();
      return { draw, p50: t[20], p95: t[37], tris: rep.map((x) => `L${x.depth} ${x.tris}`).join(', '), stats: nested.state().stats, live: nested.state().live };
    });
    drawWorst = Math.max(drawWorst, r.draw);
    frameWorst = Math.max(frameWorst, r.p50);
    rows.push(name);
    console.log(`${name}: draw ${r.draw.toFixed(2)} ms uncapped; frame p50 ${r.p50.toFixed(1)} p95 ${r.p95.toFixed(1)} ms; ${r.live} levels; tris ${r.tris}; pages ${r.stats.used} used of ${r.stats.cap} (${r.stats.mb} MB)`);
  }
  // a carve at level 1 in the tunnel scene (3 levels live round the tunnel): GPU ms with and without the bakes
  await page.evaluate((v) => nested.setView(v), views['tunnel mouth']);
  await sleep(2500);
  if (R.opt('profile', '0') === '1') await page.evaluate(() => (window.__profile = true));
  const carve = await page.evaluate(async (h) => {
    const a = nested.app;
    const s = await a.nest.readAll();
    const zo = s.zOrigin(1);
    const w1 = a.nest.wins[1];
    const out = [];
    for (let i = 0; i < 10; i++) {
      const at = { level: 1, x: (h[0] - 1 + i * 0.4) * 8 - w1.gx, y: (h[1] + 1.5) * 8 - w1.gy, z: (h[2] + 0.8 - zo) * 8 };
      const g0 = a.nest.stats.grows;
      const r = await nested.benchEdit({ op: 'carve', radius: 0.5, amount: 0, at });
      // (an edit that applied a pool grow first copies the pool: not the edit's own cost)
      if (a.nest.stats.grows === g0) out.push(r);
    }
    // (--profile 1) where a slow carve's time goes: the same carve spot again with passes left out (results wrong)
    const prof = [];
    if (window.__profile) {
      for (const skip of [[], ['derive'], ['residual'], ['restrict'], ['derive', 'residual', 'restrict']]) {
        const at = { level: 1, x: (h[0] - 0.6) * 8 - w1.gx, y: (h[1] + 1.5) * 8 - w1.gy, z: (h[2] + 0.4 - zo) * 8 };
        a.nest.skip.clear();
        for (const s of skip) a.nest.skip.add(s);
        const r = await nested.benchEdit({ op: 'carve', radius: 0.5, amount: 0, at });
        prof.push(`${skip.join('+') || 'all'} ${r.withBake.toFixed(1)}/${r.without.toFixed(1)}`);
      }
      a.nest.skip.clear();
    }
    return { out, prof, live: nested.state().live, log: a.opLog.slice(-40) };
  }, h);
  if (carve.prof.length) console.log(`profile (with bakes / without): ${carve.prof.join('; ')}`);
  console.log(`carve in order (with, without): ${carve.out.map((o) => `${o.withBake.toFixed(1)}/${o.without.toFixed(1)}`).join(' ')}`);
  const w = carve.out.map((o) => o.withBake).sort((a, b) => a - b);
  const wo = carve.out.map((o) => o.without).sort((a, b) => a - b);
  console.log(`carve at level 1 (${carve.live} levels live), ms with bakes ${w.map((x) => x.toFixed(1)).join(' ')}; without ${wo.map((x) => x.toFixed(1)).join(' ')}`);
  const ops = {};
  for (const o of carve.log) (ops[`${o.what} L${o.depth}`] ??= []).push(+o.ms.toFixed(1));
  console.log('ops (CPU ms to encode)', JSON.stringify(ops));
  R.check('carve at level 1 with its bakes <= 15 ms (median)', w[Math.floor(w.length / 2)] <= 15, `median ${w[Math.floor(w.length / 2)].toFixed(1)} ms`);
  R.check('uncapped draw <= 8 ms in every view', drawWorst <= 8, `worst ${drawWorst.toFixed(2)} ms`);
  R.check('frames at vsync while still (p50 <= 12 ms)', frameWorst <= 12, `worst p50 ${frameWorst.toFixed(1)} ms`);
});
