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
  // (round 128p: the generated town changes with its generator — roads first, buildings placed again — so each block
  // goes on the free cell nearest its point: no structure, no main road, no deep water)
  const verge = new Set(f.plan.layout.roads?.verge ?? []);
  const deep = new Set(f.plan.layout.roads?.deep ?? []);
  const taken = new Set();
  const freeNear = (x, y) => {
    for (let r = 0; r <= 12; r += 0.5)
      for (let a = 0; a < 16; a++) {
        const px = x + r * Math.cos((a / 16) * Math.PI * 2);
        const py = y + r * Math.sin((a / 16) * Math.PI * 2);
        const cell = f.cellAt(px, py);
        if (cell < 0 || taken.has(cell) || f.plan.structureAt(cell) || verge.has(cell) || deep.has(cell)) continue;
        taken.add(cell);
        return f.centre(cell);
      }
    throw new Error(`no free cell within 12 m of (${x.toFixed(1)}, ${y.toFixed(1)})`);
  };
  const c = [hx - 55, hy];
  lab.place('lumber', ...freeNear(c[0], c[1]));
  lab.place('house', ...freeNear(c[0], c[1] + 9));
  lab.place('farm', ...freeNear(c[0], c[1] - 9));
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
