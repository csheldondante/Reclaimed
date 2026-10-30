// (round 112) the user's phone report on a run (places, run=bell): "I can't walk more than a tiny bit … it walks me a
// few steps them stops": the run's TouchPad stick held up the screen for 5 s; the Walker's state every 0.25 s
const run = window.reclaimed.run;
if (!run) return 'no run (?run=bell)';
const w = run.hero;
const t = window.reclaimed.heroSandbox?.d.api.terrain ?? null;
const out = [];
const p0 = [...w.position()];
run.pad.scripted = { stick: [0, -56] };
for (let k = 0; k < 20; k++) {
  await new Promise((r) => setTimeout(r, 250));
  const p = w.position();
  out.push({ t: (k + 1) * 0.25, d: +Math.hypot(p[0] - p0[0], p[1] - p0[1]).toFixed(2), pace: +w.pace.toFixed(2), at: p.map((v) => +v.toFixed(1)), swing: w.swingT, goal: w.goal, origin: window.reclaimed.stream?.origin, talking: run.play.dialog.isOpen, ended: !!run.ended, cam: window.reclaimed.camera.target.map((v) => +v.toFixed(1)) });
}
run.pad.scripted = null;
return out.map((o) => `${o.t}s d ${o.d} pace ${o.pace} at ${o.at}`).join(' | ');
