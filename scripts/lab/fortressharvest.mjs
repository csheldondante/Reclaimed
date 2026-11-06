// (DA-A7 pinned, round 128o; round 128p a gate) The harvest comes home on the user's start town: a farmer riding grain
// to the stores along the routes keeps moving. It pinned the old ride's stall (riders standing at a route node in the
// terraced fields for good); the riders now advance along cached routes as queues (agents/routeride.ts,
// shaders/routes.wgsl), placed by the route, so the gate is that no carrier stands still.
//   node scripts/lab.mjs run scripts/lab/fortressharvest.mjs [--args '{"seconds":240,"still":120}']
export const recipe = 'town';

export default async function (lab, args) {
  const seconds = args.seconds ?? 240;
  /** a carrier that stays within a metre for this long (sim s) is stuck */
  const still = args.still ?? 120;
  lab.sims('fortress');
  lab.build();
  const since = new Map();
  let t = 0;
  let stuck = [];
  while (t < seconds) {
    const r = await lab.run(15, 16);
    t += r.simSeconds;
    const s = lab.snapshot();
    for (const w of s.walkers) {
      const was = since.get(w.id);
      if (w.phase !== 'carry') since.delete(w.id);
      else if (!was || Math.hypot(was.at[0] - w.at[0], was.at[1] - w.at[1]) > 1) since.set(w.id, { at: w.at, t });
    }
    stuck = [...since].filter(([, v]) => t - v.t >= still).map(([id, v]) => `${id} at (${v.at[0].toFixed(1)}, ${v.at[1].toFixed(1)}) since ${Math.round(v.t)} s`);
    console.log(`t ${Math.round(t)} s`, JSON.stringify({ hauled: s.stats?.hauled ?? 0, carrying: since.size, stuck: stuck.length }));
  }
  if (stuck.length) throw new Error(`${stuck.length} carriers stood still for ${still} sim s with their loads: ${stuck.slice(0, 6).join('; ')}`);
  return { simSeconds: Math.round(t) };
}
