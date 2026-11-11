// (trackA-forces, docs/design/SEASON_LOOP.md "Soldiers and waves") The season's soldiers and raiders at Muru, on the
// town game's page, phone size (412x915), the game's own play zoom, 60°: Might granted and the walls card started (a
// script's only shortcuts, SeasonLoop.grant / offer); soldiers in the muster yard once the ring is made (season 2); the
// walls built in season 4 — squads at the gates and the first raid (FIRST_WAVE) from a spawn point outside the wall,
// shot as frames for a GIF from its start; Next season settles it into the pools. The card sheet folded for the shots
// (the player's ▾). Fails when no soldier stands, no raid comes, or nothing settles.
//   RECLAIMED_PORT=5680 node scripts/lab.mjs run scripts/lab/townforces.mjs [--args '{"zoom":18,"wide":16,"close":34}']
export default async function (lab, args) {
  const S = lab.season;
  const war = window.war;
  if (!S || !war) throw new Error('no season loop or no forces (the page runs them by default)');
  const id = lab.town;
  const units = window.reclaimed.units;
  // (the zoom a player pinches in to watch soldiers: the town's opening zoom shows the whole town, figures a few pixels)
  const zoom = args.zoom ?? 18;
  const named = async () => (await lab.places(id)).named;
  const kinds = () => {
    const out = { guard: 0, raider: 0, guardDead: 0, raiderDead: 0 };
    for (const { v: u } of units.recs.values()) {
      if (u.kind !== 'guard' && u.kind !== 'raider') continue;
      out[u.alive ? u.kind : `${u.kind}Dead`]++;
    }
    return out;
  };
  const deaths = [];
  units.died.push((u, by) => deaths.push({ t: Math.round(performance.now()), kind: u.kind, by: typeof by === 'number' ? units.recs.get(by)?.v.kind : by }));
  const log = [];
  const note = (what) => {
    const e = { season: S.ledger.season, what, units: kinds(), lines: war.lines };
    log.push(e);
    console.log(`[forces] ${JSON.stringify(e)}`);
  };
  const fold = (on) => {
    const sh = document.querySelector('.season-sheet');
    if (sh && sh.classList.contains('folded') !== on) sh.querySelector('.s-fold').click();
  };
  S.grant({ labor: 6, might: 2, materials: 12 });
  let i = S.hand.findIndex((o) => o.card.id === 'walls');
  if (i < 0) i = S.offer('walls');
  S.start(i);
  const season = async () => {
    fold(false);
    await S.next();
    S.skip();
    // (the season's stages land; the squads and a raid follow the showcase's end and the adapter's one read)
    await lab.run(1, 2);
  };
  await season();
  // season 2: the ring made, the muster yard there — the free Might's squads raised and waiting there
  await lab.run(10, 2);
  note('season 2: soldiers at the yard');
  let n = await named();
  if (n.muster.status !== 0) throw new Error(`season 2: no muster yard (${JSON.stringify(n.muster)})`);
  fold(true);
  lab.look(n.muster.at[0], n.muster.at[1], zoom, 0.5);
  await lab.shot('forces-1-yard');
  if (!kinds().guard) throw new Error(`season 2: no soldiers (${JSON.stringify(war.lines)})`);
  await season();
  await season();
  // season 4: the walls built — squads to the gates; the first raid spawned outside the wall
  n = await named();
  const gates = Object.entries(n).filter(([k, v]) => k.startsWith('gate') && v.status === 0);
  const raid = war.debug().wave;
  if (!raid) throw new Error('season 4: no raid');
  note('season 4: walls built, the raid starts');
  fold(true);
  // (the raid's frames from its start: the spawn point and its target framed together)
  const spawn = n.spawn0;
  const target = [...gates.map(([, v]) => v), n.keep, n.stores].find((p) => p.status === 0);
  const mid = [(spawn.at[0] + target.at[0]) / 2, (spawn.at[1] + target.at[1]) / 2];
  const span = Math.hypot(spawn.at[0] - target.at[0], spawn.at[1] - target.at[1]);
  lab.look(mid[0], mid[1], Math.max(zoom * 0.5, Math.min(zoom, 330 / span)), 0.5);
  // (two GIFs: the raid's approach framed wide, then the fight close at its gate)
  const wide = args.wide ?? 16;
  const close = args.close ?? 34;
  const g0 = [...gates.map(([, v]) => v)][0];
  for (let k = 0; k < wide + close; k++) {
    // (the gate, and a little of the road out toward the raid)
    if (k === wide && g0) {
      const sp = n[`spawn${gates[0][0].slice(4)}`] ?? spawn;
      const d = Math.hypot(sp.at[0] - g0.at[0], sp.at[1] - g0.at[1]) || 1;
      lab.look(g0.at[0] + ((sp.at[0] - g0.at[0]) / d) * 6, g0.at[1] + ((sp.at[1] - g0.at[1]) / d) * 6, zoom, 0.5);
    }
    await lab.run(args.step ?? 1, 2);
    await lab.shot(k < wide ? `forces-wide-${String(k).padStart(3, '0')}` : `forces-close-${String(k - wide).padStart(3, '0')}`);
    if (k % 5 === 4) note(`raid frame ${k}`);
    if (k === wide + Math.floor(close / 2)) await lab.shot('forces-3-fight');
  }
  // the squads at the gates
  const g = gates[0]?.[1];
  if (g) {
    lab.look(g.at[0], g.at[1], zoom, 0.5);
    await lab.shot('forces-2-gate');
  }
  const before = { might: S.ledger.holdings.agents.filter((x) => x.kind === 'army').length, materials: S.ledger.holdings.goods.materials, unrest: S.ledger.holdings.goods.unrest };
  await season();
  note('season 5: settled');
  fold(false);
  await lab.shot('forces-4-settled');
  return { gates: gates.map(([k]) => k), statuses: Object.fromEntries(Object.entries(n).map(([k, v]) => [k, v.status])), span, before, summary: S.summary, after: { might: S.ledger.holdings.agents.filter((x) => x.kind === 'army').length, materials: S.ledger.holdings.goods.materials, unrest: S.ledger.holdings.goods.unrest }, deaths, log };
}
