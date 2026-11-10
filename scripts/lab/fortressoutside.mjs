// (round 128l, tooling) scripts/fortressoutside.mjs on the behaviour lab (docs/TOOLING.md): do the builders get out of
// the walled town and reach what's planned outside its walls?
// (Round 128n, phonefix) On the `town` recipe by default — the user's start town, captured from the game — and for
// the game's length, not until the first sites stand. The gate ran on the small `walled` recipe until its three sites
// stood (90-121 sim s) and passed on 062fe16, whose timed raid waves (the first at 228 sim s, then every 180) kept the
// builders indoors in the game: the user's phone built nothing outside. Now: three blocks (a lumber camp, a house, a
// farm) planned outside the walls, Build, 16x; then every `gap` sim seconds another block outside, round the town, for
// `duration` sim seconds. The run FAILS if, while any planned block outside waits for its builders, no builder reaches
// one for `within` sim seconds — whatever keeps them in: a wave, a shut gate, a lost way. (A site is reached when a
// builder stands within REACH_M of its cell's middle, sampled every `step` sim s, or its block stands.)
// The sim runs the 'fortress' preset (lab.sims: the land's slow processes left out); args.sims 'all' runs everything.
//   node scripts/lab.mjs run scripts/lab/fortressoutside.mjs [--recipe walled] [--args '{"duration":900,"within":180}']
// The full-game check stays scripts/fortressoutside.mjs (the gate: the atlas's own town, by finger).
export const recipe = 'town';

export default async function (lab, args) {
  // (the scenario's function runs on its own in the page: its constants inside it)
  const REACH_M = 6;
  const KINDS = ['lumber', 'house', 'farm'];
  const dists = args.dists ?? [55, 65, 75, 90];
  const every = args.every ?? 30;
  const step = args.step ?? 5;
  const speed = args.speed ?? 16;
  const duration = args.duration ?? 900;
  const gap = args.gap ?? 150;
  const within = args.within ?? 180;
  lab.sims(args.sims ?? 'fortress');
  const f = lab.fortress();
  await f.settled();
  const [hx, hy] = lab.heap;
  // (a block outside the walls: round the heap a twenty-fourth at a time, near then farther, the first spot the plan takes)
  let tried = 0;
  const planOne = (kind) => {
    for (; tried < dists.length * 24; tried++) {
      const a = (((tried * 7) % 24) / 24) * Math.PI * 2;
      const d = dists[Math.floor(tried / 24)];
      const x = hx + Math.cos(a) * d;
      const y = hy + Math.sin(a) * d;
      try {
        const cell = lab.place(kind, x, y);
        tried++;
        return { cell, at: [x, y] };
      } catch {
        // (water, the town, off the box, unreachable: the next spot)
      }
    }
    throw new Error(`no free ground outside the walls for a ${kind} (${tried} spots tried)`);
  };
  const pending = [];
  const done = [];
  let t = 0;
  for (const k of KINDS) pending.push({ k, ...planOne(k), planned: 0 });
  console.log('planned', JSON.stringify(pending));
  const [c0x, c0y] = pending[0].at;
  lab.look(c0x, c0y + 10, 3.2);
  await lab.shot('outside-plan');
  lab.build();
  let n = 0;
  let nextPlan = gap;
  let since = 0;
  let worst = { s: 0, at: 0 };
  let printAt = every;
  while (t < duration) {
    const r = await lab.run(step, speed, { dt: args.dt });
    t += r.simSeconds;
    const s = (await lab.snapshot());
    let reached = false;
    for (const p of [...pending]) {
      const [x, y] = f.centre(p.cell);
      // (or its block stands: the builders put it up from beside it, between two samples)
      if (!f.town.has(p.cell, 0) && !s.walkers.some((w) => Math.hypot(w.at[0] - x, w.at[1] - y) < REACH_M)) continue;
      pending.splice(pending.indexOf(p), 1);
      done.push({ k: p.k, cell: p.cell, planned: Math.round(p.planned), reached: Math.round(t), built: null });
      reached = true;
    }
    // (how long the builders have been kept from every waiting site: since the last reach, or the first one's plan)
    if (reached || !pending.length) since = t;
    if (t - since > worst.s) worst = { s: Math.round(t - since), at: Math.round(t) };
    if (t - since > within) {
      const phases = {};
      for (const w of s.walkers) phases[w.phase] = (phases[w.phase] ?? 0) + 1;
      throw new Error(`NOT REACHED: no builder reached any of ${JSON.stringify(pending.map((p) => p.k))} for ${Math.round(t - since)} sim s (at ${Math.round(t)} s): ${JSON.stringify({ phases, note: s.note, sites: pending.map((p) => ({ k: p.k, cell: p.cell, owner: f.plan.owner[p.cell], built: f.town.has(p.cell, 0) })) })}`);
    }
    if (t >= nextPlan && t + within <= duration) {
      nextPlan += gap;
      const k = KINDS[n++ % KINDS.length];
      // (a block the plan lets go of on Build — refused there — isn't a site: the next spot)
      let p = null;
      for (let tries = 0; !p && tries < 8; tries++) {
        lab.planMode();
        const q = { k: `${k}${n}`, ...planOne(k), planned: t };
        lab.build();
        if (f.plan.owner[q.cell] >= 0) p = q;
      }
      if (!p) throw new Error(`no ${k} outside the walls kept by the plan`);
      if (!pending.length) since = t;
      pending.push(p);
    }
    for (const d of done) d.built ??= f.town.has(d.cell, 0) ? Math.round(t) : null;
    if (t < printAt) continue;
    printAt += every;
    const phases = {};
    for (const w of s.walkers) phases[w.phase] = (phases[w.phase] ?? 0) + 1;
    console.log(`t ${Math.round(t)} s (x${r.xRealtime} real time)`, JSON.stringify({ waiting: pending.map((p) => p.k), kept: Math.round(t - since), phases, progress: s.progress, cutOff: s.cutOff, note: s.note }));
  }
  lab.look(c0x, c0y + 10, 3.2);
  await lab.shot('outside-build');
  console.log('blocks', JSON.stringify(done));
  return { reached: done.length, waiting: pending.length, simSeconds: Math.round(t), longestKept: worst };
}
