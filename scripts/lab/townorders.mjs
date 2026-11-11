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
// The walk to the muster yard depends on Muru's water holding (UC-6, fixed on trackA-uc6): flooded, the soldiers drown,
// and the gate fails loudly with "flooded" (the live water along their way past DEEP) before the muster's own check.
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
  // (the water along the walk, every 2 s at each soldier: the live water's depth there (the world's water buffer) and
  // the depth the peel gave its surface (what the fields and the step's drowning read) — the test's reads)
  const ROW_H = Math.sqrt(3) / 2;
  const core = window.reclaimed.core;
  const cellOf = (p) => { const y = Math.round(p[1] / ROW_H - 0.5); return [Math.round(p[0] - 0.5 - 0.5 * (y & 1)), y]; };
  const waterLog = async (ids, rd, into) => {
    const r = units.observe(ids);
    await lab.run(0.1, 1, { renderEvery: 8 });
    const live = await core.readBuffer('water');
    const { w } = core.dims;
    for (const i of ids) {
      const p = units.get(i)?.at;
      const u = units.get(i);
      if (!p || !u?.alive) continue;
      const [cx, cy] = cellOf(p);
      const sm = rd?.sample(p[0], p[1], p[2] + 0.5);
      const liveD = live[cy * w + cx] ?? 0;
      into.maxLive = Math.max(into.maxLive ?? 0, liveD);
      into.maxPeel = Math.max(into.maxPeel ?? 0, sm?.water ?? 0);
      if (liveD > 0.6 || (sm?.water ?? 0) > 0.6) into.wet.push(`${u.id}@${p.map((v) => v.toFixed(0))} live ${liveD.toFixed(2)} peel ${(sm?.water ?? 0).toFixed(2)} z ${(sm?.z ?? 0).toFixed(1)}`);
    }
    r();
  };
  const walk = async (place, limit, log) => {
    arrived.length = 0;
    units.orderGroup(g, { kind: 'go', at: { town, place } });
    const rd = log ? units.agents.reader(0).start(250) : null;
    let t = 0;
    while (!arrived.includes(g) && t < limit) {
      await lab.run(2, 16, { renderEvery: 8 });
      t += 2;
      if (log) await waterLog(units.members(g), rd, log);
    }
    rd?.stop();
    const after = t;
    // (and a while longer: told once, not again)
    await lab.run(6, 16, { renderEvery: 8 });
    return { after, told: arrived.filter((x) => x === g).length };
  };
  const k = await walk(PLACE.keep, 60);
  await fresh();
  out.keep = { ...k, at: (await near(N.keep.at, 3 + 0.7 * Math.sqrt(n))).length };
  out.walk = +Math.hypot(N.keep.at[0] - N.muster.at[0], N.keep.at[1] - N.muster.at[1]).toFixed(1);
  const water = { wet: [] };
  const m = await walk(PLACE.muster, 120, water);
  await fresh();
  out.muster = { ...m, at: (await near(N.muster.at, 3 + 0.7 * Math.sqrt(n))).length };
  out.water = { maxLive: +(water.maxLive ?? 0).toFixed(2), maxPeel: +(water.maxPeel ?? 0).toFixed(2), wet: water.wet.slice(0, 12) };
  out.musterDeaths = deaths.slice();

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
    // (settled first: no slide under way (the streamer's busy) and the screen covered by land — the window's or baked
    // tiles — 5 frames running, 10 s at most; what it reached is in the result)
    const R = window.reclaimed;
    let ok = 0;
    let cover = null;
    let busy = null;
    for (let f = 0; f < 200 && ok < 5; f++) {
      await lab.run(0.05, 1, { renderEvery: 1 });
      busy = !!R.scene?.stream?.busy;
      const c = R.renderer?.tiles?.coverage(R.camera) ?? null;
      cover = c ? +(c.window + c.tiles).toFixed(3) : null;
      ok = !busy && (cover === null || cover >= 0.98) ? ok + 1 : 0;
    }
    await new Promise((res) => setTimeout(res, 300));
    await lab.shot(name);
    return `${name}: ${ps.length} round ${cx.toFixed(0)},${cy.toFixed(0)}; settled ${ok >= 5}, busy ${busy}, cover ${cover}, zoom ${R.camera.zoom.toFixed(1)}`;
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
  // (the walk's precondition: no live water on the soldiers' way deeper than DEEP (0.9) — deeper than a walker is ever led
  // into, the class the peel gave the path when the field was made. Fortress's UC-6 blow-up floods Muru (its river
  // spreads over the town, columns very deep) and drowns any squad: that's the water's, not the orders' — fixed on
  // trackA-uc6, where this walk crossed dry 3 runs of 3)
  if (out.water.maxLive > 0.9) fail(`flooded: the live water on the soldiers' way reached ${out.water.maxLive} (the peel saw ${out.water.maxPeel}; DEEP 0.9) — UC-6, trackA-uc6's fix`);
  if (out.muster.told !== 1 || out.muster.at < n) fail(`the muster: arrived told ${out.muster.told} times, ${out.muster.at} of ${n} there`);
  if (!out.failed.includes('spawn:no-town') || out.badMade !== 0) fail('a spawn in no town: no orderFailed no-town, or units made');
  if (noGate && !out.failed.includes('order:none')) fail(`an order to ${noGate[0]} (no gate): no orderFailed none`);
  if (!badGate) fail('no invalid gate on Muru to test gate-else-keep with');
  if (out.gateElseKeep.atKeep !== '3/3') fail(`gate else keep: ${out.gateElseKeep.atKeep} at the keep`);
  // (round 6b: since UC-13 Muru's wet spawn points read WATER, so a spawn point standing with its gate invalid may not
  // exist — then the case is test/gpu/formations.test.ts's ("spawn k also gate k else barracks", a hand-made table))
  if (!sk) out.spawnAlsoGate = `skipped: no spawn point valid with its gate invalid (${out.spawnStatuses} / ${out.gateStatuses}) — formations.test.ts covers it`;
  else if (out.spawnAlsoGate.atBarracks !== '3/3') fail(`spawn also gate else barracks: ${out.spawnAlsoGate.atBarracks} at the barracks`);
  if (out.chainFailed.join() !== 'no-town') fail(`a failing chain told ${out.chainFailed.join()}`);
  if (!out.deepThrows) fail('a 4-deep else chain did not throw');
  return out;
}
