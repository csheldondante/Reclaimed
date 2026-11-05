// (round 128m, quarry; V128-11) A quarry's pit grown by its miners: a footprint painted east of the heap on the
// plateau (ground 44 m up the lab's window), built at once, Build, the miners dig tier by tier down the ramps and haul
// the stone up to the stores. Throws unless the pit reaches `tiers` tiers (default 2) and the miners walked into it.
//   node scripts/lab.mjs run scripts/lab/quarry.mjs [--args '{"seconds":240,"r":22,"tiers":2}']
export const recipe = 'plateau';

export default async function (lab, args) {
  lab.sims(args.sims ?? 'fortress');
  const f = lab.fortress();
  const [hx, hy] = lab.heap;
  const at = [hx + (args.dx ?? 48), hy + (args.dy ?? 0)];
  const r = args.r ?? 22;
  for (let c = 0; c < f.grid.count; c++) {
    const [x, y] = f.centre(c);
    if (Math.hypot(x - at[0], y - at[1]) <= r) f.paint(c, 0, 'quarry');
  }
  lab.standAll();
  lab.stores({ stone: 0, log: 60, grain: 150 });
  const q = f.plan.structures().find((s) => s.type === 'quarry');
  const pit = f.plan.pitOf(q.id);
  lab.build();
  const zoom = args.zoom ?? 6;
  lab.look(at[0], at[1] + 6, zoom);
  const out = { cells: q.cells.size, tiers: pit.tiers, steps: [] };
  const seconds = args.seconds ?? 240;
  const every = args.every ?? 40;
  let deepest = Infinity;
  for (let t = 0; t < seconds; t += every) {
    await lab.run(every, args.speed ?? 16, { keep: true });
    const s = lab.snapshot();
    // (the miners in the pit: under the rim's ground by a tier or more)
    const inPit = s.walkers.filter((w) => Math.hypot(w.at[0] - at[0], w.at[1] - at[1]) < r && w.at[2] < lab.ground(at[0] + r + 4, at[1]) - 3).length;
    for (const w of s.walkers) if (Math.hypot(w.at[0] - at[0], w.at[1] - at[1]) < r) deepest = Math.min(deepest, w.at[2]);
    const phases = {};
    for (const w of s.walkers) phases[w.phase] = (phases[w.phase] ?? 0) + 1;
    out.steps.push({ t: s.simT, pit: s.pits[0], phases, inPit, stone: Math.round(s.stores.stone ?? 0), dig: { ...lab.life().quarry.stats }, left: lab.life().quarry.workLeft(q.id) });
    if (args.shots) await lab.shot(`quarry-${Math.round(s.simT)}`);
  }
  lab.planMode();
  const end = lab.snapshot();
  out.end = end.pits[0];
  out.deepestMiner = deepest;
  out.floor = lab.ground(...f.centre([...pit.ring].sort((a, b) => b[1] - a[1])[0][0]));
  out.rim = lab.ground(at[0] + r + 4, at[1]);
  await lab.shot('quarry-end');
  const want = args.tiers ?? 2;
  if (!(end.pits[0].tier > want)) throw new Error(`the pit got to tier ${end.pits[0].tier} (wanted ${want} dug): ${JSON.stringify(out.steps.at(-1))}`);
  if (!out.steps.some((s) => s.inPit > 0)) throw new Error(`no miner walked into the pit: ${JSON.stringify(out.steps)}`);
  return out;
}
