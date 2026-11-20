// Nested scales (round 29): the field mesh reading the stored edge line (?fedge=1) against not (?fedge=0), at the same
// poses with the same windows. Per variant a fresh page with the field mesh on levels 1-3 (?field=1,2,3); at level 3 near
// the root window's steepest land step (r26's spot): a ball carved centred AT the ground (a sharp rim), a stroke at 27
// degrees to the grid (a trench), two overlapping bowls. The first variant's carve positions (world units) and each pose's
// windows are kept and the later variants placed on them (levels slid to the same windows, the app frozen), so each pair
// shows the same ground. Per pose a still local/nested/<tag>-<pose>-<variant>.png and the hole pixels below the horizon
// (visual closure). Then per level the field's candidate cells a column (the chunk headers) and the whole level 3 rebuilt
// 3 times in one submit (wall ms to the queue's done, back to back per variant).
//   rimAbove   the bowl from straight above, the whole rim in view
//   rimGraze   the bowl's rim from a column over the ground, nearly level
//   trench     the trench from above
//   cross      the two bowls' crossing from above
// node scripts/nested-r29-stills.mjs --chromeargs ignore-certificate-errors --port 5461
//   [--order "field~&fedge=0,field~&fedge=1,field~&fedge=0&tex=0,field~&fedge=1&tex=0"] [--tag r29] [--only rimAbove]
import { run, sleep } from './lib/runner.mjs';
import fs from 'node:fs';

