// Nested scales (round 26, step B3): the frames while the finest level opens, sheets against the field mesh. Per variant
// a fresh page; the eye over the root window's steepest step (or --at centre) at level L - 1's distance, settled; the
// frame intervals over 2 s (the baseline); then the eye at level L's distance, which opens level L, and the frame
// intervals over --secs (median, p95, worst, the worst less the baseline's median: what the open added), the field job
// (chunks, frames, ms).
// node scripts/nested-r26-open.mjs --chromeargs ignore-certificate-errors --port 5461 [--level 3] [--order sheets,field]
//   [--at step|centre] [--secs 4] [--extra "&fbudget=4"]
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'r26-open', kind: 'timing', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  const L = Number(R.opt('level', '3'));
  const secs = Number(R.opt('secs', '4'));
  for (const variant of R.opt('order', 'sheets,field').split(',')) {
    const [kind, vx = ''] = variant.split('~');
    const page = await R.page();
    page.on('console', (m) => {
      if (m.type() === 'error') console.log(`[page ${m.type()}] ${m.text()}`);
    });
    await page.goto(`https://localhost:${port}/nested.html?smooth=1${kind === 'field' ? `&field=${L}` : ''}${R.opt('extra', '')}${vx}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.nested && nested.app.pipesReady && nested.app.genReady && nested.app.fieldDone && nested.app.frameCount > 30, { timeout: 300000, polling: 200 });
    const r = await page.evaluate(
      async ({ L, secs, at }) => {
        const a = nested.app;
        const fr = (n) => new Promise((res) => (function f(i) { if (i <= 0) res(); else requestAnimationFrame(() => f(i - 1)); })(n));
        const w = a.nest.wins[0];
        let pose = { x: w.gx + w.n / 2, y: w.gy + w.n / 2, dir: [1, 0] };
        if (at !== 'centre') {
          const s = await a.nest.readAll();
          const top = (X, Y) => {
            const c = s.column(0, X, Y);
            return c.z1[c.z1.length - 1];
          };
          let best = { x: 0, y: 0, step: 0, dir: [1, 0] };
          for (let y = w.gy + 40; y < w.gy + w.n - 40; y++)
            for (let x = w.gx + 40; x < w.gx + w.n - 40; x++)
              for (const d of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
                const st = top(x, y) - top(x + d[0], y + d[1]);
                if (st > best.step) best = { x, y, step: st, dir: d };
              }
          pose = { x: best.x + 0.5 - best.dir[0] * 1.5, y: best.y + 0.5 - best.dir[1] * 1.5, dir: best.dir };
        }
        const dz = [0.9 * 32, 0.3 * 32, 0.3 * 4, 0.3 * 0.5];
        const yaw = Math.atan2(pose.dir[1], pose.dir[0]) + 0.5;
        nested.setView({ tx: pose.x, ty: pose.y, d: dz[L - 1] * 1.4, pitch: 0.95, yaw });
        for (let i = 0; i < 600 && !(a.nest.live === L && a.nest.settled && !a.nest.switching && i > 60); i++) await fr(1);
        await fr(30);
        const take = async (ms) => {
          const ft = [];
          const old = a.post;
          a.post = () => ft.push(a.frames[a.frames.length - 1]);
          const t0 = performance.now();
          while (performance.now() - t0 < ms) await fr(1);
          a.post = old;
          return ft;
        };
        const base = await take(2000);
        const jobs0 = a.nest.fieldLog.length;
        nested.setView({ tx: pose.x, ty: pose.y, d: dz[L], pitch: 0.95, yaw });
        // (what each frame of the open did: the job's queue left (-1 none), the pool's grows, levels live)
        const tags = [];
        const old2 = a.post;
        a.post = () => tags.push([+a.frames[a.frames.length - 1].toFixed(1), a.nest.fieldJob ? a.nest.fieldJob.queue.length : -1, a.nest.stats.grows, a.nest.live]);
        const ft0 = await take(0);
        a.post = old2;
        void ft0;
        const ft = [];
        {
          const old = a.post;
          a.post = () => {
            ft.push(a.frames[a.frames.length - 1]);
            tags.push([+a.frames[a.frames.length - 1].toFixed(1), a.nest.fieldJob ? a.nest.fieldJob.queue.length : -1, a.nest.stats.grows, a.nest.live]);
          };
          const t0 = performance.now();
          while (performance.now() - t0 < secs * 1000) await fr(1);
          a.post = old;
        }
        const slow = tags.map((t, i) => [i, ...t]).filter((t) => t[1] > 20);
        const q = (arr, f) => [...arr].sort((p, x) => p - x)[Math.min(arr.length - 1, Math.floor(f * arr.length))];
        return { live: a.nest.live, baseMed: q(base, 0.5), baseWorst: Math.max(...base), med: q(ft, 0.5), p95: q(ft, 0.95), worst: Math.max(...ft), n: ft.length, jobs: a.nest.fieldLog.slice(jobs0), slow };
      },
      { L, secs, at: R.opt('at', 'step') },
    );
    console.log(`${variant}: level ${L} opened (live ${r.live}); baseline median ${r.baseMed.toFixed(1)} ms (worst ${r.baseWorst.toFixed(1)}); during the open median ${r.med.toFixed(1)}, p95 ${r.p95.toFixed(1)}, worst ${r.worst.toFixed(1)} ms (+${(r.worst - r.baseMed).toFixed(1)} over the baseline median), ${r.n} frames; field jobs ${JSON.stringify(r.jobs.map((j) => ({ L: j.L, chunks: j.chunks, frames: j.frames, ms: Math.round(j.ms) })))}; frames over 20 ms [frame, ms, queue left, grows, live]: ${JSON.stringify(r.slow)}`);
    await page.close();
  }
});
