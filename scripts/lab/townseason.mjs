// (switchover, 2026-11-10; replaces the fortress's fortressallbuilt gate) Two seasons with a walls card at the start
// town (Muru) on the town game's page (scripts/lab.mjs: the atlas level, the GPU town, its living town and season loop).
// Season 1: the walls card and a houses card started (pools granted, the walls card offered as if dealt: a script's
// only shortcuts, SeasonLoop.grant/offer), Next season, Skip (every stage at once); season 2 the same with a farms card.
// It must: claim districts on the GPU (the count of districts not begun falls) and stage them (the town's edit log holds
// the stages), raise the wall (the ring made, its stage past 0, posts on risen pieces once saved), and write the save
// point (the season's record in the world store, the town's edit log with it) — with no page error.
//   node scripts/lab.mjs run scripts/lab/townseason.mjs [--args '{"settle":6}']
export default async function (lab, args) {
  const S = lab.season;
  if (!S) throw new Error('no season loop (the page runs it by default: ?opps=0 turns it off)');
  const towns = lab.towns;
  const id = lab.town;
  const t = towns.live.get(id);
  if (!t) throw new Error(`the start town ${id} isn't made`);
  const left0 = S.left;
  const season0 = S.ledger.season;
  S.grant({ labor: 10, might: 4, materials: 20, magic: 4, intel: 4 });
  const start = (cardId) => {
    let i = S.hand.findIndex((o, k) => o.card.id === cardId && !S.started.has(k));
    if (i < 0) i = S.offer(cardId);
    const can = S.canStart(i);
    if (!can.ok) throw new Error(`season ${S.ledger.season}: ${cardId} can't start (${JSON.stringify(can)})`);
    S.start(i);
  };
  const seasons = [];
  const play = async (cards) => {
    for (const c of cards) start(c);
    const r = await S.next();
    S.skip();
    await lab.run(args.settle ?? 6, 8);
    seasons.push({ season: S.ledger.season, summary: S.summary, changes: r.changes.map((ch) => `${ch.card} ${ch.from}->${ch.to}${ch.done ? ' done' : ''}`), left: S.left, districts: S.districts.size });
  };
  await play(['walls', 'houses']);
  await play(['farms']);
  // (the save point: written at a season's end — persist is asynchronous: its few reads back and the store's write)
  const store = window.reclaimed.stream?.store;
  const key = `season:${Math.round(t.site.at[0])},${Math.round(t.site.at[1])}`;
  for (let k = 0; k < 50 && !(store?.has(key) && towns.wallPosts(id).length); k++) await new Promise((r) => setTimeout(r, 200));
  const log = towns.logs.of(t.site.at);
  const posts = towns.wallPosts(id);
  lab.look(...t.centreInWindow(), args.zoom ?? 4);
  await lab.shot('townseason_end');
  const out = { town: id, name: t.site.name, season0, season: S.ledger.season, left0, left: S.left, districts: S.districts.size, stages: log.stages.length, claims: log.claims.length, wall: log.wall ? { words: log.wall.words.length, to: log.wall.to } : null, posts: posts.length, saved: !!store?.has(key), seasons };
  if (S.ledger.season < season0 + 2) throw new Error(`two seasons weren't played: ${season0} → ${S.ledger.season}`);
  if (!(S.left < left0)) throw new Error(`no district claimed on the GPU: ${left0} → ${S.left} not begun`);
  if (!log.stages.length) throw new Error('no district stage in the town’s edit log: the districts didn’t rise');
  if (!log.wall || !(log.wall.to > 0)) throw new Error(`the wall didn't rise: ${JSON.stringify(out.wall)}`);
  if (!posts.length) throw new Error('no wall piece fully risen (no posts on the saved ring)');
  if (!out.saved) throw new Error(`no save point: the world store has no ${key}`);
  return out;
}
