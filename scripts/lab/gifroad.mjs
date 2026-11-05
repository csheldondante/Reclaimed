// (round 128l, m4) GIF frames on the roads: --args '{"who":"cart"}' a cart riding out to a far quarry's pile and back;
// '{"who":"settler"}' a newcomer walking in from the window's edge and riding the roads to a house. The camera follows
// it (the game's Follow) at play zoom; shots <who>_000 … (scripts/lab/frames2gif.mjs).
export const recipe = 'flat';

export default async function (lab, args) {
  const who = args.who ?? 'cart';
  const frames = args.frames ?? 50;
  const step = args.step ?? 1.5;
  lab.sims(args.sims ?? 'fortress');
  const f = lab.fortress();
  const [hx, hy] = lab.heap;
  lab.plan({
    cells: [
      { type: 'house', at: [hx + 10, hy + 12] },
      { type: 'house', at: [hx + 16, hy + 12] },
      { type: 'house', at: [hx - 8, hy + 14] },
      ...[[70, 4], [70, 10], [76, 4], [76, 10]].map(([dx, dy]) => ({ type: 'quarry', at: [hx + dx, hy + dy] })),
    ],
    built: true,
  });
  await f.settled();
  lab.stores({ grain: 200, log: 60, stone: 60 });
  lab.build();
  const life = lab.life();
  const units = lab.units;
  let id = null;
  if (who === 'cart') {
    // (a load waiting on the quarry's pile: the first cart rides out for it)
    await lab.run(2, 4);
    life.piles.set(f.plan.structureAt(f.cellAt(hx + 70, hy + 4)).id, { stone: 6, ore: 2 });
    for (let i = 0; i < 20 && id === null; i++) {
      await lab.run(0.5, 4);
      id = life.carts.find((c) => units.recs.get(c)?.work?.phase === 'out') ?? null;
    }
  } else {
    for (let i = 0; i < 80 && id === null; i++) {
      await lab.run(0.5, 8);
      id = life.people().find((p) => units.recs.get(p)?.work?.phase === 'arrive') ?? null;
    }
  }
  if (id === null) throw new Error(`no ${who} to follow`);
  const fol = lab.follow();
  fol.select(id);
  fol.follow(true);
  const u0 = units.get(id);
  lab.look(u0.at[0], u0.at[1], args.zoom ?? 16);
  const seen = [];
  for (let i = 0; i < frames; i++) {
    await lab.run(step, 4);
    const w = units.recs.get(id)?.work;
    const u = units.get(id);
    seen.push(w?.phase ?? '-');
    await lab.shot(`${who}_${String(i).padStart(3, '0')}`);
    if (!u?.alive) break;
  }
  return { id, phases: seen.filter((s, i) => s !== seen[i - 1]), stats: life.stats };
}
