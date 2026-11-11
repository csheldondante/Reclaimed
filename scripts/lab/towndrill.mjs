// (U2 round 6b, BACKLOG SF-11) The drill at Muru's muster yard, and the patrol's march out of a gate and back, on the
// gputown recipe with the keep raised (the barracks) — Track A's season orders, as the gates:
//   1. "a squad spawned at the barracks drills round the muster yard": ordered to drill (a column) at the yard, within
//      30 sim s the anchor goes round its loop at least once, every soldier moves at least MOVE cells, and arrived
//      is told once. The GPU's words are sampled each 2 s (the test's read): the anchor's state, s, the loop's radius,
//      the lag, each rank's slot, its clearance and its distance
//   2. "the patrol marches out of a standing gate and back": march out of gate k (not leaving) → arrived; then guard
//      (a line) at gate k's window (war.ts gateWindow's first) → arrived again, within the run
// Shots settled at play zoom, 60°: the drill (close), the patrol back at its gate.
// Then the same drill ragged (discipline 0) for a second shot.
//   node scripts/lab.mjs run scripts/lab/towndrill.mjs --flags "&labkeep=1" [--args '{"n":6,"only":"drill"}']
export const recipe = 'gputown';
export default async function (lab, args) {
  if (lab.recipe !== 'gputown') throw new Error(`the page's recipe is ${lab.recipe}: run with --recipe gputown`);
  if (lab.recipeError) throw new Error(lab.recipeError);
  const units = lab.units;
  const id = lab.town;
  const town = lab.townIndex(id);
  let N = (await lab.places(id)).named;
  const fresh = async () => { N = (await lab.places(id)).named; };
  const PLACE = { muster: 0, barracks: 2, gate0: 5 };
  if (N.barracks.status !== 0) throw new Error(`no barracks (status ${N.barracks.status}): run with --flags "&labkeep=1"`);
  if (N.muster.status !== 0) throw new Error(`no muster yard (status ${N.muster.status})`);
  const n = args.n ?? 6;
  const MOVE = args.move ?? 4;
  const arrived = [];
  const failed = [];
  const deaths = [];
  units.arrived.push((g) => arrived.push([g, +lab.simT.toFixed(1)]));
  units.orderFailed.push((g, why) => failed.push([g, why]));
  units.died.push((u, by) => { if (u.role === 'soldier' && deaths.length < 20) deaths.push(`${u.id} by ${by} t ${lab.simT.toFixed(1)}`); });
  const R = window.reclaimed;
  const told = (g) => arrived.filter(([x]) => x === g);
  const L = units.agents.mailLayout;
  const ROW_H = Math.sqrt(3) / 2;
  const cellOf = (p) => { const y = Math.round(p[1] / ROW_H - 0.5); return [Math.round(p[0] - 0.5 - 0.5 * (y & 1)), y]; };
  const where = async (ids) => {
    const r = units.observe(ids);
    await lab.run(0.1, 1, { renderEvery: 8 });
    const ps = ids.map((i) => units.get(i)).filter((u) => u?.alive && u.at).map((u) => u.at.slice());
    r();
    return ps;
  };
  // (the GPU's words for group slot `slot` and its first `k` ranks — the test's read)
  const words = async (slot, k) => {
    const mail = new Uint32Array(await units.agents.readRaw('mail'));
    const f = new Float32Array(mail.buffer);
    const jfa = new Float32Array(await units.agents.readRaw('jfa'));
    const { w, h } = R.core.dims;
    const clear = (p) => { const [x, y] = cellOf(p); return x >= 0 && y >= 0 && x < w && y < h ? jfa[8 + 4 * w * h + y * w + x] : null; };
    const o = L.groups + slot * L.groupW;
    const F = o + L.formAt;
    const ranks = Array.from({ length: k }, (_, j) => {
      const r = L.ranks + (slot * L.ranksPerGroup + j) * L.rankW;
      const goal = [f[r], f[r + 1], f[r + 2]];
      return { goal: goal.map((v) => +v.toFixed(1)), mode: mail[r + 3] & 0xff, d: +f[r + 5].toFixed(2), row: mail[r + 6] & 0xff, cols: mail[r + 6] >>> 16, clear: +(clear(goal) ?? -1).toFixed(2) };
    });
    return {
      kind: mail[o], st: mail[F + 8], s: +f[F + 4].toFixed(2), lag: +f[F + 10].toFixed(2), radius: +f[F + 11].toFixed(2),
      anchor: [f[F + 5], f[F + 6], f[F + 7]].map((v) => +v.toFixed(1)), at: [f[o + 8], f[o + 9], f[o + 10]].map((v) => +v.toFixed(1)),
      atClear: +(clear([f[o + 8], f[o + 9]]) ?? -1).toFixed(2), ranks,
    };
  };
  const shoot = async (name, ids) => {
    const r = units.observe(ids);
    await lab.run(0.2, 1, { renderEvery: 1 });
    const ps = ids.map((i) => units.get(i)?.at).filter(Boolean);
    r();
    if (!ps.length) return `${name}: none`;
    const cx = ps.reduce((a, p) => a + p[0], 0) / ps.length;
    const cy = ps.reduce((a, p) => a + p[1], 0) / ps.length;
    lab.camera().elevation = args.elev ?? Math.PI / 3;
    lab.look(cx, cy, args.close ?? 36, 0.5);
    let ok = 0;
    let cover = null;
    for (let fr = 0; fr < 200 && ok < 5; fr++) {
      await lab.run(0.05, 1, { renderEvery: 1 });
      const busy = !!R.scene?.stream?.busy;
      const c = R.renderer?.tiles?.coverage(R.camera) ?? null;
      cover = c ? +(c.window + c.tiles).toFixed(3) : null;
      ok = !busy && (cover === null || cover >= 0.98) ? ok + 1 : 0;
    }
    await new Promise((res) => setTimeout(res, 300));
    await lab.shot(name);
    return `${name}: ${ps.length} round ${cx.toFixed(0)},${cy.toFixed(0)}; settled ${ok >= 5}, cover ${cover}`;
  };
  const out = { town: id, index: town, n, shots: [] };
  const errs = [];
  const only = args.only ?? 'both';

  // 1. drill at the muster yard, from the barracks
  if (only !== 'march') {
    await fresh();
    const g = units.spawnAt('soldier', 'f-muru-guard', { town, place: PLACE.barracks }, n);
    await lab.run(0.6, 4, { renderEvery: 4 });
    units.orderGroup(g, { kind: 'drill', at: { town, place: PLACE.muster }, formation: 'column' });
    // (the walk from the barracks to the yard first: the drill's clock starts when the anchor is formed)
    const samples = [];
    let formedAt = null;
    let s0 = null;
    let lapped = 0;
    let lastS = null;
    let start = null;
    const moved = new Map();
    let prev = null;
    const T = args.seconds ?? 30;
    for (let t = 0; t <= 90 + T; t += 2) {
      if (t > 0) await lab.run(2, 16, { renderEvery: 8 });
      const wd = await words(0, n);
      const ps = await where(units.members(g));
      if (formedAt === null && wd.st !== 0 && wd.lag > 0 && wd.lag < 3) { formedAt = t; start = ps; s0 = wd.s; lastS = wd.s; }
      if (formedAt !== null) {
        // (the anchor's s goes round modulo the loop: a lap is the sum of its steps reaching 2πR)
        const loop = 2 * Math.PI * wd.radius;
        const ds = ((wd.s - lastS) % loop + loop) % loop;
        lapped += ds;
        lastS = wd.s;
        ps.forEach((p, j) => { const q = prev?.[j]; if (q) moved.set(j, (moved.get(j) ?? 0) + Math.hypot(p[0] - q[0], p[1] - q[1])); });
      }
      prev = ps;
      if (samples.length < 80) samples.push({ t, st: wd.st, s: wd.s, lag: wd.lag, R: wd.radius, anchor: wd.anchor, d: wd.ranks.map((r) => r.d).join(' ') });
      if (t === 0 || t === 10) out[`drillWords${t}`] = wd;
      if (formedAt !== null && t - formedAt >= T) break;
    }
    const wd = await words(0, n);
    out.drill = {
      formedAt, after: formedAt === null ? null : T, s0, laps: formedAt === null ? 0 : +(lapped / (2 * Math.PI * wd.radius)).toFixed(2),
      radius: wd.radius, yardClear: wd.atClear, at: wd.at, moved: [...moved.values()].map((v) => +v.toFixed(1)), told: told(g).length,
      failed: failed.filter(([x]) => x === g).map(([, w]) => w), ranks: wd.ranks, samples,
    };
    out.shots.push(await shoot('towndrill_drill', units.members(g)));
    // (the same drill ragged — discipline 0 — for the look: a shot of it after 20 s)
    units.orderGroup(g, { kind: 'drill', at: { town, place: PLACE.muster }, formation: 'column', discipline: 0 });
    await lab.run(20, 16, { renderEvery: 8 });
    out.ragged = { told: told(g).length };
    out.shots.push(await shoot('towndrill_ragged', units.members(g)));
    if (formedAt === null) errs.push('drill: the anchor never formed');
    if (!(out.drill.laps >= 1)) errs.push(`drill: the anchor went ${out.drill.laps} of a lap in ${T} s`);
    if (!(out.drill.moved.length === n && out.drill.moved.every((m) => m >= MOVE))) errs.push(`drill: not every soldier moved ${MOVE} cells (${out.drill.moved})`);
    if (out.drill.told !== 1) errs.push(`drill: arrived told ${out.drill.told} times`);
  }

  // 2. march out of a standing gate and back to its window (the patrol)
  if (only !== 'drill') {
    await fresh();
    const gate = Object.entries(N).filter(([k, e]) => k.startsWith('gate') && e.status === 0).map(([k]) => Number(k.slice(4)))[0];
    out.gate = gate ?? null;
    if (gate === undefined) errs.push('no standing gate on Muru');
    else {
      const g = units.spawnAt('soldier', 'f-muru-guard', { town, place: PLACE.barracks }, n);
      await lab.run(0.6, 4, { renderEvery: 4 });
      // (args.direct: no march first — the guard order at the gate straight from the barracks, for comparison)
      if (!args.direct) units.orderGroup(g, { kind: 'march', town, gate });
      else arrived.push([g, 0]);
      const t0 = lab.simT;
      while (!told(g).length && !failed.some(([x]) => x === g) && lab.simT - t0 < (args.out ?? 200)) await lab.run(2, 16, { renderEvery: 8 });
      const outT = told(g).length ? +(lab.simT - t0).toFixed(1) : null;
      const slot = (await words(1, 0)).kind === 7 ? 1 : 0;
      out.march = { out: outT, failed: failed.filter(([x]) => x === g).map(([, w]) => w) };
      if (outT !== null) {
        units.orderGroup(g, args.plain ? { kind: 'guard', at: { town, place: PLACE.gate0 + gate } } : { kind: 'guard', at: { town, place: PLACE.gate0 + gate }, formation: 'line' });
        const t1 = lab.simT;
        const back = [];
        while (told(g).length < 2 && !failed.some(([x]) => x === g) && lab.simT - t1 < (args.back ?? 200)) {
          await lab.run(2, 16, { renderEvery: 8 });
          if (back.length < 60) { const wd = await words(slot, n); back.push({ t: +(lab.simT - t1).toFixed(0), st: wd.st, lag: wd.lag, anchor: wd.anchor, d: wd.ranks.map((r) => r.d).join(' ') }); }
          if (args.probe && back.length === 10) {
            // (the group's field where the anchor and the soldiers stand, and at the gate: does it reach them?)
            const mail = new Uint32Array(await units.agents.readRaw('mail'));
            const fld = mail[L.groups + slot * L.groupW + 6] & 0xff;
            const rd = units.agents.reader(fld).start(100);
            await lab.run(0.3, 1, { renderEvery: 8 });
            await new Promise((res) => setTimeout(res, 500));
            const wd = await words(slot, n);
            const ps = await where(units.members(g));
            const sm = (p) => { const v = rd.sample(p[0], p[1], p[2] + 0.5); return `${p.map((x) => x.toFixed(1))} d ${v ? v.dist.toFixed(1) : 'null'}`; };
            out.probeBack = { field: fld, anchor: sm(wd.anchor), gate: sm(wd.at), soldiers: ps.map(sm), scope: units.agents.scope?.box ?? null };
            rd.stop();
          }
        }
        out.march.back = told(g).length >= 2 ? +(lab.simT - t1).toFixed(1) : null;
        out.march.backWords = await words(slot, n);
        out.march.backSamples = back;
        out.march.told = told(g).length;
        out.shots.push(await shoot('towndrill_back', units.members(g)));
      }
      if (out.march.out === null) errs.push(`march: no arrival out (${out.march.failed})`);
      else if (out.march.back === null) errs.push('march: no arrival back at the gate');
    }
  }
  out.deaths = deaths;
  if (errs.length) throw new Error(`${errs.join('; ')} — ${JSON.stringify(out)}`);
  return out;
}
