// (round 128p, DA-A13 step 0) The road generator on the user's start town's land (the townland recipe: the fixture's
// land, its town left out): the roads traced on the GPU, the base lattice bent to them, a stand-in town (a house on each
// cell facing a road) drawn; shots at play zoom and an overview; then an edit — a road drawn across the town — and the
// same shots. Returns the timings and counts (docs/DEVLOG round 128p).
//   node scripts/lab.mjs run scripts/lab/roadgen.mjs [--args '{"timed":true}']
export const recipe = 'townland';

export default async function (lab, args) {
  while (!lab.ready) await new Promise((r) => setTimeout(r, 100));
  const out = {};
  // (a warm run first: the pipelines compile on first use)
  if (!args.cold) await lab.roadgen({ timed: false });
  out.run = await lab.roadgen({ timed: !!args.timed });
  const [cx, cy] = out.run.centre;
  const r = out.run.radius;
  lab.run && (await lab.run(0.5, 1));
  lab.look(cx, cy, args.overview ?? 1.6);
  await lab.shot('roadgen-overview');
  lab.look(cx, cy, args.zoom ?? 5);
  await lab.shot('roadgen-play');
  lab.look(cx - r * 0.4, cy + r * 0.3, args.zoom ?? 5);
  await lab.shot('roadgen-play2');
  const draw = [
    [cx - r * 0.7, cy - r * 0.2],
    [cx - r * 0.05, cy + 0.075 * r + 12],
    [cx + r * 0.6, cy + r * 0.35],
  ];
  out.edit = await lab.roadgen({ draw, timed: !!args.timed });
  await lab.run(0.5, 1);
  lab.look(cx, cy, args.overview ?? 1.6);
  await lab.shot('roadgen-edit-overview');
  lab.look(cx, cy, args.zoom ?? 5);
  await lab.shot('roadgen-edit-play');
  return out;
}
