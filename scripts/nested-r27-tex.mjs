// Nested scales (round 27, part 2): ?tex=1 (the function stack) against ?tex=2 (the tiling textures), the same page and
// poses, back to back. Per pose: a still of each (local/nested/<tag>-<pose>-tex1|tex2.png, the HUD hidden) and the draw's
// time (nested.benchDraw: the frame's draw alone, uncapped, GPU done; median of 3 alternations of 10 draws each).
// Poses (the root window's steepest step: a bare stone cliff; flat sand and soil found from the columns):
//   cliff5 / cliff100   the cliff from 5 m and from 100 m
//   sand2 / soil2       flat sand, flat soil (or plants) from 2 m
//   border10            the nearest border between two top materials at the finest level, from 10 m
//   grazing             across flat ground, nearly level, from 1.5 m up
//   bowl                a bowl carved at the finest level (2.5 m radius) from 6 m
//   high300             the cliff's surroundings from 300 m
// node scripts/nested-r27-tex.mjs --chromeargs ignore-certificate-errors --port 5461 [--tag r27] [--extra "&field=finest"]
//   [--only a,b] [--bench 0]
import { run, sleep } from './lib/runner.mjs';
import fs from 'node:fs';

await run({ name: 'r27-tex', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const tag = R.opt('tag', 'r27');
  const only = R.opt('only', '').split(',').filter(Boolean);
  const bench = R.opt('bench', '1') === '1';
  const page = await R.page();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning' || m.text().startsWith('[tex')) console.log(`[page ${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`[page exception] ${e.message}`));
  await page.goto(`https://localhost:${port}/nested.html?smooth=1&tex=2${R.opt('extra', '')}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.pipesReady && nested.app.genReady && nested.app.fieldDone && nested.app.render.texDrawn2 && nested.app.frameCount > 30, { timeout: 300000, polling: 200 });
  await page.evaluate(() => {
    for (const id of ['info', 'bar', 'aim']) {
      const e = document.getElementById(id);
      if (e) e.style.display = 'none';
    }
  });
  // (settled: no op in flight, the wanted levels open and, given the pose's distance in metres, the eye within 3 x of it)
  const settle = async (live, dm) => {
    for (let i = 0; i < 240; i++) {
      await sleep(150);
      const st = await page.evaluate(() => ({ live: nested.app.nest.live, d: nested.eye().dNear * 128, ok: nested.app.nest.settled && !nested.app.nest.switching && !nested.app.nest.fieldJob }));
      if ((live === undefined || st.live >= live) && (dm === undefined || st.d < 3 * dm + 2) && st.ok && i > 12) break;
    }
    await sleep(800);
  };
  // the root: the steepest step (a bare cliff), a flat sand and a flat soil (or plants) column near it
  const spot = await page.evaluate(async () => {
    const a = nested.app;
    const s = await a.nest.readAll();
    const w = a.nest.wins[0];
    const top = (X, Y) => {
      const c = s.column(0, X, Y);
      return c.z1[c.z1.length - 1];
    };
    const mat = (X, Y) => {
      const r = s.records(0, X, Y);
      for (let j = r.mat.length - 1; j >= 0; j--) if ((r.mat[j] & 255) !== 0) return r.mat[j] & 15;
      return 0;
    };
    let best = { x: 0, y: 0, step: 0, dir: [1, 0] };
    for (let y = w.gy + 40; y < w.gy + w.n - 40; y++)
      for (let x = w.gx + 40; x < w.gx + w.n - 40; x++)
        for (const d of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
          const st = top(x, y) - top(x + d[0], y + d[1]);
          if (st > best.step) best = { x, y, step: st, dir: d };
        }
    // flat columns of a material, nearest the step (a 3 x 3 block of it within 3 m of one height)
    const flat = (want) => {
      let b = null;
      for (let y = w.gy + 20; y < w.gy + w.n - 20; y++)
        for (let x = w.gx + 20; x < w.gx + w.n - 20; x++) {
          if (!want.includes(mat(x, y))) continue;
          let ok = true;
          for (let j = -1; j <= 1 && ok; j++) for (let i = -1; i <= 1 && ok; i++) ok = want.includes(mat(x + i, y + j)) && Math.abs(top(x + i, y + j) - top(x, y)) < 3 / 128;
          if (!ok) continue;
          const dd = Math.hypot(x - best.x, y - best.y);
          if (!b || dd < b.d) b = { x, y, d: dd };
        }
      return b;
    };
    return { ...best, sand: flat([3]), soil: flat([2, 5]) };
  });
  console.log('spot', JSON.stringify(spot));
  const L = await page.evaluate(() => nested.app.maxDepth);
  const M = 128;
  const yawTo = (d) => Math.atan2(d[1], d[0]);
  // (setView orbits a target on the ground at (tx, ty), d world units away)
  const wallX = spot.x + 0.5 + spot.dir[0] * 0.5;
  const wallY = spot.y + 0.5 + spot.dir[1] * 0.5;
  const poses = {
    cliff5: { tx: wallX, ty: wallY, d: 5 / M, pitch: 0.12, yaw: yawTo(spot.dir) },
    cliff100: { tx: wallX, ty: wallY, d: 100 / M, pitch: 0.3, yaw: yawTo(spot.dir) + 0.3 },
    sand2: spot.sand && { tx: spot.sand.x + 0.5, ty: spot.sand.y + 0.5, d: 2 / M, pitch: 0.7, yaw: 0.4 },
    soil2: spot.soil && { tx: spot.soil.x + 0.5, ty: spot.soil.y + 0.5, d: 2 / M, pitch: 0.7, yaw: 0.4 },
    border10: { border: true },
    grazing: spot.sand && { tx: spot.sand.x + 0.5, ty: spot.sand.y + 0.5, d: 12 / M, pitch: 0.12, yaw: 1.1 },
    bowl: spot.sand && { bowl: true, tx: spot.sand.x + 0.3, ty: spot.sand.y + 0.3, d: 7 / M, pitch: 0.6, yaw: 0.8 },
    high300: { tx: wallX, ty: wallY, d: 300 / M, pitch: 0.5, yaw: yawTo(spot.dir) + 0.6 },
  };
  fs.mkdirSync('local/nested', { recursive: true });
  const table = [];
  for (const [name, v0] of Object.entries(poses)) {
    if (!v0 || (only.length && !only.includes(name))) continue;
    let v = v0;
    if (v.border) {
      // the nearest border between top materials at the finest level, near the soil spot (or the cliff)
      const c = spot.soil ?? spot.sand ?? { x: spot.x, y: spot.y };
      await page.evaluate((v) => nested.setView(v), { tx: c.x + 0.5, ty: c.y + 0.5, d: 10 / M, pitch: 0.7, yaw: 0.4 });
      await settle(L + 1);
      // (the nearest border at level Lb: the finest first, then coarser windows; found at a coarse level, the eye goes
      // there and the finest level's border is looked for again)
      const find = (Lb) => page.evaluate(async (L) => {
        const a = nested.app;
        const s = await a.nest.readAll();
        const w = a.nest.wins[L];
        const S = a.k ** L;
        const mat = (X, Y) => {
          const r = s.records(L, X, Y);
          for (let j = r.mat.length - 1; j >= 0; j--) if ((r.mat[j] & 255) !== 0) return r.mat[j] & 15;
          return 0;
        };
        const cx = w.gx + w.n / 2;
        const cy = w.gy + w.n / 2;
        let best = null;
        for (let y = w.gy + 8; y < w.gy + w.n - 8; y++)
          for (let x = w.gx + 8; x < w.gx + w.n - 8; x++) {
            if (mat(x, y) === mat(x + 1, y) && mat(x, y) === mat(x, y + 1)) continue;
            const dd = Math.hypot(x - cx, y - cy);
            if (!best || dd < best.d) best = { x, y, d: dd, a: mat(x, y), b: mat(x + 1, y) !== mat(x, y) ? mat(x + 1, y) : mat(x, y + 1) };
          }
        return best && { tx: (best.x + 1) / S, ty: (best.y + 1) / S, mats: [best.a, best.b] };
      }, Lb);
      let b = await find(L);
      for (let Lb = L - 1; !b && Lb >= 1; Lb--) {
        const bc = await find(Lb);
        if (!bc) continue;
        await page.evaluate((v) => nested.setView(v), { tx: bc.tx, ty: bc.ty, d: 10 / M, pitch: 0.7, yaw: 0.4 });
        await settle(L + 1, 10);
        b = await find(L);
      }
      console.log(`border at the finest level: ${JSON.stringify(b)}`);
      if (!b) continue;
      v = { tx: b.tx, ty: b.ty, d: 10 / M, pitch: 0.75, yaw: 0.4 };
    }
    if (v.bowl) {
      await page.evaluate((v) => nested.setView(v), { tx: v.tx, ty: v.ty, d: v.d, pitch: v.pitch, yaw: v.yaw });
      await settle(L + 1);
      await page.evaluate(async ({ v, L }) => {
        const a = nested.app;
        const S = a.k ** L;
        const s = await a.nest.readAll();
        const w = a.nest.wins[L];
        const X = Math.floor(v.tx * S);
        const Y = Math.floor(v.ty * S);
        const c = s.column(L, X, Y);
        const z = c.z1[c.z1.length - 1];
        while (!a.nest.edit({ op: 'carve', radius: 10 / S, amount: 1, at: { level: L, x: X - w.gx + 0.5, y: Y - w.gy + 0.5, z: z - 4 } })) await new Promise((r) => setTimeout(r, 50));
      }, { v, L });
      await settle();
      // (the eye 6 m out from the bowl's centre and 3 m over the ground there, looking at the bowl's floor)
      const e = await page.evaluate(async ({ v, L }) => {
        const a = nested.app;
        const S = a.k ** L;
        const s = await a.nest.readAll();
        let zo = 0;
        for (let j = 1; j <= L; j++) zo += s.zOrigin(j) / a.k ** (j - 1);
        const top = (x, y) => {
          const c = s.column(L, Math.floor(x * S), Math.floor(y * S));
          return zo + c.z1[c.z1.length - 1] / S;
        };
        const ex = v.tx + 6 / 128;
        const ey = v.ty + 1 / 128;
        return { eye: [ex, ey, top(ex, ey) + 3 / 128], at: [v.tx, v.ty, top(v.tx, v.ty)] };
      }, { v, L });
      const dd = [e.at[0] - e.eye[0], e.at[1] - e.eye[1], e.at[2] - e.eye[2]];
      v = { eyeView: { yaw: Math.atan2(-dd[1], -dd[0]), pitch: Math.asin(-dd[2] / Math.hypot(...dd)), eye: e.eye }, d: 3 / M };
    }
    await page.evaluate((v) => nested.setView(v), v.eyeView ?? { tx: v.tx, ty: v.ty, d: v.d, pitch: v.pitch, yaw: v.yaw });
    // (a close pose waits for the finest level)
    await settle(v.d * M < 60 ? L + 1 : undefined, v.d * M);
    await page.evaluate(() => (nested.app.frozen = true));
    const eye = await page.evaluate(() => ({ ...nested.eye(), live: nested.app.nest.live }));
    const row = { pose: name, live: eye.live, dNear: +(eye.dNear * M).toFixed(1) };
    for (const m of [1, 2]) {
      await page.evaluate((m) => nested.texMode(m), m);
      await sleep(300);
      const file = `local/nested/${tag}-${name}-tex${m}.png`;
      await page.screenshot({ path: file });
    }
    if (bench) {
      const t = await page.evaluate(async () => {
        const med = (v) => [...v].sort((x, y) => x - y)[Math.floor(v.length / 2)];
        const o = { 1: [], 2: [] };
        for (let i = 0; i < 6; i++) {
          const m = 1 + (i % 2);
          await nested.texMode(m);
          o[m].push(await nested.benchDraw(10));
        }
        return { t1: med(o[1]), t2: med(o[2]) };
      });
      row.tex1 = +t.t1.toFixed(2);
      row.tex2 = +t.t2.toFixed(2);
    }
    await page.evaluate(() => (nested.app.frozen = false));
    table.push(row);
    console.log(JSON.stringify(row));
  }
  console.log('table', JSON.stringify(table));
});
