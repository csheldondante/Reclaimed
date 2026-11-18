// Nested scales lab: the streaming measurement (?fly=1). A fast traverse at three zooms; per frame: frame time, pixels
// with no surface (holes; must be 0), the share of the screen still showing a parent where the focus wants its child
// (or a child still fading in), and after each slide or promote the GPU time until it was done (+ the fade: sharp).
// The info target is read back here only (a measurement, not the player's path).
import type { App } from './app';

export interface FlyRow {
  zoom: string;
  D: number;
  speed: string;
  frames: number;
  frameP50: number;
  frameP95: number;
  frameMax: number;
  holesMax: number;
  framesWithHoles: number;
  readFrames: number;
  coarseMean: number;
  coarseMax: number;
  settleS: number;
  ops: number;
  gpuMsMean: number;
  gpuMsMax: number;
  cpuMsMax: number;
  sharpMsMax: number;
}

const pct = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
};

export interface OpBench {
  what: string;
  /** ms from submit to the GPU done, each op awaited alone with the levels frozen (the frame loop still draws) */
  ms: number[];
  median: number;
}

/** each op alone: submit, then await the GPU (the frame loop keeps drawing, at vsync, so a frame's draw may share it) */
export async function opBench(app: App): Promise<OpBench[]> {
  const dev = app.device;
  const nest = app.nest;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  app.tx = 70;
  app.ty = 120;
  app.D = app.Dgoal = 1.5;
  app.pitch = 1.0;
  await wait(3500);
  app.frozen = true;
  const time = async (fn: () => void) => {
    await dev.queue.onSubmittedWorkDone();
    const t = performance.now();
    fn();
    await dev.queue.onSubmittedWorkDone();
    return performance.now() - t;
  };
  const res: OpBench[] = [];
  const add = (what: string, ms: number[]) => res.push({ what, ms, median: [...ms].sort((a, b) => a - b)[ms.length >> 1] });
  const w1 = { ...nest.wins[1]! };
  const w2 = { ...nest.wins[2]! };
  const idle: number[] = [];
  for (let i = 0; i < 8; i++) idle.push(await time(() => undefined));
  add('nothing (a frame in flight at most)', idle);
  const e0: number[] = [];
  for (let i = 0; i < 6; i++) e0.push(await time(() => nest.edit({ op: 'raise', radius: 12 / 64, amount: 0.0005, at: { level: 2, x: 100, y: 100 } })));
  add('edit at depth 2 before the slides (a fresh table)', e0);
  const pr: number[] = [];
  for (let i = 0; i < 6; i++) {
    nest.demote(2);
    await dev.queue.onSubmittedWorkDone();
    pr.push(await time(() => nest.promote(2, w2)));
  }
  add('promote depth 2 (256 chunks, 65k columns)', pr);
  const sl: number[] = [];
  for (let i = 0; i < 6; i++) {
    sl.push(await time(() => nest.slide(2, { ...w2, gx: w2.gx + 32 })));
    sl.push(await time(() => nest.slide(2, w2)));
  }
  add('slide depth 2 by two chunks (32 entering chunks)', sl);
  const e1: number[] = [];
  for (let i = 0; i < 6; i++) e1.push(await time(() => nest.edit({ op: 'raise', radius: 4 / 8, amount: 0.002, at: { level: 1, x: w1.n / 2 - 40, y: w1.n / 2 } })));
  add('edit at depth 1, radius 4 columns: brush, restrict to the root, residual and derive on levels 1 and 2', e1);
  const e2: number[] = [];
  for (let i = 0; i < 6; i++) e2.push(await time(() => nest.edit({ op: 'raise', radius: 12 / 64, amount: 0.0005, at: { level: 2, x: 128, y: 128 } })));
  add('edit at depth 2, radius 12 columns: brush, restrict through 1 and the root, residuals and derives', e2);
  const m2: number[] = [];
  for (let i = 0; i < 6; i++) m2.push(await time(() => nest.edit({ op: 'melt', radius: 12 / 64, amount: 0, rate: 0.1, at: { level: 2, x: 128, y: 128 } })));
  add('melt at depth 2, radius 12 columns, the same chain', m2);
  app.frozen = false;
  return res;
}

