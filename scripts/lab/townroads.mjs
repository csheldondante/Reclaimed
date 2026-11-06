// (round 128p, DA-A13) The start town as generated with its roads (the `town` fixture: roads first, the paths on the
// grid's edges, the terraces levelled), and an edit through the same function: a lumber camp painted far out gets its
// road grown from the nearest major road (Fortress.sync -> relayRoads). Shots at play zoom; the layout's numbers.
//   node scripts/lab.mjs run scripts/lab/townroads.mjs [--args '{"zoom":12}']
export const recipe = 'town';

export default async function (lab, args) {
  while (!lab.ready) await new Promise((r) => setTimeout(r, 100));
  const z = args.zoom ?? 12;
  const f = lab.fortress();
  const roads = () => f.site.plan.layout.roads;
  const r0 = roads();
  const [hx, hy] = lab.heap;
  await lab.run(0.5, 1);
  lab.look(hx, hy, z);
  await lab.shot('town-core');
  lab.look(hx, hy, args.overview ?? 2.4);
  await lab.shot('town-overview');
  // a lumber camp far out (a free dry cell ~70 m from the stores, searched round)
  const at = args.far ?? [hx + 40, hy + 55];
  const t0 = performance.now();
  const cell = lab.place('lumber', at[0], at[1]);
  const ms = performance.now() - t0;
  await lab.run(0.5, 1);
  const r1 = roads();
  const far = r1.curves.filter((c) => c.kind === 'far');
  lab.look(at[0], at[1], z);
  await lab.shot('town-far');
  return {
    before: { curves: r0.curves.map((c) => `${c.kind}:${c.pts.length}`), verge: r0.verge.length, drawnSides: r0.sides.filter(Boolean).length },
    after: { curves: r1.curves.map((c) => `${c.kind}:${c.pts.length}`), verge: r1.verge.length, far: far.length },
    placeMs: +ms.toFixed(1),
    cell,
  };
}
