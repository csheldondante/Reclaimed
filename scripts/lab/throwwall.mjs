// (round 128o, DA-B22: the tumble's sub-moves) A unit thrown hard at a wall never gets into it, whatever the speed —
// the fast-forward's step spans up to a stride of ticks (agents.ts stepPlan), and the tumble checks its walls a
// sub-move (at most half a cell across) at a time (units.wgsl SUB_MOVE). A wall drawn across open ground (its columns
// along the throw read back and printed: where its face is, how many columns thick), units launched at it low and fast
// at several speeds and angles, followed while they tumble; none may be inside it (in one of its columns, under its
// top) at any frame — over it, up its slope, is the throw's. Run at `speed` (default 16: a stride of 9 ticks); ?ffwd=0
// (--flags) runs the same throws a tick at a time; pass its `ends` as args.expect to hold a run to them.
//   node scripts/lab.mjs run scripts/lab/throwwall.mjs --recipe flat [--args '{"speed":16}'] [--flags "&ffwd=0"]
export const recipe = 'flat';

export default async function (lab, args) {
  const speed = args.speed ?? 16;
  lab.sims(args.sims ?? 'fortress');
  const f = lab.fortress();
  await f.settled();
  const [hx, hy] = lab.heap;
  // (open ground west of the heap: a wall north to south, the throws at it from its west)
  const x0 = hx + (args.dx ?? -40);
  const wx = x0 + (args.gap ?? 12);
  const cells = lab.drag('wall', wx, hy - 6, wx, hy + 6);
  lab.standAll();
  await lab.run(2, 4);
  const built = f.progress();
  // (the wall as the columns hold it, along the throw: each column's top over the ground's)
  const col = window.reclaimed.phys.column;
  const floor = (await col(x0, hy)).at(-1)?.z1 ?? 0;
  const tops = [];
  for (let x = Math.floor(x0); x <= Math.ceil(wx + 6); x++) tops.push([x, +((((await col(x + 0.5, hy)).at(-1)?.z1 ?? 0) - floor).toFixed(1))]);
  const solid = tops.filter(([, h]) => h > 2);
  if (!solid.length) throw new Error(`no wall in the columns: ${JSON.stringify(tops)}`);
  const face = Math.min(...solid.map(([x]) => x));
  const agents = lab.units.agents;
  const throws = [];
  for (const v of args.speeds ?? [8, 15, 25, 40, 60]) for (const ang of [0, 20, -35]) throws.push({ v, ang });
  const ids = [];
  for (const t of throws) {
    const [id] = agents.spawn(1, x0, hy + (t.ang / 35) * 2, { kind: 'worker', spread: 0 });
    ids.push(id);
  }
  // (landed on their feet first)
  await lab.run(1, 4);
  const at = new Float32Array(await agents.readRaw('units'));
  const start = ids.map((id) => [+at[(id % 8192) * 24].toFixed(2), +at[(id % 8192) * 24 + 2].toFixed(2)]);
  throws.forEach((t, i) => {
    const a = (t.ang * Math.PI) / 180;
    agents.launch(ids[i], [t.v * Math.cos(a), t.v * Math.sin(a), 1.5]);
  });
  // (each throw followed while it tumbles: once on its feet it walks where its mind takes it — round the wall's end,
  // up a stair — which isn't the throw's to answer for; a frame of `speed` ticks at a time)
  const read = async () => new Float32Array(await agents.readRaw('units'));
  const ends = throws.map((t) => ({ ...t, x: -1e9, z: 0, flying: true }));
  for (let s = 0; s < 600 && ends.some((e) => e.flying); s++) {
    await lab.run(speed / 60, speed);
    const u = await read();
    const w = new Uint32Array(u.buffer);
    for (let i = 0; i < ids.length; i++) {
      const e = ends[i];
      if (!e.flying) continue;
      const o = (ids[i] % 8192) * 24;
      e.x = Math.max(e.x, +u[o].toFixed(2));
      e.z = +u[o + 2].toFixed(2);
      // (inside the land: its feet within a solid interval of the column it's in — got into the wall, not over it)
      const z = u[o + 2];
      if ((await col(u[o], u[o + 1])).some((iv) => z > iv.z0 + 0.3 && z < iv.z1 - 0.3)) e.inside = (e.inside ?? 0) + 1;
      // (or dead: a slam past HURT_SPEED kills — it lies where it fell)
      if (!(w[o + 3] & 256)) e.dead = true;
      if (e.dead || (s > 0 && ((w[o + 3] >>> 12) & 7) !== 3)) e.flying = false;
    }
  }
  const most = Math.max(...ends.map((e) => e.x));
  if (args.shot) {
    lab.look(wx, hy, args.zoom ?? 14);
    await lab.shot(`throwwall-${speed}`);
  }
  const passed = ends.filter((e) => e.inside);
  const out = { speed, stride: agents.strideMost(), face, thick: solid.length, tops, cells: cells.length, built, mostX: +most.toFixed(2), ends, passed: passed.length, start, stillFlying: ends.filter((e) => e.flying).length };
  console.log(JSON.stringify(out));
  // (args.expect: the same throws' ends a tick at a time — a ?ffwd=0 run's `ends`: the ones short of the wall within a
  // cell of it; those that reach it bounce and climb its slope, where a hair's difference in a bounce goes far — they're
  // printed, and held only to never getting inside)
  if (passed.length) throw new Error(`a thrown unit got into the wall: ${JSON.stringify(out)}`);
  if (args.expect) {
    const off = ends.map((e, i) => ({ v: e.v, ang: e.ang, dx: +(e.x - args.expect[i].x).toFixed(2), inside: e.inside ?? 0, then: args.expect[i].inside ?? 0 }));
    console.log(JSON.stringify({ off }));
    const bad = off.filter((o) => o.v <= 15 && Math.abs(o.dx) > 1);
    if (bad.length) throw new Error(`the throws differ from a tick at a time: ${JSON.stringify(bad)}`);
  }
  return out;
}
