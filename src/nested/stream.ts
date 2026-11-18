// Nested scales lab: the streaming measurements (round 7; tests only: the info target is read back here, never on the
// player's path). A scripted cruise or zoom; per frame: the frame time and every level's window (slides, promotes,
// demotes and their reversals); per frame where a read-back is free (at most three in flight): the central half of the
// view, counted as pixels drawn by a parent nearer the eye than its child's promote distance (draw.wgsl info.b,
// "coarse": the gate's number) and
// pixels that became finer since the last read ("pops": a strip drawn at parent detail that popped to child detail).
import type { App } from './app';
import type { Win } from './gpu/nest';

export interface StreamStats {
  frames: number;
  seconds: number;
  frameP50: number;
  frameP95: number;
  frameMax: number;
  slides: number[];
  promotes: number;
  demotes: number;
  /** a slide back along an axis within 2 s of one the other way (per level, summed) */
  slideReversals: number;
  /** a promote then a demote of the same depth (or the other way) within 2 s */
  zoomFlips: number;
  /** frames in which more than one level op was submitted */
  multiOpFrames: number;
  reads: number;
  /** reads with any central pixel drawn coarser than wanted; the worst share of the central half */
  coarseReads: number;
  coarseMax: number;
  /** reads where over 0.5 % of the central half became finer since the last read */
  popReads: number;
  /** of those, reads within 4 frames after a level op (the op's strip popping in view) */
  popAfterOp: number;
  popMax: number;
  used: number;
  cap: number;
  refused: number;
  waits: number;
  lifts: number;
  /** the eye's height over the ground at the end, and the distance travelled (world) */
  travelled: number;
  log: string[];
}

const pct = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
};

/** the depth wanted at the eye: the deepest live level, or the deepest the zoom band would open */
export function wantDepth(app: App): number {
  let d = app.nest.live - 1;
  for (let m = d + 1; m <= app.maxDepth; m++) if (app.dNear < 0.45 * app.width(m)) d = m;
  return d;
}

