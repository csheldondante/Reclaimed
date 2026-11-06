// (round 128o, DA-B22: the fast-forward's sub-move bound) How far a unit moves in one step of the units at
// fast-forward, per kind and state: a walled town's wave met by soldiers (fights, knock-backs, the builders at work),
// run a frame at a time at the speed whose frame is exactly one stride (agents.strideMost(): one step spanning the
// most ticks a step may), the units' buffer read after each. The step moves a unit in sub-moves of at most half a
// cell (units.wgsl SUB_MOVE), so a step's move is never one the links or the walls aren't checked along; this
// measures what that costs: the most a step moved, the sub-moves that took, and the share of steps that took more
// than one (the stride, from the kinds' speeds, keeps it small). Held units are the game's to place: not counted.
// The hard check — a thrown unit never passes a wall a column thick — is scripts/lab/throwwall.mjs.
//   node scripts/lab.mjs run scripts/lab/stepbound.mjs --recipe walled [--args '{"frames":900,"soldiers":4}']
export const recipe = 'walled';

export default async function (lab, args) {
  const STATES = ['wander', 'chase', 'swing', 'tumble', 'held'];
  const frames = args.frames ?? 900;
  lab.sims(args.sims ?? 'raid');
  const f = lab.fortress();
  await f.settled();
  lab.stores({ stone: 120, log: 60, grain: 60, ore: 10, weapons: 2 });
  lab.build();
  const raid = lab.raid();
  if (!raid) throw new Error('no raid after Build');
  lab.life().standSoldiers(args.soldiers ?? 4);
  await lab.run(1, 4);
  raid.callNow();
  const agents = lab.units.agents;
  const stride = agents.strideMost();
  const names = agents.kinds.map((k) => k?.name ?? null);
  const read = async () => new Float32Array(await agents.readRaw('units'));
  let prev = await read();
  const most = {};
  let steps = 0;
  for (let i = 0; i < frames; i++) {
    // (one frame of `stride` ticks: the units step once over all of them — agents.ts stepPlan)
    await lab.run(stride / 60, stride);
    const now = await read();
    const n = Math.min(prev.length, now.length) / 24;
    for (let s = 0; s < n; s++) {
      const o = s * 24;
      const a = new Uint32Array(now.buffer, o * 4 + 12, 1)[0];
      const b = new Uint32Array(prev.buffer, o * 4 + 12, 1)[0];
      // (the same unit, alive both times)
      if (a >>> 16 !== b >>> 16 || !(a & 256) || !(b & 256)) continue;
      const kind = names[(a >>> 9) & 7] ?? `kind${(a >>> 9) & 7}`;
      const state = STATES[(a >>> 12) & 7] ?? 'other';
      const d = Math.hypot(now[o] - prev[o], now[o + 1] - prev[o + 1]);
      if (state === 'held') continue;
      const key = state === 'tumble' ? `${kind}/tumble` : kind;
      const m = (most[key] ??= { most: 0, steps: 0, over: 0, speed: 0, alight: 0 });
      if (d > 0.5) m.over++;
      if (d > m.most) {
        m.most = d;
        // (what moved it: its speed after the step (cells/s), and whether it was alight)
        m.speed = +Math.hypot(now[o + 4], now[o + 5]).toFixed(2);
        m.alight = (a >>> 15) & 1;
      }
      m.steps++;
    }
    steps++;
    prev = now;
    if (raid.state().stage === 'none' && i > 60) break;
  }
  for (const m of Object.values(most)) {
    m.most = +m.most.toFixed(3);
    // (the sub-moves the longest step took, and the share of steps taking more than one)
    m.subMoves = Math.max(1, Math.ceil(m.most / 0.5));
    m.over = +(m.over / Math.max(m.steps, 1)).toFixed(4);
  }
  const out = { stride, speeds: agents.kinds.filter(Boolean).map((k) => [k.name, k.speed]), steps, most, stage: raid.state().stage, stats: raid.state().stats };
  console.log(JSON.stringify(out));
  if (!Object.values(most).some((m) => m.most > 0)) throw new Error(`no unit moved: ${JSON.stringify(out)}`);
  return out;
}
