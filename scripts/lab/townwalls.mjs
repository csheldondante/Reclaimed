// (U2 round 6, UNIT_MINDS_U2.md §9c/§9d) Manning Muru's walls and marching out of a gate, on the gputown recipe (its
// walls card risen): the orders Track A's TownForces gives —
//   1. "man gives a post to each soldier along the wall-walk tops and arrived(g) once": soldiers spawned at the muster
//      yard, ordered to man the town; up their run's stair single file, along the top to their posts; arrived once
//   2. "march g along gate k's route gives arrived(g) once": a squad from the muster yard out of a standing gate (status
//      OK) along its route to the box's edge, the column narrowing to the route's width
//   3. "march … leave tells left(g) once": a second squad through the same gate, leaving the window
// Shots settled (no slide under way, the screen covered): the wall manned, the column on the march. Fortress still
// floods Muru (UC-6): the water at the soldiers is logged, and the gates fail "flooded" (UC-6's, not the orders') when it
// passes DEEP on their way.
//   node scripts/lab.mjs run scripts/lab/townwalls.mjs [--args '{"n":12}']
export const recipe = 'gputown';
export default async function (lab, args) {
  if (lab.recipe !== 'gputown') throw new Error(`the page's recipe is ${lab.recipe}: run with --recipe gputown`);
  if (lab.recipeError) throw new Error(lab.recipeError);
  const units = lab.units;
  const id = lab.town;
  const town = lab.townIndex(id);
  let N = (await lab.places(id)).named;
  const fresh = async () => { N = (await lab.places(id)).named; };
  const PLACE = { muster: 0 };
  if (N.muster.status !== 0) throw new Error(`no muster yard (status ${N.muster.status})`);
  const n = args.n ?? 12;
  const arrived = [];
  const left = [];
  const failed = [];
  const deaths = [];
  units.arrived.push((g) => arrived.push(g));
  units.left.push((g) => left.push(g));
  units.orderFailed.push((g, why) => failed.push([g, why]));
  units.died.push((u, by) => { if (u.role === 'soldier' && deaths.length < 20) deaths.push(`${u.id} by ${by} t ${lab.simT.toFixed(1)}`); });
  const R = window.reclaimed;
  const core = R.core;
  const ROW_H = Math.sqrt(3) / 2;
  const cellOf = (p) => { const y = Math.round(p[1] / ROW_H - 0.5); return [Math.round(p[0] - 0.5 - 0.5 * (y & 1)), y]; };
  const water = { maxLive: 0 };
  // (the test's reads: where the members stand, the live water there, their heights)
  const look = async (ids) => {
    const r = units.observe(ids);
    await lab.run(0.1, 1, { renderEvery: 8 });
    const ps = ids.map((i) => units.get(i)).filter((u) => u?.alive && u.at).map((u) => u.at);
    r();
    const live = await core.readBuffer('water');
    const { w } = core.dims;
    for (const p of ps) {
      const [cx, cy] = cellOf(p);
      water.maxLive = Math.max(water.maxLive, live[cy * w + cx] ?? 0);
    }
    return ps;
  };
  const until = async (g, list, limit) => {
    let t = 0;
    while (!list.includes(g) && !failed.some(([x]) => x === g) && t < limit) {
      await lab.run(2, 16, { renderEvery: 8 });
      t += 2;
      await look(units.members(g));
    }
    return t;
  };
  const shoot = async (name, ids) => {
    const r = units.observe(ids);
    await lab.run(0.2, 1, { renderEvery: 1 });
    const ps = ids.map((i) => units.get(i)?.at).filter(Boolean);
    r();
    if (!ps.length) return `${name}: none`;
    const cx = ps.reduce((a, p) => a + p[0], 0) / ps.length;
    const cy = ps.reduce((a, p) => a + p[1], 0) / ps.length;
    lab.camera().elevation = Math.PI / 3;
    lab.look(cx, cy, args.close ?? 36, 0.5);
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
    return `${name}: ${ps.length} round ${cx.toFixed(0)},${cy.toFixed(0)}; settled ${ok >= 5}, cover ${cover}`;
  };
  const out = { town: id, index: town };

  // 1. man the walls
  await fresh();
  const gm = units.spawnAt('soldier', 'f-muru-guard', { town, place: PLACE.muster }, n);
  await lab.run(0.6, 4, { renderEvery: 4 });
  const ground = (await look(units.members(gm))).map((p) => p[2]);
  const groundZ = ground.reduce((a, z) => a + z, 0) / Math.max(ground.length, 1);
  units.orderGroup(gm, { kind: 'man', town });
  const tm = await until(gm, arrived, 150);
  const onWall = await look(units.members(gm));
  out.man = {
    after: tm,
    told: arrived.filter((x) => x === gm).length,
    failed: failed.filter(([x]) => x === gm).map(([, w]) => w),
    groundZ: +groundZ.toFixed(1),
    heights: onWall.map((p) => +(p[2] - groundZ).toFixed(1)),
  };
  // (the test's read of the GPU's words for the man group (slot 0): its posts, and each rank's mode, its distance to
  // its post)
  {
    const L = units.agents.mailLayout;
    const mail = new Uint32Array(await units.agents.readRaw('mail'));
    const f = new Float32Array(mail.buffer);
    const o = L.groups;
    out.man.posts = mail[o + L.formAt + 11];
    out.man.runs = Array.from({ length: 8 }, (_, i) => o + L.formAt + 16 + 128 + i * 8).filter((r) => mail[r] !== 0xffffffff).map((r) => `${mail[r] & 0xffff} s ${f[r + 1].toFixed(1)}-${f[r + 2].toFixed(1)} before ${mail[r + 3]}`);
    out.man.ranks = Array.from({ length: n }, (_, k) => { const r = L.ranks + k * L.rankW; return `${mail[r + 3] & 0xff}:${f[r + 5].toFixed(1)}`; }).join(' ');
    // (is the walk reachable? the run fields at the posts — each rank's target — and at the soldiers)
    const fw = mail[o + L.formAt + 14];
    const rd = units.agents.reader(fw & 0xff).start(100);
    await lab.run(0.3, 1, { renderEvery: 8 });
    await new Promise((res) => setTimeout(res, 500));
    out.man.atPosts = Array.from({ length: 4 }, (_, k) => { const r = L.ranks + k * L.rankW; const sm = rd.sample(f[r], f[r + 1], f[r + 2] + 0.5); return sm ? `${f[r].toFixed(0)},${f[r + 1].toFixed(0)},${f[r + 2].toFixed(1)} d ${sm.dist.toFixed(1)} z ${sm.z.toFixed(1)}` : 'null'; });
    const rr = units.observe(units.members(gm));
    await lab.run(0.1, 1, { renderEvery: 8 });
    out.man.atSoldiers = units.members(gm).slice(0, 4).map((m) => { const p = units.get(m).at; const sm = rd.sample(p[0], p[1], p[2] + 0.5); return `${p.map((v) => v.toFixed(1))} d ${sm?.dist.toFixed(1)} z ${sm?.z.toFixed(1)}`; });
    rr();
    rd.stop();
  }
  out.shots = [await shoot('townwalls_man', units.members(gm))];

  // 2. march out of a standing gate (status OK), not leaving
  await fresh();
  const gate = Object.entries(N).filter(([k, e]) => k.startsWith('gate') && e.status === 0).map(([k]) => Number(k.slice(4)))[0];
  out.gate = gate ?? null;
  if (gate !== undefined) {
    const gs = units.spawnAt('soldier', 'f-muru-guard', { town, place: PLACE.muster }, n);
    await lab.run(0.6, 4, { renderEvery: 4 });
    units.orderGroup(gs, { kind: 'march', town, gate });
    const half = await until(gs, arrived, 20);
    out.shots.push(await shoot('townwalls_march', units.members(gs)));
    const tg = half + (await until(gs, arrived, 150));
    out.march = { after: tg, told: arrived.filter((x) => x === gs).length, failed: failed.filter(([x]) => x === gs).map(([, w]) => w), alive: units.members(gs).length };
    await lab.run(6, 16, { renderEvery: 8 });
    out.march.toldAfter = arrived.filter((x) => x === gs).length;
    // 3. a second squad through the same gate, leaving the window
    const gl = units.spawnAt('soldier', 'f-muru-guard', { town, place: PLACE.muster }, 6);
    await lab.run(0.6, 4, { renderEvery: 4 });
    units.orderGroup(gl, { kind: 'march', town, gate, leave: true });
    const tl = await until(gl, left, 200);
    await lab.run(4, 16, { renderEvery: 8 });
    out.leave = { after: tl, told: left.filter((x) => x === gl).length, still: units.members(gl).length, failed: failed.filter(([x]) => x === gl).map(([, w]) => w) };
  }
  out.water = +water.maxLive.toFixed(2);
  out.deaths = deaths;

  const fail = (msg) => { throw new Error(`${msg} — ${JSON.stringify(out)}`); };
  if (water.maxLive > 0.9) fail(`flooded: the live water at the soldiers reached ${water.maxLive.toFixed(2)} — UC-6 (trackA-uc6's fix), not the orders`);
  if (out.man.told !== 1) fail(`man: arrived told ${out.man.told} times`);
  if (!(out.man.heights.filter((h) => h > 2).length >= Math.min(n, 6))) fail('man: the soldiers are not up on the wall');
  if (gate === undefined) fail('no standing gate on Muru');
  if (out.march.told !== 1 || out.march.toldAfter !== 1) fail(`march: arrived told ${out.march.toldAfter} times`);
  if (out.leave.told !== 1 || out.leave.still !== 0) fail(`march leave: left told ${out.leave.told} times, ${out.leave.still} still in the window`);
  return out;
}
