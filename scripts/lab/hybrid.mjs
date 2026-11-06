// (round 128p, DA-A13 step 2) The hybrid on the user's start town (the `town` fixture, claims no longer baked in): the
// radial relax, curve spokes, a drawn road, a far lumber mill's grown road, the terraces levelled, the edge lanes paved;
// shots at play zoom (before: the old lanes; after) at a lane, a spoke, the drawn road and the mill; an overview.
//   node scripts/lab.mjs run scripts/lab/hybrid.mjs [--args '{"zoom":10}']
export const recipe = 'town';

export default async function (lab, args) {
  while (!lab.ready) await new Promise((r) => setTimeout(r, 100));
  const z = args.zoom ?? 10;
  const [hx, hy] = lab.heap;
  await lab.run(0.5, 1);
  // the mill: 75 m out to the south-east of the stores; the drawn road: across the west
  const mill = [hx + 55, hy - 50];
  const drawn = [
    [hx - 90, hy - 25],
    [hx - 45, hy - 45],
    [hx + 10, hy - 70],
  ];
  lab.look(hx, hy, z);
  await lab.shot('hybrid-before-core');
  const report = await lab.edges({ hybrid: true, drawn: [drawn], place: [{ type: 'lumber', at: mill }], spokes: args.spokes ?? 4 });
  await lab.run(0.5, 1);
  const lane = report.pathsAt.find((p) => p.kind === 1)?.at ?? [hx, hy];
  const spoke = report.hybrid.curves.find((c) => c.kind === 'spoke');
  const far = report.hybrid.curves.find((c) => c.kind === 'far');
  const mid = (c) => [(c.from[0] + c.to[0]) / 2, (c.from[1] + c.to[1]) / 2];
  const looks = [
    ['core', [hx, hy]],
    ['lane', lane],
    ['spoke', spoke ? mid(spoke) : [hx, hy]],
    ['drawn', [hx - 45, hy - 45]],
    ['mill', mill],
    ['millroad', far ? mid(far) : mill],
  ];
  for (const [name, [x, y]] of looks) {
    lab.look(x, y, z);
    await lab.shot(`hybrid-${name}`);
  }
  lab.look(hx, hy, args.overview ?? 2.2);
  await lab.shot('hybrid-overview');
  return report;
}
