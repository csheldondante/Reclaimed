// (U2 round 5, UNIT_MINDS_U2.md §9a) Place orders on the GPU, on the gputown recipe with a keep district raised (the
// barracks): the interface tests both tracks build against —
//   1. "spawnAt barracks puts n units at its approach": n soldiers made by place, found within a few cells of the
//      barracks' approach (a query: the test's read, not the game's)
//   2. "orderGroup go to the muster gives arrived(g) once": first to the keep (near the barracks), then across the town
//      to the muster yard — arrived told once each
//   3. "an invalid place gives orderFailed": a spawn in a town slot past the table's room → orderFailed(g, 'no-town'),
//      no unit made; an order to a gate slot with no gate → orderFailed(g, 'none')
//   4. else / also (round 5b, with Track A): "gate else keep picks the keep when the gate is over water", "spawn k also
//      gate k fails over to the else when gate k is invalid"; a whole chain failing tells the last ref's reason; a
//      4-deep chain throws
// The gates run with the camera still (a look slides the window; the places are read again after one anyway). The
// shots come after, at play zoom, 60°: a second squad at the barracks and on its way out, the first at the muster yard.
// Known flake, not the orders': on the walk to the muster yard soldiers sometimes drown crossing Muru's river (deaths
// by water, with the camera still; BACKLOG U2-DROWN) — the muster gate then fails with deaths listed in the result.
//   node scripts/lab.mjs run scripts/lab/townorders.mjs --flags "&labkeep=1" [--args '{"n":12}']
export const recipe = 'gputown';
export default async function (lab, args) {
  if (lab.recipe !== 'gputown') throw new Error(`the page's recipe is ${lab.recipe}: run with --recipe gputown`);
  if (lab.recipeError) throw new Error(lab.recipeError);
  const units = lab.units;
  if (!units?.spawnAt) throw new Error('no units.spawnAt');
  const id = lab.town;
  const town = lab.townIndex(id);
  // (the window slides as the camera looks round — every place read again before it's used: the window's frame)
  let N = (await lab.places(id)).named;
  const fresh = async () => { N = (await lab.places(id)).named; };
  const PLACE = { muster: 0, barracks: 2, keep: 4, gate0: 5, spawn0: 15 };
  if (N.barracks.status !== 0) throw new Error(`no barracks (status ${N.barracks.status}): run with --flags "&labkeep=1"`);
  if (N.muster.status !== 0) throw new Error(`no muster yard (status ${N.muster.status})`);
  if (N.keep.status !== 0) throw new Error(`no keep (status ${N.keep.status}): run with --flags "&labkeep=1"`);
  const n = args.n ?? 12;
  const arrived = [];
  const failed = [];
  const deaths = [];
  units.arrived.push((g) => arrived.push(g));
  units.orderFailed.push((g, why) => failed.push([g, why]));
  units.died.push((u, by) => { if (u.role === 'soldier' && deaths.length < 20) deaths.push(`${u.id} by ${by} t ${lab.simT.toFixed(1)}`); });
  const near = async (p, r) => (await units.query([p[0], p[1]], r)).filter((u) => u.role === 'soldier');
  const madeNear = async (gid, p, r) => {
    const ms = units.members(gid);
    const vs = (await units.query([p[0], p[1]], r)).filter((v) => ms.includes(v.id));
    return `${vs.length}/${ms.length}`;
  };
  const out = { town: id, index: town };

  // 1. spawnAt the barracks
  await fresh();
  const g = units.spawnAt('soldier', 'f-muru-guard', { town, place: PLACE.barracks }, n);
  await lab.run(0.6, 4, { renderEvery: 4 });
  await fresh();
  const atB = await near(N.barracks.approach, 2 + 1.8 * Math.sqrt(n));
  out.spawned = units.members(g).length;
  out.atBarracks = atB.length;
  out.spawnSpread = +Math.max(...atB.map((u) => Math.hypot(u.at[0] - N.barracks.approach[0], u.at[1] - N.barracks.approach[1]))).toFixed(2);

  // 2. go to the keep, then the muster yard: arrived once each
  const walk = async (place, limit) => {
    arrived.length = 0;
    units.orderGroup(g, { kind: 'go', at: { town, place } });
    let t = 0;
    while (!arrived.includes(g) && t < limit) {
      await lab.run(2, 16, { renderEvery: 8 });
      t += 2;
    }
    const after = t;
    // (and a while longer: told once, not again)
    await lab.run(6, 16, { renderEvery: 8 });
    return { after, told: arrived.filter((x) => x === g).length };
  };
  const k = await walk(PLACE.keep, 60);
  await fresh();
  out.keep = { ...k, at: (await near(N.keep.at, 3 + 0.7 * Math.sqrt(n))).length };
  out.walk = +Math.hypot(N.keep.at[0] - N.muster.at[0], N.keep.at[1] - N.muster.at[1]).toFixed(1);
  const m = await walk(PLACE.muster, 120);
  await fresh();
  out.muster = { ...m, at: (await near(N.muster.at, 3 + 0.7 * Math.sqrt(n))).length };

  // 3. invalid places: a town slot past the table's room (never live: no race with a town streaming in), a gate with none
  failed.length = 0;
  const bad = units.spawnAt('soldier', 'f-muru-guard', { town: 4, place: PLACE.barracks }, 3);
  const noGate = Object.entries(N).find(([key, e]) => key.startsWith('gate') && e.status === 1);
  if (noGate) units.orderGroup(g, { kind: 'go', at: { town, place: PLACE.gate0 + Number(noGate[0].slice(4)) } });
  for (let i = 0; i < 10 && failed.length < (noGate ? 2 : 1); i++) await lab.run(1, 4, { renderEvery: 4 });
  out.failed = failed.map(([x, why]) => `${x === bad ? 'spawn' : x === g ? 'order' : x}:${why}`);
  out.badMade = units.members(bad).length;
  // (the group back to the muster yard, for its shot)
  units.orderGroup(g, { kind: 'go', at: { town, place: PLACE.muster } });

  // 4. else / also chains: the spawn shows which place the GPU chose
  await fresh();
  const st = (key) => N[key]?.status;
  const idx = (key) => Number(key.replace(/^\D+/, ''));
  const gates = Object.keys(N).filter((key) => key.startsWith('gate'));
  const waterGate = gates.find((key) => st(key) === 3);
  const badGate = waterGate ?? gates.find((key) => st(key) !== 0);
  out.gateStatuses = gates.map((key) => `${key}:${st(key)}`).join(' ');
  out.spawnStatuses = Object.keys(N).filter((key) => key.startsWith('spawn')).map((key) => `${key}:${st(key)}`).join(' ');
  if (badGate) {
    const ge = units.spawnAt('soldier', 'f-muru-guard', { town, place: PLACE.gate0 + idx(badGate), else: { town, place: PLACE.keep } }, 3);
    await lab.run(0.6, 4, { renderEvery: 4 });
    await fresh();
    out.gateElseKeep = { gate: badGate, status: st(badGate), atKeep: await madeNear(ge, N.keep.approach, 6) };
  }
  const sk = Object.keys(N).filter((key) => key.startsWith('spawn')).find((key) => st(key) === 0 && st(`gate${idx(key)}`) !== 0);
  if (sk) {
    const j = idx(sk);
    const sa = units.spawnAt('soldier', 'f-muru-guard', { town, place: PLACE.spawn0 + j, also: { town, place: PLACE.gate0 + j }, else: { town, place: PLACE.barracks } }, 3);
    await lab.run(0.6, 4, { renderEvery: 4 });
    await fresh();
    out.spawnAlsoGate = { spawn: sk, gate: `gate${j}:${st(`gate${j}`)}`, atBarracks: await madeNear(sa, N.barracks.approach, 6), atSpawn: await madeNear(sa, N[sk].approach, 6) };
  }
  failed.length = 0;
  const wf = units.spawnAt('soldier', 'f-muru-guard', { town, place: PLACE.gate0 + idx(badGate ?? 'gate9'), else: { town: 4, place: PLACE.keep } }, 2);
  for (let i = 0; i < 10 && !failed.some(([x]) => x === wf); i++) await lab.run(1, 4, { renderEvery: 4 });
  out.chainFailed = failed.filter(([x]) => x === wf).map(([, why]) => why);
  try {
    units.spawnAt('soldier', null, { town, place: 0, else: { town, place: 1, else: { town, place: 2, else: { town, place: 3 } } } }, 1);
    out.deepThrows = null;
  } catch (e) {
    out.deepThrows = String(e.message ?? e);
  }
  out.deaths = deaths.slice();

  // shots (after the gates: a look may slide the window): a second squad at the barracks and leaving it, the first at
  // the muster yard. Each where it stands, observed (the test's read); a few drawn frames at each view first
  const cam = lab.camera();
  cam.elevation = Math.PI / 3;
  const close = args.close ?? 40;
  const shoot = async (name, ids) => {
    const r = units.observe(ids);
    await lab.run(0.2, 1, { renderEvery: 1 });
    const ps = ids.map((i) => units.get(i)?.at).filter(Boolean);
    r();
    if (!ps.length) return `${name}: none`;
    const cx = ps.reduce((a, p) => a + p[0], 0) / ps.length;
    const cy = ps.reduce((a, p) => a + p[1], 0) / ps.length;
    lab.look(cx, cy, close, 0.5);
    await lab.run(0.3, 1, { renderEvery: 1 });
    await new Promise((res) => setTimeout(res, 300));
    await lab.shot(name);
    return `${name}: ${ps.length} round ${cx.toFixed(0)},${cy.toFixed(0)}`;
  };
  const s2 = units.spawnAt('soldier', 'f-muru-guard', { town, place: PLACE.barracks }, n);
  await lab.run(0.6, 4, { renderEvery: 4 });
  out.shots = [await shoot('townorders_spawn', units.members(s2))];
  units.orderGroup(s2, { kind: 'go', at: { town, place: PLACE.muster } });
  await lab.run(4, 4, { renderEvery: 2 });
  out.shots.push(await shoot('townorders_walk', units.members(s2)));
  out.shots.push(await shoot('townorders_muster', units.members(g)));

  const fail = (msg) => { throw new Error(`${msg} — ${JSON.stringify(out)}`); };
  if (out.spawned !== n || out.atBarracks !== n) fail(`spawnAt barracks: ${out.atBarracks} of ${n} at its approach`);
  if (out.keep.told !== 1 || out.keep.at < n) fail(`the keep: arrived told ${out.keep.told} times, ${out.keep.at} of ${n} there`);
  if (out.muster.told !== 1 || out.muster.at < n) fail(`the muster: arrived told ${out.muster.told} times, ${out.muster.at} of ${n} there`);
  if (!out.failed.includes('spawn:no-town') || out.badMade !== 0) fail('a spawn in no town: no orderFailed no-town, or units made');
  if (noGate && !out.failed.includes('order:none')) fail(`an order to ${noGate[0]} (no gate): no orderFailed none`);
  if (!badGate) fail('no invalid gate on Muru to test gate-else-keep with');
  if (out.gateElseKeep.atKeep !== '3/3') fail(`gate else keep: ${out.gateElseKeep.atKeep} at the keep`);
  if (!sk) fail('no spawn point valid with its gate invalid on Muru');
  if (out.spawnAlsoGate.atBarracks !== '3/3') fail(`spawn also gate else barracks: ${out.spawnAlsoGate.atBarracks} at the barracks`);
  if (out.chainFailed.join() !== 'no-town') fail(`a failing chain told ${out.chainFailed.join()}`);
  if (!out.deepThrows) fail('a 4-deep else chain did not throw');
  return out;
}
