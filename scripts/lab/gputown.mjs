// (Track B's unit contracts, docs/design/TOWN_CONTRACTS.md) The gputown recipe's gate and its shots: Muru's GPU town and
// living town with its walls card risen at once (src/lab/lab.ts gputown). It must: give Muru a town index; solve the side
// map over the risen wall on the GPU (the muster yard's column on Muru's side, its spawn points' outside: 0); resolve the
// named places (the stores, the market, the muster yard, the gates on the arterials' roads, the spawn points; the keep
// and barracks only with --flags "&labkeep=1"); with no page error. Shots at play zoom, 60°: the side map, the places.
//   node scripts/lab.mjs run scripts/lab/gputown.mjs [--flags "&labkeep=1&perf=1"] [--args '{"zoom":2.5}']
export const recipe = 'gputown';
export default async function (lab, args) {
  if (lab.recipe !== 'gputown') throw new Error(`the page's recipe is ${lab.recipe}: run with --recipe gputown (or this file's export)`);
  if (lab.recipeError) throw new Error(lab.recipeError);
  const id = lab.town;
  const t = lab.towns.live.get(id);
  const town = lab.townIndex(id);
  if (town < 0) throw new Error(`${id} has no town index`);
  const counts = await lab.sideCounts(id);
  const pl = await lab.places(id);
  const { w, map } = await lab.sides();
  const ROW_H = Math.sqrt(3) / 2;
  const sideAt = (p) => {
    const y = Math.round(p[1] / ROW_H - 0.5);
    const x = Math.round(p[0] - 0.5 - 0.5 * (y & 1));
    return map[y * w + x];
  };
  const N = pl.named;
  const ok = (n) => N[n]?.status === 0;
  const gates = Object.entries(N).filter(([k, e]) => k.startsWith('gate') && e.status !== 1).map(([k, e]) => `${k} ${['ok', 'none', 'rising', 'water'][e.status]}`);
  const spawns = Object.entries(N).filter(([k, e]) => k.startsWith('spawn') && e.status === 0);
  const out = {
    town: id,
    name: t.site.name,
    index: town,
    side: counts.side,
    insideColumns: counts.inside,
    otherSides: counts.others,
    muster: N.muster,
    musterSide: ok('muster') ? sideAt(N.muster.at) : null,
    stores: ok('stores') ? N.stores.at.map((v) => +v.toFixed(1)) : N.stores.status,
    market: N.market.status,
    keep: N.keep.status,
    barracks: N.barracks.status,
    gates,
    spawnSides: spawns.map(([k, e]) => `${k} ${sideAt(e.at)}`),
  };
  // (shots: the whole town at play zoom — the season's framing — and the places nearer; 60°)
  const cam = lab.camera();
  cam.elevation = Math.PI / 3;
  const zoom = args.zoom ?? innerWidth / (1.4 * t.box.R);
  const [cx, cy] = t.centreInWindow();
  const settle = () => new Promise((r) => setTimeout(r, 400));
  lab.look(cx, cy, zoom, 0.5);
  await settle();
  out.drawn = (await lab.markContracts(id)).drawn;
  await lab.shot('gputown_sides');
  // (nearer: the middle of the town's named places in the town — the muster yard, the stores, the market, a gate)
  const near = ['muster', 'stores', 'market', 'keep', 'barracks'].filter(ok).map((n) => N[n].at);
  const mx = near.reduce((a, p) => a + p[0], 0) / near.length;
  const my = near.reduce((a, p) => a + p[1], 0) / near.length;
  lab.look(mx, my, zoom * (args.near ?? 1.8), 0.5);
  await settle();
  out.invalid = (await lab.markContracts(id, { step: 3 })).invalid;
  await lab.shot('gputown_places');
  await lab.markContracts(id, { clear: true });
  // (the passes' GPU ms, when the page was opened with &perf=1)
  if (args.perf) {
    await lab.run(4, 1, { renderEvery: 1 });
    out.gpuMs = lab.gpuMs('towncontracts');
  }
  const fail = (m) => { throw new Error(`${m} — ${JSON.stringify(out)}`); };
  if (!(counts.inside > 1000)) fail(`the side map has ${counts.inside} columns inside ${t.site.name}'s wall`);
  if (!ok('muster')) fail(`no muster yard: ${JSON.stringify(N.muster)}`);
  if (out.musterSide !== counts.side) fail(`the muster yard is on side ${out.musterSide}, not the town's ${counts.side}`);
  if (!ok('stores')) fail(`no stores: ${JSON.stringify(N.stores)}`);
  if (!spawns.length || spawns.some(([, e]) => sideAt(e.at) !== 0)) fail(`the spawn points aren't outside: ${out.spawnSides.join(', ')}`);
  if (!gates.some((g) => g.endsWith(' ok') || g.endsWith(' water'))) fail(`no gate: ${gates.join(', ')}`);
  if (new URLSearchParams(location.search).get('labkeep') === '1' && !(ok('keep') && ok('barracks'))) fail(`a keep district raised, but keep ${N.keep.status} barracks ${N.barracks.status}`);
  return out;
}
