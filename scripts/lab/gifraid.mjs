// (round 128l, m4: the attack wave) GIF frames of a wave at play zoom. `args.what`:
//   gate   (walled) the raiders reach the shut gate and bash it till it breaks, then walk in — the camera on the gate
//   burn   (walled) a house set alight: flames, then it falls and its timber burns — the camera on the first house torched
//   (args.soldiers: soldiers stood up on the wall first — archers shooting)
// Then: node scripts/lab/frames2gif.mjs .testcache/lab-shots <what>_ <what>.gif
export const recipe = 'walled';

export default async function (lab, args) {
  const what = args.what ?? 'gate';
  const frames = args.frames ?? 60;
  const step = args.step ?? 0.5;
  const zoom = args.zoom ?? 14;
  lab.sims(args.sims ?? 'raid');
  const f = lab.fortress();
  await f.settled();
  lab.stores({ stone: 120, log: 60, grain: 60, ore: 10, weapons: 2 });
  lab.build();
  const raid = lab.raid();
  const life = lab.life();
  if (args.soldiers) life.standSoldiers(args.soldiers);
  await lab.run(1, 4);
  raid.callNow();
  const gates = [];
  for (const s of f.plan.structures()) for (const c of s.cells.keys()) if (f.plan.gate[c]) gates.push(c);
  const gate = f.centre(gates[0]);
  // (on until the moment worth filming)
  for (let t = 0; t < 240; t += 1) {
    await lab.run(1, 8);
    const s = raid.state();
    if (what === 'gate' && s.stage === 'breach' && s.goal?.kind === 'breach') {
      const g = f.centre(s.goal.cell);
      if (s.raiders.some((r) => r.at && Math.hypot(r.at[0] - g[0], r.at[1] - g[1]) < (args.near ?? 14))) break;
    }
    if (what === 'burn' && s.burning > 0) break;
    if (s.stage === 'none') throw new Error(`the wave ended before the shot: ${JSON.stringify(s.stats)}`);
  }
  const seen = [];
  // (the camera on the wall cell they go for: the breach goal, the gate failing that)
  const goal = raid.state().goal;
  let at = goal?.kind === 'breach' ? f.centre(goal.cell) : gate;
  if (what === 'burn') {
    const h = f.plan.structures().find((s) => s.type === 'house');
    at = f.doorOf(h.id) ?? gate;
  }
  for (let i = 0; i < frames; i++) {
    const s = raid.state();
    if (what === 'burn' && s.burning === 0 && i === 0) break;
    // (gate: the camera on the raiders while they're at the wall, held there after)
    if (what === 'gate' && (s.stage === 'breach' || i === 0)) {
      const ps = s.raiders.map((r) => r.at).filter(Boolean);
      if (ps.length) at = [ps.reduce((a, p) => a + p[0], 0) / ps.length, ps.reduce((a, p) => a + p[1], 0) / ps.length];
    }
    seen.push(`${s.stage}:${s.raiders.map((r) => r.phase[0]).join('')}:${s.stats.blows}`);
    lab.look(at[0] + (args.dx ?? 0), at[1] + (args.dy ?? 0), zoom);
    await lab.shot(`${what}_${String(i).padStart(3, '0')}`);
    await lab.run(step, 4);
  }
  return { seen: seen.filter((s, i) => s !== seen[i - 1]), stats: raid.state().stats };
}
