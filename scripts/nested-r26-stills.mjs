// Nested scales (round 26, steps C-E): the field mesh against the sheets, side by side, and its visual-closure check.
// Per variant a fresh page (sheets: ?smooth=1; field: &field=<level>), the same scene: the root window's steepest land
// step (--below m: steps whose top is under it, so a land cliff, not a crystal spire; r25's fang spot at level 1), a
// bowl carved at the field level near the step, a cave carved under the ground beside it with a side pocket (an
// overhang), then the poses, each a still local/nested/r26-<pose>-<variant>.png and, below the horizon, the pixels where
// nothing was drawn (the sky or the clear colour): the visual-closure count (a cave's poses count every pixel).
//   bowl      the carved bowl's rim from 30 degrees up
//   cliff     the generated step from the side
//   overhang  inside the bowl, looking into the side pocket under its lip
//   cave      inside the closed cave
//   above     straight down at the field level
//   grazing   a few metres over the ground, nearly level
//   border-in / border-out   across the field level's window edge from about 30 m, from inside and from outside
// node scripts/nested-r26-stills.mjs --chromeargs ignore-certificate-errors --port 5461 [--level 3] [--order sheets,field]
//   [--below 200] [--tag r26] [--extra "&tex=0"] [--only bowl,cliff]
import { run, sleep } from './lib/runner.mjs';
import fs from 'node:fs';

