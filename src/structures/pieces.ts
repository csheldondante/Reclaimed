// Plan → pieces: every module the city shows, each warped into its frame (contracts/structures.ts StructurePieces).
// The rules are Townscaper's in spirit — what stands is worked out from the neighbours: a wall where a storey has no
// neighbour covering it (its kind from the plan's façades), a post where two walls meet outside, a roof on every top
// from the roof's own height rule (modules.ts roofHeight: ridges, hips and valleys meet across tiles by themselves),
// gables where a ridge ends, a plinth down to the ground on a slope, paving on the streets.
import type { BuildingKind, CityPlan, FacadeKind, StructurePieces, V2 } from '../api/contracts/structures';
import { adjacency, quadCorners } from './tiles/builder';
import { library, roofName } from './modules';
import { styleOf, STYLE_IDS, type Style } from './styles';
import { hashf } from './rng';
import { WALL_H } from './plan';
import { resample, segFrame, WALL_WALK } from './linear';

/** floats a piece */
export const PIECE_FLOATS = 16;
/** flags: the top is a height over the foot (paving that follows the ground) */
export const REL = 1;
/** a wall's thickness (m) */
export const WALL_T = 0.35;
/** the roof's lift over the walls' tops (m) */
export const ROOF_LIFT = 0.2;

class Out {
  module: number[] = [];
  data: number[] = [];
  building: number[] = [];
  /** the building the next pieces belong to */
  owner = -1;
  add(mod: number, f: [V2, V2, V2, V2], foot: number | [number, number, number, number], top: number, look: number, seed: number, flags = 0): void {
    this.module.push(mod);
    this.building.push(this.owner);
    const z = typeof foot === 'number' ? [foot, foot, foot, foot] : foot;
    this.data.push(f[0][0], f[0][1], f[1][0], f[1][1], f[2][0], f[2][1], f[3][0], f[3][1], z[0], z[1], z[2], z[3], top, look, seed, flags);
  }
  done(): StructurePieces {
    return { module: Uint16Array.from(this.module), data: Float32Array.from(this.data), building: Int32Array.from(this.building), count: this.module.length };
  }
}

/** a wall's frame on side a→b: along it, then in by the thickness (counter-clockwise, as the quad) */
function wallFrame(a: V2, b: V2, t: number): [V2, V2, V2, V2] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L = Math.hypot(dx, dy) || 1;
  const nx = (-dy / L) * t;
  const ny = (dx / L) * t;
  return [a, b, [b[0] + nx, b[1] + ny], [a[0] + nx, a[1] + ny]];
}

/** the wall module a façade shows on a building of this kind (a hut's and a barn's sets are smaller: no shops, no balconies) */
export function wallModule(kind: BuildingKind, level: number, f: FacadeKind, style: Style): string {
  if (kind === 'house') return `${level === 0 ? style.walls0 : style.walls}:${f}`;
  const set = kind === 'barn' ? 'barn' : 'hut';
  const k = f === 'door' || f === 'shop' ? 'door' : f === 'blank' ? 'blank' : 'window';
  return `${set}:${k}`;
}

/**
 * A wall's frame on side s of a tile, mitred: its inner corners slide along the tile's neighbouring sides (not straight
 * in), so two walls round a corner meet on the corner's line and two in a row meet on the side between them. (Square
 * ends stuck out past the next wall's face at an obtuse corner, up through its eave.)
 */
function sideFrame(p: [V2, V2, V2, V2], s: number, t: number): [V2, V2, V2, V2] {
  const a = p[s];
  const b = p[(s + 1) % 4];
  const e = unit(a, b);
  const slide = (from: V2, to: V2, along: V2): V2 => {
    const d = unit(from, to);
    // distance along d that puts the point t in from side s: t / sin(angle between d and the side)
    const sin = Math.abs(along[0] * d[1] - along[1] * d[0]);
    const k = t / Math.max(sin, 0.35);
    return [from[0] + d[0] * k, from[1] + d[1] * k];
  };
  return [a, b, slide(b, p[(s + 2) % 4], e), slide(a, p[(s + 3) % 4], e)];
}

/** a small square frame in the corner at p, along unit directions e1 then e2 (counter-clockwise) */
function cornerFrame(p: V2, e1: V2, e2: V2, s: number): [V2, V2, V2, V2] {
  return [p, [p[0] + e1[0] * s, p[1] + e1[1] * s], [p[0] + (e1[0] + e2[0]) * s, p[1] + (e1[1] + e2[1]) * s], [p[0] + e2[0] * s, p[1] + e2[1] * s]];
}