/** measure while `drive` runs (it resolves when done) */
export async function measure(app: App, drive: () => Promise<void>): Promise<StreamStats> {
  const dev = app.device;
  const frames: number[] = [];
  const st: StreamStats = { frames: 0, seconds: 0, frameP50: 0, frameP95: 0, frameMax: 0, slides: [0, 0, 0, 0, 0, 0, 0, 0], promotes: 0, demotes: 0, slideReversals: 0, zoomFlips: 0, multiOpFrames: 0, reads: 0, coarseReads: 0, coarseMax: 0, popReads: 0, popAfterOp: 0, popMax: 0, used: 0, cap: 0, refused: 0, waits: 0, lifts: 0, travelled: 0, log: [] };
  const refused0 = app.nest.stats.refused;
  const waits0 = app.nest.stats.waits;
  const lifts0 = app.lifts;
  let prevWins: (Win | null)[] = app.nest.wins.slice();
  const lastSlide: { t: number; dx: number; dy: number }[][] = [[], [], [], [], [], [], [], []];
  const lastZoom: { t: number; what: string }[] = [];
  let inflight = 0;
  let frameNo = 0;
  let lastOpFrame = -100;
  let prevLv: Uint8Array | null = null;
  let last = performance.now();
  const t0 = last;
  let ex = app.ex;
  let ey = app.ey;
  const hookWas = app.post;
  app.post = () => {
    const t = performance.now();
    frames.push(t - last);
    last = t;
    st.travelled += Math.hypot(app.ex - ex, app.ey - ey);
    ex = app.ex;
    ey = app.ey;
    // level ops this frame, from the windows
    const wins = app.nest.wins;
    let opsNow = 0;
    for (let m = 1; m < 8; m++) {
      const a = prevWins[m];
      const b = wins[m];
      if (!a && b) {
        st.promotes++;
        opsNow++;
        if (lastZoom.some((z) => z.what === `demote${m}` && t - z.t < 2000)) st.zoomFlips++;
        lastZoom.push({ t, what: `promote${m}` });
        st.log.push(`${((t - t0) / 1000).toFixed(2)} promote ${m} dNear ${app.dNear.toFixed(3)}`);
      } else if (a && !b) {
        st.demotes++;
        opsNow++;
        if (lastZoom.some((z) => z.what === `promote${m}` && t - z.t < 2000)) st.zoomFlips++;
        lastZoom.push({ t, what: `demote${m}` });
        st.log.push(`${((t - t0) / 1000).toFixed(2)} demote ${m} dNear ${app.dNear.toFixed(3)}`);
      } else if (a && b && (a.gx !== b.gx || a.gy !== b.gy)) {
        st.slides[m]++;
        opsNow++;
        const dx = Math.sign(b.gx - a.gx);
        const dy = Math.sign(b.gy - a.gy);
        if (lastSlide[m].some((s) => t - s.t < 2000 && ((dx && s.dx === -dx) || (dy && s.dy === -dy)))) st.slideReversals++;
        lastSlide[m].push({ t, dx, dy });
      }
    }
    if (opsNow > 1) st.multiOpFrames++;
    frameNo++;
    if (opsNow) lastOpFrame = frameNo;
    prevWins = wins.slice().map((w) => (w ? { ...w } : null));
    // the central half of the info target
    const tex = app.render.info;
    if (!tex || inflight >= 3) return;
    const recentOp = frameNo - lastOpFrame <= 4;
    const w = tex.width;
    const h = tex.height;
    const x0 = Math.floor(w / 4);
    const y0 = Math.floor(h / 4);
    const cw = Math.floor(w / 2);
    const ch = Math.floor(h / 2);
    const bpr = Math.ceil((cw * 4) / 256) * 256;
    const buf = dev.createBuffer({ size: bpr * ch, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = dev.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: tex, origin: [x0, y0] }, { buffer: buf, bytesPerRow: bpr }, [cw, ch]);
    dev.queue.submit([enc.finish()]);
    inflight++;
    buf.mapAsync(GPUMapMode.READ).then(
      () => {
        const px = new Uint8Array(buf.getMappedRange());
        const lv = new Uint8Array(cw * ch);
        let coarse = 0;
        let pop = 0;
        for (let y = 0; y < ch; y++)
          for (let x = 0; x < cw; x++) {
            const i = y * bpr + x * 4;
            const j = y * cw + x;
            if (px[i] === 0) {
              lv[j] = 255;
              continue;
            }
            lv[j] = Math.round((px[i + 1] / 255) * 8);
            if (px[i + 2] > 127) coarse++;
            if (prevLv && prevLv[j] !== 255 && lv[j] > prevLv[j]) pop++;
          }
        const n = cw * ch;
        st.reads++;
        if (coarse > 0) st.coarseReads++;
        st.coarseMax = Math.max(st.coarseMax, coarse / n);
        if (prevLv && pop > 0.005 * n) {
          st.popReads++;
          // (a pop within 4 frames after a level op: a strip drawn at parent detail that the op replaced; else the
          // view's own motion moved a level's rim across the centre)
          if (recentOp) st.popAfterOp++;
        }
        if (prevLv) st.popMax = Math.max(st.popMax, pop / n);
        prevLv = lv;
        buf.unmap();
        buf.destroy();
        inflight--;
      },
      () => inflight--,
    );
  };
  await drive();
  while (inflight > 0) await new Promise((r) => setTimeout(r, 20));
  app.post = hookWas;
  Object.assign(st, {
    frames: frames.length,
    seconds: (performance.now() - t0) / 1000,
    frameP50: pct(frames, 0.5),
    frameP95: pct(frames, 0.95),
    frameMax: Math.max(0, ...frames.slice(1)),
    used: app.nest.stats.used,
    cap: app.nest.stats.cap,
    refused: app.nest.stats.refused - refused0,
    waits: app.nest.stats.waits - waits0,
    lifts: app.lifts - lifts0,
  });
  return st;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** settle at a spot: the eye d from the ground under (x, y) along the view, every wanted level open */
export async function settle(app: App, x: number, y: number, d: number, yaw: number, pitch: number): Promise<void> {
  app.setCruise(false);
  app.yaw = yaw;
  app.pitch = pitch;
  app.place(x, y, d);
  await wait(3500);
}

/** a cruise of `seconds` at `wps` finest-window widths a second */
export async function cruise(app: App, wps: number, seconds: number, turn = 0): Promise<StreamStats> {
  return measure(app, async () => {
    app.cruiseWps = wps;
    app.setCruise(true);
    const t0 = performance.now();
    while (performance.now() - t0 < seconds * 1000) {
      await new Promise((r) => requestAnimationFrame(r));
      if (turn) app.yaw += turn / 60;
    }
    app.setCruise(false);
    await wait(300);
  });
}

/** a slow zoom: from distance d0 toward the surface at the centre down to d1 and back, `seconds` each way */
export async function zoomInOut(app: App, d0: number, d1: number, seconds: number): Promise<StreamStats> {
  return measure(app, async () => {
    const perFrame = Math.log(d1 / d0) / (seconds * 60);
    for (const dir of [1, -1]) {
      const t0 = performance.now();
      while (performance.now() - t0 < seconds * 1000) {
        await new Promise((r) => requestAnimationFrame(r));
        app.zoomLog += dir * perFrame;
      }
    }
    await wait(500);
  });
}
