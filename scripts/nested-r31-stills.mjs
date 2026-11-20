// Nested scales (round 31): the faceted-block cliff shading (?cliff=1) against the plain sheet, at the same poses. The
// switch is a uniform (render.cliff), so each pair is one page, the app frozen, the switch flipped between two shots: the
// same windows, the same frame. Stills local/nested/r31-<pose>-cliff0|1.png.
//   --phase gen    the generated world (?smooth=1): the root's steepest step seen from the side with the 16 m level open
//                  (side16), closer with the 2 m level open (side2); the level-load pair (load-before / load-after, cliff
//                  on: the same view as the 2 m level opens); the frame time with cliff off / on at side2 (?gputime=1
//                  pass times and the page's frame times, alternating, 3 s each)
//   --phase field  the same as side2 with ?field=1,2,3
//   --phase toy    ?gen=0: a trench carved at the finest level, its wall from the side
//   --phase cut    (?cliffcut=1 compiled in; cut flipped at run time, cliff on) the step's top against the sky from the
//                  side / below (cutside) and from above (cutabove); and the frame time cut off / on
// node scripts/nested-r31-stills.mjs --chromeargs ignore-certificate-errors --port 5461 --phase gen [--extra "&cliffT=2"]
import { run, sleep } from './lib/runner.mjs';
import fs from 'node:fs';

