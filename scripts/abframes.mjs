// Round 113 (tilesfirst): a frame-time A/B of a build — the phone proxy (412x915, dpr 2.6, q=low, a Pixel's UA, the
// pan bench's flags, no pixel check), parked then panning up the screen at each speed, at each zoom: the frames'
// p50 / p95 / p99 / worst (ms) and the GPU's frame (the profiler's timestamps, ?perf=1). Run it against one build
// (this worktree's, or `--server URL` another's: e.g. places' dist served by python -m http.server), in turns.
//   node scripts/abframes.mjs [--server http://127.0.0.1:6199] [--zooms 14,8,5] [--speeds 0,40,80] [--secs 6] [--tag a]
import { run } from './lib/runner.mjs';
import fs from 'node:fs';

const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36';
const BENCH = 'tufts=0&shadowcache=4&prepevery=2&bandh=2&shadowsize=512&hybrid=1&settle=0&inplace=1&sleepmore=1&hitch=1&hitchhud=0';

await run({ name: 'abframes', kind: 'timing', size: '412x915', dpr: 2.6 }, async (R) => {
  const zooms = R.opt('zooms', '14,8,5').split(',').map(Number);
  const speeds = R.opt('speeds', '0,40,80').split(',').map(Number);
  const secs = Number(R.opt('secs', 6));
  const p = await R.page({ size: '412x915', dpr: 2.6 });
  await p.setViewport({ width: 412, height: 915, deviceScaleFactor: 2.6, hasTouch: true, isMobile: true });
  await p.setUserAgent(UA);
  const params = Object.fromEntries(new URLSearchParams(`${BENCH}&level=atlas&at=15024,14337&win=256&worldsave=0&world=tilegate&tod=0.42&day=100000&season=0.3&perf=1${R.opt('extra', '')}`));
  await R.level(params, { page: p });
  await R.simSeconds(p, 8);
  const rows = [];
  for (const z of zooms)
    for (const v of speeds) {
      const r = await p.evaluate(
        async (z, v, secs) => {
          const RR = window.reclaimed;
          const cam = RR.camera;
          cam.zoom = z;
          const [ux, uy] = cam.screenDeltaToWorld(0, -1);
          const l = Math.hypot(ux, uy) || 1;
          RR.scene.pan = v ? { speed: v, dir: [ux / l, uy / l], t: 0, turnAt: 0, turnBy: 0, turned: 0, asked: 0 } : null;
          const frame = () => new Promise((res) => requestAnimationFrame(res));
          for (let t0 = performance.now(); performance.now() - t0 < 1500; ) await frame();
          const ft = [];
          const gpu = [];
          let last = performance.now();
          const t0 = last;
          while (performance.now() - t0 < secs * 1000) {
            const t = await frame();
            ft.push(t - last);
            last = t;
            const P = RR.core?.host?.profiler ?? RR.renderer?.profiler;
            if (P?.gpuFrameMs > 0) gpu.push(P.gpuFrameMs);
          }
          RR.scene.pan = null;
          const q = (a, f) => {
            const s = [...a].sort((x, y) => x - y);
            return s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * f))].toFixed(2) : null;
          };
          return { zoom: z, speed: v, frames: ft.length, fps: +(ft.length / secs).toFixed(1), p50: q(ft, 0.5), p95: q(ft, 0.95), p99: q(ft, 0.99), max: q(ft, 1), gpuP50: q(gpu, 0.5), gpuP95: q(gpu, 0.95) };
        },
        z,
        v,
        secs,
      );
      rows.push(r);
      console.log(JSON.stringify(r));
    }
  const out = R.opt('json', null);
  if (out) fs.writeFileSync(out, JSON.stringify({ tag: R.opt('tag', ''), server: R.opt('server', null), rows }, null, 1));
});
