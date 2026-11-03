// A system's cost on a phone by toggling it (round 120, physbench; shared since round 128 with the hero bench,
// src/perf/herobench.ts): per-pass timestamps don't add up on a tiler GPU, so the frame with it, less the frame without.

import type { Toggle } from './physsummary';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rec = any;

/**
 * A system's cost by the frame with it and without it (round 120: per-pass timestamps don't add up on a tiler): `set`
 * turns it off (true) or on, in WINDOWS alternating windows each way, each WINDOW_S long — so heat and clocks even
 * out as the main bench's toggles do; the frames' mean interval and GPU span with it on, less with it off.
 */
const WINDOWS = 3;
const WINDOW_S = 1.5;
export async function toggled(R: Rec, set: (off: boolean) => void): Promise<Toggle> {
  const P = R.core.host.profiler;
  const sums = { on: { dt: [] as number[], gpu: [] as number[] }, off: { dt: [] as number[], gpu: [] as number[] } };
  let side: 'on' | 'off' = 'on';
  let last = 0;
  let live = true;
  const tick = (t: number) => {
    if (last) sums[side].dt.push(t - last);
    last = t;
    if (live) requestAnimationFrame(tick);
  };
  P.listen((_f: number, ms: number) => {
    if (live) sums[side].gpu.push(ms);
  });
  requestAnimationFrame(tick);
  for (let k = 0; k < WINDOWS; k++)
    for (const s of ['on', 'off'] as const) {
      set(s === 'off');
      await sleep(250);
      side = s;
      last = 0;
      await sleep(WINDOW_S * 1000);
    }
  set(false);
  live = false;
  const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
  const d = (a: number, b: number) => (Number.isFinite(a) && Number.isFinite(b) ? +(a - b).toFixed(2) : null);
  return {
    frameMs: d(mean(sums.on.dt), mean(sums.off.dt)),
    gpuMs: d(mean(sums.on.gpu), mean(sums.off.gpu)),
    on: { frameMs: +mean(sums.on.dt).toFixed(2), gpuMs: sums.on.gpu.length ? +mean(sums.on.gpu).toFixed(2) : null },
    off: { frameMs: +mean(sums.off.dt).toFixed(2), gpuMs: sums.off.gpu.length ? +mean(sums.off.gpu).toFixed(2) : null },
    windows: WINDOWS,
  };
}
