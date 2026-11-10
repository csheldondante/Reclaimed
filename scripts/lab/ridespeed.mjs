// (round 128o, DA-B22: main's check on fortressallbuilt) How fast the riders go: fortressallbuilt's start (the user's
// start town, three blocks planned 55 m west, Build), the units' buffer read after every frame at `speed`. A rider on
// a trip (its steer RIDE_TRIP, word e.w: roadride.wgsl) both before and after a frame moved this far in that frame's
// sim time — per kind, the distance over the sim seconds (cells/s) against its kind's speed, and how many of the
// frames' moves were short of it (a stall: under half its speed's distance); the trips begun and the frames a rider
// turned back on its trip (a move against its last). Run with and without ?ffwd=0, at 1x and 16x.
//   node scripts/lab.mjs run scripts/lab/ridespeed.mjs [--args '{"speed":16,"seconds":60}'] [--flags "&ffwd=0"]
export const recipe = 'town';

export default async function (lab, args) {
  const speed = args.speed ?? 16;
  const seconds = args.seconds ?? 60;
  lab.sims(args.sims ?? 'fortress');
  const [hx, hy] = lab.heap;
  const c = [hx - 55, hy];
  lab.place('lumber', c[0], c[1]);
  lab.place('house', c[0], c[1] + 9);
  lab.place('farm', c[0], c[1] - 9);
  lab.build();
  const agents = lab.units.agents;
  const names = agents.kinds.map((k) => k?.name ?? null);
  const speeds = agents.kinds.map((k) => k?.speed ?? 0);
  const read = async () => new Float32Array(await agents.readRaw('units'));
  let prev = await read();
  const per = {};
  // (per unit: its last frame's move on a trip — a move against it is a turn back; trips begun: off a trip, then on one)
  const last = new Map();
  let begun = 0;
  // (args.trips: each trip's start and end, the path it rode and the sim time it began)
  const open = new Map();
  const trips = [];
  let turns = 0;
  const frameDt = speed / 60;
  let t = 0;
  // (the frame's sim time from the ticks the sim ran in it, not the lab's wall-time sum: the tick clock may run a
  // frame's ticks a tick fewer or more)
  const sim = window.reclaimed.core.sim;
  let tick = sim.tick;
  while (t < seconds - 1e-6) {
    await lab.run(frameDt, speed);
    const dt = (sim.tick - tick) / 60;
    tick = sim.tick;
    if (!(dt > 0)) continue;
    t += dt;
    const now = await read();
    const pw = new Uint32Array(prev.buffer);
    const nw = new Uint32Array(now.buffer);
    const n = Math.min(prev.length, now.length) / 24;
    for (let s = 0; s < n; s++) {
      const o = s * 24;
      const a = nw[o + 3];
      if (a >>> 16 !== pw[o + 3] >>> 16 || !(a & 256)) continue;
      if (prev[o + 19] !== -2 && now[o + 19] === -2) {
        begun++;
        open.set(s, { t0: +t.toFixed(1), from: [+prev[o].toFixed(1), +prev[o + 1].toFixed(1)], path: Math.hypot(now[o] - prev[o], now[o + 1] - prev[o + 1]), turns: 0 });
      }
      if (prev[o + 19] === -2 && now[o + 19] !== -2 && open.has(s)) {
        const tr = open.get(s);
        open.delete(s);
        trips.push({ ...tr, path: +tr.path.toFixed(1), to: [+now[o].toFixed(1), +now[o + 1].toFixed(1)], net: +Math.hypot(now[o] - tr.from[0], now[o + 1] - tr.from[1]).toFixed(1), t1: +t.toFixed(1), steer: now[o + 19] });
      }
      // (on a trip before and after: placed by the ride the whole frame)
      if (prev[o + 19] !== -2 || now[o + 19] !== -2) {
        last.delete(s);
        continue;
      }
      const mv = [now[o] - prev[o], now[o + 1] - prev[o + 1]];
      const lm = last.get(s);
      if (lm && mv[0] * lm[0] + mv[1] * lm[1] < 0) {
        turns++;
        if (open.has(s)) open.get(s).turns++;
      }
      if (open.has(s)) open.get(s).path += Math.hypot(mv[0], mv[1]);
      if (Math.hypot(mv[0], mv[1]) > 1e-4) last.set(s, mv);
      const k = (a >>> 9) & 7;
      const d = Math.hypot(now[o] - prev[o], now[o + 1] - prev[o + 1]);
      const p = (per[names[k] ?? k] ??= { kindSpeed: speeds[k], dist: 0, time: 0, frames: 0, short: 0, most: 0 });
      p.dist += d;
      p.time += dt;
      p.frames++;
      p.most = Math.max(p.most, d / dt);
      if (d < 0.5 * speeds[k] * dt) p.short++;
    }
    prev = now;
  }
  for (const p of Object.values(per)) {
    p.speed = +(p.dist / Math.max(p.time, 1e-9)).toFixed(3);
    p.most = +p.most.toFixed(2);
    p.dist = +p.dist.toFixed(1);
    p.time = +p.time.toFixed(1);
  }
  const out = { speed, seconds: +t.toFixed(1), progress: (await lab.snapshot()).progress, riders: per, tripsBegun: begun, turnBacks: turns, trips: args.trips ? trips : undefined, riding: args.trips ? [...open.values()].map((tr) => ({ ...tr, path: +tr.path.toFixed(1) })) : undefined };
  console.log(JSON.stringify(out));
  return out;
}
