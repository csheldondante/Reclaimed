// (U2 round 5, UNIT_MINDS_U2.md §9a) Place orders on the GPU, on the gputown recipe with a keep district raised (the
// barracks): the interface tests both tracks build against —
//   1. "spawnAt barracks puts n units at its approach": n soldiers made by place, found within a few cells of the
//      barracks' approach (a query: the test's read, not the game's)
//   2. "orderGroup go to the muster gives arrived(g) once": the group walks to the muster yard; arrived told once.
//      (first to the keep, near the barracks — arrived once — then across the town to the muster yard: arrived once)
//   3. "an invalid place gives orderFailed": a spawn in an empty town slot → orderFailed(g, 'no-town'), no unit made;
//      an order to a gate slot with no gate → orderFailed(g, 'none')
// Shots at play zoom, 60°: the soldiers at the barracks, on the way, at the muster.
//   node scripts/lab.mjs run scripts/lab/townorders.mjs --flags "&labkeep=1" [--args '{"n":12}']
export const recipe = 'gputown';
export default async function (lab, args) {
  if (lab.recipe !== 'gputown') throw new Error(`the page's recipe is ${lab.recipe}: run with --recipe gputown`);
  if (lab.recipeError) throw new Error(lab.recipeError);
  const units = lab.units;
  const rejections = [];
  addEventListener('unhandledrejection', (e) => rejections.push(String(e.reason?.stack ?? e.reason).slice(0, 400)));
  if (!units?.spawnAt) throw new Error('no units.spawnAt');
  const id = lab.town;
  const town = lab.townIndex(id);
  // (the window slides as the camera looks round — every place read again before it's used: the window's frame)
  let N = (await lab.places(id)).named;
  const fresh = async () => { N = (await lab.places(id)).named; };
  const PLACE = { muster: 0, barracks: 2, keep: 4, gate0: 5 };
  if (N.barracks.status !== 0) throw new Error(`no barracks (status ${N.barracks.status}): run with --flags "&labkeep=1"`);
  if (N.muster.status !== 0) throw new Error(`no muster yard (status ${N.muster.status})`);
  if (N.keep.status !== 0) throw new Error(`no keep (status ${N.keep.status}): run with --flags "&labkeep=1"`);
  const n = args.n ?? 12;
  const arrived = [];
  const failed = [];
  units.arrived.push((g) => arrived.push(g));
  units.orderFailed.push((g, why) => failed.push([g, why]));
  const near = async (p, r) => (await units.query([p[0], p[1]], r)).filter((u) => u.role === 'soldier');
  const cam = lab.camera();
  cam.elevation = Math.PI / 3;
  const zoom = args.zoom ?? (innerWidth / (1.4 * lab.towns.live.get(id).box.R)) * 3.5;
  const settle = () => new Promise((r) => setTimeout(r, 300));
  const out = { town: id, index: town, barracks: N.barracks.approach.map((v) => +v.toFixed(1)), muster: N.muster.at.map((v) => +v.toFixed(1)) };

  // 1. spawnAt the barracks
  await fresh();
  const g = units.spawnAt('soldier', 'f-muru-guard', { town, place: PLACE.barracks }, n);
  await lab.run(0.6, 4, { renderEvery: 1 });
  const atB = await near(N.barracks.approach, 2 + 1.8 * Math.sqrt(n));
  out.spawned = units.members(g).length;
  out.atBarracks = atB.length;
  out.spawnSpread = +Math.max(...atB.map((u) => Math.hypot(u.at[0] - N.barracks.approach[0], u.at[1] - N.barracks.approach[1]))).toFixed(2);
  lab.look(N.barracks.approach[0], N.barracks.approach[1], args.close ?? 40, 0.5);
  await settle();
  await lab.shot('townorders_spawn');

  // 2. orderGroup go to the keep: arrived once (the gate)
  units.orderGroup(g, { kind: 'go', at: { town, place: PLACE.keep } });
  const watchIds = units.members(g);
  const unwatch = units.observe(watchIds);
  const where = () => watchIds.map((m) => units.get(m)?.at).filter(Boolean).map((p) => `${p[0].toFixed(0)},${p[1].toFixed(0)},${p[2].toFixed(0)}`).join(' ');
  let tk = 0;
  while (!arrived.includes(g) && tk < 60) {
    await lab.run(2, 16, { renderEvery: 8 });
    tk += 2;
  }
  out.atArrival = where();
  await lab.run(6, 16, { renderEvery: 8 });
  out.keepArrivedAfter = tk;
  out.keepArrivedTold = arrived.filter((x) => x === g).length;
  await fresh();
  out.keep = N.keep.at.map((v) => +v.toFixed(1));
  out.atKeep = (await near(N.keep.at, 3 + 0.7 * Math.sqrt(n))).length;
  out.afterArrival = where();
  lab.look(N.keep.at[0], N.keep.at[1], zoom, 0.5);
  await settle();
  await lab.shot('townorders_keep');
  arrived.length = 0;
  // (then to the muster yard: reported)
  units.orderGroup(g, { kind: 'go', at: { town, place: PLACE.muster } });
  await fresh();
  const dist = Math.hypot(N.keep.at[0] - N.muster.at[0], N.keep.at[1] - N.muster.at[1]);
  out.walk = +dist.toFixed(1);
  // (a third of the way at a soldier's 2.7 cells/s, then a shot on them: where they stand, observed — the test's read)
  await lab.run(Math.max(2, dist / 2.7 / 3), 8, { renderEvery: 2 });
  const ps = watchIds.map((m) => units.get(m)?.at).filter(Boolean);
  const cx = ps.reduce((a, p) => a + p[0], 0) / ps.length;
  const cy = ps.reduce((a, p) => a + p[1], 0) / ps.length;
  out.walking = where();
  lab.look(cx, cy, args.close ?? 40, 0.5);
  await settle();
  await lab.shot('townorders_walk');
  unwatch();
  let t = 0;
  while (!arrived.includes(g) && t < (args.limit ?? 80)) {
    await lab.run(2, 16, { renderEvery: 8 });
    t += 2;
  }
  out.arrivedAfter = t;
  out.rejections = rejections;
  out.syncs = units.stats.syncs;
  out.syncing = !!units.syncing;
  { const r = units.observe(watchIds); await lab.run(0.5, 4, { renderEvery: 1 }); out.end = where(); r(); out.syncs2 = units.stats.syncs; }
  // (and a while longer: told once, not again)
  await lab.run(6, 16, { renderEvery: 8 });
  out.arrivedTold = arrived.filter((x) => x === g).length;
  await fresh();
  out.atMuster = (await near(N.muster.at, 3 + 0.7 * Math.sqrt(n))).length;
  out.musterNow = N.muster.at.map((v) => +v.toFixed(1));
  lab.look(N.muster.at[0], N.muster.at[1], args.close ?? 40, 0.5);
  await settle();
  await lab.shot('townorders_muster');

  // 3. invalid places: an empty town slot (spawn), a gate slot with no gate (order)
  const emptySlot = [0, 1, 2, 3].find((i) => i !== town && lab.contracts.townArea?.(i) == null) ?? 3;
  const bad = units.spawnAt('soldier', 'f-muru-guard', { town: emptySlot, place: PLACE.barracks }, 3);
  const noGate = Object.entries(N).find(([k, e]) => k.startsWith('gate') && e.status === 1);
  if (noGate) units.orderGroup(g, { kind: 'go', at: { town, place: PLACE.gate0 + Number(noGate[0].slice(4)) } });
  for (let i = 0; i < 10 && failed.length < (noGate ? 2 : 1); i++) await lab.run(1, 4, { renderEvery: 4 });
  out.failed = failed.map(([x, why]) => `${x === bad ? 'spawn' : x === g ? 'order' : x}:${why}`);
  out.badMade = units.members(bad).length;

  const fail = (m) => { throw new Error(`${m} — ${JSON.stringify(out)}`); };
  if (out.spawned !== n || out.atBarracks !== n) fail(`spawnAt barracks: ${out.atBarracks} of ${n} at its approach`);
  if (out.keepArrivedTold !== 1) fail(`arrived at the keep told ${out.keepArrivedTold} times`);
  if (out.arrivedTold !== 1) fail(`arrived at the muster told ${out.arrivedTold} times`);
  if (out.atMuster < n) fail(`${out.atMuster} of ${n} at the muster`);
  if (out.atKeep < n) fail(`${out.atKeep} of ${n} at the keep`);
  if (!out.failed.includes('spawn:no-town') || out.badMade !== 0) fail('a spawn in an empty town slot: no orderFailed no-town, or units made');
  if (noGate && !out.failed.includes('order:none')) fail(`an order to ${noGate[0]} (no gate): no orderFailed none`);
  return out;
}