await run({ name: 'r26-stills', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const L = Number(R.opt('level', '3'));
  const tag = R.opt('tag', 'r26');
  const only = R.opt('only', '').split(',').filter(Boolean);
  fs.mkdirSync('local/nested', { recursive: true });
  const totals = {};
  for (const variant of R.opt('order', 'sheets,field').split(',')) {
    const [kind, vx = ''] = variant.split('~');
    const page = await R.page();
    page.on('console', (m) => {
      if (m.type() === 'error') console.log(`[page ${m.type()}] ${m.text()}`);
    });
    page.on('pageerror', (e) => console.log(`[page exception] ${e.message}`));
    await page.goto(`https://localhost:${port}/nested.html?smooth=1${kind === 'field' ? `&field=${L}` : ''}${R.opt('extra', '')}${vx}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.nested && nested.app.pipesReady && nested.app.genReady && nested.app.fieldDone && nested.app.frameCount > 30, { timeout: 300000, polling: 200 });
    const settle = async (live) => {
      for (let i = 0; i < 160; i++) {
        await sleep(150);
        const st = await page.evaluate(() => ({ live: nested.app.nest.live, ok: nested.app.nest.settled && !nested.app.nest.switching }));
        if ((live === undefined || st.live >= live) && st.ok && i > 10) break;
      }
      await sleep(600);
    };
    // the spot: the steepest step whose top is under --below metres (root columns)
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
    }, Number(R.opt('below', '200')) / 128);
    const dz = [0.9 * 32, 0.3 * 32, 0.3 * 4, 0.3 * 0.5];
    const zx = spot.x + 0.5 - spot.dir[0] * 1.5;
    const zy = spot.y + 0.5 - spot.dir[1] * 1.5;
    const yaw0 = Math.atan2(spot.dir[1], spot.dir[0]) + 0.5;
    await page.evaluate((v) => nested.setView(v), { tx: zx, ty: zy, d: dz[L], pitch: 0.95, yaw: yaw0 });
    await settle(L + 1);
    // (the r25 zoom pose itself, before any carve: r25-zoom-L1's fang location at --level 1 --below 200)
    if (!only.length || only.includes('zoom')) {
      await page.evaluate(() => (nested.app.frozen = true));
      await sleep(400);
      const file = `local/nested/${tag}-zoom-${variant.replace(/[^a-z0-9]+/gi, '_')}.png`;
      await page.screenshot({ path: file });
      await page.evaluate(() => (nested.app.frozen = false));
      console.log(`${variant} zoom: ${file}`);
    }
    // the scene at level L: positions from its window and its columns (world = root columns; level L's global column / k^L)
    const scene = await page.evaluate(async (L) => {
      const a = nested.app;
      const k = a.k;
      const s = await a.nest.readAll();
      const w = a.nest.wins[L];
      let zo = 0;
      for (let j = 1; j <= L; j++) zo += s.zOrigin(j) / k ** (j - 1);
      const top = (X, Y) => {
        const c = s.column(L, X, Y);
        return c.z1.length ? c.z1[c.z1.length - 1] : 0;
      };
      // the bowl and the cave a quarter of the window from its centre toward the eye's side, the ground's height there
      const bx = Math.round(w.n * 0.38);
      const by = Math.round(w.n * 0.5);
      const cx = Math.round(w.n * 0.62);
      const cy = Math.round(w.n * 0.5);
      const S = k ** L;
      return { L, k, S, w, zo, bowl: [bx, by, top(w.gx + bx, w.gy + by)], cave: [cx, cy, top(w.gx + cx, w.gy + cy)] };
    }, L);
    const toWorld = (lx, ly, lz) => [(scene.w.gx + lx) / scene.S, (scene.w.gy + ly) / scene.S, scene.zo + lz / scene.S];
    // the carves (level L columns): a bowl radius 10 columns centred 4 under the ground; a cave radius 7 centred 14 under
    // and a pocket radius 6 beside the bowl's wall, 9 under, reaching under its rim (the overhang)
    const R0 = 10;
    await page.evaluate(
      async ({ sc, R0 }) => {
        const a = nested.app;
        const ed = async (x, y, z, r) => {
          while (!a.nest.edit({ op: 'carve', radius: r / sc.S, amount: 1, at: { level: sc.L, x: x + 0.5, y: y + 0.5, z } })) await new Promise((res) => setTimeout(res, 50));
          for (let i = 0; i < 40 && !(a.nest.settled && !a.nest.switching); i++) await new Promise((res) => setTimeout(res, 50));
        };
        await ed(sc.bowl[0], sc.bowl[1], sc.bowl[2] - 4, R0);
        await ed(sc.bowl[0] + 13, sc.bowl[1], sc.bowl[2] - 9, 6);
        await ed(sc.cave[0], sc.cave[1], sc.cave[2] - 14, 7);
      },
      { sc: scene, R0 },
    );
    await sleep(1500);
    const look = (eye, at) => {
      const d = [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]];
      const n = Math.hypot(...d);
      return { yaw: Math.atan2(-d[1], -d[0]), pitch: Math.asin(-d[2] / n), eye };
    };
    const b = scene.bowl;
    const c = scene.cave;
    const n = scene.w.n;
    const m30 = (30 / 0.25) * (L === 3 ? 1 : 0.25 / (2 ** (3 * (3 - L)) * 0.25)); // 30 m in level L columns
    const colM = 128 / scene.S; // metres a level-L column
    const c30 = 30 / colM;
    void m30;
    const poses = {
      bowl: look(toWorld(b[0] - 1.6 * R0, b[1] - 1.6 * R0, b[2] + 1.2 * R0), toWorld(b[0], b[1], b[2] - 4)),
      cliff: look(toWorld(n / 2 - spot.dir[0] * n * 0.05 + spot.dir[1] * n * 0.2, n / 2 - spot.dir[1] * n * 0.05 - spot.dir[0] * n * 0.2, b[2] + 6), toWorld(n / 2, n / 2, b[2] - 6)),
      overhang: look(toWorld(b[0] - 2, b[1], b[2] - 6), toWorld(b[0] + 13, b[1], b[2] - 9)),
      cave: look(toWorld(c[0], c[1], c[2] - 14), toWorld(c[0] + 5, c[1] + 2, c[2] - 15)),
      above: look(toWorld(n / 2, n / 2 + 1, b[2] + c30), toWorld(n / 2, n / 2, b[2])),
      // (300 m up, 30 degrees down: the material borders from afar)
      above300: look(toWorld(n / 2 - 10 * c30 * 0.87, n / 2, b[2] + 10 * c30 * 0.5), toWorld(n / 2, n / 2, b[2])),
      grazing: look(toWorld(n * 0.3, n * 0.3, b[2] + 6), toWorld(n * 0.7, n * 0.7, b[2])),
      'border-in': look(toWorld(n * 0.5, n - c30 * 0.6, b[2] + c30 * 0.5), toWorld(n * 0.5, n + c30 * 0.4, b[2])),
      'border-out': look(toWorld(n * 0.5, n + c30 * 0.6, b[2] + c30 * 0.5), toWorld(n * 0.5, n - c30 * 0.4, b[2])),
    };
    for (const [name, v] of Object.entries(poses)) {
      if (only.length && !only.includes(name)) continue;
      await page.evaluate((v) => nested.setView(v), v);
      await settle();
      await page.evaluate(() => (nested.app.frozen = true));
      await sleep(400);
      const file = `local/nested/${tag}-${name}-${variant.replace(/[^a-z0-9]+/gi, '_')}.png`;
      await page.screenshot({ path: file });
      // the closure count: holes below the horizon (the cave: every pixel)
      const h = await page.evaluate(
        async ({ pitch, all }) => {
          const hl = await nested.holes();
          const tn = Math.tan((50 * Math.PI) / 360);
          let cnt = 0;
          for (let y = 0; y < hl.h; y++) {
            const ny = 1 - ((y + 0.5) / hl.h) * 2;
            const dz = -Math.sin(pitch) + ny * tn * Math.cos(pitch);
            if (all || dz / Math.hypot(1, ny * tn) < -0.1) cnt += hl.rows[y];
          }
          return { cnt, live: nested.app.nest.live, eye: nested.eye() };
        },
        { pitch: v.pitch, all: name === 'cave' },
      );
      await page.evaluate(() => (nested.app.frozen = false));
      totals[variant] = (totals[variant] ?? 0) + h.cnt;
      console.log(`${variant} ${name}: ${h.cnt} hole pixels ${name === 'cave' ? '(all)' : 'below the horizon'}; levels ${h.live}; eye ${(h.eye.dNear * 128).toFixed(1)} m from the nearest surface; ${file}`);
    }
    await page.close();
  }
  console.log(`closure totals: ${JSON.stringify(totals)}`);
});
