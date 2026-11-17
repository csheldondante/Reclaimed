// The perf gate's comparison (2026-11-17, the owner: "make a quick unit test to flag that if it ever happens again so
// we know right away what change caused it"). Pure: a run's numbers against the committed baseline
// (data/perf/gate-baseline.json), in plain words naming the scenario, the metric, the baseline and the new value.
// Unit-tested in test/unit/perfgate.test.ts; scripts/perfgate.mjs measures and calls it.
//
// Three kinds of metric:
//   counter  deterministic per-frame counts at idle (passes, dispatches, draws, instances, reads, uploads, ticks):
//            they don't depend on the machine's load, so a rise past a small allowance FAILS
//   timing   ms (boot, time to a full screen, frame GPU/CPU ms): the GPU is shared, so a rise is a WARNING unless it is
//            far out (FAIL_RATIO), and a time-to-cover past its limit always fails
//   pan      a steady pan's pop-in and hitches (PAN_TOL): FAIL past their allowance; its per-slide work is counters
//   awake    the systems doing GPU work at idle: one not in the baseline FAILS; a quiet system awake in the loop FAILS

/** counters: relative allowance and an absolute slack. Measured run to run at one commit (2026-11-17): the loop's idle
 *  compute passes 8.35-10.6 a frame (timers and the town's life: up to 26 %), so 30 % + 1; the sandbox's own weather
 *  (natural storms) moves its counts 24-59 a frame, so a scenario may carry its own `counterTol` (the sandbox's: 100 %
 *  + 5 — it catches a doubling, not a drift) */
export const COUNTER_TOL = { ratio: 0.3, abs: 1 };
export const LOOSE_TOL = { ratio: 1, abs: 5 };
/** timings: warn past WARN_RATIO x baseline (+ WARN_ABS ms), fail past FAIL_RATIO x (+ FAIL_ABS) */
export const TIMING_TOL = { warnRatio: 1.5, warnAbs: 2, failRatio: 3, failAbs: 5 };
/** pans (scenario D): pop-in (undrawn %, mean over the pan's frames and its worst frame) and hitches (frames over
 *  33 ms) depend on the GPU's load, but a pan that pops in or hitches clearly more fails: past base * (1 + ratio) + abs
 *  (mean undrawn 1.5x + 0.5 points, worst frame's undrawn 1.25x + 5 points, hitches 2x + 10: one run to the next at one
 *  commit, on the shared GPU, a pan's frames over 33 ms went 0 -> 32) */
export const PAN_TOL = { undrawnMeanPct: { ratio: 0.5, abs: 0.5 }, undrawnMaxPct: { ratio: 0.25, abs: 5 }, over33: { ratio: 1, abs: 10 } };
const panTol = (name) => PAN_TOL[Object.keys(PAN_TOL).find((k) => name.endsWith(k)) ?? 'over33'];
/** a screen counts as fully drawn at this coverage */
export const COVER_FULL = 0.99;

/** a counter's verdict: a line when it rose past base * (1 + ratio) + abs, else null */
export function judgeCounter(name, base, now, tol = COUNTER_TOL) {
  if (base == null || now == null) return null;
  const limit = base * (1 + tol.ratio) + tol.abs;
  return now > limit ? `${name}: baseline ${round(base)}, now ${round(now)} (allowed up to ${round(limit)})` : null;
}

export function judgeTiming(name, base, now, tol = TIMING_TOL) {
  if (base == null || now == null) return null;
  if (now > base * tol.failRatio + tol.failAbs) return { level: 'fail', msg: `${name}: baseline ${round(base)} ms, now ${round(now)} ms (fails past ${round(base * tol.failRatio + tol.failAbs)})` };
  if (now > base * tol.warnRatio + tol.warnAbs) return { level: 'warn', msg: `${name}: baseline ${round(base)} ms, now ${round(now)} ms (warns past ${round(base * tol.warnRatio + tol.warnAbs)})` };
  return null;
}

const round = (v) => (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100);

/**
 * Compare one run with the baseline. Both are `{ scenarios: { <key>: Scenario } }`, a Scenario being
 *   { counters: {name: number}, timings: {name: ms}, awake: string[], mustSleep?: string[], cover: {name: {reached: bool, ms}} }
 * Returns { fails: string[], warns: string[] }, each line starting with the scenario's key.
 */
export function compare(baseline, run, opts = {}) {
  const fails = [];
  const warns = [];
  for (const [key, now] of Object.entries(run.scenarios ?? {})) {
    const base = baseline?.scenarios?.[key];
    // (an absolute rule, baseline or not: a screen that never fills, a quiet system awake)
    for (const [name, c] of Object.entries(now.cover ?? {})) if (!c.reached) fails.push(`${key}: ${name} never reached ${COVER_FULL * 100} % coverage (best ${round((c.best ?? 0) * 100)} % in ${round(c.ms)} ms)`);
    for (const s of now.mustSleep ?? []) if ((now.awake ?? []).includes(s)) fails.push(`${key}: ${s} must be asleep at idle but did GPU work`);
    if (!base) {
      warns.push(`${key}: no baseline (run npm run perfgate -- --update)`);
      continue;
    }
    for (const [name, v] of Object.entries(now.counters ?? {})) {
      const f = judgeCounter(name, base.counters?.[name], v, opts.counterTol ?? (now.loose ? LOOSE_TOL : COUNTER_TOL));
      if (f) fails.push(`${key}: ${f}`);
    }
    for (const [name, v] of Object.entries(now.pan ?? {})) {
      const f = judgeCounter(name, base.pan?.[name], v, panTol(name));
      if (f) fails.push(`${key}: ${f}`);
    }
    for (const [name, v] of Object.entries(now.timings ?? {})) {
      const j = judgeTiming(name, base.timings?.[name], v, opts.timingTol);
      if (j) (j.level === 'fail' ? fails : warns).push(`${key}: ${j.msg}`);
    }
    const was = new Set(base.awake ?? []);
    for (const s of now.awake ?? []) if (!was.has(s)) fails.push(`${key}: ${s} is awake at idle (it was not in the baseline)`);
  }
  return { fails, warns };
}