await run({ name: 'r29-stills', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const L = 3;
  const tag = R.opt('tag', 'r29');
  const only = R.opt('only', '').split(',').filter(Boolean);
  fs.mkdirSync('local/nested', { recursive: true });
  const totals = {};
  let pinned = null; // { carves (world), poses: { name: { view, wins } } }
  for (const variant of R.opt('order', 'field~&fedge=0,field~&fedge=1,field~&fedge=0&tex=0,field~&fedge=1&tex=0').split(',')) {
    const [, vx = ''] = variant.split('~');
    const page = await R.page();
    page.on('console', (m) => {
      if (m.type() === 'error') console.log(`[page ${m.type()}] ${m.text()}`);
    });
    page.on('pageerror', (e) => console.log(`[page exception] ${e.message}`));
    await page.goto(`https://localhost:${port}/nested.html?smooth=1&field=1,2,3${R.opt('extra', '')}${vx}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.nested && nested.app.pipesReady && nested.app.genReady && nested.app.fieldDone && nested.app.frameCount > 30, { timeout: 300000, polling: 200 });
    const settle = async (live) => {
      for (let i = 0; i < 200; i++) {
        await sleep(150);
        const st = await page.evaluate(() => ({ live: nested.app.nest.live, ok: nested.app.nest.settled && !nested.app.nest.switching && !nested.app.nest.fieldJob }));
        if ((live === undefined || st.live >= live) && st.ok && i > 10) break;
      }
      await sleep(600);
    };
    // (levels held: the app frozen, each level slid to the pinned window, parents first, the field jobs run out)
    const pin = async (wins) =>
      page.evaluate(async (wins) => {
        const a = nested.app;
        const nest = a.nest;
        a.frozen = true;
        const idle = async () => {
          for (let i = 0; i < 3000; i++) {
            if (nest.settled && !nest.fieldJob && !nest.switching) return;
            if (nest.settled && nest.fieldJob) nest.stepField(a.ex * a.k ** nest.fieldJob.L, a.ey * a.k ** nest.fieldJob.L);
            await new Promise((r) => setTimeout(r, 20));
          }
        };
        await idle();
        for (let m = 1; m < wins.length && m < nest.live; m++) {
          const w = nest.wins[m];
          if (w.gx === wins[m].gx && w.gy === wins[m].gy && w.n === wins[m].n) continue;
          for (let t = 0; t < 400 && !nest.slide(m, wins[m]); t++) await new Promise((r) => setTimeout(r, 20));
          await idle();
        }
        await new Promise((r) => setTimeout(r, 300));
        return nest.wins.slice(0, nest.live).map((w) => ({ ...w }));
      }, wins);
    // the spot: r26's (the root window's steepest land step under 200 m), the view over it at level 3's distance
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
      return best;
    }, 200 / 128);
    // (away from the step itself: 6 root columns back from it, onto the step's low side's flatter ground)
    const zx = spot.x + 0.5 - spot.dir[0] * 6;
    const zy = spot.y + 0.5 - spot.dir[1] * 6;
    await page.evaluate((v) => nested.setView(v), { tx: zx, ty: zy, d: 0.3 * 0.5, pitch: 0.95, yaw: 0.4 });
    await settle(L + 1);
    if (pinned) await pin(pinned.carveWins);
    const carveWins = await page.evaluate(() => nested.app.nest.wins.slice(0, nested.app.nest.live).map((w) => ({ ...w })));
    // the carves at level 3 (positions in world units = root columns, kept from the first variant)
    const sc = await page.evaluate(
      async ({ L, keep }) => {
        const a = nested.app;
        const k = a.k;
        const S = k ** L;
        const s = await a.nest.readAll();
        const w = a.nest.wins[L];
        let zo = 0;
        for (let j = 1; j <= L; j++) zo += s.zOrigin(j) / k ** (j - 1);
        const top = (X, Y) => {
          const c = s.column(L, Math.floor(X), Math.floor(Y));
          return c.z1.length ? c.z1[c.z1.length - 1] : 0;
        };
        // (level-3 global columns; from the kept world positions, or a third of the window round its centre)
        const P = keep
          ? keep.map(([x, y]) => [x * S, y * S])
          : [
              [w.gx + w.n * 0.32 + 0.37, w.gy + w.n * 0.5 - 0.19],
              [w.gx + w.n * 0.68 + 0.21, w.gy + w.n * 0.3 + 0.13],
              [w.gx + w.n * 0.66 + 0.29, w.gy + w.n * 0.7 - 0.31],
            ];
        const ed = async (x, y, z, r) => {
          while (!a.nest.edit({ op: 'carve', radius: r / S, amount: 1, at: { level: L, x: x - w.gx, y: y - w.gy, z } })) await new Promise((res) => setTimeout(res, 50));
          for (let i = 0; i < 80 && !(a.nest.settled && !a.nest.switching); i++) await new Promise((res) => setTimeout(res, 50));
        };
        const zs = P.map(([x, y]) => top(x, y));
        // the bowl: radius 10.3 columns, centred at the ground (its rim a sharp vertical edge)
        await ed(P[0][0], P[0][1], zs[0], 10.3);
        // the trench: a stroke of radius 4, 32 columns long, at 27 degrees, centred at the ground
        const ang = (27 * Math.PI) / 180;
        a.nest.strokeBegin();
        await ed(P[1][0] - 16 * Math.cos(ang), P[1][1] - 16 * Math.sin(ang), zs[1], 4);
        await ed(P[1][0] + 16 * Math.cos(ang), P[1][1] + 16 * Math.sin(ang), zs[1], 4);
        a.nest.strokeEnd();
        // two overlapping bowls, radius 8, 10.5 columns apart
        await ed(P[2][0] - 5.25, P[2][1], zs[2], 8);
        await ed(P[2][0] + 5.25, P[2][1] + 1.3, zs[2], 8);
        return { S, zo, P, zs, w: { ...w }, world: P.map(([x, y]) => [x / S, y / S]) };
      },
      { L, keep: pinned ? pinned.world : null },
    );
    await settle();
    const toWorld = (X, Y, z) => [X / sc.S, Y / sc.S, sc.zo + z / sc.S];
    const look = (eye, at) => {
      const d = [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]];
      const n = Math.hypot(...d);
      return { yaw: Math.atan2(-d[1], -d[0]), pitch: Math.asin(-d[2] / n), eye };
    };
    const [B, T, C] = sc.P;
    const poses = {
      rimAbove: look(toWorld(B[0], B[1] + 0.5, sc.zs[0] + 30), toWorld(B[0], B[1], sc.zs[0])),
      rimGraze: look(toWorld(B[0] - 24, B[1] - 7, sc.zs[0] + 1.2), toWorld(B[0], B[1], sc.zs[0] - 1)),
      trench: look(toWorld(T[0], T[1] + 0.5, sc.zs[1] + 42), toWorld(T[0], T[1], sc.zs[1])),
      cross: look(toWorld(C[0], C[1] + 0.5, sc.zs[2] + 26), toWorld(C[0], C[1], sc.zs[2])),
    };
    const poseWins = {};
    for (const [name, v] of Object.entries(poses)) {
      if (only.length && !only.includes(name)) continue;
      await page.evaluate((v) => nested.setView(v), v);
      await settle();
      const wins = pinned?.poseWins?.[name] ? await pin(pinned.poseWins[name]) : await pin([]);
      poseWins[name] = wins;
      await sleep(400);
      const file = `local/nested/${tag}-${name}-${variant.replace(/^field~&?/, '').replace(/[^a-z0-9]+/gi, '_')}.png`;
      await page.screenshot({ path: file });
      const h = await page.evaluate(async ({ pitch }) => {
        const hl = await nested.holes();
        const tn = Math.tan((50 * Math.PI) / 360);
        let cnt = 0;
        for (let y = 0; y < hl.h; y++) {
          const ny = 1 - ((y + 0.5) / hl.h) * 2;
          const dz = -Math.sin(pitch) + ny * tn * Math.cos(pitch);
          if (dz / Math.hypot(1, ny * tn) < -0.1) cnt += hl.rows[y];
        }
        return { cnt, live: nested.app.nest.live, miss: nested.app.nest.stats.fieldMiss ?? 0 };
      }, { pitch: v.pitch });
      await page.evaluate(() => (nested.app.frozen = false));
      totals[variant] = (totals[variant] ?? 0) + h.cnt;
      console.log(`${variant} ${name}: ${h.cnt} hole pixels below the horizon; levels ${h.live}; fieldMiss ${h.miss}; windows ${wins.map((w) => `${w.gx},${w.gy}`).join(' ')}; ${file}`);
    }
    // the cost: candidate cells a column per field level (the chunk headers' word 4) and level 3 rebuilt whole, 3 times
    const cost = await page.evaluate(async () => {
      const a = nested.app;
      const nest = a.nest;
      a.frozen = true;
      for (let i = 0; i < 400 && !(nest.settled && !nest.fieldJob); i++) await new Promise((r) => setTimeout(r, 20));
      const s = await nest.readAll();
      const PW = 12544;
      const per = [];
      for (let m = 1; m < nest.live; m++) {
        const w = nest.wins[m];
        let c = 0;
        for (let cy = w.gy / 16; cy < (w.gy + w.n) / 16; cy++)
          for (let cx = w.gx / 16; cx < (w.gx + w.n) / 16; cx++) {
            const hp = s.page(24 + m, cx, cy, 0);
            if (hp >= 0) c += s.pg[hp * PW + 4];
          }
        per.push(+(c / (w.n * w.n)).toFixed(3));
      }
      const ms = [];
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        nest.rebakeLevel(nest.live - 1, true);
        await a.device.queue.onSubmittedWorkDone();
        ms.push(+(performance.now() - t0).toFixed(1));
      }
      a.frozen = false;
      return { per, ms, miss: nest.stats.fieldMiss ?? 0 };
    });
    console.log(`${variant} cost: candidate cells a column, levels 1..: ${cost.per.join(', ')}; level 3 rebuilt whole: ${cost.ms.join(' / ')} ms; fieldMiss ${cost.miss}`);
    if (!pinned) pinned = { world: sc.world, carveWins, poseWins };
    await page.close();
  }
  console.log(`closure totals: ${JSON.stringify(totals)}`);
});
