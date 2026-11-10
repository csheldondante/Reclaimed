// (switchover, 2026-11-10; replaces the fortress's fortressfollow gate) Follow one living-town person at the start town
// (Muru) on the town game's page (scripts/lab.mjs: the atlas level, the GPU town, its living town and season loop). A
// rider on a route leg is picked from the living town's rows (lab.riders: a debug read of its rows); the camera follows
// it for `seconds` of sim (lab.look at its window place each sample); it must ride its route (its distance along the
// route moves the leg's way, its place moves) and reach its destination (the leg ends: its row's leg word goes to none
// and its job steps on, at the route's end), on screen throughout, with no page error. Shots follow_000 … for a GIF
// (scripts/lab/frames2gif.mjs).
//   node scripts/lab.mjs run scripts/lab/townfollow.mjs [--args '{"seconds":90,"shots":true}']
export default async function (lab, args) {
  const seconds = args.seconds ?? 90;
  const step = args.step ?? 0.5;
  const id = lab.town;
  const W = 16;
  const word = (r, i, k) => r.words[i * W + k];
  const leg = (r, i) => (word(r, i, 4) >> 16) & 0xff;
  const stOf = (r, i) => (word(r, i, 4) >> 8) & 0xff;
  // (window units: the camera's; world units: the window slides under a followed person, the person doesn't jump)
  const at = (r, i) => [r.rows[i * W] + r.place[0], r.rows[i * W + 1] + r.place[1], r.rows[i * W + 2] + r.place[2]];
  const world = (r, p) => [p[0] + r.origin[0], p[1] + r.origin[1]];
  // a rider just setting out on a route leg (forward, near its start: the whole ride ahead) — waited for while the
  // graph settles, the routes are traced and the riders' first rests run out (a second of sim at a time)
  let r = null;
  let k = -1;
  let waited = 0;
  for (; waited < (args.waitRider ?? 120) && k < 0; waited++) {
    await lab.run(1, 8);
    r = await lab.riders(id);
    if (!r) throw new Error(`no living town at ${id}`);
    for (let i = 0; i < r.n && k < 0; i++) if (leg(r, i) === 1 && r.rows[i * W + 8] < 6) k = i;
  }
  if (k < 0) throw new Error(`no rider set out on a route leg among ${r.n} in ${waited} s`);
  const job = word(r, k, 4) & 0xff;
  const route = word(r, k, 5);
  const p0 = at(r, k);
  lab.look(p0[0], p0[1], args.zoom ?? 9);
  const [VW, VH] = lab.viewport();
  // (on screen: above the card sheet, its top at ~half the screen on a phone)
  const sheetTop = document.querySelector('.season-sheet')?.getBoundingClientRect().top ?? VH;
  const trace = [];
  let riding = 0;
  let moved = 0;
  let sBack = 0;
  let arrived = null;
  let onScreen = 0;
  let samples = 0;
  let prev = world(r, p0);
  let i = 0;
  for (let t = 0; t < seconds && !arrived; t += step) {
    await lab.run(step, 4, { renderEvery: 2 });
    r = await lab.riders(id);
    const l = leg(r, k);
    const p = at(r, k);
    const s = r.rows[k * W + 8];
    const pw = world(r, p);
    const step_m = Math.hypot(pw[0] - prev[0], pw[1] - prev[1]);
    if (step_m > 8) throw new Error(`rider ${k} jumped ${step_m.toFixed(1)} m in ${step} s`);
    moved += step_m;
    prev = pw;
    lab.look(p[0], p[1]);
    const [sx, sy] = lab.project(p[0], p[1], p[2] + 0.7);
    samples++;
    if (sx >= 0 && sy >= 0 && sx <= VW && sy <= Math.min(VH, sheetTop)) onScreen++;
    trace.push({ t: +(t + step).toFixed(1), leg: l, st: stOf(r, k), s: +s.toFixed(1), at: pw.map((v) => +v.toFixed(1)) });
    if (l === 1 && word(r, k, 5) === route) {
      riding++;
      if (s < sBack - 0.01) throw new Error(`rider ${k} went back along its route: s ${sBack.toFixed(2)} → ${s.toFixed(2)}`);
      sBack = s;
    } else arrived = { t: +(t + step).toFixed(1), leg: l, st: stOf(r, k), at: pw, s: sBack };
    if (args.shots) await lab.shot(`follow_${String(i++).padStart(3, '0')}`);
  }
  await lab.shot('townfollow_end');
  const out = { town: id, rider: k, job, waited, riders: r.n, riding, moved: +moved.toFixed(1), arrived, onScreen, samples, trace: trace.filter((_, j) => j % 4 === 0 || j === trace.length - 1) };
  if (riding < 2) throw new Error(`rider ${k} wasn't seen riding (${riding} samples)`);
  if (moved < 5) throw new Error(`rider ${k} moved ${moved.toFixed(1)} m in ${riding} samples riding`);
  if (!arrived) throw new Error(`rider ${k} didn't reach its destination in ${seconds} s (s ${sBack.toFixed(1)})`);
  if (onScreen < samples) throw new Error(`the person left the screen: ${onScreen} of ${samples} samples on it`);
  return out;
}
