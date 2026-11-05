// (round 128l, m4) GIF frames: a recruit fetches a weapon, drills at the barracks, becomes a soldier and marches by road
// to the wall's stairs — the camera on them at play zoom. Then: node scripts/lab/frames2gif.mjs <shots> soldier_ soldier.gif
export const recipe = 'flat';

export default async function (lab, args) {
  const frames = args.frames ?? 70;
  const step = args.step ?? 1.5;
  lab.sims(args.sims ?? 'fortress');
  const f = lab.fortress();
  const [hx, hy] = lab.heap;
  const at = [hx + 48, hy];
  lab.plan({
    at,
    walls: { r: 16, gate: 'west' },
    blocks: [{ type: 'warehouse', d: [-6, 0] }, { type: 'barracks', d: [5, 6] }, { type: 'house', d: [-5, 8] }],
    built: true,
  });
  await f.settled();
  lab.stores({ ore: 0, log: 80, stone: 200, grain: 150, weapons: 3 });
  lab.build();
  const life = lab.life();
  const units = lab.units;
  // the first recruit
  let id = null;
  for (let i = 0; i < 40 && id === null; i++) {
    await lab.run(0.5, 4);
    id = life.people().find((p) => life.board.jobOf(p)?.startsWith('s') && units.recs.get(p)?.work?.phase === 'fetch') ?? null;
  }
  if (id === null) throw new Error('no recruit');
  let last = null;
  const seen = [];
  for (let i = 0; i < frames; i++) {
    let u = units.get(id);
    if (!u || !u.alive) {
      // (enlisted: the soldier stood up where the recruit stood)
      const near = life.soldiers.map((s) => units.get(s)).filter(Boolean).sort((a, b) => Math.hypot(a.at[0] - last[0], a.at[1] - last[1]) - Math.hypot(b.at[0] - last[0], b.at[1] - last[1]))[0];
      if (near) {
        id = near.id;
        u = near;
      }
    }
    if (u) last = [u.at[0], u.at[1]];
    const w = units.recs.get(id)?.work;
    seen.push(`${u?.role ?? '?'}:${u?.job?.kind === 'go' ? 'patrol' : (w?.phase ?? '-')}`);
    lab.look(last[0], last[1] + 1, args.zoom ?? 18);
    await lab.shot(`soldier_${String(i).padStart(3, '0')}`);
    await lab.run(step, 4);
  }
  return { seen: seen.filter((s, i) => s !== seen[i - 1]), stats: life.stats };
}
