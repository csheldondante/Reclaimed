// The farmland: plots on the ground round a settlement (round 119, the user: "Can we get farms and smaller huts for
// lower population density?"). Plots are Voronoi cells over the ring past the town; each plot is a field, an orchard,
// a fenced pasture, or a farmstead's yard with its lots. What a plot becomes follows the density there (thinnest:
// pasture and woods' edge; thin: fields and orchards; where it rises toward the town: farmsteads, hamlets along the
// roads).
// (round 128m, onetown) The plots are outlines over the town's one grid (the tile system tiles on past the town:
// systems.ts `extent`): the tiles whose middles fall in a plot are its cells, and a plot is a structure of the plan (a
// farm, an orchard, a pasture) or a farmstead's lots — no tile system of its own (the user accepted the plots' edges
// following the tiles).
import type { CitySpec, DensityFn, GroundFn, V2 } from '../../api/contracts/structures';
import { clipHalf, inset } from './systems';
import { hashf, rng } from '../rng';

export interface FarmOpts {
  spec: CitySpec;
  ground: GroundFn;
  density: DensityFn;
  /** the ring: from the town's edge out to the farmland's */
  rIn: number;
  rOut: number;
  /** points the roads pass (farmsteads gather by them: hamlets along the roads) */
  roads: V2[];
  /** block ids start here (the town's are below) */
  block0: number;
}

/** a plot's lane round it (m) */
const LANE = 1.2;

/** a plot: its outline (inside its lane), what it is, its block id */
export interface FarmPlot {
  poly: V2[];
  use: 'farmstead' | 'field' | 'orchard' | 'pasture';
  /** hedged round, not fenced */
  hedge: boolean;
  block: number;
}

export function farmPlots(o: FarmOpts): FarmPlot[] {
  const out: FarmPlot[] = [];
  const { spec, rIn, rOut } = o;
  const r = rng(spec.seed * 53 + 29);
  const [cx, cy] = spec.at;
  const plot = 26;
  // plot seeds: a jittered lattice over the ring
  const seeds: V2[] = [];
  const h = plot * 0.87;
  for (let y = cy - rOut; y <= cy + rOut; y += h)
    for (let x = cx - rOut + ((Math.round((y - cy) / h) & 1) * plot) / 2; x <= cx + rOut; x += plot) {
      const p: V2 = [x + (r() - 0.5) * plot * 0.6, y + (r() - 0.5) * plot * 0.6];
      const d = Math.hypot(p[0] - cx, p[1] - cy);
      if (d < rIn + plot * 0.35 || d > rOut) continue;
      seeds.push(p);
    }
  const rim: V2[] = [];
  for (let k = 0; k < 40; k++) rim.push([cx + Math.cos((k / 40) * Math.PI * 2) * rOut, cy + Math.sin((k / 40) * Math.PI * 2) * rOut]);
  const nearRoad = (p: V2) => o.roads.reduce((m, q) => Math.min(m, Math.hypot(q[0] - p[0], q[1] - p[1])), Infinity);
  seeds.forEach((s, i) => {
    let poly: V2[] = rim;
    for (let j = 0; j < seeds.length && poly.length >= 3; j++) {
      if (j === i) continue;
      const t = seeds[j];
      const dx = t[0] - s[0];
      const dy = t[1] - s[1];
      if (Math.abs(dx) > plot * 3 || Math.abs(dy) > plot * 3) continue;
      poly = clipHalf(poly, [(s[0] + t[0]) / 2, (s[1] + t[1]) / 2], [dx, dy]);
    }
    // (off the town: the plot's part nearer the middle than the town's edge is cut away along the seed's radial line)
    const d0 = Math.hypot(s[0] - cx, s[1] - cy);
    const ux = (s[0] - cx) / d0;
    const uy = (s[1] - cy) / d0;
    poly = clipHalf(poly, [cx + ux * rIn, cy + uy * rIn], [-ux, -uy]);
    if (poly.length < 3) return;
    const q = inset(poly, LANE);
    if (q.length < 3) return;
    const block = o.block0 + i;
    const d = o.density(s[0], s[1]);
    const roadD = nearRoad(s);
    // what the plot becomes: a farmstead where people are fewer than a town's but more than none (nearer a road, more
    // likely: hamlets string along the roads); else fields, orchards, pastures by density and chance
    const hRand = hashf(i, spec.seed, 31);
    const farmstead = d > 0.08 && hRand < 0.18 + Math.min(0.5, d * 0.9) + (roadD < 20 ? 0.25 : 0);
    // (every plot fenced round, or hedged; a farmstead's yard fenced)
    const hedge = !farmstead && hashf(i, spec.seed, 46) < 0.35;
    if (farmstead) return void out.push({ poly: q, use: 'farmstead', hedge, block });
    const k = hashf(i, spec.seed, 32);
    const use = d < 0.04 ? (k < 0.5 ? 'pasture' : 'field') : k < 0.16 ? 'orchard' : k < 0.3 ? 'pasture' : 'field';
    out.push({ poly: q, use, hedge, block });
  });
  return out;
}
