// (round 128r, Track A "Next season") The start town's seasons on the `town` recipe (the user's start town): the
// scenario's three cards set up (the fortress tower, the outer quarter, the low ground's flood), then `seasons` Next
// seasons, each played as the showcase (`mode: 'play'`) or skipped at once (`mode: 'skip'`). Shots of each change
// before and after at play zoom (`shots`), the frame during a showcase against the frame idle (a toggle diff), the
// frame with the flood standing still, and the end state as JSON: the ledger, the plan, the blocks standing, and probes
// of the GPU's fields (water over the flood, plants over the quarter). scripts/seasongate.mjs runs it both ways and
// compares (skipping must give the same world).
//   node scripts/lab.mjs run scripts/lab/season.mjs --reload [--args '{"mode":"play","seasons":3,"shots":true}']
export const recipe = 'town';

export default async function (lab, args) {
  const mode = args.mode ?? 'play';
  const seasons = args.seasons ?? 3;
  const R = window.reclaimed;
  const scene = R.scene;
  const core = R.core;
  const S = scene.season;
  if (!S) throw new Error('season.mjs: no season on the scene (fortress mode)');
  const f = lab.fortress();
  await f.settled();
  lab.sims('all');
  const prof = core.host.profiler;
  prof.active = true;

  // ---- frame stats over a phase (the game's own frames)
  const raf = window.requestAnimationFrame.bind(window);
  const F = { iv: [], gpu: [], last: 0, passes: new Map(), on: true };
  const tick = (t) => {
    if (F.last) F.iv.push(t - F.last);
    F.last = t;
    if (F.on) raf(tick);
  };
  raf(tick);
  prof.listen((_n, ms) => {
    F.gpu.push(ms);
    for (const [k, v] of prof.lastPasses) F.passes.set(k, (F.passes.get(k) ?? 0) + v);
  });
  const q = (a, p) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2) : null;
  };
  const begin = () => {
    F.iv = [];
    F.gpu = [];
    F.last = 0;
    F.passes = new Map();
  };
  const sum = (pre) => [...F.passes].filter(([k]) => pre.some((p) => k.startsWith(p))).reduce((s, [, v]) => s + v, 0) / Math.max(1, F.gpu.length);
  const end = (name) => {
    const out = { phase: name, frames: F.iv.length, iv50: q(F.iv, 0.5), iv95: q(F.iv, 0.95), gpu50: q(F.gpu, 0.5), gpu95: q(F.gpu, 0.95), water: +sum(['water']).toFixed(3), fieldmesh: +sum(['fieldmesh']).toFixed(3), basin: +sum(['basin']).toFixed(3), top: [...F.passes].map(([k, v]) => [k, +(v / Math.max(1, F.gpu.length)).toFixed(3)]).sort((a, b) => b[1] - a[1]).slice(0, 8) };
    console.log(`SEASON ${JSON.stringify(out)}`);
    return out;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const phase = async (name, ms) => {
    begin();
    await wait(ms);
    return end(name);
  };

  // ---- the scenario
  const t0 = performance.now();
  await S.setup();
  const setupMs = Math.round(performance.now() - t0);
  // (the view a season plays in: the build view, time stopped — what Next season does first)
  S.enter();
  await wait(500);
  const cards = S.play.ledger.projects.map((p) => ({ id: p.card.id, work: p.card.work }));
  const tower = cards.find((c) => c.id === 'tower').work;
  const quarter = cards.find((c) => c.id === 'quarter').work;
  const flood = cards.find((c) => c.id === 'flood').work;
  const towerAt = (() => {
    const s = f.plan.structure(tower.structure);
    const cs = [...s.cells.keys()].map((c) => f.centre(c));
    return [cs.reduce((a, p) => a + p[0], 0) / cs.length, cs.reduce((a, p) => a + p[1], 0) / cs.length];
  })();
  const spots = { tower: towerAt, quarter: quarter.at, flood: flood.at };
  const zoom = args.zoom ?? 9;
  const shoot = async (tag) => {
    if (!args.shots) return;
    for (const [k, at] of Object.entries(spots)) {
      lab.look(at[0], at[1], zoom);
      await lab.shot(`${k}-${tag}`);
    }
  };
  await shoot('s0');
  const rows = [];
  if (args.perf) rows.push(await phase('idle before', 5000));
  const summaries = [];
  /** the water over the flood's seed after each season (it stands in seasons 1-2, gone after 3) */
  const perSeason = [];
  for (let k = 1; k <= seasons; k++) {
    begin();
    const tn = performance.now();
    await S.next();
    const resolveMs = Math.round(performance.now() - tn);
    if (mode === 'skip') S.play.skip();
    // (the showcase plays on the game's own frames; a mid shot of the season while it plays)
    let mid = false;
    let g = 0;
    while (S.play.playing) {
      if (args.shots && args.mid && !mid && S.play.progress > 0.5) {
        mid = true;
        await lab.shot(`season${k}-mid`);
      }
      // (args.gif: season `args.gif`'s frames as it plays, the camera as the showcase frames it — scripts/lab-gif.mjs joins them)
      if (args.gif === k) {
        await lab.shot(`seasongif-${String(g++).padStart(3, '0')}`);
        continue;
      }
      await wait(50);
    }
    const r = end(`season ${k} (${mode})`);
    r.resolveMs = resolveMs;
    rows.push(r);
    summaries.push(S.play.summary);
    // (what the showcase's last steps queued — a grow — lands, then the shots)
    await wait(1500);
    {
      const wv = await core.readBuffer('water');
      const Wd = core.dims.w;
      const at = (x, y) => {
        const cy = Math.round(y / 0.8660254 - 0.5);
        return wv[cy * Wd + Math.round(x - 0.5 - 0.5 * (cy & 1))];
      };
      const [fx, fy] = cards.find((c) => c.id === 'flood').work.at;
      perSeason.push([[fx, fy], [fx + 3, fy], [fx - 3, fy], [fx, fy + 3], [fx, fy - 3]].map(([x, y]) => +at(x, y).toFixed(2)));
    }
    await shoot(`s${k}`);
    if (args.perf && k === 1) {
      // the flood standing still: the frame with the camera on it, once it's settled
      lab.look(flood.at[0], flood.at[1], zoom);
      rows.push(await phase('flood standing (0-5 s)', 5000));
      rows.push(await phase('flood standing (5-10 s)', 5000));
    }
  }
  if (args.perf) rows.push(await phase('idle after', 5000));
  F.on = false;

  // ---- the end state: the strategic truth exactly, the GPU's fields by probes
  const plan = f.plan;
  const structures = plan
    .structures()
    .sort((a, b) => a.id - b.id)
    .map((s) => ({ id: s.id, type: s.type, wear: s.wear ?? null, cells: [...s.cells].sort((a, b) => a[0] - b[0]).map(([c, runs]) => [c, runs.map((r) => [r.lo, r.hi])]) }));
  const standing = [];
  for (const s of plan.structures()) for (const c of s.cells.keys()) for (const l of f.town.built.each(c)) standing.push(`${c}:${l}`);
  standing.sort();
  const water = await core.readBuffer('water');
  const veg = await core.readBuffer('veg');
  const W = core.dims.w;
  const col = (x, y) => {
    const cy = Math.round(y / 0.8660254 - 0.5);
    const cx = Math.round(x - 0.5 - 0.5 * (cy & 1));
    return cy * W + cx;
  };
  const ring = (at, r, n) => Array.from({ length: n }, (_, i) => [at[0] + Math.cos((i / n) * 6.283) * r * (i % 2 ? 0.5 : 1), at[1] + Math.sin((i / n) * 6.283) * r * (i % 2 ? 0.5 : 1)]);
  const probes = {
    water: [flood.at, ...ring(flood.at, 6, 6)].map(([x, y]) => +water[col(x, y)].toFixed(2)),
    plants: [quarter.at, ...ring(quarter.at, quarter.r * 0.6, 8)].map(([x, y]) => veg[col(x, y)] > 1 ? 1 : 0),
  };
  const L = S.play.ledger;
  return {
    mode,
    setupMs,
    cards,
    summaries,
    flooded: S.play.flooded,
    floods: S.play.standing,
    ledger: { season: L.season, pools: L.pools, projects: L.projects.map((p) => ({ id: p.card.id, worked: p.worked })), story: L.story },
    history: S.world.history().map((e) => ({ id: e.id, kind: e.kind, level: e.level ?? null })),
    structures,
    standing,
    probes: { ...probes, perSeason },
    rows,
  };
}
