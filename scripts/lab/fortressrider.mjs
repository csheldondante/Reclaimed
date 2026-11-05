// (round 128l, m4: the attack wave) The rider's word: the next wave's clock brought near (its rider out 10 sim s on), the
// rider walks in from the window's edge to the stores, the bar's line says where the raiders come from and when, the
// rider walks out again; the soldiers take their posts (archers up on the wall). Fails unless the line came with the
// rider at the stores and the soldiers are posted.
//   node scripts/lab.mjs run scripts/lab/fortressrider.mjs --recipe walled
export const recipe = 'walled';

export default async function (lab, args) {
  lab.sims(args.sims ?? 'fortress');
  const f = lab.fortress();
  await f.settled();
  lab.build();
  // (part B: soldiers take their posts when the word comes)
  lab.life().standSoldiers(args.soldiers ?? 3);
  await lab.run(1, 4);
  const raid = lab.raid();
  // (the wave far enough off for the rider to walk in: its warning 10 s on)
  raid.clock.next = raid.state().t + 10 + 1.5 * 60;
  const log = [];
  let told = null;
  let riderAt = null;
  for (let t = 0; t < (args.seconds ?? 90); t += 2) {
    await lab.run(2, 8);
    const s = raid.state();
    const v = raid.rider !== null ? lab.units.get(raid.rider) : null;
    if (v) riderAt = [v.at[0], v.at[1]];
    log.push({ t: Math.round(s.t), rider: v ? v.at.map((n) => Math.round(n)).join(',') : null, lines: s.lines });
    if (!told && s.lines.length) {
      told = { t: s.t, line: s.lines[0], riderAt, heap: lab.life().heap() };
      lab.look(riderAt?.[0] ?? lab.heap[0], riderAt?.[1] ?? lab.heap[1], 14);
      await lab.shot('rider-told');
    }
    if (told && raid.rider === null && raid.state().defence.posted.some((p) => p.up)) break;
  }
  const posted = raid.state().defence.posted;
  const out = { told, posted, gone: raid.rider === null, log: log.filter((l, i) => i % 5 === 0) };
  if (!told) throw new Error(`no word came: ${JSON.stringify(out)}`);
  const d = Math.hypot(told.riderAt[0] - told.heap[0], told.riderAt[1] - told.heap[1]);
  if (!(d < 8)) throw new Error(`the word came with the rider ${d.toFixed(1)} m from the stores: ${JSON.stringify(out)}`);
  if (posted.length !== (args.soldiers ?? 3) || !posted.some((p) => p.up)) throw new Error(`the soldiers didn't take their posts: ${JSON.stringify(out)}`);
  return out;
}
