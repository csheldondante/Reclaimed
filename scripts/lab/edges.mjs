// (round 128p, DA-A13 step 1) The paths on the grid's edges on the user's start town (the `town` fixture as generated):
// shots at play zoom of the lanes as they are, then of the edge paths with the buildings inset, at drawn paths near the
// stores; the reach report.
//   node scripts/lab.mjs run scripts/lab/edges.mjs [--args '{"zoom":12}']
export const recipe = 'town';

export default async function (lab, args) {
  while (!lab.ready) await new Promise((r) => setTimeout(r, 100));
  const z = args.zoom ?? 12;
  await lab.run(0.5, 1);
  const report = lab.edges({ spokes: args.spokes ?? 5 });
  const spots = report.pathsAt.slice(0, args.n ?? 4).map((p) => p.at);
  lab.edges({ off: true });
  await lab.run(0.5, 1);
  for (const [i, [x, y]] of spots.entries()) {
    lab.look(x, y, z);
    await lab.shot(`edges-before-${i}`);
  }
  lab.edges({ spokes: args.spokes ?? 5 });
  await lab.run(0.5, 1);
  for (const [i, [x, y]] of spots.entries()) {
    lab.look(x, y, z);
    await lab.shot(`edges-after-${i}`);
  }
  const [hx, hy] = lab.heap;
  lab.look(hx, hy, args.overview ?? 4);
  await lab.shot('edges-overview');
  return report;
}
