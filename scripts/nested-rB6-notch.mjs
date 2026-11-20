// Nested scales (round 32 step B6): notches in the ?cliff=5 march (?cliffGap=1), at rB2's poses (side16, side2, foot; the
// steepest root step) at T 2: per pose a still with no notches and with each named set (cliffbox.ts NOTCH_SETS: middle,
// many, every; switched at run time through the box pass's notch uniform), the closure count (holes below the horizon).
// node scripts/nested-rB6-notch.mjs --chromeargs ignore-certificate-errors --port 5461 [--only side2] [--tag rB6]
import { run, sleep } from './lib/runner.mjs';
import fs from 'node:fs';

/** (a copy of cliffbox.ts NOTCH_SETS: the page does not expose the module) */
const SETS = {
  none: { on: false, pct: [0, 0, 0, 0, 0, 0, 0], dep: [0, 1, 1, 1, 1, 1, 1], frac: [0.1, 0.9], slotLog: 2 },
  middle: { on: true, pct: [0, 25, 25, 0, 0, 0, 0], dep: [0, 2, 3, 4, 4, 4, 4], frac: [0.1, 0.9], slotLog: 2 },
  many: { on: true, pct: [0, 50, 40, 0, 0, 0, 0], dep: [0, 4, 4, 4, 4, 4, 4], frac: [0.1, 0.9], slotLog: 2 },
  every: { on: true, pct: [0, 30, 25, 20, 15, 15, 15], dep: [0, 2, 3, 4, 4, 4, 4], frac: [0.1, 0.9], slotLog: 2 },
  // (the owner's preference: fine columns and more notches; with --extra '&cliffAmp=0,256,256,256,256,256,256&cliffWLv=5')
  fine: { on: true, pct: [0, 30, 25, 25, 20, 20, 20], dep: [0, 2, 3, 4, 4, 4, 4], frac: [0.1, 0.9], slotLog: 2 },
};

await run({ name: 'rB6-notch', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const tag = R.opt('tag', 'rB6');
  const only = R.opt('only', '').split(',').filter(Boolean);
  const sets = R.opt('sets', 'none,middle,many,every').split(',');
  fs.mkdirSync('local/nested', { recursive: true });
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`[page exception] ${e.message}`));
  await page.goto(`https://localhost:${port}/nested.html?cliff=5&smooth=1&cliffT=${R.opt('T', '2')}&cliffGap=1&cliffNotch=middle${R.opt('extra', '')}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.pipesReady && nested.app.genReady && nested.app.frameCount > 30, { timeout: 180000, polling: 200 });
  await page.waitForFunction(() => nested.app.render.texDrawn && nested.app.render.cliffBox && nested.app.render.cliffBox.ready, { timeout: 120000, polling: 200 });
  const settle = async (minLive = 0) => {
    for (let i = 0; i < 400; i++) {
      await sleep(150);
      const ok = await page.evaluate((m) => nested.app.nest.settled && !nested.app.nest.switching && !nested.app.nest.fieldJob && nested.app.nest.live >= m, minLive);
      if (ok && i > 10) break;
    }
    await sleep(800);
  };
  const look = (eye, at) => {
    const d = [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]];
    const n = Math.hypot(...d);
    return { yaw: Math.atan2(-d[1], -d[0]), pitch: Math.asin(-d[2] / n), eye };
  };
  const holes = (pitch) =>
    page.evaluate(async (pitch) => {
      const hl = await nested.holes();
      const tn = Math.tan((50 * Math.PI) / 360);
      let cnt = 0;
      for (let y = 0; y < hl.h; y++) {
        const ny = 1 - ((y + 0.5) / hl.h) * 2;
        const dz = -Math.sin(pitch) + ny * tn * Math.cos(pitch);
        if (dz / Math.hypot(1, ny * tn) < -0.1) cnt += hl.rows[y];
      }
      return cnt;
    }, pitch);
  const setSet = (s) =>
    page.evaluate(async (s) => {
      nested.app.render.cliffBox.setNotch(s);
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(res))));
    }, s);
  // (rB2's site: the steepest root step of the root window's middle)
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
  const C = [spot.x + 0.5 + spot.dir[0] * 0.5, spot.y + 0.5 + spot.dir[1] * 0.5];
  const zMid = (spot.hi + spot.lo) / 2;
  const perp = [-spot.dir[1], spot.dir[0]];
  const side = (D, up, along = 0.35) => look([C[0] + spot.dir[0] * D + perp[0] * D * along, C[1] + spot.dir[1] * D + perp[1] * D * along, zMid + up], [C[0], C[1], zMid]);
  const poses = {
    side2: [side(1.5, 0.3), 3],
    side16: [side(8, 1.6), 2],
    foot: [look([C[0] + spot.dir[0] * 0.25 + perp[0] * 0.05, C[1] + spot.dir[1] * 0.25 + perp[1] * 0.05, spot.lo + 0.04], [C[0], C[1], spot.hi]), 3],
  };
  for (const [name, [v, minLive]] of Object.entries(poses)) {
    if (only.length && !only.includes(name)) continue;
    await page.evaluate((v) => nested.setView(v), v);
    await settle(minLive);
    const out = [];
    for (const sn of sets) {
      await setSet(SETS[sn]);
      await sleep(250);
      await page.screenshot({ path: `local/nested/${tag}-${name}-${sn}.png` });
      out.push(`${sn} holes ${await holes(v.pitch)}`);
    }
    console.log(`  ${name}: ${out.join('; ')}`);
  }
});