await run({ name: 'r31-stills', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const phase = R.opt('phase', 'gen');
  const extra = R.opt('extra', '');
  const tag = R.opt('tag', 'r31');
  fs.mkdirSync('local/nested', { recursive: true });
  const q = { gen: '&smooth=1&gputime=1', field: '&smooth=1&field=1,2,3', toy: '&smooth=1&gen=0', cut: '&smooth=1&cliffcut=1&gputime=1' }[phase];
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`[page ${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`[page exception] ${e.message}`));
  await page.goto(`https://localhost:${port}/nested.html?cliff=${R.opt('cliff', '1')}${q}${extra}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.pipesReady && nested.app.genReady && (!nested.app.nest.fieldMask || nested.app.fieldDone) && nested.app.frameCount > 30, { timeout: 300000, polling: 200 });
  // (the textured pipelines made: the cliff shading lives there)
  await page.waitForFunction(() => nested.app.render.texDrawn, { timeout: 120000, polling: 200 });
  const settle = async (live) => {
    for (let i = 0; i < 200; i++) {
      await sleep(150);
      const st = await page.evaluate(() => ({ live: nested.app.nest.live, ok: nested.app.nest.settled && !nested.app.nest.switching && !nested.app.nest.fieldJob }));
      if ((live === undefined || st.live >= live) && st.ok && i > 10) break;
    }
    await sleep(600);
  };
  const look = (eye, at) => {
    const d = [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]];
    const n = Math.hypot(...d);
    return { yaw: Math.atan2(-d[1], -d[0]), pitch: Math.asin(-d[2] / n), eye };
  };
  const info = () => page.evaluate(() => ({ live: nested.app.nest.live, eyeLevel: nested.app.nest.camOut[30] }));
  /** a pair at the current view: the app frozen, cliff off then on (or the cut off then on) */
  const pair = async (name, key = 'cliff') => {
    await page.evaluate(() => (nested.app.frozen = true));
    const out = [];
    for (const on of [false, true]) {
      await page.evaluate(({ key, on }) => {
        const r = nested.app.render;
        if (key === 'cliff') r.cliff = on;
        else {
          r.cliff = true;
          r.cliffCut = on;
        }
      }, { key, on });
      await sleep(500);
      const file = `local/nested/${tag}-${name}-${key}${on ? 1 : 0}.png`;
      await page.screenshot({ path: file });
      out.push(file);
    }
    const st = await info();
    await page.evaluate(() => (nested.app.frozen = false));
    console.log(`${name}: levels ${st.live}, eye level ${st.eyeLevel}; ${out.join(' ')}`);
  };
  /** frame time with the switch off / on, alternating, ms each: the page's frame times and (?gputime=1) the passes */
  const bench = async (name, key = 'cliff') => {
    await page.evaluate(() => (nested.app.frozen = true));
    const res = { off: { f: [], g: [] }, on: { f: [], g: [] } };
    for (let rep = 0; rep < 3; rep++)
      for (const on of [false, true]) {
        const r = await page.evaluate(
          async ({ key, on }) => {
            const a = nested.app;
            if (key === 'cliff') a.render.cliff = on;
            else a.render.cliffCut = on;
            await new Promise((res) => setTimeout(res, 600));
            a.render.gpuSamples.clear();
            const c0 = a.frameCount;
            await new Promise((res) => setTimeout(res, 3000));
            const f = a.frames.slice(-(a.frameCount - c0));
            let g = 0;
            for (const s of a.render.gpuSamples.values()) g += s.ms.reduce((x, y) => x + y, 0) / Math.max(1, s.ms.length);
            return { f: f.reduce((x, y) => x + y, 0) / Math.max(1, f.length), g };
          },
          { key, on },
        );
        res[on ? 'on' : 'off'].f.push(+r.f.toFixed(2));
        res[on ? 'on' : 'off'].g.push(+r.g.toFixed(3));
      }
    await page.evaluate(() => (nested.app.frozen = false));
    console.log(`${name} frame time ${key} off: frame ms ${res.off.f.join(' / ')}, GPU passes ms ${res.off.g.join(' / ')}`);
    console.log(`${name} frame time ${key} on:  frame ms ${res.on.f.join(' / ')}, GPU passes ms ${res.on.g.join(' / ')}`);
  };

  if (phase === 'toy') {
    // a trench at the finest level: carve a stroke there, then look along it from one end, low
    await page.evaluate(() => nested.setView({ yaw: 0.6, pitch: 0.7 }));
    await settle();
    const sc = await page.evaluate(async () => {
      const a = nested.app;
      const nest = a.nest;
      const L = nest.live - 1;
      const k = a.k;
      const S = k ** L;
      const s = await nest.readAll();
      const w = nest.wins[L];
      let zo = 0;
      for (let j = 1; j <= L; j++) zo += s.zOrigin(j) / k ** (j - 1);
      const top = (X, Y) => {
        const c = s.column(L, Math.floor(X), Math.floor(Y));
        return c.z1.length ? c.z1[c.z1.length - 1] : 0;
      };
      const P = [w.gx + w.n * 0.5 + 0.3, w.gy + w.n * 0.5 + 0.2];
      const z = top(P[0], P[1]);
      const ed = async (x, y, r) => {
        while (!nest.edit({ op: 'carve', radius: r / S, amount: 1, at: { level: L, x: x - w.gx, y: y - w.gy, z } })) await new Promise((res) => setTimeout(res, 50));
        for (let i = 0; i < 80 && !(nest.settled && !nest.switching); i++) await new Promise((res) => setTimeout(res, 50));
      };
      nest.strokeBegin();
      for (let i = -3; i <= 3; i++) await ed(P[0] + i * 4, P[1], 5);
      nest.strokeEnd();
      return { L, S, zo, P, z };
    });
    await settle();
    const W = (X, Y, z) => [X / sc.S, Y / sc.S, sc.zo + z / sc.S];
    // across the trench, the eye just above its far rim, looking at the near wall
    await page.evaluate((v) => nested.setView(v), look(W(sc.P[0] + 3, sc.P[1] + 9, sc.z + 1.5), W(sc.P[0], sc.P[1] - 4, sc.z - 3)));
    await settle();
    await pair('toy-trench');
    console.log(`toy: level ${sc.L}, carve at ${sc.P.map((v) => v.toFixed(1)).join(',')} z ${sc.z.toFixed(2)}`);
    return;
  }

  // the root window's steepest step (root columns = world units, 128 m with the generator)
  const spot = await page.evaluate(async () => {
    const a = nested.app;
    const s = await a.nest.readAll();
    const w = a.nest.wins[0];
    const top = (X, Y) => {
      const c = s.column(0, X, Y);
      return c.z1[c.z1.length - 1];
    };
    let best = { x: 0, y: 0, step: 0, dir: [1, 0], hi: 0, lo: 0 };
    for (let y = w.gy + 40; y < w.gy + w.n - 40; y++)
      for (let x = w.gx + 40; x < w.gx + w.n - 40; x++)
        for (const d of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
          const st = top(x, y) - top(x + d[0], y + d[1]);
          if (st > best.step) best = { x, y, step: st, dir: d, hi: top(x, y), lo: top(x + d[0], y + d[1]) };
        }
    return best;
  });
  console.log(`steepest root step: ${JSON.stringify(spot)} (world units; slope over one column = the step)`);
  const C = [spot.x + 0.5 + spot.dir[0] * 0.5, spot.y + 0.5 + spot.dir[1] * 0.5];
  const zMid = (spot.hi + spot.lo) / 2;
  const perp = [-spot.dir[1], spot.dir[0]];
  // a side view: back D from the step on its low side, a little to one side, a little above the step's middle
  const side = (D, up, along = 0.35) => look([C[0] + spot.dir[0] * D + perp[0] * D * along, C[1] + spot.dir[1] * D + perp[1] * D * along, zMid + up], [C[0], C[1], zMid]);

  if (phase === 'cut') {
    // the top against the sky: from below the step's top, looking up at its rim; then from above
    await page.evaluate((v) => nested.setView(v), look([C[0] + spot.dir[0] * 0.9, C[1] + spot.dir[1] * 0.9, spot.lo + 0.05], [C[0], C[1], spot.hi]));
    await settle();
    await pair('cutside', 'cut');
    await page.evaluate((v) => nested.setView(v), look([C[0] + spot.dir[0] * 0.6, C[1] + spot.dir[1] * 0.6, spot.hi + 0.6], [C[0] - spot.dir[0] * 0.2, C[1] - spot.dir[1] * 0.2, zMid]));
    await settle();
    await pair('cutabove', 'cut');
    await page.evaluate((v) => nested.setView(v), look([C[0] + spot.dir[0] * 0.9, C[1] + spot.dir[1] * 0.9, spot.lo + 0.05], [C[0], C[1], spot.hi]));
    await settle();
    await bench('cutside', 'cut');
    return;
  }
  const D16 = Number(R.opt('d16', '8'));
  const D2 = Number(R.opt('d2', '1.5'));
  if (phase === 'field') {
    await page.evaluate((v) => nested.setView(v), side(D2, D2 * 0.2));
    await settle();
    await pair('field-side2');
    return;
  }
  await page.evaluate((v) => nested.setView(v), side(D16, D16 * 0.2));
  await settle();
  await pair('side16');
  await page.evaluate((v) => nested.setView(v), side(D2, D2 * 0.2));
  await settle();
  await pair('side2');
  // (--variants "name:prop=v;prop=v,...": per view (side16, side2) one still each with those render fields set at run time)
  const variants = R.opt('variants', '');
  if (variants) {
    for (const [view, D] of [['side16', D16], ['side2', D2]]) {
      await page.evaluate((v) => nested.setView(v), side(D, D * 0.2));
      await settle();
      await page.evaluate(() => (nested.app.frozen = true));
      for (const vs of variants.split(',')) {
        const [name, sets] = vs.split(':');
        await page.evaluate((sets) => {
          const r = nested.app.render;
          Object.assign(r, { cliff: true, cliffW: 0, cliffDbg: false, cliffN: 4, cliffPx: 3 });
          for (const kv of sets.split(';')) {
            const [k, v] = kv.split('=');
            r[k] = v === 'true' ? true : v === 'false' ? false : Number(v);
          }
        }, sets);
        await sleep(500);
        const file = `local/nested/${tag}-${view}-${name}.png`;
        await page.screenshot({ path: file });
        console.log(`${view} ${name}: ${file}`);
      }
      await page.evaluate(() => (nested.app.frozen = false));
    }
  }
  // (--approach "D1,D2,..": cliff on as loaded, a still at each distance along the side line, settled)
  const approach = R.opt('approach', '');
  if (approach) {
    for (const D of approach.split(',').map(Number)) {
      await page.evaluate(() => Object.assign(nested.app.render, { cliff: true, cliffDbg: false, cliffW: 0, cliffPx: 3 }));
      await page.evaluate((v) => nested.setView(v), side(D, D * 0.2));
      await settle();
      const file = `local/nested/${tag}-approach-${D}.png`;
      await page.screenshot({ path: file });
      console.log(`approach ${D}: ${file}; ${JSON.stringify(await info())}`);
    }
  }
  // (--vbench "name:prop=v;..|name:..": frame time per state at side16 and side2, alternating, 3 s each, 3 rounds)
  const vb = R.opt('vbench', '');
  if (vb) {
    const states = vb.split('|').map((s) => s.split(':'));
    for (const [view, D] of [['side16', D16], ['side2', D2]]) {
      await page.evaluate((v) => nested.setView(v), side(D, D * 0.2));
      await settle();
      await page.evaluate(() => (nested.app.frozen = true));
      const res = {};
      for (let rep = 0; rep < 3; rep++)
        for (const [name, sets] of states) {
          const m = await page.evaluate(async (sets) => {
            const a = nested.app;
            for (const kv of sets.split(';')) {
              const [k, v] = kv.split('=');
              a.render[k] = v === 'true' ? true : v === 'false' ? false : Number(v);
            }
            await new Promise((res) => setTimeout(res, 600));
            a.render.gpuSamples.clear();
            const c0 = a.frameCount;
            await new Promise((res) => setTimeout(res, 3000));
            const f = a.frames.slice(-(a.frameCount - c0));
            let g = 0;
            for (const s of a.render.gpuSamples.values()) g += s.ms.reduce((x, y) => x + y, 0) / Math.max(1, s.ms.length);
            return { f: f.reduce((x, y) => x + y, 0) / Math.max(1, f.length), g };
          }, sets);
          (res[name] ??= []).push(`${m.f.toFixed(2)}/${m.g.toFixed(2)}`);
        }
      await page.evaluate(() => (nested.app.frozen = false));
      for (const [name, v] of Object.entries(res)) console.log(`${view} ${name}: frame ms / GPU passes ms: ${v.join('  ')}`);
    }
  }
  // (--quick 1: the two pairs only)
  if (R.opt('quick', '0') === '1') return;
  await bench('side2');
  // the level-load pair (cliff on): from side16, jump to the side2 view and shoot at once, then once it has settled
  await page.evaluate((v) => nested.setView(v), side(D16, D16 * 0.2));
  await settle();
  await page.evaluate(() => (nested.app.render.cliff = true));
  await page.evaluate((v) => nested.setView(v), side(D2, D2 * 0.2));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const a0 = await info();
  await page.screenshot({ path: `local/nested/${tag}-load-before.png` });
  await settle();
  const a1 = await info();
  await page.screenshot({ path: `local/nested/${tag}-load-after.png` });
  console.log(`load pair: levels ${a0.live} -> ${a1.live}; local/nested/${tag}-load-before.png local/nested/${tag}-load-after.png`);
});
