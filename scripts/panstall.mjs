// Round 113 (tilesfirst, SF10): a pan at a speed for N seconds never stalls the camera — the user on places: "This
// version seems to stop me from scrolling when I get near the edge of what is loaded which is not desirable either."
// The phone proxy (412x915, dpr 2.6, q=low, a Pixel's UA, window 256, the pan bench's flags), up the screen at each
// speed and zoom: the camera's world position each frame (the window's origin added), every 250 ms span's distance
// against what was asked; a span under 80% of it is a stall. With the pixel check and the geometric check over the run.
//   node scripts/panstall.mjs [--speeds 80,160] [--zooms 14,5] [--secs 10] [--extra "&camclamp=1"] [--json f]
import { run } from './lib/runner.mjs';
import fs from 'node:fs';

const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36';
const BENCH = 'tufts=0&shadowcache=4&prepevery=2&bandh=2&shadowsize=512&hybrid=1&settle=0&inplace=1&sleepmore=1&hitch=1&hitchhud=0';

await run({ name: 'panstall', kind: 'behaviour', size: '412x915', dpr: 2.6 }, async (R) => {
  const speeds = R.opt('speeds', '80,160').split(',').map(Number);
  const zooms = R.opt('zooms', '14,5').split(',').map(Number);
  const secs = Number(R.opt('secs', 10));
  const p = await R.page({ size: '412x915', dpr: 2.6 });
  await p.setViewport({ width: 412, height: 915, deviceScaleFactor: 2.6, hasTouch: true, isMobile: true });
  await p.setUserAgent(UA);
  const params = Object.fromEntries(new URLSearchParams(`${BENCH}&level=atlas&at=15024,14337&win=256&bgcheck=1&worldsave=0&world=tilegate&tod=0.42&day=100000&season=0.3${R.opt('extra', '')}`));
  await R.level(params, { page: p });
  await R.simSeconds(p, 8);
  const out = [];
  for (const z of zooms)
    for (const v of speeds) {
      const r = await p.evaluate(
        async (z, v, secs) => {
          const RR = window.reclaimed;
          const cam = RR.camera;
          const S = RR.stream;
          const TL = RR.renderer.tiles;
          const BG = RR.renderer.bgCheck;
          const ROW_H = Math.sqrt(3) / 2;
          cam.zoom = z;
          const [ux, uy] = cam.screenDeltaToWorld(0, -1);
          const l = Math.hypot(ux, uy) || 1;
          const dir = [ux / l, uy / l];
          const frame = () => new Promise((res) => requestAnimationFrame(res));
          for (let t0 = performance.now(); performance.now() - t0 < 1000; ) await frame();
          const pos = () => (S.origin[0] + cam.target[0]) * dir[0] + (S.origin[1] * ROW_H + cam.target[1]) * dir[1];
          RR.scene.pan = { speed: v, dir, t: 0, turnAt: 0, turnBy: 0, turned: 0, asked: 0 };
          BG?.take();
          const samples = [];
          let geoMax = 0;
          const t0 = performance.now();
          const p0 = pos();
          while (performance.now() - t0 < secs * 1000) {
            await frame();
            samples.push([performance.now() - t0, pos() - p0, RR.scene.pan.asked]);
            const g = TL.coverCheck(cam);
            if (g) geoMax = Math.max(geoMax, g.share);
          }
          RR.scene.pan = null;
          await Promise.race([BG?.sync(), new Promise((r) => setTimeout(r, 2000))]);
          const bt = BG?.take();
          // (each 250 ms span: the distance moved over what was asked in it)
          let worst = Infinity;
          let stalls = 0;
          for (let i = 0, j = 0; i < samples.length; i++) {
            while (j < samples.length && samples[j][0] - samples[i][0] < 250) j++;
            if (j >= samples.length) break;
            const asked = samples[j][2] - samples[i][2];
            if (asked <= 0) continue;
            const ratio = (samples[j][1] - samples[i][1]) / asked;
            worst = Math.min(worst, ratio);
            if (ratio < 0.8) stalls++;
          }
          const last = samples[samples.length - 1];
          return { zoom: z, speed: v, moved: Math.round(last[1]), asked: Math.round(last[2]), worstSpan: +worst.toFixed(3), stalledSpans: stalls, geoMax: +geoMax.toFixed(4), bgMax: bt ? +(bt.bg.max / bt.samples).toFixed(4) : null, farMax: bt ? +(bt.far.max / bt.samples).toFixed(4) : null, slides: S.stats.slides };
        },
        z,
        v,
        secs,
      );
      out.push(r);
      R.check(`zoom ${z} at ${v} c/s for ${secs} s: the camera never stalls`, r.stalledSpans === 0, r);
    }
  const jf = R.opt('json', null);
  if (jf) fs.writeFileSync(jf, JSON.stringify(out, null, 1));
});
