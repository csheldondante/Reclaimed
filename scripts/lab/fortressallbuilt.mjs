// (round 128o, onetown) Every block of the user's start town gets built: the generated town's own sites (a house walled
// in by houses, reached under its neighbour's arch) and three blocks planned 55 m west of the stores, Build, 16x; fails
// if any block still waits after `limit` sim s (default 600). Was 702/708 (nobody built), then 706/708 (cell 1188).
//   node scripts/lab.mjs run scripts/lab/fortressallbuilt.mjs [--args '{"limit":600}']
export const recipe = 'town';

export default async function (lab, args) {
  const limit = args.limit ?? 600;
  lab.sims(args.sims ?? 'fortress');
  const f = lab.fortress();
  const [hx, hy] = lab.heap;
  const c = [hx - 55, hy];
  lab.place('lumber', c[0], c[1]);
  lab.place('house', c[0], c[1] + 9);
  lab.place('farm', c[0], c[1] - 9);
  lab.build();
  let t = 0;
  let s = lab.snapshot();
  while (t < limit) {
    t += (await lab.run(30, 16)).simSeconds;
    s = lab.snapshot();
    console.log(`t ${Math.round(t)} s`, JSON.stringify({ progress: s.progress, cutOff: s.cutOff, grain: Math.round(s.stores.grain ?? 0) }));
    if (s.progress.built === s.progress.total) break;
  }
  if (s.progress.built !== s.progress.total) throw new Error(`${s.progress.total - s.progress.built} blocks not built in ${Math.round(t)} sim s: ${JSON.stringify(f.todoCells().map((x) => [x, f.plan.typeAt(x)]))}`);
  return { built: s.progress.built, simSeconds: Math.round(t) };
}
