// The farmland: a tile system of its own on the ground round a settlement (round 119, the user: "Can we get farms and
// smaller huts for lower population density?"). Plots are Voronoi cells over the ring past the town; each plot is a
// field cut into long parallel strips (ridge and furrow: the look of open-field farming), an orchard, a fenced pasture,
// or a farmstead's yard with its lots. What a plot becomes follows the density there (thinnest: pasture and woods'
// edge; thin: fields and orchards; where it rises toward the town: farmsteads, hamlets along the roads).
// Same output as every tile system — a quad mesh with uses and blocks (a plot's block is its own) — so the massing,
// the module set and the nav serve it unchanged.
import type { CitySpec, DensityFn, GroundFn, TileMesh, V2 } from '../../api/contracts/structures';
import { TileBuilder } from './builder';
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

/** a plot's outline: its fence (or hedge) round it, the lane's inner edge */
export interface PlotFence {
  pts: V2[];
  hedge: boolean;
}

export function farmland(o: FarmOpts): { mesh: TileMesh; fences: PlotFence[] } {
  const fences: PlotFence[] = [];
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
  const B = new TileBuilder();
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
    fences.push({ pts: q, hedge: !farmstead && hashf(i, spec.seed, 46) < 0.35 });
    const ids = q.map((p) => B.vert(p[0], p[1]));
    if (farmstead) {
      // its yard round its lots (Townscaper's cut of the plot: the farmhouse and the barn go on the lots)
      // (cut twice — centre to midpoints, then each quad in four — for tiles a building across, ~4-6 m)
      let cx2 = 0;
      let cy2 = 0;
      for (const p of q) {
        cx2 += p[0] / q.length;
        cy2 += p[1] / q.length;
      }
      const c = B.vert(cx2, cy2);
      for (let a = 0; a < ids.length; a++) {
        const prev = B.mid(ids[(a - 1 + ids.length) % ids.length], ids[a]);
        const next = B.mid(ids[a], ids[(a + 1) % ids.length]);
        B.poly([ids[a], next, c, prev], 'lot', block, true);
      }
      return;
    }
    const k = hashf(i, spec.seed, 32);
    const use = d < 0.04 ? (k < 0.5 ? 'pasture' : 'field') : k < 0.16 ? 'orchard' : k < 0.3 ? 'pasture' : 'field';
    if (use !== 'field') {
      B.poly(ids, use, block, true);
      return;
    }
    // strips: parallel cuts across the plot, a strip 5-7 m wide, running the plot's long way
    let lx = 0;
    let ly = 0;
    let best = 0;
    for (let a = 0; a < q.length; a++)
      for (let b = a + 1; b < q.length; b++) {
        const dd = Math.hypot(q[b][0] - q[a][0], q[b][1] - q[a][1]);
        if (dd > best) {
          best = dd;
          lx = (q[b][0] - q[a][0]) / dd;
          ly = (q[b][1] - q[a][1]) / dd;
        }
      }
    // across: the normal to the long way
    const nx = -ly;
    const ny = lx;
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of q) {
      const t = (p[0] - s[0]) * nx + (p[1] - s[1]) * ny;
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
    }
    const w = 5 + hashf(i, 33) * 2;
    const n = Math.max(1, Math.round((hi - lo) / w));
    for (let k2 = 0; k2 < n; k2++) {
      const t0 = lo + ((hi - lo) * k2) / n;
      const t1 = lo + ((hi - lo) * (k2 + 1)) / n;
      let strip = clipHalf(q, [s[0] + nx * t0, s[1] + ny * t0], [-nx, -ny]);
      strip = clipHalf(strip, [s[0] + nx * t1, s[1] + ny * t1], [nx, ny]);
      if (strip.length < 3) continue;
      // (a strip's crop runs along it: a strip with more corners than four is made a quad by dropping its straightest
      // corners — a fan of quads from its middle would turn its rows into spokes)
      while (strip.length > 4) {
        let bi = 0;
        let bs = Infinity;
        for (let k3 = 0; k3 < strip.length; k3++) {
          const a = strip[(k3 + strip.length - 1) % strip.length];
          const b = strip[k3];
          const c = strip[(k3 + 1) % strip.length];
          const turn = Math.abs((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]));
          if (turn < bs) {
            bs = turn;
            bi = k3;
          }
        }
        strip.splice(bi, 1);
      }
      const tri = strip.length === 3;
      if (tri) strip.splice(1, 0, [(strip[0][0] + strip[1][0]) / 2, (strip[0][1] + strip[1][1]) / 2]);
      // (its first side the long one: the crop's rows run along u)
      if (Math.hypot(strip[1][0] - strip[0][0], strip[1][1] - strip[0][1]) < Math.hypot(strip[2][0] - strip[1][0], strip[2][1] - strip[1][1])) strip.push(strip.shift()!);
      // (a wedge — a strip pinched to a point at the plot's corner — is left to grass: its rows would converge to spikes)
      const e1 = Math.hypot(strip[2][0] - strip[1][0], strip[2][1] - strip[1][1]);
      const e3 = Math.hypot(strip[0][0] - strip[3][0], strip[0][1] - strip[3][1]);
      const wedge = tri || Math.min(e1, e3) < Math.max(e1, e3) * 0.4;
      // (cut along its length every ~6 m: a strip's pieces lie on the ground between their corners, and a hill bulges
      // or dips under a long one — its rows floated as blades over the grass)
      const L = Math.hypot(strip[1][0] - strip[0][0], strip[1][1] - strip[0][1]);
      const segs = Math.max(1, Math.round(L / 6));
      const lerp = (a: V2, b: V2, t: number): V2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      for (let k4 = 0; k4 < segs; k4++) {
        const t0 = k4 / segs;
        const t1 = (k4 + 1) / segs;
        const qd = [lerp(strip[0], strip[1], t0), lerp(strip[0], strip[1], t1), lerp(strip[3], strip[2], t1), lerp(strip[3], strip[2], t0)];
        // (a crop only on gentle ground: a strip piece whose corners differ by more than 1.5 m is left to grass — on a
        // steep or cut slope its rows read as fins standing up, not a field)
        const gs = qd.map((p) => o.ground(p[0], p[1]));
        const steep = Math.max(...gs) - Math.min(...gs) > 1.5;
        B.quad(...(qd.map((p) => B.vert(p[0], p[1])) as [number, number, number, number]), wedge || steep ? 'pasture' : 'field', block);
      }
    }
  });
  return { mesh: B.build(0.5), fences };
}

/** Two tile meshes as one (the town's and its farmland's): vertices and quads concatenated, the second's re-indexed. */
export function mergeTiles(a: TileMesh, b: TileMesh): TileMesh {
  const nv = a.verts.length / 2;
  const verts = new Float64Array(a.verts.length + b.verts.length);
  verts.set(a.verts, 0);
  verts.set(b.verts, a.verts.length);
  const quads = new Uint32Array(a.quads.length + b.quads.length);
  quads.set(a.quads, 0);
  for (let i = 0; i < b.quads.length; i++) quads[a.quads.length + i] = b.quads[i] + nv;
  const block = new Int32Array(a.block.length + b.block.length);
  block.set(a.block, 0);
  block.set(b.block, a.block.length);
  return { verts, quads, use: [...a.use, ...b.use], block };
}
