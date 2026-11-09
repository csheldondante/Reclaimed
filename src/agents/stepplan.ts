// (round 128o, DA-B22) Fast-forward's stride: when the units step in a frame of many ticks (agents.ts, traits/system.ts).

/**
 * (round 128o, DA-B22; DESIGN §12 fast-forward) The units' step in a frame of `n` ticks: on tick `i`, whether it runs,
 * and over how many ticks (its dt). It runs every `stride` ticks and on the frame's last, so a frame of 16 ticks at a
 * stride of 5 steps 4 times (5, 5, 5, 1 ticks) and a frame of one tick steps once. Pure: the agents and the traits
 * (traits/system.ts) step together by it.
 */
export function stepPlan(n: number, i: number, stride: number): { step: boolean; ticks: number } {
  const s = Math.max(1, Math.min(stride, n));
  const last = i >= n - 1;
  const on = last || (i + 1) % s === 0;
  if (!on) return { step: false, ticks: 0 };
  const prev = (i + 1) % s === 0 ? i - s : Math.floor(i / s) * s - 1;
  return { step: true, ticks: i - prev };
}
