// (round 128l, m4; V128-10) Follow a person on the behaviour lab: a working town (houses, a warehouse, a quarry out past
// the carts' distance, farms), all standing. A worker is picked by a tap on it (lab.tap at its screen point, as a
// finger), the card's Follow pressed, then `seconds` of sim: every sample the person must be on the screen; the card's
// lines are logged as they change (its day: home, work, haul, eat, home). Shots follow_000 … for a GIF
// (scripts/lab/frames2gif.mjs). Then a tap on empty ground lets go.
//   node scripts/lab.mjs run scripts/lab/fortressfollow.mjs [--args '{"seconds":60,"shots":true}']
export const recipe = 'flat';

export default async function (lab, args) {
  const seconds = args.seconds ?? 60;
  const step = args.step ?? 1.5;
  lab.sims(args.sims ?? 'fortress');
  const f = lab.fortress();
  const [hx, hy] = lab.heap;
  lab.plan({
    cells: [
      { type: 'warehouse', at: [hx + 8, hy - 6] },
      { type: 'house', at: [hx + 10, hy + 12] },
      { type: 'house', at: [hx + 16, hy + 12] },
      ...[[40, 4], [40, 10], [46, 4]].map(([dx, dy]) => ({ type: 'quarry', at: [hx + dx, hy + dy] })),
      ...[[6, -30], [12, -30], [6, -36]].map(([dx, dy]) => ({ type: 'farm', at: [hx + dx, hy + dy] })),
    ],
    built: true,
  });
  await f.settled();
  lab.stores({ grain: 200, log: 60, stone: 60 });
  lab.build();
  await lab.run(args.warm ?? 8, 8);
  const life = lab.life();
  const units = lab.units;
  // a worker with a job (a miner or a farmer), looked at and tapped
  // (round 128o: one standing apart — riders on the same trip are placed at the same spots along it, drawn one over the
  // other, and a tap there picks either: a known bug, BACKLOG DA-A12 — lanes, queueing and passing on the roads, the
  // rest of DA-A7. This scenario checks Follow, not that)
  const apart = (p) => {
    const a = units.get(p).at;
    return life.everyone().every((q) => q === p || Math.hypot(units.get(q).at[0] - a[0], units.get(q).at[1] - a[1]) > 1.5);
  };
  const id = life.people().find((p) => /^s/.test(life.board.jobOf(p) ?? '') && apart(p)) ?? life.people().find(apart) ?? life.people()[0];
  const u0 = units.get(id);
  lab.look(u0.at[0], u0.at[1], 16);
  await lab.run(0.05, 1);
  const [sx, sy] = lab.project(u0.at[0], u0.at[1], u0.at[2] + 0.7);
  await lab.tap(sx, sy);
  const fol = lab.follow();
  if (fol.selected !== id) throw new Error(`the tap at (${sx.toFixed(0)}, ${sy.toFixed(0)}) didn't pick person ${id}: ${fol.selected}`);
  const btn = document.querySelector('.fort-bar button.follow');
  if (!btn || btn.textContent !== 'Follow') throw new Error(`no Follow button under the card: ${btn?.textContent}`);
  btn.click();
  if (!fol.following) throw new Error('Follow did not start');
  const [W, H] = lab.viewport();
  let onScreen = 0;
  let samples = 0;
  const cards = [];
  let i = 0;
  for (let t = 0; t < seconds; t += step) {
    await lab.run(step, 4);
    const u = units.get(id);
    if (!u?.alive) throw new Error('the person followed is gone');
    const [px, py] = lab.project(u.at[0], u.at[1], u.at[2] + 0.7);
    samples++;
    if (px >= 0 && py >= 0 && px <= W && py <= H) onScreen++;
    const card = [...document.querySelectorAll('.fort-info p')].map((p) => p.textContent).join(' | ');
    if (cards[cards.length - 1]?.card !== card) cards.push({ t: +(t + step).toFixed(1), card });
    if (args.shots) await lab.shot(`follow_${String(i++).padStart(3, '0')}`);
  }
  const today = life.personFacts(id)?.today ?? [];
  // a tap on empty ground: let go
  await lab.tap(4, 200);
  const out = { id, onScreen, samples, today, following: fol.following, released: fol.selected === null, cards: cards.slice(0, 40) };
  if (onScreen < samples) throw new Error(`the person left the screen: ${onScreen} of ${samples} samples on it`);
  if (!out.released) throw new Error('a tap elsewhere did not let go');
  return out;
}
