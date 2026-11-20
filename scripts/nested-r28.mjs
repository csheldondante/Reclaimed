// Nested scales (round 28): the field mesh on levels 1-3 against the sheets at the owner's phone situations.
// Per variant (sheets: ?smooth=1; field: ?smooth=1&field=1,2,3) a fresh page, the same scene: the root window's steepest
// land step (as round 26), a bowl carved at the 2 m level beside it, then the poses (the phone screenshots of round 28):
//   rim100     the carved bowl's rim at the 2 m level from about 100 m up, 50 degrees down
//   cliff600   the generated step at the 16 m level from about 600 m, 45 degrees down
//   pillar190  the step's land from about 190 m (3 levels open: the 128 m pillars of the phone's image 2)
//   border2m   a material border at the 2 m level from about 100 m straight down
// Each still local/nested/<tag>-<pose>-<variant>.png and its hole pixels below the horizon (the visual-closure count).
// node scripts/nested-r28.mjs --chromeargs ignore-certificate-errors --port 5461 [--order sheets,field] [--runs 1]
//   [--tag r28] [--extra "&tex=1"] [--only rim100,cliff600] [--size 446x1000]
import { run, sleep } from './lib/runner.mjs';
import fs from 'node:fs';

await run({ name: 'r28', kind: 'behaviour', size: '446x1000', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const tag = R.opt('tag', 'r28');
  const only = R.opt('only', '').split(',').filter(Boolean);
  const runs = Number(R.opt('runs', '1'));
  fs.mkdirSync('local/nested', { recursive: true });
  const totals = {};
  for (let rep = 0; rep < runs; rep++)
    for (const variant of R.opt('order', 'sheets,field').split(',')) {
      const page = await R.page();
      page.on('console', (m) => {
        const t = m.text();
        if (m.type() === 'error' || t.startsWith('[field]') || t.startsWith('[r28]')) console.log(`[page ${m.type()}] ${t}`);
      });
      page.on('pageerror', (e) => console.log(`[page exception] ${e.message}`));
      const fieldQ = variant === 'field' ? '&field=1,2,3' : variant === 'sheets' ? '' : `&${variant}`;
      await page.goto(`https://localhost:${port}/nested.html?smooth=1${fieldQ}${R.opt('extra', '')}`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.nested && nested.app.pipesReady && nested.app.genReady && nested.app.fieldDone && nested.app.frameCount > 30, { timeout: 300000, polling: 200 });
      const settle = async (live) => {
        for (let i = 0; i < 200; i++) {
          await sleep(150);
          const st = await page.evaluate(() => ({ live: nested.app.nest.live, ok: nested.app.nest.settled && !nested.app.nest.switching && !nested.app.nest.fieldJob }));
          if ((live === undefined || st.live >= live) && st.ok && i > 10) break;
        }
        await sleep(600);
      };
      const spot = await page.evaluate(async (below) => {
        const a = nested.app;
        const s = await a.nest.readAll();
        const w = a.nest.wins[0];
        const top = (X, Y) => {
          const c = s.column(0, X, Y);
          return c.z1[c.z1.length - 1];
        };
        let best = { x: 0, y: 0, step: 0, dir: [1, 0] };
        for (let y = w.gy + 40; y < w.gy + w.n - 40; y++)
          for (let x = w.gx + 40; x < w.gx + w.n - 40; x++) {
            if (top(x, y) > below) continue;
            for (const d of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
              const st = top(x, y) - top(x + d[0], y + d[1]);
              if (st > best.step) best = { x, y, step: st, dir: d };
            }
          }
        return { ...best, top: top(best.x, best.y) };
      }, 200 / 128);
      // the 2 m level open over the step's foot, 100 m up
      const sx = spot.x + 0.5 + spot.dir[0] * 2.5;
      const sy = spot.y + 0.5 + spot.dir[1] * 2.5;
      const yaw0 = Math.atan2(spot.dir[1], spot.dir[0]) + 0.5;
      await page.evaluate((v) => nested.setView(v), { tx: sx, ty: sy, d: 100 / 128, pitch: 0.9, yaw: yaw0 });
      await settle(3);
      // (variant 'button': the sheets' page switched to the field mesh by the button, the frames meanwhile)
      if (variant === 'button') {
        const sw = await page.evaluate(async () => {
          const a = nested.app;
          const t0 = performance.now();
          while (!a.fieldDone || !a.nest.fieldMade) {
            a.setField(true);
            await new Promise((r) => setTimeout(r, 50));
          }
          const tMade = performance.now();
          const f0 = a.frameCount;
          a.frames.length = 0;
          await nested.field(true);
          for (let i = 0; i < 400 && (a.nest.live < 3 || a.nest.fieldJob || !a.nest.settled); i++) await new Promise((r) => setTimeout(r, 50));
          return { waitMade: tMade - t0, frames: a.frameCount - f0, worst: Math.max(...a.frames), ms: performance.now() - tMade, live: a.nest.live, mask: a.nest.fieldMask };
        });
        console.log(`button: pipelines ready after ${sw.waitMade.toFixed(0)} ms more; switch and reopen ${sw.ms.toFixed(0)} ms, ${sw.frames} frames, worst frame ${sw.worst.toFixed(1)} ms; levels ${sw.live}, mask ${sw.mask}`);
        await settle(3);
      }
      // a bowl at level 2 (2 m columns) at the window's centre: radius 15 columns (30 m), its centre 5 under the ground
      const sc = await page.evaluate(async () => {
        const a = nested.app;
        const L = 2;
        const s = await a.nest.readAll();
        const w = a.nest.wins[L];
        let zo = 0;
        for (let j = 1; j <= L; j++) zo += s.zOrigin(j) / a.k ** (j - 1);
        const S = a.k ** L;
        const bx = Math.round(w.n / 2);
        const by = Math.round(w.n / 2);
        const c = s.column(L, w.gx + bx, w.gy + by);
        const top = c.z1[c.z1.length - 1];
        while (!a.nest.edit({ op: 'carve', radius: 15 / S, amount: 1, at: { level: L, x: bx + 0.5, y: by + 0.5, z: top - 5 } })) await new Promise((r) => setTimeout(r, 50));
        return { L, S, w, zo, b: [bx, by, top] };
      });
      await settle();
      const toWorld = (lx, ly, lz) => [(sc.w.gx + lx) / sc.S, (sc.w.gy + ly) / sc.S, sc.zo + lz / sc.S];
      const look = (eye, at) => {
        const d = [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]];
        const n = Math.hypot(...d);
        return { yaw: Math.atan2(-d[1], -d[0]), pitch: Math.asin(-d[2] / n), eye };
      };
      const b = toWorld(sc.b[0], sc.b[1], sc.b[2]);
      const m = 1 / 128;
      const poses = {
        rim100: look([b[0] - 60 * m, b[1] - 35 * m, b[2] + 100 * m], [b[0], b[1], b[2] - 6 * m]),
        border2m: look([b[0] + 80 * m, b[1] + 0.5 * m, b[2] + 100 * m], [b[0] + 80 * m, b[1], b[2]]),
        pillar190: look([spot.x + 0.5 - spot.dir[0] * 1.2 - spot.dir[1] * 0.8, spot.y + 0.5 - spot.dir[1] * 1.2 + spot.dir[0] * 0.8, spot.top + 190 * m], [spot.x + 0.5 + spot.dir[0], spot.y + 0.5 + spot.dir[1], spot.top - 0.3]),
        cliff600: look([spot.x + 0.5 - spot.dir[0] * 4 - spot.dir[1] * 2, spot.y + 0.5 - spot.dir[1] * 4 + spot.dir[0] * 2, spot.top + 600 * m], [spot.x + 0.5 + spot.dir[0], spot.y + 0.5 + spot.dir[1], spot.top - 0.5]),
      };
      for (const [name, v] of Object.entries(poses)) {
        if (only.length && !only.includes(name)) continue;
        await page.evaluate((v) => nested.setView(v), v);
        await settle();
        await page.evaluate((hud) => {
          nested.app.frozen = true;
          for (const id of ['info', 'bar', 'aim']) {
            const e = document.getElementById(id);
            if (e) e.style.visibility = hud ? '' : 'hidden';
          }
        }, R.flag('hud'));
        await sleep(400);
        const file = `local/nested/${tag}-${name}-${variant.replace(/[^a-z0-9]+/gi, '_')}${runs > 1 ? `-run${rep}` : ''}.png`;
        await page.screenshot({ path: file });
        await page.evaluate(() => {
          for (const id of ['info', 'bar', 'aim']) {
            const e = document.getElementById(id);
            if (e) e.style.visibility = '';
          }
        });
        const h = await page.evaluate(
          async ({ pitch }) => {
            const hl = await nested.holes();
            const tn = Math.tan((50 * Math.PI) / 360);
            let cnt = 0;
            for (let y = 0; y < hl.h; y++) {
              const ny = 1 - ((y + 0.5) / hl.h) * 2;
              const dz = -Math.sin(pitch) + ny * tn * Math.cos(pitch);
              if (dz / Math.hypot(1, ny * tn) < -0.1) cnt += hl.rows[y];
            }
            const st = nested.app.nest.stats;
            return { cnt, live: nested.app.nest.live, eye: nested.eye(), used: st.used, held: st.held, mb: st.mb };
          },
          { pitch: v.pitch },
        );
        await page.evaluate(() => (nested.app.frozen = false));
        const key = `${variant} ${name}`;
        (totals[key] ??= []).push(h.cnt);
        console.log(`${variant} ${name}: ${h.cnt} hole pixels; levels ${h.live}; eye ${(h.eye.dNear * 128).toFixed(0)} m from the nearest surface; pages ${h.used}/${h.held} (${h.mb} MB); ${file}`);
      }
      const fl = await page.evaluate(() => nested.app.nest.fieldLog.slice());
      if (fl.length) console.log(`${variant} field jobs: ${JSON.stringify(fl.map((j) => `${j.L}:${j.chunks}c/${j.frames}f/${j.ms.toFixed(0)}ms`))}`);
      if (R.flag('mem')) {
        const g = await page.evaluate(() => ({ grow: nested.app.nest.growLog.slice(), st: nested.app.nest.stats }));
        console.log(`${variant} grows: ${JSON.stringify(g.grow)}; maxCz ${g.st.maxCz} maxCzField ${g.st.maxCzField} used ${g.st.used} held ${g.st.held}`);
      }
      await page.close();
    }
  console.log(`closure per pose: ${JSON.stringify(totals)}`);
});
