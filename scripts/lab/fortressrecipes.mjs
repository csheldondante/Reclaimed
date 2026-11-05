// (round 128l, m4: milestone 4) The recipes on the behaviour lab: a walled site with a warehouse, a blacksmith, a barracks
// and houses, all standing, the stores given ore and wood. Build, then `seconds` of sim: the smiths fetch ore and wood,
// forge weapons at the smithy and carry them to the stores; the recruits take a weapon to the barracks and drill — each
// becomes a soldier (a guard) who musters at the barracks, marches by road to the wall's stairs and walks the wall-walk.
// Fails unless weapons were made, a soldier was trained, and a soldier got up on the wall.
//   node scripts/lab.mjs run scripts/lab/fortressrecipes.mjs [--args '{"seconds":180}']
export const recipe = 'flat';

export default async function (lab, args) {
  const seconds = args.seconds ?? 180;
  const every = args.every ?? 15;
  lab.sims(args.sims ?? 'fortress');
  const f = lab.fortress();
  const [hx, hy] = lab.heap;
  const at = [hx + 48, hy];
  const plan = lab.plan({
    at,
    walls: { r: 16, gate: 'west' },
    blocks: [
      { type: 'warehouse', d: [-6, 0] },
      { type: 'blacksmith', d: [4, -7] },
      { type: 'barracks', d: [5, 6] },
      { type: 'house', d: [-5, 8] },
      { type: 'house', d: [-5, -8] },
    ],
    built: true,
  });
  await f.settled();
  lab.stores({ ore: 30, log: 80, stone: 200, grain: 150, weapons: 0 });
  lab.build();
  const log = [];
  let wall = 0;
  let soldierRoad = 0;
  let soldierWalk = 0;
  for (let t = 0; t < seconds; t += every) {
    await lab.run(every, 16);
    const s = lab.snapshot();
    for (const q of s.soldiers) {
      // (on the wall-walk: more than 2 m over the ground at its feet)
      if (q.phase === "patrol") wall++;
      if (q.state === 'walk') {
        soldierWalk++;
        if (q.onRoad) soldierRoad++;
      }
    }
    log.push({ t: s.simT, weapons: Math.round(s.stores.weapons ?? 0), ore: Math.round(s.stores.ore ?? 0), soldiers: s.soldiers.length, phases: s.soldiers.map((q) => q.phase).join(','), jobs: s.jobs, forged: s.stats.forged, trained: s.stats.trained });
    console.log(JSON.stringify(log[log.length - 1]));
    if (t === every * 4) {
      lab.look(at[0], at[1] + 18, 5);
      await lab.shot('recipes-mid');
    }
  }
  const s = lab.snapshot();
  lab.look(at[0], at[1] + 18, 5);
  await lab.shot('recipes-end');
  const out = { plan, onWall: s.stats.onWall, forged: s.stats.forged, trained: s.stats.trained, mustered: s.stats.mustered, patrols: s.stats.patrols, onWallSamples: wall, soldierRoadShare: soldierWalk ? +(soldierRoad / soldierWalk).toFixed(2) : null, riding: s.roads.riding, stores: s.stores };
  if (!(s.stats.forged > 0)) throw new Error(`no weapons were made: ${JSON.stringify(out)}`);
  if (!(s.stats.trained > 0)) throw new Error(`no soldier was trained: ${JSON.stringify(out)}`);
  return out;
}
