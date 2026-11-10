// (round 128r, Track A "Next season" slice, derisk before the design is built) Two questions on the user's start town
// (`town`), at 412x915 ?q=low (the lab's page):
//  (a) the frame with a great flood standing over the town's low quarter against the same frame without it: the water
//      kernel wakes the flooded chunks (a toggle diff: same page, same view, phases before and after the water lands);
//  (b) a play-zoom shot of the construction stages as the fortress draws them today: a plot only (planned), scaffolding
//      (work begun) and a half-built block (lower storey standing, upper ones scaffolded).
//   node scripts/lab.mjs run scripts/lab/seasonderisk.mjs [--args '{"seconds":8,"depth":2.5,"radius":22}']
export const recipe = 'town';

export default async function (lab, args) {
  const seconds = args.seconds ?? 8;
  const R = window.reclaimed;
  const core = R.core;
  const scene = R.scene;
  const prof = core.host.profiler;
  prof.active = true;
  const f = lab.fortress();
  await f.settled();
  const [hx, hy] = lab.heap;

  // ---- the low quarter: the lowest fifth of the town's own cells (the plan's structures), by their ground
  const map = core.map;
  const { w } = core.dims;
  const wet = (x, y) => {
    const i = Math.floor(y / 0.8660254) * w + Math.floor(x);
    return map.water ? map.water[i] > 0.05 : false;
  };
  const pts = [];
  for (const s of f.plan.structures())
    for (const c of s.cells.keys()) {
      const [x, y] = f.centre(c);
      if (!wet(x, y)) pts.push([x, y, lab.ground(x, y)]);
    }
  pts.sort((a, b) => a[2] - b[2]);
  const low = pts.slice(0, Math.max(1, Math.floor(pts.length * 0.2)));
  const cx = low.reduce((s, p) => s + p[0], 0) / low.length;
  const cy = low.reduce((s, p) => s + p[1], 0) / low.length;
  const townCells = pts.length;
  const groundAtC = lab.ground(cx, cy);
  const heapZ = lab.ground(hx, hy);

  // ---- frame stats (the game's own frames: interval, rAF CPU, the profiler's GPU frame and its passes)
  const raf = window.requestAnimationFrame.bind(window);
  const S = { iv: [], cpu: [], gpu: [], last: 0, acc: 0 };
  window.requestAnimationFrame = (cb) =>
    raf((t) => {
      const t0 = performance.now();
      try {
        cb(t);
      } finally {
        S.acc += performance.now() - t0;
      }
    });
  let on = true;
  const tick = (t) => {
    if (S.last) S.iv.push(t - S.last);
    S.cpu.push(S.acc);
    S.last = t;
    S.acc = 0;
    if (on) raf(tick);
  };
  const passes = new Map();
  prof.listen((_n, ms) => {
    S.gpu.push(ms);
    for (const [k, v] of prof.lastPasses) passes.set(k, (passes.get(k) ?? 0) + v);
  });
  raf(tick);
  const q = (a, p) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2) : null;
  };
  const phase = async (name, speed) => {
    scene.speed = speed;
    await new Promise((r) => setTimeout(r, 1000));
    S.iv = [];
    S.cpu = [];
    S.gpu = [];
    S.last = 0;
    passes.clear();
    const t0 = core.sim.tick;
    await new Promise((r) => setTimeout(r, seconds * 1000));
    const n = Math.max(1, S.gpu.length);
    const water = [...passes].filter(([k]) => k.startsWith('water')).reduce((s, [, v]) => s + v, 0) / n;
    const out = { phase: name, speed, fps: +(S.iv.length / seconds).toFixed(1), iv50: q(S.iv, 0.5), iv95: q(S.iv, 0.95), cpu50: q(S.cpu, 0.5), gpu50: q(S.gpu, 0.5), gpu95: q(S.gpu, 0.95), waterMs: +water.toFixed(3), ticks: core.sim.tick - t0, top: [...passes].map(([k, v]) => [k, +(v / n).toFixed(3)]).sort((a, b) => b[1] - a[1]).slice(0, 8) };
    console.log(`SEASON ${JSON.stringify(out)}`);
    return out;
  };

  lab.sims('all');
  lab.look(cx, cy, args.zoom ?? 6);
  const rows = [];
  const depth = args.depth ?? 2.5;
  const radius = args.radius ?? 16;
  if (!args.stagesOnly) {
  rows.push(await phase('dry 1x', 1));
  rows.push(await phase('dry 4x', 4));
  scene.speed = 0;
  await lab.shot('flood-before');

  // ---- the flood: water raised over the low quarter in one tick (OP.WATER: water[i] += strength * 0.02, fading to
  // the rim — the closest thing the engine has today to a fill to a level; the instant operator is proposed in the note)
  core.globals.events.push({ kind: 5, x: cx, y: cy, z: 3 * 32, radius, strength: depth / 0.02 });
  rows.push(await phase('flooded 1x (settling)', 1));
  rows.push(await phase('flooded 1x', 1));
  rows.push(await phase('flooded 4x', 4));
  scene.speed = 0;
  await lab.shot('flood-after');
  }

  // ---- (b) the construction stages as drawn today, at play zoom near the heap
  // a free row of three sites 10 apart (no structure on any of them), nearest the heap first
  const free = (x, y) => {
    const c = f.cellAt(x, y);
    if (c < 0 || f.plan.typeAt(c) !== null || wet(x, y)) return false;
    // (well inside the window: its edge is drawn as void)
    if (x < 50 || x > w - 50 || y < 50 * 0.8660254 || y > core.dims.h * 0.8660254 - 50) return false;
    // (out in the open: no structure within 8, so the stages aren't hidden behind the town's roofs)
    return !pts.some((p) => Math.hypot(p[0] - x, p[1] - y) < 8);
  };
  let site = null;
  for (let r = 12; r < 90 && !site; r += 3)
    for (let a = 0; a < 24 && !site; a++) {
      const x = hx + r * Math.cos((a / 24) * 2 * Math.PI);
      const y = hy + r * Math.sin((a / 24) * 2 * Math.PI);
      if (free(x - 10, y) && free(x, y) && free(x + 10, y) && Math.abs(lab.ground(x - 10, y) - lab.ground(x + 10, y)) < 2) site = [x, y];
    }
  if (!site) throw new Error('seasonderisk: no free row of three sites near the heap');
  const [sx, sy] = site;
  lab.plan({ at: [sx, sy], blocks: [{ type: 'house', d: [10, 0] }], built: true });
  const res = lab.plan({
    at: [sx, sy],
    blocks: [
      // a plot only (stays planned)
      { type: 'house', d: [-10, 0] },
      // scaffolding round all three storeys
      { type: 'house', d: [0, 0] },
      { type: 'house', d: [0, 0], level: 1 },
      { type: 'house', d: [0, 0], level: 2 },
      // the lower storey standing (above), two scaffolded on it
      { type: 'house', d: [10, 0], level: 1 },
      { type: 'house', d: [10, 0], level: 2 },
    ],
  });
  lab.build();
  const ca = f.cellAt(sx, sy);
  const cb = f.cellAt(sx + 10, sy);
  for (const l of [0, 1, 2]) f.markStarted(ca, l);
  for (const l of [1, 2]) f.markStarted(cb, l);
  await lab.run(0.5, 1);
  lab.look(sx, sy, args.bzoom ?? 6);
  await lab.shot('stages-play-zoom');
  lab.look(sx, sy, (args.bzoom ?? 6) * 2);
  await lab.shot('stages-close');

  on = false;
  window.requestAnimationFrame = raf;
  return { low: { cx: +cx.toFixed(1), cy: +cy.toFixed(1), ground: +groundAtC.toFixed(2), heapZ: +heapZ.toFixed(2), townCells, lowCells: low.length, lowZ: [low[0][2], low[low.length - 1][2]] }, site, flood: { depth, radius }, plan: res, rows };
}
