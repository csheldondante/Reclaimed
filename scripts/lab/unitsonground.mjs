// (round 128o) Every walker stands on a surface the agents know: never inside a building's claimed columns nor under the
// ground. Checked at each unit's exact position (lab.snapshot() rounds positions to 0.1 m â€” sampling at the rounded
// point once put a unit "inside the lighthouse" that wasn't: a column boundary). The town recipe, Build, 60 sim s.
//   node scripts/lab.mjs run scripts/lab/unitsonground.mjs [--args '{"seconds":60}']
export const recipe = 'town';

export default async function (lab, args) {
  lab.sims('fortress');
  lab.build();
  const rd = lab.units.agents.reader(5);
  const bad = [];
  let t = 0;
  while (t < (args.seconds ?? 60)) {
    t += (await lab.run(10, 16)).simSeconds;
    await rd.refresh();
    // (round 128p, U1: exact places asked of the GPU - the snapshot rounds them)
    const where = new Map((await lab.units.query([0, 0], 1e7)).map((v) => [v.id, v.at]));
    for (const w of (await lab.snapshot()).walkers) {
      if (w.state !== 'walk') continue;
      const p = where.get(w.id);
      if (!p) continue;
      // (a surface under its feet, and not above them: stepping down it rides a little over its floor, never under it.
      // A unit pressed against a column's edge — a terrace it can't step — stands on the boundary, where the CPU's lattice
      // rounds a half the other way from the GPU's: both columns either side of its point are read)
      const ok = [[0, 0], [0.03, 0], [-0.03, 0], [0, 0.03], [0, -0.03]].some(([dx, dy]) => {
        const q = rd.sample(p[0] + dx, p[1] + dy, p[2] + 0.5);
        return q && q.z > 0 && p[2] >= q.z - 0.3;
      });
      const q = rd.sample(p[0], p[1], p[2] + 0.5);
      if (!ok) bad.push(`${w.id} (${w.phase}) at (${p.map((v) => v.toFixed(2)).join(', ')}): surface ${q ? q.z.toFixed(2) : 'none'} at ${Math.round(t)} s`);
    }
  }
  if (bad.length) throw new Error(`walkers off their surfaces: ${bad.slice(0, 8).join('; ')}`);
  return { simSeconds: Math.round(t) };
}
