// (round 128m, quarry) Frames for a GIF of the miners growing a pit (scripts/lab/quarry.mjs's set-up): a shot every
// `every` sim seconds at play zoom, framed on the pit. The runner saves quarry-gif-<n>.png; scripts/lab-gif.mjs joins them.
//   node scripts/lab.mjs run scripts/lab/quarrygif.mjs [--args '{"r":18,"frames":60,"every":5,"zoom":8}']
export const recipe = 'plateau';

export default async function (lab, args) {
  lab.sims(args.sims ?? 'fortress');
  const f = lab.fortress();
  const [hx, hy] = lab.heap;
  const at = [hx + (args.dx ?? 48), hy];
  const r = args.r ?? 18;
  for (let c = 0; c < f.grid.count; c++) {
    const [x, y] = f.centre(c);
    if (Math.hypot(x - at[0], y - at[1]) <= r) f.paint(c, 0, 'quarry');
  }
  lab.standAll();
  lab.stores({ stone: 0, log: 60, grain: 150 });
  lab.build();
  const q = f.plan.structures().find((s) => s.type === 'quarry');
  const frames = args.frames ?? 60;
  const states = [];
  for (let i = 0; i < frames; i++) {
    lab.look(at[0] + (args.lx ?? -4), at[1] + (args.ly ?? 2), args.zoom ?? 8);
    await lab.run(args.every ?? 5, 16, { keep: true });
    await lab.shot(`quarry-gif-${String(i).padStart(3, '0')}`);
    states.push(lab.life().quarry.stateOf(q.id));
  }
  lab.planMode();
  return { tiers: f.plan.pitOf(q.id).tiers, last: states.at(-1), states: states.filter((_, i) => i % 10 === 0) };
}
