// Round 128i (FT-67): the town's position across a window slide, frame by frame. The user, Pixel 9a town bench:
// "flickering of the town (position jumping)". Each frame, right after it's drawn (core.render wrapped), a point of
// every drawn settlement (its box's middle at its ground) is projected two ways with the camera that frame drew with:
//   drawn — through the grid row the GPU holds (every StructureGpu.setGrid mirrored: the row last written)
//   true  — through the row the town should have now (SettlementsView.frame: the box's offset in the window as it is)
// A row written a frame late (the slide moved the camera and the window after the town's rows were written) draws the
// town a region off for that frame: drawn ≠ true. Reported: the max |drawn − true| (px; expected 0), the max per-frame
// move of the drawn point against the median (a jump), both on slide frames and others.
//   node scripts/townslide.mjs [--zooms 2.6,1.3] [--speed 40] [--secs 6]      exits 1 when the town's off on any frame
import { run } from './lib/runner.mjs';

await run({ name: 'townslide', kind: 'behaviour', size: '412x915', dpr: 1 }, async (R) => {
  const zooms = R.opt('zooms', '2.6,1.3').split(',').map(Number);
  const speed = Number(R.opt('speed', 40));
  const secs = Number(R.opt('secs', 6));
  const p = await R.level({ level: 'atlas', town: '1', tod: '0.4', day: '100000', worldsave: '0', tutorial: '0' });
  await R.simSeconds(p, 4);
  await p.evaluate(() => {
    const RR = window.reclaimed;
    const view = RR.settlementsView();
    const rows = new Map();
    const set = view.sg.setGrid.bind(view.sg);
    view.sg.setGrid = (g, t) => {
      rows.set(g, [...t.pos]);
      return set(g, t);
    };
    const T = (window.__townslide = { frames: [], on: false, origin: `${RR.stream.origin}` });
    const ROW_H = Math.sqrt(3) / 2;
    const render = RR.core.render.bind(RR.core);
    RR.core.render = (...a) => {
      const out = render(...a);
      if (!T.on) return out;
      const cam = RR.camera;
      const o = `${RR.stream.origin}`;
      const slid = o !== T.origin;
      T.origin = o;
      const f = { slid, towns: {} };
      for (const [id, s] of view.shown) {
        if (!s.grid || !s.drawn) continue;
        const w = rows.get(s.grid);
        if (!w) continue;
        const t = view.frame(s).pos;
        const a = [(s.seed.box.w / 2), (s.seed.box.h * ROW_H) / 2, s.zr[0]];
        const pd = cam.project(w[0] + a[0], w[1] + a[1], w[2] + a[2]);
        const pt = cam.project(t[0] + a[0], t[1] + a[1], t[2] + a[2]);
        f.towns[id] = { drawn: [pd[0], pd[1]], err: Math.hypot(pd[0] - pt[0], pd[1] - pt[1]) };
      }
      T.frames.push(f);
      return out;
    };
  });
  let bad = false;
  for (const z of zooms) {
    const r = await p.evaluate(
      async (z, v, secs) => {
        const RR = window.reclaimed;
        const T = window.__townslide;
        const cam = RR.camera;
        cam.zoom = z;
        const frame = () => new Promise((res) => requestAnimationFrame(res));
        for (let t0 = performance.now(); performance.now() - t0 < 1500; ) await frame();
        T.frames = [];
        T.origin = `${RR.stream.origin}`;
        T.on = true;
        // (out from the town up the screen and back: 30% of the screen each way, round again till the time's up)
        const [ux, uy] = cam.screenDeltaToWorld(0, -cam.viewportH * 0.3);
        const dist = Math.min(100, Math.hypot(ux, uy));
        const dir = [ux / Math.hypot(ux, uy), uy / Math.hypot(ux, uy)];
        const t0 = performance.now();
        while (performance.now() - t0 < secs * 1000)
          for (const d of [1, -1]) {
            RR.scene.pan = { speed: v, dir: [dir[0] * d, dir[1] * d], t: 0, turnAt: 0, turnBy: 0, turned: 0, asked: 0 };
            const tl = performance.now();
            while (performance.now() - tl < (dist / v) * 1000) await frame();
          }
        RR.scene.pan = null;
        await frame();
        T.on = false;
        // (per town, the drawn point's move a frame; a slide frame's against the rest)
        const moves = { slide: [], other: [] };
        let errMax = { slide: 0, other: 0 };
        let worst = null;
        const fs = T.frames;
        for (let i = 0; i < fs.length; i++) {
          const k = fs[i].slid ? 'slide' : 'other';
          for (const [id, t] of Object.entries(fs[i].towns)) {
            if (t.err > errMax[k]) {
              errMax[k] = t.err;
              worst = { frame: i, id, err: +t.err.toFixed(1), slid: fs[i].slid };
            }
            const q = fs[i - 1]?.towns[id];
            if (q) moves[k].push(Math.hypot(t.drawn[0] - q.drawn[0], t.drawn[1] - q.drawn[1]));
            // (the frame after a slide too: a row written late is put right there — a jump back)
            if (q && fs[i - 1].slid && !fs[i].slid) moves.slide.push(Math.hypot(t.drawn[0] - q.drawn[0], t.drawn[1] - q.drawn[1]));
          }
        }
        const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
        return {
          zoom: z,
          frames: fs.length,
          slides: fs.filter((f) => f.slid).length,
          townFrames: fs.filter((f) => Object.keys(f.towns).length).length,
          errMaxSlide: +errMax.slide.toFixed(1),
          errMaxOther: +errMax.other.toFixed(1),
          moveMedian: +med(moves.other).toFixed(1),
          moveMaxSlide: +Math.max(0, ...moves.slide).toFixed(1),
          moveMaxOther: +Math.max(0, ...moves.other).toFixed(1),
          worst,
        };
      },
      z,
      speed,
      secs,
    );
    R.log(JSON.stringify(r));
    R.check(`zoom ${z}: the window slid with a town drawn`, r.slides > 0 && r.townFrames > 0, r);
    // (the drawn point within a pixel of where the town is, every frame — a slide's frame too)
    const ok = r.errMaxSlide < 1 && r.errMaxOther < 1;
    R.check(`zoom ${z}: the town is drawn where it is on every frame (slide frames too)`, ok, { errMaxSlide: r.errMaxSlide, errMaxOther: r.errMaxOther, worst: r.worst });
    if (!ok) bad = true;
  }
  void bad;
});
