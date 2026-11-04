// Round 128g (cityrender): panning over a town draws it properly. The user: "The town seems slightly glitchy when
// panning"; "This should only happen off screen we should prioritize and keep cached the city tiles".
// The phone proxy (412x915) on the atlas at a town (town=1), at each zoom: the camera panned up the screen across the
// town and back (scene.pan), and per frame
//   - the CPU ms in SettlementsView.update() (the desktop proxy's),
//   - the bytes written to the structures' data buffer (StructureGpu.data: pieces and grid rows), per window slide,
//   - every settlement's box on screen (projected) and drawn: a settlement whose drawing changes while it's on screen
//     is a pop (the near/far handoff at REACH before the fix).
// --gif out.gif: a capture of the first zoom's pan. Exits 1 on a pop or (--expect-grid) a slide writing pieces.
//   node scripts/townpan.mjs [--zooms 2.6,1.3] [--speed 40] [--secs 8] [--gif g.gif] [--json f] [--expect-grid]
import { run } from './lib/runner.mjs';
import fs from 'node:fs';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';

const { GIFEncoder, quantize, applyPalette } = gifenc;

await run({ name: 'townpan', kind: 'behaviour', size: '412x915', dpr: 1 }, async (R) => {
  const zooms = R.opt('zooms', '2.6,1.3').split(',').map(Number);
  const speed = Number(R.opt('speed', 40));
  const secs = Number(R.opt('secs', 8));
  const gif = R.opt('gif', '');
  const p = await R.level({ level: 'atlas', town: '1', tod: '0.4', day: '100000', worldsave: '0' });
  await R.simSeconds(p, 4);
  // (the hooks: update() timed, the data buffer's writes counted)
  await p.evaluate(() => {
    const RR = window.reclaimed;
    const view = RR.settlementsView();
    const M = (window.__townpan = { ms: 0, max: 0, bytes: 0, pieceBytes: 0 });
    const upd = view.update.bind(view);
    view.update = () => {
      const t0 = performance.now();
      upd();
      const d = performance.now() - t0;
      M.ms += d;
      if (d > M.max) M.at = { ...view.stats };
      M.max = Math.max(M.max, d);
    };
    const q = RR.core.device?.queue ?? view.sg.device?.queue;
    const dev = view.sg.device ?? RR.core.device;
    const wb = dev.queue.writeBuffer.bind(dev.queue);
    dev.queue.writeBuffer = (buf, off, data, dOff, size) => {
      if (buf === view.sg.data) {
        const n = size !== undefined ? size * (data.BYTES_PER_ELEMENT ?? 1) : data.byteLength - (dOff ?? 0) * (data.BYTES_PER_ELEMENT ?? 1);
        M.bytes += n;
        // (a grid row is 32 bytes; anything bigger in one write is pieces)
        if (n > 64) M.pieceBytes += n;
      }
      return wb(buf, off, data, dOff, size);
    };
    void q;
  });
  const out = [];
  for (const [zi, z] of zooms.entries()) {
    const r = await p.evaluate(
      async (z, v, secs) => {
        const RR = window.reclaimed;
        const M = window.__townpan;
        const cam = RR.camera;
        const S = RR.stream;
        const st = RR.settlements;
        const view = RR.settlementsView();
        const ROW_H = Math.sqrt(3) / 2;
        cam.zoom = z;
        const [ux, uy] = cam.screenDeltaToWorld(0, -1);
        const l = Math.hypot(ux, uy) || 1;
        const dir = [ux / l, uy / l];
        const frame = () => new Promise((res) => requestAnimationFrame(res));
        for (let t0 = performance.now(); performance.now() - t0 < 1500; ) await frame();
        const onScreen = (s) => {
          const [bx, by] = st.toWindow([s.seed.box.x0, s.seed.box.y0 * ROW_H]);
          const w = s.seed.box.w;
          const h = s.seed.box.h * ROW_H;
          const z0 = cam.target[2] - 20;
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const [x, y] of [[bx, by], [bx + w, by], [bx, by + h], [bx + w, by + h]])
            for (const zz of [z0, z0 + 50]) {
              const [sx, sy] = cam.project(x, y, zz);
              x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
            }
          onScreen.last = [x0, y0, x1, y1].map(Math.round);
          return x1 > 0 && y1 > 0 && x0 < cam.viewportW && y0 < cam.viewportH;
        };
        const drawn = (s) => {
          if (typeof view.isDrawn === 'function') return view.isDrawn(s.seed.rec.id);
          // (before the fix: settle/view.ts REACH, 1400 from the camera's point to the box's middle)
          const [bx, by] = st.toWindow([s.seed.box.x0, s.seed.box.y0 * ROW_H]);
          return Math.hypot(bx + s.seed.box.w / 2 - cam.target[0], by + (s.seed.box.h * ROW_H) / 2 - cam.target[1]) <= 1400;
        };
        const prev = new Map();
        let pops = 0;
        const popIds = new Set();
        const popWhy = [];
        const up0 = view.sg.stats.uploads ?? 0;
        const built0 = view.stats.built ?? 0;
        let slides = 0;
        let lastO = `${S.origin}`;
        const slideBytes = [];
        let bytesAt = M.bytes;
        let pieceAt = M.pieceBytes;
        const frameMs = [];
        let maxOn = 0;
        M.ms = 0;
        M.max = 0;
        let frames = 0;
        for (const d of [1, -1]) {
          RR.scene.pan = { speed: v, dir: [dir[0] * d, dir[1] * d], t: 0, turnAt: 0, turnBy: 0, turned: 0, asked: 0 };
          const t0 = performance.now();
          let tl = t0;
          while (performance.now() - t0 < secs * 1000) {
            await frame();
            const now = performance.now();
            frameMs.push(now - tl);
            tl = now;
            frames++;
            let on = 0;
            for (const s of st.plannedAll()) {
              const id = s.seed.rec.id;
              const o = onScreen(s);
              const dr = drawn(s);
              if (o) on++;
              const pv = prev.get(id);
              const hist = (window.__hist ??= new Map());
              const hl = hist.get(id) ?? [];
              hl.push([frames, +(view.gaps?.find((q) => q.id === id)?.gap ?? -1).toFixed(2), o ? 1 : 0, dr ? 1 : 0]);
              if (hl.length > 12) hl.shift();
              hist.set(id, hl);
              if (pv && pv.o && o && pv.dr !== dr) {
                pops++;
                popIds.add(id);
                if (popWhy.length < 5) popWhy.push({ id, frame: frames, drawn: dr, box: onScreen.last, gap: view.gaps?.find((g) => g.id === id), hist: [...(window.__hist.get(id) ?? [])], zr: view.shown?.get(id)?.zr, oz: RR.stream.oz, tz: cam.target[2] });
              }
              prev.set(id, { o, dr });
            }
            maxOn = Math.max(maxOn, on);
            const so = `${S.origin}`;
            if (so !== lastO) {
              lastO = so;
              slides++;
              slideBytes.push({ all: M.bytes - bytesAt, pieces: M.pieceBytes - pieceAt });
              bytesAt = M.bytes;
              pieceAt = M.pieceBytes;
            }
          }
        }
        RR.scene.pan = null;
        frameMs.sort((a, b) => a - b);
        const sum = (a) => a.reduce((x, y) => x + y, 0);
        return {
          zoom: z,
          frames,
          slides,
          updateMsPerFrame: +(M.ms / frames).toFixed(3),
          updateMsMax: +M.max.toFixed(2),
          worstFrame: M.at,
          frameP50: +frameMs[Math.floor(frameMs.length / 2)].toFixed(1),
          frameP99: +frameMs[Math.floor(frameMs.length * 0.99)].toFixed(1),
          bytesPerSlide: slides ? Math.round(sum(slideBytes.map((s) => s.all)) / slides) : 0,
          pieceBytesPerSlide: slides ? Math.round(sum(slideBytes.map((s) => s.pieces)) / slides) : 0,
          maxPieceBytesInASlide: Math.max(0, ...slideBytes.map((s) => s.pieces)),
          pops,
          popIds: [...popIds],
          popWhy,
          // (pieces uploaded during the pan, and how many of those were a settlement's first build or a rebuild — the
          // rest would be uploads a slide caused; the grid version has none)
          uploads: (view.sg.stats.uploads ?? 0) - up0,
          builds: (view.stats.built ?? 0) - built0,
          onScreenMax: maxOn,
          stats: { ...view.stats },
        };
      },
      z,
      speed,
      secs,
    );
    R.log(JSON.stringify(r));
    out.push(r);
    R.check(`zoom ${z}: no settlement's drawing changes while it's on screen`, r.pops === 0, { pops: r.pops, ids: r.popIds });
    if (R.flag('expect-grid')) R.check(`zoom ${z}: a slide uploads no pieces (only grid rows; uploads are builds)`, r.uploads <= r.builds, { uploads: r.uploads, builds: r.builds, slides: r.slides, bytesPerSlide: r.bytesPerSlide });
    if (gif && zi === 0) {
      // (the pan again, captured)
      const enc = GIFEncoder();
      await p.evaluate((v) => {
        const RR = window.reclaimed;
        const [ux, uy] = RR.camera.screenDeltaToWorld(0, -1);
        const l = Math.hypot(ux, uy) || 1;
        RR.scene.pan = { speed: v, dir: [ux / l, uy / l], t: 0, turnAt: 0, turnBy: 0, turned: 0, asked: 0 };
      }, speed);
      for (let i = 0; i < 40; i++) {
        const png = PNG.sync.read(Buffer.from(await p.screenshot({ type: 'png' })));
        const pal = quantize(png.data, 256);
        enc.writeFrame(applyPalette(png.data, pal), png.width, png.height, { palette: pal, delay: 120 });
      }
      await p.evaluate(() => (window.reclaimed.scene.pan = null));
      enc.finish();
      fs.writeFileSync(gif, enc.bytes());
      R.log(`saved ${gif}`);
    }
  }
  const json = R.opt('json', '');
  if (json) fs.writeFileSync(json, JSON.stringify(out, null, 2));
});