function shrink(f: [V2, V2, V2, V2], k: number): [V2, V2, V2, V2] {
  const cx = (f[0][0] + f[1][0] + f[2][0] + f[3][0]) / 4;
  const cy = (f[0][1] + f[1][1] + f[2][1] + f[3][1]) / 4;
  return f.map((p) => [cx + (p[0] - cx) * k, cy + (p[1] - cy) * k]) as [V2, V2, V2, V2];
}

const unit = (a: V2, b: V2): V2 => {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
};

export function piecesOf(plan: CityPlan): StructurePieces {
  const lib = library();
  const style = styleOf(plan.spec.style);
  const styleIx = STYLE_IDS.indexOf(style.id);
  const t = plan.tiles;
  const adj = adjacency(t);
  const nq = t.use.length;
  const gz = plan.ground;
  const out = new Out();
  const seed = plan.spec.seed;
  const look = (b: number) => styleIx * 65536 + (b >= 0 ? plan.buildings[b].look : Math.floor(hashf(seed, 77) * 65536));
  const footOf = (q: number, d: number): [number, number, number, number] => [0, 1, 2, 3].map((k) => gz[t.quads[q * 4 + k]] - d) as [number, number, number, number];
  // quads round each vertex (the roofs' corner rule)
  const around: number[][] = Array.from({ length: gz.length }, () => []);
  for (let q = 0; q < nq; q++) for (let k = 0; k < 4; k++) around[t.quads[q * 4 + k]].push(q);

  // ---- the façades' walls, and the posts where two meet outside
  const wallsAt = new Set<string>();
  for (const f of plan.facades) wallsAt.add(`${f.quad},${f.side},${f.level}`);
  for (const f of plan.facades) {
    const b = plan.buildings[f.building];
    out.owner = b.id;
    const p = quadCorners(t, f.quad);
    const a = p[f.side];
    const c = p[(f.side + 1) % 4];
    out.add(lib.id(wallModule(b.kind, f.level, f.kind, style)), sideFrame(p, f.side, WALL_T), f.z0, f.z1, look(b.id), hashf(f.quad, f.side, f.level));
    // a post at the wall's start where the side before also has a wall here (a convex corner)
    const prev = (f.side + 3) % 4;
    if (wallsAt.has(`${f.quad},${prev},${f.level}`)) {
      const e1 = unit(a, c);
      const e2 = unit(a, p[prev]);
      if (style.corners === 'post' || b.kind !== 'house') out.add(lib.id('post:1'), cornerFrame(a, e1, e2, 0.3), f.z0, f.z1, look(b.id), 0);
      else out.add(lib.id('quoins'), cornerFrame(a, e1, e2, 0.42), f.z0, f.z1, look(b.id), 0);
    }
  }

  // ---- per built tile: its plinth, its roof (or a landmark's tower), a chimney now and then
  for (const b of plan.buildings) {
    if (plan.quadBuilding[b.quads[0]] !== b.id) continue;
    out.owner = b.id;
    const rise = plan.roofRise[b.id];
    for (const q of b.quads) {
      const p = quadCorners(t, q);
      const top = plan.quadTop[q];
      let lo = Infinity;
      for (let k = 0; k < 4; k++) lo = Math.min(lo, gz[t.quads[q * 4 + k]]);
      if (b.mega === 'dome') continue;
      if (b.mega === 'tower') {
        out.add(lib.id('tower'), p, lo - 0.6, top, look(b.id), hashf(q, 5));
        out.add(lib.id('spire'), p, top, top + rise * 2.6, look(b.id), hashf(q, 6));
        continue;
      }
      if (b.base > lo + 0.05) out.add(lib.id('plinth'), p, footOf(q, 0.6), b.base, look(b.id), 0);
      // (a site — going up in a grown plan — has no roof yet)
      if (plan.sites?.has(b.id)) continue;
      // the roof: which sides and corners end it
      const joined = (n: number) => {
        if (n < 0) return false;
        const nb = plan.quadBuilding[n];
        if (nb < 0) return false;
        if (nb === b.id) return plan.quadTop[n] >= top - 0.01;
        // (another building: a taller one is a wall to lean the roof on; one as tall keeps its own eaves)
        return plan.quadTop[n] > top + 0.5;
      };
      let sides = 0;
      for (let s = 0; s < 4; s++) if (!joined(adj[q * 4 + s])) sides |= 1 << s;
      let corners = 0;
      for (let c = 0; c < 4; c++) {
        const v = t.quads[q * 4 + c];
        if (around[v].some((o) => o !== q && !joined(o))) corners |= 1 << c;
      }
      let verge = 0;
      // (gables: the style's for a house; a hut's thatch is hipped all round; a farmhouse and a barn gabled)
      if (b.kind === 'house' ? style.gables : b.kind !== 'hut') {
        // a ridge's end: a free side whose opposite is joined and whose neighbours are free; a lone tile gables its
        // short sides (the ridge along the long way)
        if (sides === 15) {
          const l02 = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]) + Math.hypot(p[3][0] - p[2][0], p[3][1] - p[2][1]);
          const l13 = Math.hypot(p[2][0] - p[1][0], p[2][1] - p[1][1]) + Math.hypot(p[0][0] - p[3][0], p[0][1] - p[3][1]);
          verge = l02 > l13 ? 2 | 8 : 1 | 4;
        } else
          for (let s = 0; s < 4; s++) {
            const free = (k: number) => (sides >> ((s + k) % 4)) & 1;
            if (free(0) && !free(2) && free(1) && free(3)) verge |= 1 << s;
          }
        for (let s = 0; s < 4; s++)
          if (verge & (1 << s)) out.add(lib.id(`gable:t:${hashf(q, s, 3) < 0.6 ? 'w' : ''}`), sideFrame(p, s, WALL_T), top, top + ROOF_LIFT + rise, look(b.id), hashf(q, s, 4));
        sides &= ~verge;
      }
      // overhangs only over what's lower (or nothing): never into a neighbour's wall as tall
      let eaves = 0;
      for (let s = 0; s < 4; s++) {
        const n = adj[q * 4 + s];
        const nt = n >= 0 && plan.quadBuilding[n] >= 0 ? plan.quadTop[n] : -Infinity;
        if (nt < top - 0.3) eaves |= 1 << s;
      }
      let clip = 0;
      for (let c = 0; c < 4; c++) {
        const v = t.quads[q * 4 + c];
        const side = new Set([adj[q * 4 + c], adj[q * 4 + ((c + 3) % 4)]]);
        if (around[v].some((o) => o !== q && !side.has(o) && plan.quadBuilding[o] >= 0 && plan.quadTop[o] >= top - 0.3)) clip |= 1 << c;
      }
      // (the roof sits a hair above the walls' tops: a warped tile's roof is flat between its warped corners, not exactly
      // the bilinear surface, so on a skewed tile a wall's top could peek through by a few centimetres; the eave's
      // thickness hides the lift)
      // (thatch on huts and farmhouses; a barn's thatch or the style's tiles, building by building)
      const roofLook = b.kind === 'house' ? style.roof : b.kind === 'barn' && hashf(b.id, seed, 41) < 0.5 ? style.roof : 'thatch';
      out.add(lib.id(roofName(sides, corners, verge & eaves, eaves, clip, roofLook)), p, top + ROOF_LIFT, top + ROOF_LIFT + rise, look(b.id), hashf(q, 8));
      // a chimney on a ridge (tiles whose roof rises to a ridge, not flat tops)
      const chimneys = b.kind === 'house' ? style.chimneys : b.kind === 'barn' ? 0 : 0.4;
      if (sides && hashf(q, seed, 9) < chimneys) {
        const f = shrink(p, 0.16);
        const o = hashf(q, 10) < 0.5 ? 0.18 : -0.18;
        const g: [V2, V2, V2, V2] = f.map(([x, y]) => [x + (p[1][0] - p[0][0]) * o, y + (p[1][1] - p[0][1]) * o]) as [V2, V2, V2, V2];
        out.add(lib.id('chimney'), g, top, top + rise * 0.5 + 1.3, look(b.id), 0);
      }
    }
  }

  // ---- streets, plazas, ramparts and gates, lamps
  out.owner = -1;
  for (let q = 0; q < nq; q++) {
    const u = t.use[q];
    const p = quadCorners(t, q);
    // (owners: −1 the ramparts — one External instance —, −1000 what claims no columns: paving, lamps, the fountain)
    out.owner = u === 'wall' || u === 'gate' ? -1 : -1000;
    if (u === 'field' || u === 'orchard' || u === 'pasture') {
      // the farmland: a strip's crop (its plot's colour: green, ripening, ripe), an orchard's trees, a pasture's grass
      // (the ground's own); fences or hedges round each plot, on the sides with another plot or none beside
      out.owner = -1000;
      const plotLook = styleIx * 65536 + (hashf(t.block[q], seed, 43) * 4096) | 0;
      if (u === 'field') out.add(lib.id('crop'), p, footOf(q, 0.12), 0.42, plotLook, hashf(q, 44), REL);
      else if (u === 'orchard') {
        const c: V2 = [(p[0][0] + p[1][0] + p[2][0] + p[3][0]) / 4, (p[0][1] + p[1][1] + p[2][1] + p[3][1]) / 4];
        const s = 2.2;
        const z = gz[t.quads[q * 4]] - 0.1;
        out.add(lib.id('fruittree'), [[c[0] - s, c[1] - s], [c[0] + s, c[1] - s], [c[0] + s, c[1] + s], [c[0] - s, c[1] + s]], z, z + 4.2, plotLook, hashf(q, 45));
      }
      const hedged = hashf(t.block[q], seed, 46) < 0.35;
      for (let s = 0; s < 4; s++) {
        const n = adj[q * 4 + s];
        if (n >= 0 && t.block[n] === t.block[q]) continue;
        const a = p[s];
        const b2 = p[(s + 1) % 4];
        const za = gz[t.quads[q * 4 + s]];
        const zb = gz[t.quads[q * 4 + ((s + 1) % 4)]];
        out.add(lib.id(hedged ? 'hedge' : 'fence'), wallFrame(a, b2, hedged ? 0.7 : 0.18), [za - 0.1, zb - 0.1, zb - 0.1, za - 0.1], hedged ? 1.3 : 1.15, plotLook, 0, REL);
      }
      continue;
    }
    if (u === 'street' || u === 'plaza') {
      out.add(lib.id('pave'), p, footOf(q, 0.25), 0.37, look(-1), hashf(q, 11), REL);
      if (u === 'street' && hashf(q, seed, 12) < 0.05) {
        const c: V2 = [(p[0][0] + p[2][0]) / 2, (p[0][1] + p[2][1]) / 2];
        const s = 0.22;
        const z = gz[t.quads[q * 4]] + 0.1;
        out.add(lib.id('lamp'), [[c[0] - s, c[1] - s], [c[0] + s, c[1] - s], [c[0] + s, c[1] + s], [c[0] - s, c[1] + s]], z, z + 3.2, look(-1), hashf(q, 13));
      }
    } else if (u === 'wall' || u === 'gate') {
      const top = plan.quadTop[q];
      if (u === 'wall') out.add(lib.id('rampart'), p, footOf(q, 0.6), top, look(-1), 0);
      else {
        // the gate: arches on the sides the passage runs through, a lintel over it
        let lo = Infinity;
        for (let k = 0; k < 4; k++) lo = Math.min(lo, gz[t.quads[q * 4 + k]]);
        for (let s = 0; s < 4; s++) {
          const n = adj[q * 4 + s];
          if (n >= 0 && (t.use[n] === 'wall' || t.use[n] === 'gate')) continue;
          out.add(lib.id('gatearch'), wallFrame(p[s], p[(s + 1) % 4], 0.9), lo - 0.3, top, look(-1), 0);
        }
        out.add(lib.id('rampart'), p, top - WALL_H * 0.28, top, look(-1), 0);
      }
      for (let s = 0; s < 4; s++) {
        const n = adj[q * 4 + s];
        if (n >= 0 && (t.use[n] === 'wall' || t.use[n] === 'gate')) continue;
        out.add(lib.id('merlons'), wallFrame(p[s], p[(s + 1) % 4], 0.45), top, top + 1.1, look(-1), 0);
      }
    }
  }
  out.owner = -1000;
  for (const m of plan.megas) {
    if (m.kind === 'fountain') out.add(lib.id('fountain'), m.frame, m.z0, m.z1, look(-1), 0);
    const half = Math.hypot(m.frame[2][0] - m.frame[0][0], m.frame[2][1] - m.frame[0][1]) / (2 * Math.SQRT2);
    let lo = m.z0;
    for (const q of m.quads) for (let k = 0; k < 4; k++) lo = Math.min(lo, gz[t.quads[q * 4 + k]]);
    if (m.kind === 'dome') {
      // a domed temple: a drum of tall windows, the dome on it, a lantern on its crown
      out.owner = plan.quadBuilding[m.quads[0]];
      const L = look(out.owner);
      const f = shrink(m.frame, 0.9);
      const r = half * 0.9;
      out.add(lib.id('drum'), f, lo - 0.6, m.z1, L, 0);
      out.add(lib.id('dome'), shrink(m.frame, 0.86), m.z1, m.z1 + r * 0.95, L, 0);
      out.add(lib.id('lantern'), shrink(m.frame, 0.2), m.z1 + r * 0.9, m.z1 + r * 0.9 + half * 0.55, L, 0);
    } else if (m.kind === 'keep') {
      out.owner = -1;
      out.add(lib.id('drum'), m.frame, lo - 0.6, m.z1, look(-1), 0);
      out.add(lib.id('spire'), shrink(m.frame, 0.92), m.z1, m.z1 + half * 2.2, look(-1), 0);
    }
  }
  out.owner = -1000;

  // ---- linear features: a module a segment along the spline (contracts LinearFeature; linear.ts)
  plan.linear.forEach((f, fk) => {
    const L = look(-1);
    // (a wall run or a bridge is its own External instance, −2 − its index: cut, only it goes)
    out.owner = f.kind === 'wall' || f.kind === 'bridge' ? -2 - fk : -1000;
    if (f.kind === 'road' || f.kind === 'rail') {
      const S = resample(f, 3);
      for (let i = 0; i + 1 < S.length; i++) {
        const a = S[i];
        const b = S[i + 1];
        const fr = segFrame(a, b, f.width);
        // (its foot 0.3 m under the surface at each end: the paving follows the road's own grade)
        out.add(lib.id(f.kind), fr, [a.p[2] - 0.3, b.p[2] - 0.3, b.p[2] - 0.3, a.p[2] - 0.3], f.kind === 'road' ? 0.45 : 0.6, L, hashf(i, 21), REL);
      }
    } else if (f.kind === 'bridge') {
      // spans about as long as the bridge is high (Roman proportions), at least 5 m
      const S0 = resample(f, 2);
      let hMean = 0;
      for (const s of S0) hMean += s.p[2] - s.g;
      hMean /= Math.max(1, S0.length);
      const S = resample(f, Math.max(5, Math.min(12, hMean * 1.1)));
      for (let i = 0; i + 1 < S.length; i++) {
        const a = S[i];
        const b = S[i + 1];
        const fr = segFrame(a, b, f.width);
        const da = a.p[2] - 0.3;
        const db = b.p[2] - 0.3;
        out.add(lib.id('deck'), fr, [da, db, db, da], 1.2, L, hashf(i, 22), REL);
        const top = Math.min(da, db);
        if (top - Math.max(a.g, b.g) > 1.2) out.add(lib.id('archspan'), fr, [a.g - 0.5, b.g - 0.5, b.g - 0.5, a.g - 0.5], top, L, hashf(i, 23));
      }
    } else if (f.kind === 'wall') {
      const S = resample(f, 4);
      for (let i = 0; i + 1 < S.length; i++) {
        const a = S[i];
        const b = S[i + 1];
        const fr = segFrame(a, b, f.width);
        // (the walk follows the ground WALL_WALK over it: the body's top a height over its foot, the parapets on it)
        out.add(lib.id('wallseg'), fr, [a.g - 0.6, b.g - 0.6, b.g - 0.6, a.g - 0.6], WALL_WALK + 0.6, L, hashf(i, 24), REL);
        out.add(lib.id('wallwalk'), fr, [a.p[2], b.p[2], b.p[2], a.p[2]], 1.3, L, hashf(i, 25), REL);
      }
      // towers along it every ~28 m and at its open ends (the gates' flanks)
      const T = resample(f, 28);
      const ends = f.closed ? T : [...T, S[S.length - 1]];
      for (const s of ends) {
        const h = f.width * 0.95;
        const fr: [V2, V2, V2, V2] = [[s.p[0] - h, s.p[1] - h], [s.p[0] + h, s.p[1] - h], [s.p[0] + h, s.p[1] + h], [s.p[0] - h, s.p[1] + h]];
        out.add(lib.id('tower'), fr, s.g - 0.6, s.p[2] + 3.5, L, hashf(Math.round(s.p[0]), 26));
        out.add(lib.id('spire'), shrink(fr, 0.95), s.p[2] + 3.5, s.p[2] + 3.5 + h * 2.4, L, hashf(Math.round(s.p[1]), 27));
      }
    }
  });
  return out.done();
}
