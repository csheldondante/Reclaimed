// (round 128n, phonefix; the user on the Pixel 9a, fortress 062fe16: "performance on mobile was abysmal and could not be
// played") The fortress's frame and its GPU reads on the user's start town (the `town` recipe), Build pressed, time at
// the game's speed with the display's own frames: per phase the rAF interval and the frame's CPU (p50/p95/max) and
// every GPU → CPU read by label (calls and bytes a second). Before Build ("plan") and after ("build"), `args.speed`.
// Toggle diffs: run it on two builds (one with a reader switched off) and compare (docs/DEVLOG round 128n).
//   node scripts/lab.mjs run scripts/lab/fortressperf.mjs [--args '{"seconds":10,"speed":4}']
export const recipe = 'town';

export default async function (lab, args) {
  const seconds = args.seconds ?? 10;
  const speed = args.speed ?? 4;
  lab.sims(args.sims ?? 'all');
  const f = lab.fortress();
  await f.settled();
  // (every read counted by its buffer's label)
  const rows = new Map();
  const map = GPUBuffer.prototype.mapAsync;
  if (!GPUBuffer.prototype.__counted) {
    GPUBuffer.prototype.mapAsync = function (mode, offset, size) {
      if (mode & GPUMapMode.READ && window.__readRows) {
        const k = this.label || `unlabeled ${this.size}`;
        const r = window.__readRows.get(k) ?? { calls: 0, bytes: 0 };
        r.calls++;
        r.bytes += size ?? this.size - (offset ?? 0);
        window.__readRows.set(k, r);
      }
      return map.call(this, mode, offset, size);
    };
    GPUBuffer.prototype.__counted = true;
  }
  window.__readRows = rows;
  // (each frame's interval and the CPU of its rAF callbacks)
  const raf = window.requestAnimationFrame.bind(window);
  const S = { iv: [], cpu: [], last: 0, acc: 0 };
  window.requestAnimationFrame = (cb) =>
    raf((t) => {
      const t0 = performance.now();
      try {
        cb(t);
      } finally {
        S.acc += performance.now() - t0;
      }
    });
  let on = true;
  const tick = (t) => {
    if (S.last) S.iv.push(t - S.last);
    S.cpu.push(S.acc);
    S.last = t;
    S.acc = 0;
    if (on) raf(tick);
  };
  const q = (a, p) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1) : null;
  };
  const phase = async (name) => {
    S.iv = [];
    S.cpu = [];
    S.last = 0;
    rows.clear();
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, seconds * 1000));
    const secs = (performance.now() - t0) / 1000;
    const reads = [...rows].map(([label, r]) => ({ label, perSec: +(r.calls / secs).toFixed(1), KBps: Math.round(r.bytes / 1024 / secs) })).sort((a, b) => b.KBps - a.KBps);
    const total = Math.round(reads.reduce((n, r) => n + r.KBps, 0));
    const out = { phase: name, frames: S.iv.length, fps: +(S.iv.length / secs).toFixed(1), iv50: q(S.iv, 0.5), iv95: q(S.iv, 0.95), ivMax: q(S.iv, 1), cpu50: q(S.cpu, 0.5), cpu95: q(S.cpu, 0.95), cpuMax: q(S.cpu, 1), over33: S.iv.filter((v) => v > 33).length, readKBps: total, readsPerSec: +reads.reduce((n, r) => n + r.perSec, 0).toFixed(1), reads: reads.slice(0, 14) };
    console.log(`PERF ${JSON.stringify(out)}`);
    return out;
  };
  raf(tick);
  // (plan mode: time stopped, the town drawn)
  const plan = await phase('plan');
  lab.build();
  await lab.run(2, speed, { keep: true });
  const build = await phase('build');
  on = false;
  window.requestAnimationFrame = raf;
  return { plan, build };
}
