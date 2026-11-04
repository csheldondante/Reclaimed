// (round 128l, tooling) scripts/fortressoutside.mjs on the behaviour lab (docs/TOOLING.md): do the builders get out of
// the walled town and put up what's planned outside its walls? The walled recipe's town (a ring of wall round the heap,
// its gate east), a lumber camp, a house and a farm planned on open ground `dist` from the heap on the side `side`
// (default west: away from the gate, so they must go round), Build, 16x; each site's first block must stand within
// `limit` sim seconds. Prints progress every `every` sim seconds; throws (the run FAILS) if a site isn't reached.
// The sim runs the 'fortress' preset (lab.sims: the land's slow processes left out); args.sims 'all' runs everything.
//   node scripts/lab.mjs run scripts/lab/fortressoutside.mjs [--args '{"side":"north","dist":60,"sims":"all"}']
// The full-game check stays scripts/fortressoutside.mjs (the gate: the atlas's own town, by finger).
export const recipe = 'walled';

export default async function (lab, args) {
  const side = args.side ?? 'west';
  const dist = args.dist ?? 55;
  const limit = args.limit ?? 600;
  const every = args.every ?? 30;
  const speed = args.speed ?? 16;
  // (the sim's land processes the check doesn't read left out: lab.sims — 'all' for the whole game)
  lab.sims(args.sims ?? 'fortress');
  const dir = { east: [1, 0], west: [-1, 0], north: [0, -1], south: [0, 1] }[side];
  const [hx, hy] = lab.heap;
  const c = [hx + dir[0] * dist, hy + dir[1] * dist];
  // (the three sites across the way out: the camp in the middle, the house and the farm a cell and a half either side)
  const across = [-dir[1], dir[0]];
  const sites = {
    lumber: c,
    house: [c[0] + across[0] * 9, c[1] + across[1] * 9],
    farm: [c[0] - across[0] * 9, c[1] - across[1] * 9],
  };
  const f = lab.fortress();
  const cells = {};
  for (const [type, at] of Object.entries(sites)) cells[type] = lab.place(type, at[0], at[1]);
  console.log('planned', JSON.stringify({ side, dist, cells }));
  lab.look(c[0], c[1] + 10, 3.2);
  await lab.shot('outside-plan');
  lab.build();
  let t = 0;
  let built = null;
  while (t < limit) {
    const r = await lab.run(every, speed, { dt: args.dt });
    t += r.simSeconds;
    built = Object.fromEntries(Object.entries(cells).map(([k, cell]) => [k, f.town.has(cell, 0)]));
    const s = lab.snapshot();
    const phases = {};
    for (const w of s.walkers) phases[w.phase] = (phases[w.phase] ?? 0) + 1;
    console.log(`t ${Math.round(t)} s (x${r.xRealtime} real time)`, JSON.stringify({ built, phases, progress: s.progress, cutOff: s.cutOff, note: s.note }));
    if (Object.values(built).every(Boolean)) break;
  }
  lab.look(c[0], c[1] + 10, 3.2);
  await lab.shot('outside-build');
  const ok = Object.values(built).every(Boolean);
  if (!ok) throw new Error(`NOT REACHED in ${limit} sim s: ${JSON.stringify(built)}`);
  return { reached: true, simSeconds: Math.round(t), built };
}
