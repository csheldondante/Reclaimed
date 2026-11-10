// (round 128l, m4) Carts and newcomers on the behaviour lab: houses with free beds by the town, a quarry and farms far
// out (past ECON.cartDist from the stores), all standing. Build, then `seconds` of sim sampled every `every` s: the
// miners and farmers leave their loads on their structure's pile and the carts ride out by road and back; newcomers
// walk in from the window's edge where the roads come nearest it and ride the roads to a house. Prints the share of the
// carts' walking samples on a road or lane, and the newcomers'; fails unless a cart brought a load in and a newcomer
// reached a house.
//   node scripts/lab.mjs run scripts/lab/fortresscarts.mjs [--args '{"seconds":200}']
export const recipe = 'flat';

export default async function (lab, args) {
  const seconds = args.seconds ?? 200;
  const every = args.every ?? 2;
  lab.sims(args.sims ?? 'fortress');
  const f = lab.fortress();
  const [hx, hy] = lab.heap;
  const plan = lab.plan({
    cells: [
      { type: 'house', at: [hx + 10, hy + 12] },
      { type: 'house', at: [hx + 16, hy + 12] },
      { type: 'house', at: [hx - 8, hy + 14] },
      ...[[70, 4], [70, 10], [76, 4], [76, 10]].map(([dx, dy]) => ({ type: 'quarry', at: [hx + dx, hy + dy] })),
      ...[[6, -60], [12, -60], [6, -66], [12, -66]].map(([dx, dy]) => ({ type: 'farm', at: [hx + dx, hy + dy] })),
    ],
    built: true,
  });
  await f.settled();
  lab.stores({ grain: 200, log: 60, stone: 60 });
  lab.build();
  const cart = { on: 0, walk: 0 };
  const comer = { on: 0, walk: 0 };
  const phases = {};
  let shot = !args.shot;
  // (round trips per pile type: a cart seen bringing a load back from it, then out of `back` — delivered)
  const trips = {};
  const backFrom = new Map();
  for (let t = 0; t < seconds; t += every) {
    await lab.run(every, 16);
    const s = (await lab.snapshot());
    for (const c of s.carts) {
      const from = c.pile;
      if (c.phase === 'back') backFrom.set(c.id, from);
      else if (backFrom.has(c.id)) {
        const k = lab.fortress().plan.structure(backFrom.get(c.id))?.type ?? '?';
        trips[k] = (trips[k] ?? 0) + 1;
        backFrom.delete(c.id);
      }
      phases[c.phase] = (phases[c.phase] ?? 0) + 1;
      if (c.state === 'walk') {
        cart.walk++;
        if (c.onRoad) cart.on++;
      }
    }
    for (const w of s.walkers)
      if (w.phase === 'arriving' && w.state === 'walk') {
        comer.walk++;
        if (w.onRoad) comer.on++;
      }
    if (!shot && s.carts.some((c) => c.phase === 'back')) {
      const c = s.carts.find((q) => q.phase === 'back');
      lab.look(c.at[0], c.at[1] + 1, 14);
      await lab.shot('cart-back');
      shot = true;
    }
    if (t % 40 === 0) console.log(JSON.stringify({ t: s.simT, people: s.people, carts: s.carts.map((c) => `${c.phase}@${Math.round(c.at[0])},${Math.round(c.at[1])}`).join(" "), piles: s.piles, carted: s.stats.carted, cs: lab.life().cartsState(), arrived: s.stats.arrived, stone: Math.round(s.stores.stone ?? 0), grain: Math.round(s.stores.grain ?? 0) }));
  }
  const s = (await lab.snapshot());
  const out = {
    plan,
    carts: s.carts.length,
    cartLoads: s.stats.cartLoads,
    carted: Math.round(s.stats.carted),
    piled: s.stats.piled,
    trips,
    cartOnRoadShare: cart.walk ? +(cart.on / cart.walk).toFixed(2) : null,
    cartWalkSamples: cart.walk,
    cartPhases: phases,
    arrived: s.stats.arrived,
    newcomerOnRoadShare: comer.walk ? +(comer.on / comer.walk).toFixed(2) : null,
    newcomerWalkSamples: comer.walk,
    people: s.people,
    riding: s.roads.riding,
  };
  if (!(s.stats.cartLoads > 0)) throw new Error(`no cart brought a load in: ${JSON.stringify(out)}`);
  if (!(s.stats.arrived > 0)) throw new Error(`nobody new came: ${JSON.stringify(out)}`);
  return out;
}
