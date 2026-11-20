// Nested scales (round 28): where do the square pillars and the material checkerboards at the 2 m level come from?
// Reads the live columns (a readback, measurement only) at the round 28 scene and reports, per level: neighbouring
// columns of different structure (interval count, or a record's material class: matKey), the flat blocks (a parent
// cell's k x k children all at one height with a step at the block's edge: a pillar), and where they are.
// node scripts/nested-r28-pillars.mjs --chromeargs ignore-certificate-errors --port 5461 [--extra ""] [--out r28-pillar]
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'r28-pillars', kind: 'behaviour', size: '446x1000', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const page = await R.page();
  page.on('pageerror', (e) => console.log(`[page exception] ${e.message}`));
  await page.goto(`https://localhost:${port}/nested.html?smooth=1${R.opt('extra', '')}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.nested && nested.app.pipesReady && nested.app.genReady && nested.app.fieldDone && nested.app.frameCount > 30, { timeout: 300000, polling: 200 });
  const settle = async (live) => {
    for (let i = 0; i < 200; i++) {
      await sleep(150);
      const st = await page.evaluate(() => ({ live: nested.app.nest.live, ok: nested.app.nest.settled && !nested.app.nest.switching && !nested.app.nest.fieldJob }));
      if ((live === undefined || st.live >= live) && st.ok && i > 10) break;
    }
    await sleep(600);
  };
  const at = R.opt('at', '');
  if (at) {
    const [tx, ty, d] = at.split(',').map(Number);
    await page.evaluate((v) => nested.setView(v), { tx, ty, d: d / 128, pitch: 0.9, yaw: 0.5 });
  } else await page.evaluate((v) => nested.setView(v), { d: 150 / 128, pitch: 0.9 });
  await settle(3);
  const rep = await page.evaluate(async () => {
    const a = nested.app;
    const s = await a.nest.readAll();
    const key = (m) => ((m & 0x30) !== 0 ? m & 0x30 : m & 0xff);
    const out = [];
    for (let L = 0; L < a.nest.live; L++) {
      const w = a.nest.wins[L];
      const cols = new Map();
      const col = (X, Y) => {
        const k = Y * 1e6 + X;
        let c = cols.get(k);
        if (!c) {
          c = s.column(L, X, Y);
          cols.set(k, c);
        }
        return c;
      };
      let pairs = 0;
      let diff = 0;
      const why = { count: 0, mat: 0 };
      const where = [];
      const hist = {};
      for (let Y = w.gy; Y < w.gy + w.n - 1; Y++)
        for (let X = w.gx; X < w.gx + w.n - 1; X++) {
          const c = col(X, Y);
          const sig = `${c.mat.length}:${c.mat.map(key).join('/')}`;
          hist[sig] = (hist[sig] ?? 0) + 1;
          for (const [dx, dy] of [[1, 0], [0, 1]]) {
            const o = col(X + dx, Y + dy);
            pairs++;
            if (o.mat.length !== c.mat.length) {
              diff++;
              why.count++;
              if (where.length < 6) where.push({ X, Y, a: c.mat.map((m) => m.toString(16)), b: o.mat.map((m) => m.toString(16)) });
            } else if (c.mat.some((m, i) => key(m) !== key(o.mat[i]))) {
              diff++;
              why.mat++;
              if (where.length < 6) where.push({ X, Y, a: c.mat.map((m) => m.toString(16)), b: o.mat.map((m) => m.toString(16)) });
            }
          }
        }
      // flat blocks (L >= 1): the k x k children of a parent cell within 1e-4 of one height, and a step of more than a
      // column to a neighbour block
      let flat = 0;
      let blocks = 0;
      const flatAt = [];
      if (L > 0) {
        const k = a.k;
        for (let by = w.gy; by + k <= w.gy + w.n; by += k)
          for (let bx = w.gx; bx + k <= w.gx + w.n; bx += k) {
            blocks++;
            let lo = Infinity;
            let hi = -Infinity;
            for (let y = 0; y < k; y++)
              for (let x = 0; x < k; x++) {
                const c = col(bx + x, by + y);
                const t = c.z1[c.z1.length - 1];
                lo = Math.min(lo, t);
                hi = Math.max(hi, t);
              }
            if (hi - lo > 0.05) continue;
            let step = 0;
            if (bx + k < w.gx + w.n) {
              const c = col(bx + k, by);
              step = Math.max(step, Math.abs(c.z1[c.z1.length - 1] - hi));
            }
            if (by + k < w.gy + w.n) {
              const c = col(bx, by + k);
              step = Math.max(step, Math.abs(c.z1[c.z1.length - 1] - hi));
            }
            if (step > 1) {
              flat++;
              if (flatAt.length < 4) flatAt.push({ bx, by, top: hi, step: +step.toFixed(2), world: [(bx + k / 2) / k ** L, (by + k / 2) / k ** L] });
            }
          }
      }
      // (the limiter's rule) parent cells that are a local extremum of the parent's tops along x or y (higher or lower than
      // both neighbours on that axis): their children's spread against the step to the neighbour, and the same for the
      // other (monotone) cells. A pillar: a small spread inside, a big step at the edge.
      const ext = { n: 0, spread: 0, step: 0 };
      const mono = { n: 0, spread: 0, step: 0 };
      const pillars = [];
      if (L > 0) {
        const k = a.k;
        const P = a.nest.wins[L - 1];
        const ptop = (X, Y) => {
          const c = s.column(L - 1, X, Y);
          return c.z1[c.z1.length - 1];
        };
        for (let by = w.gy + k; by + 2 * k <= w.gy + w.n; by += k)
          for (let bx = w.gx + k; bx + 2 * k <= w.gx + w.n; bx += k) {
            const PX = Math.floor(bx / k);
            const PY = Math.floor(by / k);
            if (PX - 1 < P.gx || PY - 1 < P.gy || PX + 1 >= P.gx + P.n || PY + 1 >= P.gy + P.n) continue;
            const c0 = ptop(PX, PY);
            const xl = ptop(PX - 1, PY);
            const xr = ptop(PX + 1, PY);
            const yl = ptop(PX, PY - 1);
            const yr = ptop(PX, PY + 1);
            const isExt = (c0 - xl) * (c0 - xr) > 0 || (c0 - yl) * (c0 - yr) > 0;
            const step = Math.max(Math.abs(c0 - xl), Math.abs(c0 - xr), Math.abs(c0 - yl), Math.abs(c0 - yr)) * k;
            let lo = Infinity;
            let hi = -Infinity;
            for (let y = 0; y < k; y++)
              for (let x = 0; x < k; x++) {
                const c = col(bx + x, by + y);
                const t = c.z1[c.z1.length - 1];
                lo = Math.min(lo, t);
                hi = Math.max(hi, t);
              }
            const o = isExt ? ext : mono;
            if (step < k) continue;
            o.n++;
            o.spread += hi - lo;
            o.step += step;
            if (isExt && hi - lo < 0.25 * step && pillars.length < 4) pillars.push({ PX, PY, spread: +(hi - lo).toFixed(1), step: +step.toFixed(1), world: [(PX + 0.5) / k ** (L - 1), (PY + 0.5) / k ** (L - 1)] });
          }
      }
      const lim = { ext: { n: ext.n, spreadOverStep: ext.n ? +(ext.spread / ext.step).toFixed(3) : 0 }, mono: { n: mono.n, spreadOverStep: mono.n ? +(mono.spread / mono.step).toFixed(3) : 0 }, pillars };
      const top = Object.entries(hist).sort((x, y) => y[1] - x[1]).slice(0, 6);
      out.push({ L, n: w.n, pairs, diff, why, where, flat, blocks, flatAt, sigs: top, lim });
    }
    return out;
  });
  for (const r of rep) console.log(JSON.stringify(r));
});
