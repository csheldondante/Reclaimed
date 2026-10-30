// (round 112) the stick-walk probe (the user: "it walks me a few steps them stops"): in as the Walker, the TouchPad's
// stick held up the screen for 5 s; position, pace and the Walker's state every 0.25 s
const hs = window.reclaimed.heroSandbox;
if (!hs.active) await hs.enter();
await new Promise((r) => setTimeout(r, 1500));
const w = hs.hero;
const out = [];
const p0 = [...w.position()];
hs.pad.scripted = { stick: [0, -56] };
for (let k = 0; k < 20; k++) {
  await new Promise((r) => setTimeout(r, 250));
  const p = w.position();
  out.push({ t: (k + 1) * 0.25, d: +Math.hypot(p[0] - p0[0], p[1] - p0[1]).toFixed(2), pace: +w.pace.toFixed(2), z: +p[2].toFixed(1), swing: w.swingT, push: w.push, goal: w.goal, move: hs.lastIntent.move.map((v) => +v.toFixed(2)), az: +window.reclaimed.camera.azimuth.toFixed(2) });
}
hs.pad.scripted = null;
return out.map((o) => `${o.t}s d ${o.d} pace ${o.pace} z ${o.z} move ${o.move}`).join(' | ');
