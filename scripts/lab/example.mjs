// (round 128l, tooling) The behaviour lab's smallest scenario — a template (docs/TOOLING.md): a house and a farm planned
// beside the heap, Build, 20 sim seconds at 16x, what the people are doing. Runs in the page; `lab` is reclaimed.lab.
//   node scripts/lab.mjs run scripts/lab/example.mjs [--recipe hill] [--args '{"seconds":40}']
export const recipe = 'flat';

export default async function (lab, args) {
  lab.sims(args.sims ?? 'fortress');
  const [hx, hy] = lab.heap;
  lab.plan({ cells: [{ type: 'house', at: [hx + 12, hy + 6] }, { type: 'farm', at: [hx + 20, hy - 8] }] });
  lab.build();
  const r = await lab.run(args.seconds ?? 20, 16);
  const s = lab.snapshot();
  const phases = {};
  for (const w of s.walkers) phases[w.phase] = (phases[w.phase] ?? 0) + 1;
  lab.look(hx + 10, hy + 10, 5);
  await lab.shot('example');
  return { run: r, progress: s.progress, phases, stores: s.stores, roads: s.roads };
}
