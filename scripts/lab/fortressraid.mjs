// (round 128l, m4: the attack wave) A wave on the behaviour lab. `--args '{"town":"open"}'`:
//   open    the walled recipe's town with its wall taken away: the raiders walk in, loot the stores, torch the houses
//           and ride out
//   walled  the walled recipe's town (a ring with a gate east): the gates shut, the raiders bash the gate till it breaks
//   (args.repair: sim seconds of building after the wave, which must rebuild something; args.seconds: sim seconds at most; args.shots: a shot every this many; args.soldiers: soldiers stood up first)
// Fails unless the wave did what its town calls for: open — loot taken; walled — the gates shut and the raiders reached
// the gate and struck it (and, unless args.hold, it broke). Prints the wave's state as it goes.
//   node scripts/lab.mjs run scripts/lab/fortressraid.mjs --recipe walled --args '{"town":"walled"}'
export const recipe = 'walled';

export default async function (lab, args) {
  const town = args.town ?? 'walled';
  const seconds = args.seconds ?? 150;
  const every = args.every ?? 3;
  lab.sims(args.sims ?? 'raid');
  const f = lab.fortress();
  const [hx, hy] = lab.heap;
  if (town === 'open') {
    // (the walled recipe's town with its wall taken away: the flat recipe's own little town has a road its people
    // can't ride from the edge to the stores — BACKLOG M4-14, another branch's)
    for (const st of f.plan.structures()) if (st.type === 'wall') for (const c of [...st.cells.keys()]) f.erase(c, 0);
  }
  await f.settled();
  lab.stores({ stone: 120, log: 60, grain: 60, ore: 10, weapons: 2 });
  lab.build();
  const raid = lab.raid();
  const life = lab.life();
  if (!raid) throw new Error('no raid after Build');
  if (args.soldiers) life.standSoldiers?.(args.soldiers);
  await lab.run(1, 4);
  raid.callNow();
  const log = [];
  let shut = false;
  let bashed = false;
  let maxBlows = 0;
  let shots = 0;
  const raiderMid = () => {
    const at = raid.state().raiders.map((r) => r.at).filter(Boolean);
    if (!at.length) return null;
    return [at.reduce((a, p) => a + p[0], 0) / at.length, at.reduce((a, p) => a + p[1], 0) / at.length];
  };
  for (let t = 0; t < seconds; t += every) {
    await lab.run(every, args.speed ?? 8);
    const s = raid.state();
    shut ||= s.gatesShut;
    bashed ||= s.raiders.some((r) => r.phase === 'bash');
    maxBlows = s.stats.blows;
    const line = { t: Math.round(s.t), stage: s.stage, shut: s.gatesShut, goal: s.goal, phases: s.raiders.map((r) => `${r.phase}${r.at ? '' : '+'}${r.to ? 'w' : ''}`).join(','), hp: s.hp, stats: s.stats, stores: lab.snapshot().stores };
    console.log(JSON.stringify(line));
    log.push(line);
    if (args.shots && t % args.shots === 0) {
      const m = raiderMid() ?? [hx, hy];
      lab.look(m[0], m[1], args.zoom ?? 7);
      await lab.shot(`raid-${town}-${String(shots++).padStart(2, '0')}`);
    }
    if (s.stage === 'none') break;
  }
  // (args.repair: sim seconds after the wave for the builders: the broken blocks are planned again)
  let repaired = null;
  if (args.repair && raid.state().stage === 'none') {
    const before = f.progress();
    for (let t = 0; t < args.repair; t += 10) {
      await lab.run(10, args.speed ?? 8);
      const p = f.progress();
      console.log(JSON.stringify({ repair: Math.round(t + 10), built: p.built, total: p.total, crew: f.crew }));
      if (p.built >= p.total) break;
    }
    const after = f.progress();
    repaired = { before, after };
  }
  const s = raid.state();
  lab.look(hx, hy, 5);
  await lab.shot(`raid-${town}-end`);
  const out = { town, repaired, log: s.log, stage: s.stage, stats: s.stats, report: s.report, lines: s.lines, shut, bashed, blows: maxBlows, hp: s.hp };
  if (town === 'open' && !(s.stats.looted > 0)) throw new Error(`open town: nothing was looted: ${JSON.stringify(out)}`);
  if (town === 'walled') {
    if (!shut) throw new Error(`walled: the gates never shut: ${JSON.stringify(out)}`);
    if (!bashed || !(s.stats.blows > 0)) throw new Error(`walled: no raider struck the wall: ${JSON.stringify(out)}`);
    if (!args.hold && !(s.stats.breaches > 0)) throw new Error(`walled: nothing broke: ${JSON.stringify(out)}`);
  }
  if (repaired && !(repaired.after.built > repaired.before.built)) throw new Error(`nothing was rebuilt after the raid: ${JSON.stringify(out)}`);
  return out;
}
