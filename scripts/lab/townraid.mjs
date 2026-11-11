// (trackA-forces3, docs/design/SEASON_LOOP.md "Soldiers and waves") A raid on a town with no walls: Muru in season 1
// (`--flags "&wave=1"`: the first raid at once), no ring, so no gates — the raiders come from a spawn point on an
// arterial (no gate partner) and attack the keep, else the stores, else the market. Shot at phone size, the game's play
// zoom, 60°: the spawn, the walk in, and the fight at the place they reach. Fails when no raid comes or the sheet says
// it found no road.
//   RECLAIMED_PORT=5660 node scripts/lab.mjs run scripts/lab/townraid.mjs --flags "&wave=1" [--args '{"zoom":18}']
export default async function (lab, args) {
  const S = lab.season;
  const war = window.war;
  if (!S || !war) throw new Error('no season loop or no forces');
  const units = window.reclaimed.units;
  const id = lab.town;
  const zoom = args.zoom ?? 18;
  const fold = (on) => {
    const sh = document.querySelector('.season-sheet');
    if (sh && sh.classList.contains('folded') !== on) sh.querySelector('.s-fold').click();
  };
  const log = [];
  const note = (what) => {
    const e = { season: S.ledger.season, what, lines: war.lines, wave: war.debug().wave && { ...war.debug().wave, report: undefined, alive: war.debug().wave.report?.alive } };
    log.push(e);
    console.log(`[raid] ${JSON.stringify(e)}`);
  };
  const hurts = { raider: 0, other: 0 };
  units.hurt.push((u) => (u.kind === 'raider' ? hurts.raider++ : hurts.other++));
  // (the season's first post waits for the town's place table: a few frames)
  let t = 0;
  while (!war.debug().wave && t < 30) {
    await lab.run(1, 4);
    t++;
  }
  note('raid spawned');
  const w = war.debug().wave;
  if (!w) throw new Error(`no raid (${JSON.stringify(war.lines)})`);
  if (w.failed) throw new Error(`the raid found no road (${JSON.stringify(war.lines)})`);
  const ug = war.hooked.groups.get(w.g).ug;
  const n = (await lab.places(id)).named;
  const target = [n.keep, n.stores, n.market].find((p) => p.status === 0);
  fold(true);
  const frames = args.frames ?? 30;
  for (let k = 0; k < frames; k++) {
    const ids = units.members(ug);
    const rel = units.observe(ids);
    await lab.run(args.step ?? 2, 4);
    const at = ids.map((i) => units.get(i)?.at).filter(Boolean);
    rel();
    const c = at.length ? [at.reduce((s, p) => s + p[0], 0) / at.length, at.reduce((s, p) => s + p[1], 0) / at.length] : target.at;
    lab.look(c[0], c[1], zoom, 0.5);
    await lab.shot(`raid-${String(k).padStart(3, '0')}`);
    if (k % 5 === 4) note(`frame ${k}`);
  }
  fold(false);
  await lab.shot('raid-sheet');
  return { target: target && Object.entries(n).find(([, v]) => v === target)?.[0], statuses: Object.fromEntries(Object.entries(n).map(([k, v]) => [k, v.status])), hurts, log };
}
