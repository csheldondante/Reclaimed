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
  // (round 14, --smooth 1) the smooth draw on for everything below (the switch is itself a bake of every window)
  if (R.opt('smooth', '0') === '1') {
    const t = await page.evaluate(async () => {
      const t0 = performance.now();
      await nested.smooth(true);
      return performance.now() - t0;
    });
    console.log(`smooth on: ${t.toFixed(0)} ms (every live window baked again)`);
  }
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
  // (round 14, --sab 1) boxes against the smooth draw in the same page, alternating: per view the draw alone (5 rounds,
  // median), then carves at level 1 at the tunnel mouth alternating the two (the switch's own rebake not timed). Then
  // stops: the A/B is the measurement.
  if (R.opt('sab', '0') === '1') {
    const med = (v) => [...v].sort((x, y) => x - y)[Math.floor(v.length / 2)];
    for (const [name, v] of Object.entries(R.opt('draws', '1') === '1' ? views : {})) {
      await page.evaluate((v) => nested.setView(v), v);
      await sleep(2500);
      const r = await page.evaluate(async () => {
        const out = { box: [], smooth: [], tris: {} };
        for (let i = 0; i < 6; i++) {
          const sm = i % 2 === 1;
          await nested.smooth(sm);
          await new Promise((r) => setTimeout(r, 300));
          out[sm ? 'smooth' : 'box'].push(await nested.benchDraw(10));
          if (i < 2) out.tris[sm ? 'smooth' : 'box'] = (await nested.manifold()).map((x) => `L${x.depth} ${x.tris}`).join(', ');
        }
        await nested.smooth(false);
        return out;
      });
      console.log(`${name}: draw boxes ${med(r.box).toFixed(2)} ms (${r.box.map((x) => x.toFixed(1)).join(' ')}), smooth ${med(r.smooth).toFixed(2)} ms (${r.smooth.map((x) => x.toFixed(1)).join(' ')}); drawn triangles boxes ${r.tris.box}; smooth ${r.tris.smooth}`);
    }
    // (the aside) vertex vs pixel share of the draw: the same draw into a 4 x 4 canvas (the vertex work and almost no
    // pixels) against the full one, boxes and smooth, at the hillside and inside the tunnel
    for (const vn of ['hillside', 'tunnel inside, looking back']) {
      await page.evaluate((v) => nested.setView(v), views[vn]);
      await sleep(2500);
      const vp = await page.evaluate(async () => {
        const out = {};
        const cv = nested.app.canvas;
        const fr = () => new Promise((r) => requestAnimationFrame(r));
        for (const sm of [false, true]) {
          await nested.smooth(sm);
          for (let i = 0; i < 10; i++) await fr();
          const full = [];
          const tiny = [];
          for (let rep = 0; rep < 3; rep++) {
            cv.style.width = '';
            cv.style.height = '';
            for (let i = 0; i < 4; i++) await fr();
            full.push(await nested.benchDraw(10));
            cv.style.width = '4px';
            cv.style.height = '4px';
            for (let i = 0; i < 4; i++) await fr();
            tiny.push(await nested.benchDraw(10));
          }
          cv.style.width = '';
          cv.style.height = '';
          const med = (v) => [...v].sort((x, y) => x - y)[1];
          out[sm ? 'smooth' : 'box'] = { full: +med(full).toFixed(2), tiny: +med(tiny).toFixed(2) };
        }
        await nested.smooth(false);
        return out;
      });
      console.log(`${vn}: draw full vs a 4 x 4 canvas (vertex share), ms: boxes ${vp.box.full} / ${vp.box.tiny}; smooth ${vp.smooth.full} / ${vp.smooth.tiny}`);
    }
    await page.evaluate((v) => nested.setView(v), views['tunnel mouth']);
    await sleep(2500);
    const c = await page.evaluate(async (h) => {
      const a = nested.app;
      const s = await a.nest.readAll();
      const zo = s.zOrigin(1);
      const w1 = a.nest.wins[1];
      // (round 17, NS-129: the split) the sheet pass left out, the partner bakes left out, round 16's one-row bands; per
      // mode the submits and dispatches of a carve (both runs of benchEdit) and the sheet-pass chunks seen / baked
      const out = { box: [], smooth: [], 'smooth, no sheet pass': [], 'smooth, no partners': [], 'smooth, one row a band': [] };
      const modes = Object.keys(out);
      const cnt = {};
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 40; i++) {
        const mode = modes[i % modes.length];
        // (a switch reserves a whole rebake's pages: the grow it asks for lands on the next op; one carve first, not counted)
        if (a.nest.smooth !== (mode !== 'box')) {
          await nested.smooth(mode !== 'box');
          await wait(300);
          await nested.benchEdit({ op: 'carve', radius: 0.5, amount: 0, at: { level: 1, x: (h[0] + 3) * 8 - w1.gx, y: (h[1] + 3) * 8 - w1.gy, z: (h[2] + 0.8 - zo) * 8 } });
        }
        a.nest.skip.clear();
        if (mode.includes('no sheet')) a.nest.skip.add('sheet');
        if (mode.includes('no partners')) a.nest.skip.add('partner');
        if (mode.includes('one row')) a.nest.skip.add('bands');
        const at = { level: 1, x: (h[0] - 1 + (i % 12) * 0.3) * 8 - w1.gx, y: (h[1] + 1.5 + Math.floor(i / 12) * 0.4) * 8 - w1.gy, z: (h[2] + 0.8 - zo) * 8 };
        const g0 = a.nest.stats.grows;
        await wait(100);
        const c0 = { ...a.nest.counts, seen: a.nest.stats.sheetSeen ?? 0, baked: a.nest.stats.sheetBaked ?? 0 };
        const r = await nested.benchEdit({ op: 'carve', radius: 0.5, amount: 0, at });
        await wait(100);
        a.nest.skip.clear();
        if (a.nest.stats.grows === g0) {
          out[mode].push(r);
          (cnt[mode] ??= []).push(`${a.nest.counts.submits - c0.submits}s/${a.nest.counts.dispatches - c0.dispatches}d/${(a.nest.stats.sheetSeen ?? 0) - c0.seen}c/${(a.nest.stats.sheetBaked ?? 0) - c0.baked}b`);
        }
      }
      out.cnt = cnt;
      // (the switch itself: a whole-window rebake of every live level, pipelines made)
      await nested.smooth(false);
      const t0 = performance.now();
      await nested.smooth(true);
      out.switchOn = performance.now() - t0;
      await nested.smooth(false);
      return out;
    }, h);
    const mn = (v) => Math.min(...v);
    for (const k of ['box', 'smooth', 'smooth, no sheet pass', 'smooth, no partners', 'smooth, one row a band'])
      if (c[k].length) console.log(`carve at level 1, ${k}: with bakes ${c[k].map((r) => r.withBake.toFixed(1)).join(' ')} (median ${med(c[k].map((r) => r.withBake)).toFixed(1)}, min ${mn(c[k].map((r) => r.withBake)).toFixed(1)}); without ${c[k].map((r) => r.without.toFixed(1)).join(' ')}; bakes' share median ${med(c[k].map((r) => r.withBake - r.without)).toFixed(1)} ms; submits/dispatches/sheet chunks seen/baked ${(c.cnt[k] ?? []).join(' ')}`);
    console.log(`switching the smooth draw on (pipelines made): ${c.switchOn.toFixed(0)} ms`);
    return;
  }
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
  if (R.opt('ab', '0') === '1') await page.evaluate(() => (window.__ab = true));
  if (R.opt('levels', '0') === '1') await page.evaluate(() => (window.__levels = true));
  // (--old 1, round 10: the carves with round 9's rules, derive's top from every neighbour and no residual cleared, to
  // measure what the round 10 rules add to an edit)
  if (R.opt('old', '0') === '1')
    await page.evaluate(() => {
      nested.app.nest.oldTop = 1;
      nested.app.nest.skip.add('resClear');
    });
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
    // (--ab 1, round 11) the rim-line rule's cost: 16 more carves alternating GpuNest.rimOff 1 / 0 in the same page, the
    // bake's share (with - without) of each
    const ab = { off: [], on: [] };
    if (window.__ab) {
      for (let i = 0; i < 16; i++) {
        a.nest.rimOff = i % 2 === 0 ? 1 : 0;
        const at = { level: 1, x: (h[0] - 1 + i * 0.25) * 8 - w1.gx, y: (h[1] + 0.5) * 8 - w1.gy, z: (h[2] + 0.8 - zo) * 8 };
        const g0 = a.nest.stats.grows;
        const r = await nested.benchEdit({ op: 'carve', radius: 0.5, amount: 0, at });
        if (a.nest.stats.grows === g0) (i % 2 === 0 ? ab.off : ab.on).push(r.withBake - r.without);
      }
      a.nest.rimOff = 0;
      // (round 12) the split bake (plain and rim pipelines) against round 11's one pipeline, the same way
      ab.one = [];
      ab.split = [];
      for (let i = 0; i < 16; i++) {
        a.nest.splitBake = i % 2 === 1;
        const at = { level: 1, x: (h[0] - 1 + i * 0.25) * 8 - w1.gx, y: (h[1] + 0.2) * 8 - w1.gy, z: (h[2] + 0.8 - zo) * 8 };
        const g0 = a.nest.stats.grows;
        const r = await nested.benchEdit({ op: 'carve', radius: 0.5, amount: 0, at });
        if (a.nest.stats.grows === g0) (i % 2 === 1 ? ab.split : ab.one).push(r.withBake - r.without);
      }
      a.nest.splitBake = true;
    }
    // (--levels 1, round 12) which level's bake a carve's bake time goes to: carves alternating a mask of levels whose
    // bakes are skipped, the bakes' share (with - without) of each
    const lv = {};
    if (window.__levels) {
      const masks = [0, 1, 2, 4, 7];
      for (let i = 0; i < 25; i++) {
        const m = masks[i % masks.length];
        a.nest.bakeSkip = m;
        const at = { level: 1, x: (h[0] - 1 + i * 0.16) * 8 - w1.gx, y: (h[1] + 1.0) * 8 - w1.gy, z: (h[2] + 0.8 - zo) * 8 };
        const g0 = a.nest.stats.grows;
        const r = await nested.benchEdit({ op: 'carve', radius: 0.5, amount: 0, at });
        if (a.nest.stats.grows === g0) (lv[`skip ${m}`] ??= []).push(+(r.withBake - r.without).toFixed(1));
      }
      a.nest.bakeSkip = 0;
    }
    // (--profile 1) where a slow carve's time goes: the same carve spot again with passes left out (results wrong)
    const prof = [];
    if (window.__profile) {
      // (round 12) each step left out in turn, interleaved, 5 rounds; medians of the op's wall time (submit to GPU done)
      // without its bakes; the bakes' share per level from bakeSkip; then the op's dispatches, submits and chunks baked.
      // 'pack' last: left out it leaks the scratch pages.
      const NONE = ['ball', 'resClear', 'restrict', 'residual', 'derive'];
      const sets = { all: [], ball: ['ball'], resClear: ['resClear'], restrict: ['restrict'], residual: ['residual'], derive: ['derive'], 'all edit passes': NONE };
      const t = {};
      const med = (v) => [...v].sort((x, y) => x - y)[Math.floor(v.length / 2)];
      for (let rep = 0; rep < 5; rep++)
        for (const [name, skip] of Object.entries(sets)) {
          const at = { level: 1, x: (h[0] - 0.6 + rep * 0.3) * 8 - w1.gx, y: (h[1] + 1.5) * 8 - w1.gy, z: (h[2] + 0.4 - zo) * 8 };
          a.nest.skip.clear();
          for (const s of skip) a.nest.skip.add(s);
          const r = await nested.benchEdit({ op: 'carve', radius: 0.5, amount: 0, at });
          (t[name] ??= []).push(r.without);
        }
      a.nest.skip.clear();
      const base = med(t.all);
      for (const [name, v] of Object.entries(t)) prof.push(`${name === 'all' ? 'all (no bakes)' : `without ${name}`} ${med(v).toFixed(1)} ms${name === 'all' ? '' : ` (step ~${(base - med(v)).toFixed(1)})`}`);
      // the bakes per level
      const bk = {};
      for (let rep = 0; rep < 5; rep++)
        for (const m of [0, 1, 2, 4, 7]) {
          a.nest.bakeSkip = m;
          const at = { level: 1, x: (h[0] - 0.6 + rep * 0.3) * 8 - w1.gx, y: (h[1] + 2.0) * 8 - w1.gy, z: (h[2] + 0.4 - zo) * 8 };
          const r = await nested.benchEdit({ op: 'carve', radius: 0.5, amount: 0, at });
          (bk[m] ??= []).push(r.withBake);
        }
      a.nest.bakeSkip = 0;
      const all = med(bk[0]);
      prof.push(`with all bakes ${all.toFixed(1)} ms; no bakes ${med(bk[7]).toFixed(1)}; L0 bake ~${(all - med(bk[1])).toFixed(1)}, L1 ~${(all - med(bk[2])).toFixed(1)}, L2 ~${(all - med(bk[4])).toFixed(1)}`);
      // one carve's dispatches, submits and chunks baked per level
      const c0 = { ...a.nest.counts };
      const at = { level: 1, x: (h[0] - 0.3) * 8 - w1.gx, y: (h[1] + 2.5) * 8 - w1.gy, z: (h[2] + 0.4 - zo) * 8 };
      while (!a.nest.edit({ op: 'carve', radius: 0.5, amount: 0, at })) await new Promise((r) => setTimeout(r, 30));
      const disp = a.nest.counts.dispatches - c0.dispatches;
      const subs = a.nest.counts.submits - c0.submits;
      const bakes = await a.nest.readBakes();
      const rep = await nested.manifold();
      const tri = Object.fromEntries(rep.map((x) => [x.depth, x.tris]));
      const per = {};
      for (const b of bakes) per[b.L] = (per[b.L] ?? 0) + b.chunks;
      prof.push(`one carve: ${disp} dispatches, ${subs} submit(s); chunks baked (each by two pipelines, rim and plain) ${Object.entries(per).map(([L, c]) => `L${L} ${c} (${c * 256} columns, ~${Math.round((tri[L] * c) / (a.nest.wins[L].n / 16) ** 2)} triangles at the level's mean)`).join(', ')}`);
      const sl = bakes.slots;
      prof.push(`regions in chunks (edit / restrict from the child / residual / derive): ${[0, 1, 2].map((m) => `L${m} ${sl[m * 4 + 3]} / ${m + 1 < 3 ? sl[(m + 1) * 4] : '-'} / ${sl[m * 4 + 1]} / ${sl[m * 4 + 2]}`).join('; ')}`);
      // (pack last: it leaks scratch pages when left out)
      const pk = [];
      for (let rep = 0; rep < 3; rep++) {
        a.nest.skip.clear();
        a.nest.skip.add('pack');
        const at2 = { level: 1, x: (h[0] - 0.6 + rep * 0.3) * 8 - w1.gx, y: (h[1] + 3) * 8 - w1.gy, z: (h[2] + 0.4 - zo) * 8 };
        pk.push((await nested.benchEdit({ op: 'carve', radius: 0.5, amount: 0, at: at2 })).without);
      }
      a.nest.skip.clear();
      prof.push(`without pack ${med(pk).toFixed(1)} ms (step ~${(base - med(pk)).toFixed(1)})`);
    }
    return { out, prof, ab, lv, live: nested.state().live, log: a.opLog.slice(-40) };
  }, h);
  if (Object.keys(carve.lv).length) console.log(`bakes' share by skipped levels (mask: L0 1, L1 2, L2 4): ${JSON.stringify(carve.lv)}`);
  if (carve.ab.on.length) {
    const med = (v) => [...v].sort((x, y) => x - y)[Math.floor(v.length / 2)];
    console.log(`rim rule A/B, the bakes' share of a carve (ms): off ${carve.ab.off.map((x) => x.toFixed(1)).join(' ')} (median ${med(carve.ab.off).toFixed(1)}); on ${carve.ab.on.map((x) => x.toFixed(1)).join(' ')} (median ${med(carve.ab.on).toFixed(1)})`);
    console.log(`split bake A/B, the bakes' share (ms): one pipeline ${carve.ab.one.map((x) => x.toFixed(1)).join(' ')} (median ${med(carve.ab.one).toFixed(1)}); split ${carve.ab.split.map((x) => x.toFixed(1)).join(' ')} (median ${med(carve.ab.split).toFixed(1)})`);
  }
  if (carve.prof.length) console.log(`profile:\n  ${carve.prof.join('\n  ')}`);
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
