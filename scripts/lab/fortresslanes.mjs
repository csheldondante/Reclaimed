// (round 128l, tooling) scripts/fortresslanes.mjs on the behaviour lab (docs/TOOLING.md): the roads and lanes of a
// planned walled site and how much of the people's walking is on them. A walled ring with a gate, the keep, houses and
// a warehouse, farms on one side and a quarry on the other, planned by the API — on the flat recipe beside the town, or
// (--recipe hill) with the farms up the hill's flank; the lanes' numbers printed. Then Build, the plan stood up at once
// (as the full script does) after `building` sim s of the builders, the people's work — grain and stone hauled to the
// warehouse, home to the houses — settling for `settle` s, then run for `measure` sim seconds, sampled every `sample` s: the share of the walkers on a road or lane against the roads' share
// of the ground round them. Shots at play zoom (lanes-<recipe>*.png).
//   node scripts/lab.mjs run scripts/lab/fortresslanes.mjs [--recipe hill] [--args '{"measure":240,"sims":"all"}']
// The full-game check stays scripts/fortresslanes.mjs (the gate: the atlas's land round its own town).
export const recipe = 'flat';

export default async function (lab, args) {
  const measure = args.measure ?? 40;
  const sample = args.sample ?? 2;
  const speed = args.speed ?? 8;
  lab.sims(args.sims ?? 'fortress');
  const t0 = performance.now();
  const at_ = (what) => console.log(`${what} at ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  const f = lab.fortress();
  // the site: east of the heap (flat: on the plain; hill: the farms up the hill's west flank)
  const [hx, hy] = lab.heap;
  const at = [hx + (args.dx ?? (lab.recipe === 'hill' ? 62 : 48)), hy + (args.dy ?? 0)];
  const plan = lab.plan({
    at,
    walls: { r: 16, gate: 'east' },
    blocks: [
      { type: 'fortress', d: [0, 0] },
      { type: 'fortress', d: [0, 0], level: 1 },
      { type: 'house', d: [-8, 5] },
      { type: 'house', d: [-9, -4] },
      { type: 'house', d: [5, 8] },
      { type: 'warehouse', d: [4, -9] },
      ...[[30, 6], [32, 6], [30, 12], [36, 6], [36, 12]].map((d) => ({ type: 'farm', d })),
      ...[[-30, 6], [-30, 12], [-36, 6]].map((d) => ({ type: 'quarry', d })),
    ],
  });
  // (a block whose cell the ring took — the warehouse, on some sites — moved to the nearest free spot round its offset)
  for (const sk of plan.skipped) {
    const [type] = sk.split(' ');
    const d0 = { warehouse: [4, -9], house: [5, 8] }[type];
    if (!d0) continue;
    const tries = [[0, 0], [-3, 0], [0, -3], [-3, -3], [3, 0], [0, 3], [-5, 2], [2, -5]];
    const ok = tries.some(([ox, oy]) => {
      try {
        lab.place(type, at[0] + d0[0] + ox, at[1] + d0[1] + oy);
        return true;
      } catch {
        return false;
      }
    });
    console.log(`${type} moved off the ring: ${ok ? 'placed' : 'no free spot'}`);
  }
  // (the stores topped up: the whole plan stands, so the people's work is watched, not a wait for stone)
  lab.stores({ stone: 200, log: 60 });
  const L = f.lanes();
  const w = f.ways();
  const segs = {};
  const metres = {};
  for (const s of L.segs) {
    segs[s.kind] = (segs[s.kind] ?? 0) + 1;
    metres[s.kind] = Math.round((metres[s.kind] ?? 0) + Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]));
  }
  const lanes = { recipe: lab.recipe, at: at.map(Math.round), plan, slope: +L.slope.toFixed(3), contour: +L.contour.toFixed(2), segs, metres, steps: L.segs.filter((s) => s.steps).length, doors: w.doors.length, cutOff: w.cutOff.length, roadShapes: f.roadShapes().length / 12 };
  console.log('lanes', JSON.stringify(lanes));
  at_('planned');
  lab.look(at[0], at[1] + 25, 3.2);
  await lab.shot(`lanes-${lab.recipe}`);
  // build: the builders a moment, then everything standing and the people's work
  lab.build();
  await lab.run(args.building ?? 5, speed);
  at_('built');
  lab.standAll();
  at_('stood');
  await lab.run(args.settle ?? 15, speed);
  at_('settled');
  let on = 0;
  let walking = 0;
  const shares = [];
  let last = null;
  for (let t = 0; t < measure; t += sample) {
    await lab.run(sample, speed);
    last = lab.snapshot();
    on += last.roads.onRoad;
    walking += last.roads.walking;
    if (last.roads.areaShare !== null) shares.push(last.roads.areaShare);
  }
  at_('measured');
  lab.look(at[0], at[1] + 25, 3.2);
  await lab.shot(`lanes-${lab.recipe}-build`);
  const walkers = { recipe: lab.recipe, onRoad: on, walking, onRoadShare: walking ? +(on / walking).toFixed(2) : null, roadAreaShare: shares.length ? +(shares.reduce((a, b) => a + b, 0) / shares.length).toFixed(2) : null, ride: last?.roads.riding, progress: last?.progress, stats: last?.stats, simT: last?.simT };
  console.log('walkers', JSON.stringify(walkers));
  if (plan.cutOff) throw new Error(`the plan has ${plan.cutOff} blocks cut off`);
  return { lanes, walkers };
}