export async function flyThrough(app: App, out: (s: string) => void): Promise<FlyRow[]> {
  const dev = app.device;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let inflight = 0;
  let sampling: { holes: number[]; coarse: number[] } | null = null;
  let frameN = 0;
  let lastByLevel: number[] = [];
  // every second frame: the info target read back and counted
  app.post = () => {
    frameN++;
    const tex = app.render.info;
    if (!sampling || !tex || inflight >= 2 || frameN % 2) return;
    const w = tex.width;
    const h = tex.height;
    const bpr = Math.ceil((w * 4) / 256) * 256;
    const buf = dev.createBuffer({ size: bpr * h, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = dev.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [w, h]);
    dev.queue.submit([enc.finish()]);
    inflight++;
    const into = sampling;
    buf.mapAsync(GPUMapMode.READ).then(
      () => {
        const px = new Uint8Array(buf.getMappedRange());
        let holes = 0;
        let coarse = 0;
        const byLevel = [0, 0, 0, 0, 0, 0, 0, 0];
        // the bottom 70 css px are the buttons' row: still the surface underneath, counted like the rest
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const i = y * bpr + x * 4;
            if (px[i] === 0) holes++;
            else if (px[i + 2] > 127) {
              coarse++;
              byLevel[Math.round((px[i + 1] / 255) * 8)]++;
            }
          }
        lastByLevel = byLevel.map((v) => +(v / (w * h)).toFixed(4));
        into.holes.push(holes);
        into.coarse.push(coarse / (w * h));
        buf.unmap();
        buf.destroy();
        inflight--;
      },
      () => {
        inflight--;
      },
    );
  };
  const rows: FlyRow[] = [];
  const zooms = [
    { zoom: 'depth 1 open (40 cm columns)', D: 12 },
    { zoom: 'depth 2 open (5 cm columns)', D: 1.5 },
    { zoom: 'depth 3 open (0.63 cm columns)', D: 0.2 },
  ];
  for (const z of zooms) {
    // settle at the start: every wanted level open and sharp
    app.tx = 70;
    app.ty = 120;
    app.D = app.Dgoal = z.D;
    app.yaw = -Math.PI / 2;
    app.pitch = 1.0;
    await wait(3500);
    const ops0 = app.opLog.length;
    const opTimes: { gpu: number; cpu: number }[] = [];
    sampling = { holes: [], coarse: [] };
    const speed = 2 * z.D;
    const frames: number[] = [];
    let last = performance.now();
    app.hook = (dt) => {
      app.tx += speed * dt;
    };
    const watchOps = () => {
      const fresh = app.opLog.slice(ops0 + opTimes.length);
      for (const o of fresh) {
        const rec = { gpu: -1, cpu: o.ms };
        opTimes.push(rec);
        dev.queue.onSubmittedWorkDone().then(() => (rec.gpu = performance.now() - o.at));
      }
    };
    const t0 = performance.now();
    while (performance.now() - t0 < 3000) {
      await new Promise((r) => requestAnimationFrame(r));
      const t = performance.now();
      frames.push(t - last);
      last = t;
      watchOps();
    }
    app.hook = null;
    const traverse = sampling;
    // stop: how long until the screen is all sharp
    sampling = { holes: [], coarse: [] };
    const ts = performance.now();
    let settle = -1;
    while (performance.now() - ts < 4000) {
      await new Promise((r) => requestAnimationFrame(r));
      watchOps();
      const c = sampling.coarse;
      if (c.length >= 2 && c[c.length - 1] === 0 && c[c.length - 2] === 0) {
        settle = (performance.now() - ts) / 1000;
        break;
      }
    }
    await wait(300);
    const all = { holes: [...traverse.holes, ...sampling.holes], coarse: traverse.coarse };
    const done = opTimes.filter((o) => o.gpu >= 0);
    rows.push({
      zoom: z.zoom,
      D: z.D,
      speed: `${(speed * 3.2).toFixed(2)} m/s (${speed.toFixed(2)} root columns a second, 2 camera distances a second)`,
      frames: frames.length,
      frameP50: pct(frames, 0.5),
      frameP95: pct(frames, 0.95),
      frameMax: Math.max(...frames),
      holesMax: Math.max(0, ...all.holes),
      framesWithHoles: all.holes.filter((h) => h > 0).length,
      readFrames: all.holes.length,
      coarseMean: all.coarse.reduce((a, b) => a + b, 0) / Math.max(1, all.coarse.length),
      coarseMax: Math.max(0, ...all.coarse),
      settleS: settle,
      ops: opTimes.length,
      gpuMsMean: done.reduce((a, b) => a + b.gpu, 0) / Math.max(1, done.length),
      gpuMsMax: Math.max(0, ...done.map((o) => o.gpu)),
      cpuMsMax: Math.max(0, ...opTimes.map((o) => o.cpu)),
      sharpMsMax: Math.max(0, ...done.map((o) => o.gpu)) + app.render.fadeSeconds * 1000,
    });
    out(JSON.stringify(rows[rows.length - 1]));
    (rows[rows.length - 1] as FlyRow & { restByLevel: number[] }).restByLevel = lastByLevel;
  }
  sampling = null;
  app.post = null;
  return rows;
}
