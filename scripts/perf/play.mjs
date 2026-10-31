// Round 117 (play): the play layer's own perf test — the sandbox on the atlas level as deployed (every system, 1x),
// the phone proxy (412x915, dpr 2.6, q=low), a timing check (the GPU alone). Two phases after the level settles:
//   ride   the hoverbike flat out with boost for `--ride` s (the window streaming after it), raiders spawned ahead
//   lich   the lich among raiders: a storm drawn, slams every 2 s, for `--lich` s
// Per phase: frame times (p50, p95, worst, frames over 50 ms), the GPU's frame (the profiler), the play layer's own
// main-thread cost (PlaySandbox.stats). JSON to data/perf/play-<adapter>.json. Under 2 minutes.
//   node scripts/perf/play.mjs [--ride 20] [--lich 15] [--settle 20000]
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, run, sleep } from '../lib/runner.mjs';

await run({ name: 'perf-play', kind: 'timing', size: '412x915', dpr: 2.6 }, async (R) => {
  const ride = Number(R.opt('ride', 20));
  const lichS = Number(R.opt('lich', 15));
  const settle = Number(R.opt('settle', 20000));
  const p = await R.level({ level: 'atlas', play: 'hoverbike' });
  await p.waitForFunction(() => window.reclaimed?.play?.hero, { timeout: 120000, polling: 250 });
  await sleep(settle);
  const adapter = await p.evaluate(async () => {
    const a = await navigator.gpu.requestAdapter();
    const i = a?.info ?? {};
    return `${i.vendor || 'unknown'}-${i.architecture || 'unknown'}`.replace(/[^a-z0-9-]/gi, '_').toLowerCase();
  });
  const begin = () =>
    p.evaluate(() => {
      const pr = window.reclaimed.core.host.profiler;
      pr.resetTotals();
      const st = window.reclaimed.play.stats;
      st.frames = 0;
      st.ms = 0;
      st.max = 0;
      window.__t = [];
      window.__on = true;
      const tick = () => {
        if (!window.__on) return;
        window.__t.push(performance.now());
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  const end = () =>
    p.evaluate(() => {
      window.__on = false;
      const t = window.__t;
      const d = [];
      for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
      d.sort((a, b) => a - b);
      const q = (k) => +(d[Math.min(d.length - 1, Math.floor(d.length * k))] ?? 0).toFixed(2);
      const pr = window.reclaimed.core.host.profiler;
      const st = window.reclaimed.play.stats;
      const h = window.reclaimed.play.hero;
      return {
        frames: d.length,
        fps: +(d.length / ((t[t.length - 1] - t[0]) / 1000)).toFixed(1),
        p50: q(0.5),
        p95: q(0.95),
        worst: +(d[d.length - 1] ?? 0).toFixed(1),
        over50: d.filter((x) => x > 50).length,
        gpuFrame: +(pr.gpuTotalMs / Math.max(pr.framesResolved, 1)).toFixed(2),
        gpuFrameMs: +(pr.gpuFrameMs ?? 0).toFixed(2),
        playCpu: +(st.ms / Math.max(st.frames, 1)).toFixed(3),
        playCpuMax: +st.max.toFixed(2),
        hero: { status: h.status(), speed: +h.speed().toFixed(1) },
      };
    });
  // ride
  await p.evaluate(() => {
    window.reclaimed.play.controls.script = { stick: [0, -1], buttons: [true] };
    window.reclaimed.play.spawn();
  });
  await begin();
  for (let s = 0; s < ride; s += 5) {
    await sleep(5000);
    await p.evaluate(() => window.reclaimed.play.spawn());
  }
  const rideR = await end();
  R.log(`ride ${JSON.stringify(rideR)}`);
  // the lich
  await p.evaluate(() => {
    const s = window.reclaimed.play;
    s.controls.script = { stick: [0, 0], buttons: [false, false] };
    s.choose('lich');
    s.spawn();
    s.spawn();
  });
  await sleep(2000);
  await begin();
  await p.evaluate(() => {
    const s = window.reclaimed.play;
    const cam = window.reclaimed.core.camera;
    const [x, y, z] = s.hero.position();
    const c = cam.project(x, y, z);
    s.controls.inject({ kind: 'circle', centre: c, ccw: true, turns: 1.5 });
  });
  for (let s = 0; s < lichS; s += 2) {
    await p.evaluate(() => (window.reclaimed.play.controls.script = { stick: [0, 0], buttons: [true, false] }));
    await sleep(200);
    await p.evaluate(() => (window.reclaimed.play.controls.script = { stick: [0, 0], buttons: [false, false] }));
    await sleep(1800);
  }
  const lichR = await end();
  R.log(`lich ${JSON.stringify(lichR)}`);
  const out = { when: new Date().toISOString(), adapter, size: `${R.W}x${R.H}`, dpr: R.dpr, q: 'low', ride: rideR, lich: lichR };
  const f = path.join(ROOT, 'data', 'perf', `play-${adapter}.json`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(out, null, 1));
  R.log(`wrote ${f}`);
  R.check('the play layer costs under 1 ms of main thread a frame (both phases)', rideR.playCpu < 1 && lichR.playCpu < 1, { ride: rideR.playCpu, lich: lichR.playCpu });
});
