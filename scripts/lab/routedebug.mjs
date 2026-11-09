// (diagnostic, Track A) The start town's edge network with ?routedebug=1: what the routes treat as not walkable and why
// (fortress/routedebug.ts, build/edgecuts.ts). Shots at play zoom: the town's middle, its cliff cuts' two biggest clusters
// out from the middle (the town's edges), and the whole town; the counts and the rise against SLOPE.
//   node scripts/lab.mjs run scripts/lab/routedebug.mjs --flags "&routedebug=1"
export const recipe = 'town';

export default async function (lab, args) {
  while (!lab.ready) await new Promise((r) => setTimeout(r, 100));
  const z = args.zoom ?? 4;
  const R = window.reclaimed;
  const dbg = R.routeDebug?.();
  if (!dbg) throw new Error('routedebug: load the lab with --flags "&routedebug=1"');
  await lab.run(0.5, 1);
  if (args.nopanel) dbg.panel.style.display = 'none';
  const f = lab.fortress();
  const [hx, hy] = lab.heap;
  lab.look(hx, hy, z);
  await lab.run(0.1, 1);
  const s = dbg.summary;
  if (!s) throw new Error('routedebug: no roads laid');
  // the cliff cuts' middles (window world), in 10 m bins, the biggest bins first — those that are cliffs alone (a cliff
  // also cut by water or a wall shows as that)
  const net = f.roads.net;
  const g = f.site.grid;
  const bins = new Map();
  const ends = [];
  const cliffs = [];
  for (let e = 0; e < net.cut.length; e++) {
    if (!(net.cut[e] & 4)) continue;
    const a = net.ends[e * 2];
    const b = net.ends[e * 2 + 1];
    const [x, y] = f.toWindow((g.verts[a * 2] + g.verts[b * 2]) / 2, (g.verts[a * 2 + 1] + g.verts[b * 2 + 1]) / 2);
    const alone = !(net.cut[e] & 3);
    const k = `${Math.floor(x / 10)},${Math.floor(y / 10)}`;
    const v = bins.get(k) ?? { n: 0, x: 0, y: 0 };
    if (alone) {
      v.n++;
      v.x += x;
      v.y += y;
      bins.set(k, v);
    }
    const ga = f.site.groundAt(g.verts[a * 2], g.verts[a * 2 + 1]);
    const gb = f.site.groundAt(g.verts[b * 2], g.verts[b * 2 + 1]);
    // (the live ground there, window z + oz: what's drawn — the net's sampler is the land before the town)
    const [ax, ay] = f.toWindow(g.verts[a * 2], g.verts[a * 2 + 1]);
    const [bx, by] = f.toWindow(g.verts[b * 2], g.verts[b * 2 + 1]);
    // (a script's readback round the edge, not the overlay's: the terrain mirror keeps a small area)
    await R.api.terrain.load(Math.min(ax, bx) - 2, Math.min(ay, by) - 2, Math.max(ax, bx) + 2, Math.max(ay, by) + 2);
    const la = R.api.terrain.groundAt(ax, ay);
    const lb = R.api.terrain.groundAt(bx, by);
    ends.push([ga, gb]);
    cliffs.push({ alone, at: [+x.toFixed(1), +y.toFixed(1)], len: +net.length[e].toFixed(2), dz: +Math.abs(ga - gb).toFixed(2), liveDz: la == null || lb == null ? null : +Math.abs(la - lb).toFixed(2), netVsLive: la == null ? null : +(ga - f.zShift - la).toFixed(2), cells: [net.cells[e * 2], net.cells[e * 2 + 1]].map((c) => (c < 0 ? 'rim' : (f.plan.structureAt(c)?.type ?? (net.roads.has(c) ? 'road' : 'open')))) });
  }
  // every walkable-by-the-net edge again with the live ground: how many would be cliffs (a measurement, nothing changed)
  let liveCliff = 0;
  let liveMissing = 0;
  // (tiles of 32 m, each read and then its edges sampled)
  const tiles = new Map();
  for (let e = 0; e < net.cut.length; e++) {
    const a = net.ends[e * 2];
    const [x, y] = f.toWindow(g.verts[a * 2], g.verts[a * 2 + 1]);
    const k = Math.floor(x / 32) + ',' + Math.floor(y / 32);
    (tiles.get(k) ?? tiles.set(k, []).get(k)).push(e);
  }
  for (const [k, es] of tiles) {
   const [tx, ty] = k.split(',').map(Number);
   await R.api.terrain.load(tx * 32 - 8, ty * 32 - 8, tx * 32 + 40, ty * 32 + 40);
   for (const e of es) {
    const a = net.ends[e * 2];
    const b = net.ends[e * 2 + 1];
    const la = R.api.terrain.groundAt(...f.toWindow(g.verts[a * 2], g.verts[a * 2 + 1]));
    const lb = R.api.terrain.groundAt(...f.toWindow(g.verts[b * 2], g.verts[b * 2 + 1]));
    if (la == null || lb == null) {
      liveMissing++;
      continue;
    }
    if (Math.abs(la - lb) / Math.max(net.length[e], 1e-6) > 0.75) liveCliff++;
   }
  }
  const clusters = [...bins.values()].map((v) => ({ n: v.n, at: [+(v.x / v.n).toFixed(1), +(v.y / v.n).toFixed(1)], d: Math.hypot(v.x / v.n - hx, v.y / v.n - hy) })).sort((a, b) => b.n - a.n);
  // the ground sampled: whole-number heights or not (a column top's quantum shows as steps)
  const cols = f.site.groundCols;
  let whole = 0;
  for (const v of cols) if (Math.abs(v - Math.round(v)) < 1e-4) whole++;
  const fracs = new Set();
  for (const v of cols) fracs.add(+(v - Math.floor(v)).toFixed(3));
  // every edge's length
  const lens = [...net.length].sort((a, b) => a - b);
  const q = (xs, p) => +xs[Math.min(xs.length - 1, Math.round(p * (xs.length - 1)))].toFixed(2);
  const shots = [];
  await lab.shot('rd-core');
  shots.push({ name: 'rd-core', at: [hx, hy] });
  const out = clusters.filter((c) => c.d > 25);
  const picked = [];
  for (const c of out) {
    if (picked.length >= 3) break;
    if (picked.some((p) => Math.hypot(p.at[0] - c.at[0], p.at[1] - c.at[1]) < 30)) continue;
    picked.push(c);
  }
  for (let i = 0; i < picked.length; i++) {
    lab.look(picked[i].at[0], picked[i].at[1], z);
    await lab.run(0.1, 1);
    await lab.shot(`rd-edge${i + 1}`);
    shots.push({ name: `rd-edge${i + 1}`, at: picked[i].at, cliffs: picked[i].n });
  }
  lab.look(hx, hy, args.overview ?? 1.8);
  await lab.run(0.1, 1);
  await lab.shot('rd-wide');
  dbg.show(false);
  await lab.shot('rd-wide-clean');
  lab.look(hx, hy, z);
  await lab.run(0.1, 1);
  await lab.shot('rd-core-clean');
  for (let i = 0; i < picked.length; i++) {
    lab.look(picked[i].at[0], picked[i].at[1], z);
    await lab.run(0.1, 1);
    await lab.shot(`rd-edge${i + 1}-clean`);
  }
  dbg.show(true);
  const dzs = ends.map(([a, b]) => Math.abs(a - b));
  const dzHist = {};
  for (const d of dzs) {
    const k = d < 1 ? '<1' : d < 2 ? '1-2' : d < 3 ? '2-3' : d < 5 ? '3-5' : '>=5';
    dzHist[k] = (dzHist[k] ?? 0) + 1;
  }
  return {
    summary: s,
    cliffs,
    live: { cliff: liveCliff, missing: liveMissing },
    reach: { structures: net.reach.structures, reached: net.reach.reached, out: net.reach.out.length, noDoorAtGrade: net.reach.noDoorAtGrade },
    heap: [hx, hy],
    clusters: clusters.slice(0, 10),
    shots,
    cliffDzHist: dzHist,
    edgeLength: { min: q(lens, 0), q25: q(lens, 0.25), med: q(lens, 0.5), q75: q(lens, 0.75), max: q(lens, 1) },
    ground: { cols: cols.length, wholeNumbers: whole, fractions: [...fracs].slice(0, 12), fractionKinds: fracs.size },
  };
}
