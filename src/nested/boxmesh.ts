// Nested scales lab, round 11: the reference box mesher and the smooth draw's step 1 (docs/design/NESTED_SCALES.md "The
// smooth draw (agreed 2026-11-19)"). Plain TypeScript, tests only for now; the GPU bake (nest.wgsl faceBake / emitCol) is
// the runtime path and this file follows its rule:
// - a level draws a column when it lies in the level's window and not under its live child's footprint; every other
//   column is air to it (so a level walls its own window edge and its child's footprint and is closed by itself);
// - caps where a solid record meets air above it (or air meets solid), a down cap at the column's own bottom
//   zb = floor((min(own first top, each neighbour's depth as seen from it) - 1) / 32) * 32 (nest.wgsl zbOf; across a rim
//   the neighbour's depth comes from the level that draws there: depthElsewhere);
// - walls: for each side, each solid record's range less the neighbour's solid ranges, as strips between the two corner
//   lines, each corner line split at every record top and bottom of its four columns (nextBp).
// Differences from the GPU, none of them topological: the down cap is two triangles a column (the GPU's fans of round 9,
// NS-83, have the same rim edges); triangles are oriented (solid inside, counter-clockwise seen from the air) so the
// tests can check the oriented closure and volumes.
//
// The smooth draw's principle: the smooth mesh is this mesh with its vertices moved. A vertex is an IDENTITY, not a
// position: (level, corner line, bound), the bound being the exact height value on that corner line (every face that
// touches the line at that height uses that vertex: the corner line's split rule above makes that so). A placement maps
// each identity to a 3D point; identities of one corner line that a placement puts at the same point become one vertex
// (a simplicial map), and the triangles left with a repeated vertex are dropped. A simplicial map carries a closed
// surface (every edge used an even number of times; oriented: every directed edge cancelled) to a closed surface, so the
// smooth mesh is closed by construction whatever the placement.
import { AIR, type Part } from './oracle';

export type Vec3 = [number, number, number];

/** one level as the draw sees it: its window (global columns of its depth), its z origin and its columns */
export interface MeshLevel {
  depth: number;
  gx: number;
  gy: number;
  n: number;
  /** z origin in the parent's local units (0 for the root): child z = (parent z - zo) * k */
  zo: number;
  /** the stored partitions, row by row (index (y - gy) * n + (x - gx)) */
  parts: Part[];
}
export interface MeshScene {
  k: number;
  /** levels[d + 1] is the live child of levels[d]; its window lies inside the parent's */
  levels: MeshLevel[];
  /** whether a material is drawn solid (store.wgsl matSolid: everything but air; fluids are materials) */
  solid?: (m: number) => boolean;
}

/** a vertex identity: level, corner line (global columns of the level's depth: the line at the low corner of column
 *  (cx, cy)), bound (the exact height on that line, the level's local units) */
export interface VertexId {
  L: number;
  cx: number;
  cy: number;
  z: number;
}
export const idKey = (v: VertexId) => `${v.L}:${v.cx}:${v.cy}:${v.z}`;

/** a box face kind: 0 +x, 1 -x, 2 +y, 3 -y wall, 4 up cap, 5 down cap (draw.wgsl NRM) */
export interface Tri {
  v: [number, number, number];
  kind: number;
  mat: number;
  /** the column that emitted it (global, its level) */
  L: number;
  X: number;
  Y: number;
  /** (round 13) the column's down cap (its bottom at zb) */
  down?: boolean;
  /** (round 13) a wall's piece: its height range in the emitting column's own units */
  p0?: number;
  p1?: number;
}
export interface BoxMesh {
  ids: VertexId[];
  tris: Tri[];
  /** drawn columns per level */
  drawn: number[];
  /** (round 12, the GPU's collapse) the cluster of a vertex identity from the columns round its corner line alone (no
   *  mesh): its lowest and highest breakpoint and its placed height (f32, summed bottom up); see clusterOf below */
  cluster: (id: VertexId, T: number) => { bot: number; top: number; z: number };
  /** (round 12) whether column (X, Y) of level L lies in a 4 x 4 block whose down caps the GPU bakes as one fan (NS-83):
   *  its down cap takes no part in dropping coincident cap pairs */
  fan: (L: number, X: number, Y: number) => boolean;
  /** (round 13) the column as level L draws it (null where it is air to the level), its bottom, and whether a corner
   *  line is a rim line (a parent's rimP or a child's rimC) */
  col: (L: number, X: number, Y: number) => Part | null;
  zb: (L: number, X: number, Y: number) => number;
  rim: (L: number, CX: number, CY: number) => boolean;
}

const NO_DEPTH = 3e38;
const ZB_STEP = 32;

/** a point of level L (its columns and units) in world units (the root's) */
export function toWorld(scene: MeshScene, L: number, x: number, y: number, z: number): Vec3 {
  let zz = z;
  for (let j = L; j > 0; j--) zz = scene.levels[j].zo + zz / scene.k;
  const s = Math.pow(scene.k, L);
  return [x / s, y / s, zz];
}

/** the box mesh of every level (each closed by itself) */
export function boxMesh(scene: MeshScene): BoxMesh {
  const { k, levels } = scene;
  const solid = scene.solid ?? ((m: number) => m !== AIR);
  const ids: VertexId[] = [];
  const idx = new Map<string, number>();
  const vid = (v: VertexId) => {
    const key = idKey(v);
    let i = idx.get(key);
    if (i === undefined) {
      i = ids.length;
      ids.push(v);
      idx.set(key, i);
    }
    return i;
  };
  const tris: Tri[] = [];
  const drawn: number[] = [];
  const inWin = (L: number, X: number, Y: number) => {
    const w = levels[L];
    return X >= w.gx && Y >= w.gy && X < w.gx + w.n && Y < w.gy + w.n;
  };
  const partAt = (L: number, X: number, Y: number): Part | undefined => (inWin(L, X, Y) ? levels[L].parts[(Y - levels[L].gy) * levels[L].n + (X - levels[L].gx)] : undefined);
  const colOn = (L: number, X: number, Y: number) => {
    if (!inWin(L, X, Y)) return false;
    const c = levels[L + 1];
    if (c && X * k >= c.gx && Y * k >= c.gy && X * k < c.gx + c.n && Y * k < c.gy + c.n) return false;
    return true;
  };
  const rec0 = (L: number, X: number, Y: number) => {
    const p = partAt(L, X, Y);
    return p && p.top.length ? p.top[0] : NO_DEPTH;
  };
  const fdiv = (a: number, b: number) => Math.floor(a / b);
  // (nest.wgsl depthElsewhere)
  const depthElsewhere = (L: number, X: number, Y: number, NX: number, NY: number) => {
    if (!inWin(L, NX, NY)) {
      if (L === 0) return NO_DEPTH;
      const t = rec0(L - 1, fdiv(NX, k), fdiv(NY, k));
      if (t >= NO_DEPTH) return NO_DEPTH;
      return Math.fround((t - levels[L].zo) * k);
    }
    let cx = NX * k;
    let cy = NY * k;
    let dx = 0;
    let dy = 0;
    if (X > NX) {
      cx = NX * k + k - 1;
      dy = 1;
    } else if (X < NX) dy = 1;
    else if (Y > NY) {
      cy = NY * k + k - 1;
      dx = 1;
    } else dx = 1;
    let m = NO_DEPTH;
    for (let i = 0; i < k; i++) m = Math.min(m, rec0(L + 1, cx + i * dx, cy + i * dy));
    if (m >= NO_DEPTH) return NO_DEPTH;
    return Math.fround(levels[L + 1].zo + m / k);
  };
  const nbDepth = (L: number, X: number, Y: number, NX: number, NY: number) => (colOn(L, NX, NY) ? rec0(L, NX, NY) : depthElsewhere(L, X, Y, NX, NY));
  // (round 11, nest.wgsl rimP / rimC / toKid / nextBpRim) rim lines: a parent corner line on its live child's footprint
  // boundary; its vertices belong to the child (child corner line, child units) for both levels' faces
  const rimP = (L: number, CX: number, CY: number) => {
    const c = levels[L + 1];
    if (!c) return false;
    const x = CX * k;
    const y = CY * k;
    if (x < c.gx || y < c.gy || x > c.gx + c.n || y > c.gy + c.n) return false;
    return x === c.gx || y === c.gy || x === c.gx + c.n || y === c.gy + c.n;
  };
  const rimC = (L: number, cx: number, cy: number) => {
    if (L === 0) return false;
    const w = levels[L];
    if (cx < w.gx || cy < w.gy || cx > w.gx + w.n || cy > w.gy + w.n) return false;
    if (cx - fdiv(cx, k) * k !== 0 || cy - fdiv(cy, k) * k !== 0) return false;
    return cx === w.gx || cy === w.gy || cx === w.gx + w.n || cy === w.gy + w.n;
  };
  const toKid = (L: number, z: number) => Math.fround((z - levels[L + 1].zo) * k);
  const zbCache = new Map<string, number>();
  const zb = (L: number, X: number, Y: number) => {
    const key = `${L}:${X}:${Y}`;
    let z = zbCache.get(key);
    if (z === undefined) {
      const m = Math.min(rec0(L, X, Y), nbDepth(L, X, Y, X + 1, Y), nbDepth(L, X, Y, X - 1, Y), nbDepth(L, X, Y, X, Y + 1), nbDepth(L, X, Y, X, Y - 1));
      z = Math.floor((m - 1) / ZB_STEP) * ZB_STEP;
      zbCache.set(key, z);
    }
    return z;
  };
  /** a drawn column's partition (none where it is air to the level) */
  const drawnPart = (L: number, X: number, Y: number): Part | null => {
    if (!colOn(L, X, Y)) return null;
    const p = partAt(L, X, Y)!;
    return p.top.length ? p : null;
  };
  // (nest.wgsl nextBp) the lowest breakpoint above z on corner line (CX, CY): a record top or a bottom of its 4 columns
  const nextBp = (L: number, CX: number, CY: number, z: number) => {
    let best = NO_DEPTH;
    for (let q = 0; q < 4; q++) {
      const X = CX - 1 + (q & 1);
      const Y = CY - 1 + (q >> 1);
      const p = drawnPart(L, X, Y);
      if (!p) continue;
      const b = zb(L, X, Y);
      if (b > z) best = Math.min(best, b);
      for (const t of p.top)
        if (t > z) {
          best = Math.min(best, t);
          break;
        }
    }
    return best;
  };
  const nextBpRim = (Lk: number, cx: number, cy: number, zc: number) => {
    let best = NO_DEPTH;
    for (let s = 0; s < 2; s++) {
      const lv = Lk - s;
      const lx = s ? fdiv(cx, k) : cx;
      const ly = s ? fdiv(cy, k) : cy;
      for (let q = 0; q < 4; q++) {
        const X = lx - 1 + (q & 1);
        const Y = ly - 1 + (q >> 1);
        const p = drawnPart(lv, X, Y);
        if (!p) continue;
        const b = s ? toKid(lv, zb(lv, X, Y)) : zb(lv, X, Y);
        if (b > zc) best = Math.min(best, b);
        for (const t0 of p.top) {
          const t = s ? toKid(lv, t0) : t0;
          if (t > zc) {
            best = Math.min(best, t);
            break;
          }
        }
      }
    }
    return best;
  };
  /** a wall side: 0 ordinary, 1 a parent's rim line (child units), 2 a child's rim line */
  const rimMode = (L: number, CX: number, CY: number) => (rimP(L, CX, CY) ? 1 : rimC(L, CX, CY) ? 2 : 0);
  const sideNext = (L: number, m: number, CX: number, CY: number, z: number) => (m === 1 ? nextBpRim(L + 1, CX * k, CY * k, z) : m === 2 ? nextBpRim(L, CX, CY, z) : nextBp(L, CX, CY, z));
  const sideOwn = (L: number, m: number, z: number) => (m === 1 ? levels[L + 1].zo + z / k : z);
  /** the identity of level L's vertex at corner line (CX, CY), height z (its own units): on a rim line, the child's */
  const vAt = (L: number, CX: number, CY: number, z: number, m = rimP(L, CX, CY) ? 1 : 0): VertexId => (m === 1 ? { L: L + 1, cx: CX * k, cy: CY * k, z } : { L, cx: CX, cy: CY, z });
  const SIDES: { off: [number, number]; cA: number; cB: number; out: Vec3 }[] = [
    { off: [1, 0], cA: 1, cB: 3, out: [1, 0, 0] },
    { off: [-1, 0], cA: 0, cB: 2, out: [-1, 0, 0] },
    { off: [0, 1], cA: 2, cB: 3, out: [0, 1, 0] },
    { off: [0, -1], cA: 0, cB: 1, out: [0, -1, 0] },
  ];
  // a triangle, oriented so its normal (by the identity positions) points along `out`
  const put = (L: number, X: number, Y: number, kind: number, mat: number, a: VertexId, b: VertexId, c: VertexId, out: Vec3, tag: Partial<Tri> = {}) => {
    const pa = toWorld(scene, a.L, a.cx, a.cy, a.z);
    const pb = toWorld(scene, b.L, b.cx, b.cy, b.z);
    const pc = toWorld(scene, c.L, c.cx, c.cy, c.z);
    const u = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    const w = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const ia = vid(a);
    const ib = vid(b);
    const ic = vid(c);
    const flip = n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0;
    tris.push({ v: flip ? [ia, ic, ib] : [ia, ib, ic], kind, mat, L, X, Y, ...tag });
  };
  for (let L = 0; L < levels.length; L++) {
    const w = levels[L];
    let nDrawn = 0;
    for (let Y = w.gy; Y < w.gy + w.n; Y++)
      for (let X = w.gx; X < w.gx + w.n; X++) {
        const p = drawnPart(L, X, Y);
        if (!p) continue;
        nDrawn++;
        const n = p.top.length;
        const z0 = zb(L, X, Y);
        const corner = (c: number, z: number): VertexId => {
          const CX = X + (c & 1);
          const CY = Y + (c >> 1);
          return rimP(L, CX, CY) ? vAt(L, CX, CY, toKid(L, z), 1) : vAt(L, CX, CY, z, 0);
        };
        // caps
        for (let j = 0; j < n; j++) {
          const up = j + 1 < n ? p.mat[j + 1] : AIR;
          const s0 = solid(p.mat[j]);
          if (s0 === solid(up)) continue;
          const z = p.top[j];
          const out: Vec3 = [0, 0, s0 ? 1 : -1];
          const mat = s0 ? p.mat[j] : up;
          put(L, X, Y, s0 ? 4 : 5, mat, corner(0, z), corner(1, z), corner(3, z), out);
          put(L, X, Y, s0 ? 4 : 5, mat, corner(0, z), corner(3, z), corner(2, z), out);
        }
        if (solid(p.mat[0])) {
          put(L, X, Y, 5, p.mat[0], corner(0, z0), corner(1, z0), corner(3, z0), [0, 0, -1], { down: true });
          put(L, X, Y, 5, p.mat[0], corner(0, z0), corner(3, z0), corner(2, z0), [0, 0, -1], { down: true });
        }
        // walls
        for (let d = 0; d < 4; d++) {
          const { off, cA, cB, out } = SIDES[d];
          const NX = X + off[0];
          const NY = Y + off[1];
          const q = drawnPart(L, NX, NY);
          const nb = q ? zb(L, NX, NY) : 0;
          const AX = X + (cA & 1);
          const AY = Y + (cA >> 1);
          const BX = X + (cB & 1);
          const BY = Y + (cB >> 1);
          const mA = rimMode(L, AX, AY);
          const mB = rimMode(L, BX, BY);
          let lo = z0;
          for (let j = 0; j < n; j++) {
            const hi = p.top[j];
            if (solid(p.mat[j])) {
              let cur = lo;
              let jn = 0;
              let nlo = nb;
              while (cur < hi) {
                let a = NO_DEPTH;
                let b = NO_DEPTH;
                while (q && jn < q.top.length) {
                  const qt = q.top[jn];
                  const qlo = nlo;
                  nlo = qt;
                  const qm = q.mat[jn];
                  jn++;
                  if (solid(qm) && qt > cur) {
                    a = qlo;
                    b = qt;
                    break;
                  }
                }
                const p0 = cur;
                const p1 = Math.min(a, hi);
                if (p1 > p0) {
                  const eA = mA === 1 ? toKid(L, p1) : p1;
                  const eB = mB === 1 ? toKid(L, p1) : p1;
                  let za = mA === 1 ? toKid(L, p0) : p0;
                  let zc = mB === 1 ? toKid(L, p0) : p0;
                  while (za < eA || zc < eB) {
                    const na = Math.min(sideNext(L, mA, AX, AY, za), eA);
                    const nc = Math.min(sideNext(L, mB, BX, BY, zc), eB);
                    const A0 = vAt(L, AX, AY, za, mA === 1 ? 1 : 0);
                    const B0 = vAt(L, BX, BY, zc, mB === 1 ? 1 : 0);
                    if (za < eA && (sideOwn(L, mA, na) <= sideOwn(L, mB, nc) || zc >= eB)) {
                      put(L, X, Y, d, p.mat[j], A0, B0, vAt(L, AX, AY, na, mA === 1 ? 1 : 0), out, { p0, p1 });
                      za = na;
                    } else {
                      put(L, X, Y, d, p.mat[j], A0, B0, vAt(L, BX, BY, nc, mB === 1 ? 1 : 0), out, { p0, p1 });
                      zc = nc;
                    }
                  }
                }
                cur = Math.max(cur, b);
              }
            }
            lo = hi;
          }
        }
      }
    drawn.push(nDrawn);
  }
  // ---- (round 12) the collapse as the GPU computes it: from the columns round a corner line, no mesh ----------------
  // A vertex's corner line: its level's four columns, and on a rim line (the identity is the child's) also the parent's
  // four (heights through toKid). Breakpoints: every record top and bottom of those columns. A segment between two
  // consecutive breakpoints is an edge of the mesh (joined) exactly when the four columns of one level are not all solid
  // or all air just above its lower end (a wall stands on some half-edge round the line there); below a column's bottom,
  // and where the column is not drawn, it is air. A cluster: the chain of joined segments shorter than T round the
  // vertex; its height the f32 mean of its breakpoints, summed bottom up (the same arithmetic on every face).
  type LC = { lv: number; X: number; Y: number; s: number };
  const lineCols = (id: VertexId): LC[] => {
    const out: LC[] = [];
    for (let q = 0; q < 4; q++) out.push({ lv: id.L, X: id.cx - 1 + (q & 1), Y: id.cy - 1 + (q >> 1), s: 0 });
    if (id.L > 0 && rimC(id.L, id.cx, id.cy)) {
      const px = fdiv(id.cx, k);
      const py = fdiv(id.cy, k);
      for (let q = 0; q < 4; q++) out.push({ lv: id.L - 1, X: px - 1 + (q & 1), Y: py - 1 + (q >> 1), s: 1 });
    }
    return out;
  };
  const cv = (c: LC, z: number) => (c.s ? toKid(c.lv, z) : z);
  const bpNext = (cs: LC[], z: number) => {
    let best = NO_DEPTH;
    for (const c of cs) {
      const p = drawnPart(c.lv, c.X, c.Y);
      if (!p) continue;
      const b = cv(c, zb(c.lv, c.X, c.Y));
      if (b > z) best = Math.min(best, b);
      for (const t0 of p.top) {
        const t = cv(c, t0);
        if (t > z) {
          best = Math.min(best, t);
          break;
        }
      }
    }
    return best;
  };
  const bpPrev = (cs: LC[], z: number) => {
    let best = -NO_DEPTH;
    for (const c of cs) {
      const p = drawnPart(c.lv, c.X, c.Y);
      if (!p) continue;
      const b = cv(c, zb(c.lv, c.X, c.Y));
      if (b < z) best = Math.max(best, b);
      for (let j = p.top.length - 1; j >= 0; j--) {
        const t = cv(c, p.top[j]);
        if (t < z) {
          best = Math.max(best, t);
          break;
        }
      }
    }
    return best;
  };
  /** solid just above breakpoint z (no breakpoint lies between z and the next one, so this is the segment's state) */
  const solidAbove = (c: LC, z: number) => {
    const p = drawnPart(c.lv, c.X, c.Y);
    if (!p) return false;
    if (z < cv(c, zb(c.lv, c.X, c.Y))) return false;
    for (let j = 0; j < p.top.length; j++) if (cv(c, p.top[j]) > z) return solid(p.mat[j]);
    return false;
  };
  const joinedAbove = (cs: LC[], z: number) => {
    for (let g = 0; g < cs.length; g += 4) {
      const s0 = solidAbove(cs[g], z);
      for (let q = 1; q < 4; q++) if (solidAbove(cs[g + q], z) !== s0) return true;
    }
    return false;
  };
  const f = Math.fround;
  const cluster = (id: VertexId, T: number) => {
    const cs = lineCols(id);
    const Tf = f(T);
    let a = id.z;
    for (;;) {
      const p = bpPrev(cs, a);
      if (p <= -NO_DEPTH || !(f(a - p) < Tf) || !joinedAbove(cs, p)) break;
      a = p;
    }
    let b = a;
    let sum = a;
    let n = 1;
    for (;;) {
      const nx = bpNext(cs, b);
      if (nx >= NO_DEPTH || !(f(nx - b) < Tf) || !joinedAbove(cs, b)) break;
      sum = f(sum + nx);
      n++;
      b = nx;
    }
    return { bot: a, top: b, z: f(sum / n) };
  };
  const fan = (L: number, X: number, Y: number) => {
    const bx = fdiv(X, 4) * 4;
    const by = fdiv(Y, 4) * 4;
    let z: number | undefined;
    for (let q = 0; q < 16; q++) {
      const cX = bx + (q % 4);
      const cY = by + Math.floor(q / 4);
      const p = drawnPart(L, cX, cY);
      if (!p || !solid(p.mat[0])) return false;
      const b = zb(L, cX, cY);
      if (z === undefined) z = b;
      else if (b !== z) return false;
    }
    for (let e = 0; e <= 4; e++) if (rimP(L, bx + e, by) || rimP(L, bx + e, by + 4) || rimP(L, bx, by + e) || rimP(L, bx + 4, by + e)) return false;
    return true;
  };
  return { ids, tris, drawn, cluster, fan, col: drawnPart, zb, rim: (L, CX, CY) => rimP(L, CX, CY) || rimC(L, CX, CY) };
}

/** (round 12) the collapse as the GPU bakes it: each identity at its cluster's height from the columns (mesh.cluster) */
export function collapseCols(mesh: BoxMesh, T = 2): Placement {
  return (v) => [v.cx, v.cy, mesh.cluster(v, T).z];
}

/** (round 12, NS-102) coincident cap pairs dropped: a thin layer that collapses flat leaves its top and bottom cap
 *  triangles on the same three vertices, facing opposite ways (they z-fight). Within one column, the cap triangles (the
 *  same corner triple) that land on the same three vertices are a run of consecutive caps (clusters are intervals of a
 *  corner line), alternating up and down; dropping them in pairs from the bottom keeps the mesh closed (each pair's
 *  edges cancel) and leaves one, the top, where the run is odd. The GPU's rule per cap: kept iff no cap of its run lies
 *  above it and an even number lie below. A fan column's down cap (the GPU bakes a fan there) takes no part. Returns a
 *  new placed mesh. */
export function dropCapPairs(mesh: BoxMesh, m: PlacedMesh): PlacedMesh & { pairs: number } {
  const groups = new Map<string, number[]>();
  m.tris.forEach((t, i) => {
    const s = mesh.tris[m.src[i]];
    if (s.kind !== 4 && s.kind !== 5) return;
    const v0 = mesh.ids[s.v[0]];
    if (s.kind === 5 && mesh.fan(s.L, s.X, s.Y)) {
      // (the down cap at the column's bottom: the lowest vertex of the column's caps)
      const isDown = !mesh.tris.some((o) => o !== s && o.L === s.L && o.X === s.X && o.Y === s.Y && (o.kind === 4 || o.kind === 5) && mesh.ids[o.v[0]].cx === v0.cx && mesh.ids[o.v[0]].cy === v0.cy && mesh.ids[o.v[0]].z < v0.z);
      if (isDown) return;
    }
    const key = `${s.L}:${s.X}:${s.Y}:${[...t].sort((a, b) => a - b).join(',')}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(i);
  });
  const drop = new Set<number>();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => mesh.ids[mesh.tris[m.src[a]].v[0]].z - mesh.ids[mesh.tris[m.src[b]].v[0]].z);
    for (let i = 0; i < g.length - (g.length % 2); i++) drop.add(g[i]);
  }
  const tris: [number, number, number][] = [];
  const src: number[] = [];
  m.tris.forEach((t, i) => {
    if (drop.has(i)) return;
    tris.push(t);
    src.push(m.src[i]);
  });
  return { ...m, tris, src, pairs: drop.size / 2 };
}

// ---- placement -------------------------------------------------------------------------------------------------------

/** what a placement may look at round a vertex: its corner line's vertices (sorted heights) and which consecutive pairs
 *  the mesh joins by a vertical edge */
export interface Neighbourhood {
  line: number[];
  joined: boolean[];
}
export type Placement = (v: VertexId, nb: Neighbourhood) => Vec3;

/** the boxes: every identity where it is */
export const identity: Placement = (v) => [v.cx, v.cy, v.z];

/** vertices of a corner line joined by vertical edges shorter than T (the level's column units) merge to their mean
 *  height (chains: a run of short edges is one cluster) */
export function collapse(T = 2): Placement {
  return (v, nb) => {
    const i = nb.line.indexOf(v.z);
    let a = i;
    let b = i;
    while (a > 0 && nb.joined[a - 1] && nb.line[a] - nb.line[a - 1] < T) a--;
    while (b < nb.line.length - 1 && nb.joined[b] && nb.line[b + 1] - nb.line[b] < T) b++;
    let s = 0;
    for (let j = a; j <= b; j++) s += nb.line[j];
    return [v.cx, v.cy, s / (b - a + 1)];
  };
}

/** (the principle's proof only) a seeded random displacement inside the cell neighbourhood: x, y within 0.45 of the
 *  corner line, z within 0.45 of the gap to the next vertex on the line either way */
export function random(seed: number): Placement {
  const h = (v: VertexId, s: number) => {
    let x = Math.imul(v.cx | 0, 0x9e3779b1) ^ Math.imul(v.cy | 0, 0x85ebca6b) ^ Math.imul(v.L + 1, 0xc2b2ae35) ^ Math.imul(seed + s, 0x27d4eb2f);
    const zb = new Float64Array([v.z]);
    const zu = new Uint32Array(zb.buffer);
    x ^= Math.imul(zu[0], 0x165667b1) ^ Math.imul(zu[1], 0xd3a2646c);
    x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d);
    x = Math.imul(x ^ (x >>> 12), 0x297a2d39);
    x ^= x >>> 15;
    return (x >>> 0) / 4294967296 - 0.5;
  };
  return (v, nb) => {
    const i = nb.line.indexOf(v.z);
    const below = i > 0 ? v.z - nb.line[i - 1] : 1;
    const above = i < nb.line.length - 1 ? nb.line[i + 1] - v.z : 1;
    const dz = h(v, 3) * 0.9 * (h(v, 4) < 0 ? below : above);
    return [v.cx + h(v, 1) * 0.9, v.cy + h(v, 2) * 0.9, v.z + dz];
  };
}

export interface PlacedMesh {
  /** the placed vertices (one per merged identity) */
  pos: Vec3[];
  /** each identity's vertex */
  of: number[];
  /** the triangles left (three distinct vertices), as vertex indices */
  tris: [number, number, number][];
  /** which box triangle each came from */
  src: number[];
  /** triangles dropped for a repeated vertex */
  dropped: number;
}

/** every identity placed; identities of one corner line placed at the same point merged; triangles with a repeated
 *  vertex dropped */
export function place(mesh: BoxMesh, pl: Placement, scene: MeshScene): PlacedMesh {
  // the corner lines: their vertices and vertical edges
  const lines = new Map<string, { zs: number[]; ids: number[]; joined: Set<string> }>();
  const lk = (v: VertexId) => `${v.L}:${v.cx}:${v.cy}`;
  mesh.ids.forEach((v, i) => {
    const key = lk(v);
    let l = lines.get(key);
    if (!l) lines.set(key, (l = { zs: [], ids: [], joined: new Set() }));
    l.zs.push(v.z);
    l.ids.push(i);
  });
  for (const t of mesh.tris)
    for (let e = 0; e < 3; e++) {
      const a = mesh.ids[t.v[e]];
      const b = mesh.ids[t.v[(e + 1) % 3]];
      if (a.cx === b.cx && a.cy === b.cy) lines.get(lk(a))!.joined.add(`${Math.min(a.z, b.z)}|${Math.max(a.z, b.z)}`);
    }
  const of = new Array<number>(mesh.ids.length);
  const pos: Vec3[] = [];
  for (const l of lines.values()) {
    const order = l.zs.map((z, i) => i).sort((a, b) => l.zs[a] - l.zs[b]);
    const line = order.map((i) => l.zs[i]);
    const joined = line.slice(0, -1).map((z, i) => l.joined.has(`${z}|${line[i + 1]}`));
    const nb: Neighbourhood = { line, joined };
    const at = new Map<string, number>();
    for (const i of order) {
      const id = mesh.ids[l.ids[i]];
      const p = pl(id, nb);
      const key = `${p[0]},${p[1]},${p[2]}`;
      let o = at.get(key);
      if (o === undefined) {
        o = pos.length;
        // (placed in the identity's level units; kept in world units)
        pos.push(toWorld(scene, id.L, p[0], p[1], p[2]));
        at.set(key, o);
      }
      of[l.ids[i]] = o;
    }
  }
  const tris: [number, number, number][] = [];
  const src: number[] = [];
  let dropped = 0;
  mesh.tris.forEach((t, s) => {
    const a = of[t.v[0]];
    const b = of[t.v[1]];
    const c = of[t.v[2]];
    if (a === b || b === c || a === c) {
      dropped++;
      return;
    }
    tris.push([a, b, c]);
    src.push(s);
  });
  return { pos, of, tris, src, dropped };
}

export interface Closure {
  tris: number;
  /** edges used by an odd number of triangles (by vertex identity, nothing exempt) */
  odd: number;
  /** directed edges not cancelled by an opposite one (oriented closure) */
  unbalanced: number;
  /** triangles with a repeated vertex left (none expected) */
  repeated: number;
  /** triangles of zero area by their placed points (with three distinct vertices) */
  zeroArea: number;
  /** pairs of triangles on the same three vertices (a collapsed thin layer's two faces) */
  coincident: number;
  /** the enclosed volume (divergence theorem over the oriented triangles) */
  volume: number;
}
/** the closure of a placed mesh, exact, by vertex index; `keep` picks triangles by their box triangle (a level's own) */
export function closure(m: PlacedMesh, keep: (src: number) => boolean = () => true): Closure {
  const und = new Map<string, number>();
  const dir = new Map<string, number>();
  const faces = new Map<string, number>();
  let repeated = 0;
  let zeroArea = 0;
  let volume = 0;
  let count = 0;
  for (let ti = 0; ti < m.tris.length; ti++) {
    if (!keep(m.src[ti])) continue;
    count++;
    const t = m.tris[ti];
    if (t[0] === t[1] || t[1] === t[2] || t[0] === t[2]) repeated++;
    const [a, b, c] = t.map((i) => m.pos[i]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    if (n[0] === 0 && n[1] === 0 && n[2] === 0) zeroArea++;
    // (relative to the triangle's first point's column: the heights are large, the volume a sum of small terms)
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    const fk = [...t].sort((x, y) => x - y).join(',');
    faces.set(fk, (faces.get(fk) ?? 0) + 1);
    for (let e = 0; e < 3; e++) {
      const p = t[e];
      const q = t[(e + 1) % 3];
      const uk = p < q ? `${p},${q}` : `${q},${p}`;
      und.set(uk, (und.get(uk) ?? 0) + 1);
      dir.set(uk, (dir.get(uk) ?? 0) + (p < q ? 1 : -1));
    }
  }
  let odd = 0;
  let unbalanced = 0;
  for (const c of und.values()) if (c % 2) odd++;
  for (const c of dir.values()) if (c !== 0) unbalanced++;
  let coincident = 0;
  for (const c of faces.values()) if (c > 1) coincident += c;
  return { tris: count, odd, unbalanced, repeated, zeroArea, coincident, volume };
}

/** (round 11) the rim lines between each level and its child: vertical edges (consecutive heights joined by an edge) of
 *  either level on a rim line that hold a vertex of the other level strictly inside (a T-junction across the rim); by
 *  identity: both levels' rim vertices are the child's */
export function rimJunctionsRef(mesh: BoxMesh): { lines: number; junctions: number } {
  const lines = new Map<string, { v: [Set<number>, Set<number>]; e: [number, number][][] }>();
  for (const t of mesh.tris)
    for (let e = 0; e < 3; e++) {
      const a = mesh.ids[t.v[e]];
      if (a.L === t.L) continue; // (a rim vertex of a parent's face carries the child's level)
      const key = `${a.L}:${a.cx}:${a.cy}`;
      if (!lines.has(key)) lines.set(key, { v: [new Set(), new Set()], e: [[], []] });
    }
  for (const t of mesh.tris)
    for (let e = 0; e < 3; e++) {
      const a = mesh.ids[t.v[e]];
      const b = mesh.ids[t.v[(e + 1) % 3]];
      const l = lines.get(`${a.L}:${a.cx}:${a.cy}`);
      if (!l) continue;
      const side = t.L === a.L ? 1 : 0;
      l.v[side].add(a.z);
      if (b.L === a.L && b.cx === a.cx && b.cy === a.cy) l.e[side].push([Math.min(a.z, b.z), Math.max(a.z, b.z)]);
    }
  let junctions = 0;
  for (const l of lines.values())
    for (const s of [0, 1])
      for (const [a, b] of l.e[s]) for (const z of l.v[1 - s]) if (z > a && z < b) junctions++;
  return { lines: lines.size, junctions };
}

// ---- (round 13) the smooth draw as it reaches the screen: a fixed template + a vertex cache + baked exceptions ------
// (docs/design/NESTED_SCALES.md "The smooth draw: template, cache, exceptions (round 13)".) The reference decides the
// design: smoothSplit proves, scene by scene, that the template expanded from the cache plus the exceptions baked by the
// box rule is the collapse mesh after dropCapPairs, triangle for triangle (by vertex identity), up to triangles the
// template leaves degenerate.

/** a cache slot with no column (not drawn by the level): it clamps to the wall's bottom, so it is never a vertex */
export const NONE = -3e38;

/** corner line (CX, CY)'s slots: slot q is column (CX - 1 + (q & 1), CY - 1 + (q >> 1)); raw: that column's last record
 *  top (the identity's height), z: its placed height (collapseCols), bot: the bottom of its cluster */
export interface LineSlots {
  raw: number[];
  z: number[];
  bot: number[];
}
export interface SmoothCache {
  T: number;
  line: (L: number, CX: number, CY: number) => LineSlots;
}
/** the slot of column (X, Y) on corner line (CX, CY) (one of its four corners) */
export const slotOf = (X: number, Y: number, CX: number, CY: number) => X - CX + 1 + 2 * (Y - CY + 1);

/** the vertex cache: what the GPU's cache pass writes per corner line (the general collapse rule, so it is right next to
 *  complex columns and across rims too) */
export function smoothCache(mesh: BoxMesh, T: number): SmoothCache {
  const memo = new Map<string, LineSlots>();
  const line = (L: number, CX: number, CY: number) => {
    const key = `${L}:${CX}:${CY}`;
    let s = memo.get(key);
    if (s) return s;
    s = { raw: [], z: [], bot: [] };
    for (let q = 0; q < 4; q++) {
      const p = mesh.col(L, CX - 1 + (q & 1), CY - 1 + (q >> 1));
      if (!p) {
        s.raw.push(NONE);
        s.z.push(NONE);
        s.bot.push(NONE);
        continue;
      }
      const t = p.top[p.top.length - 1];
      const c = mesh.cluster({ L, cx: CX, cy: CY, z: t }, T);
      s.raw.push(t);
      s.z.push(c.z);
      s.bot.push(c.bot);
    }
    memo.set(key, s);
    return s;
  };
  return { T, line };
}

/** a column's template word: its top cap, its walls on edges +x and +y (dir 0, 1), its top material */
export interface TemplateWord {
  cap: boolean;
  w: [boolean, boolean];
  mat: number;
}
/** an edge's two corner lines and the neighbour: dir 0 = edge +x (B = X + 1), dir 1 = edge +y (B = Y + 1); P is the
 *  line with the lower coordinate along the edge */
export const edgeOf = (X: number, Y: number, dir: number) =>
  dir === 0 ? { BX: X + 1, BY: Y, P: [X + 1, Y], Q: [X + 1, Y + 1] } : { BX: X, BY: Y + 1, P: [X, Y + 1], Q: [X + 1, Y + 1] };

/** the template mask, from the columns (what the GPU's classify pass writes per column). Rules:
 *  - simple column: drawn, every record solid (its only solid/air boundary is its top);
 *  - cap: the column is simple, none of its corner lines is a rim line, and on every corner its top's cluster stays above
 *    its own bottom (else the up and down caps may coincide and the pair rule decides: exception);
 *  - wall on an edge: both columns simple, neither corner line a rim line, and on both lines every breakpoint strictly
 *    between the two tops is the last top of one of the line's four columns (no record boundary, no bottom there). */
export function templateMask(scene: MeshScene, mesh: BoxMesh, cache: SmoothCache) {
  const solid = scene.solid ?? ((m: number) => m !== AIR);
  const simple = (L: number, X: number, Y: number) => {
    const p = mesh.col(L, X, Y);
    return !!p && p.mat.every(solid);
  };
  const top = (L: number, X: number, Y: number) => {
    const p = mesh.col(L, X, Y)!;
    return p.top[p.top.length - 1];
  };
  const lineOk = (L: number, CX: number, CY: number, lo: number, hi: number) => {
    if (mesh.rim(L, CX, CY)) return false;
    for (let q = 0; q < 4; q++) {
      const X = CX - 1 + (q & 1);
      const Y = CY - 1 + (q >> 1);
      const p = mesh.col(L, X, Y);
      if (!p) continue;
      const b = mesh.zb(L, X, Y);
      if (b > lo && b < hi) return false;
      for (let j = 0; j + 1 < p.top.length; j++) if (p.top[j] > lo && p.top[j] < hi) return false;
    }
    return true;
  };
  const memo = new Map<string, TemplateWord>();
  return (L: number, X: number, Y: number): TemplateWord => {
    const key = `${L}:${X}:${Y}`;
    let w = memo.get(key);
    if (w) return w;
    w = { cap: false, w: [false, false], mat: 0 };
    if (simple(L, X, Y)) {
      const p = mesh.col(L, X, Y)!;
      w.mat = p.mat[p.mat.length - 1];
      const zb = mesh.zb(L, X, Y);
      let cap = true;
      for (let c = 0; c < 4 && cap; c++) {
        const CX = X + (c & 1);
        const CY = Y + (c >> 1);
        if (mesh.rim(L, CX, CY) || !(cache.line(L, CX, CY).bot[slotOf(X, Y, CX, CY)] > zb)) cap = false;
      }
      w.cap = cap;
      for (let dir = 0; dir < 2; dir++) {
        const e = edgeOf(X, Y, dir);
        if (!simple(L, e.BX, e.BY)) continue;
        const a = top(L, X, Y);
        const b = top(L, e.BX, e.BY);
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        w.w[dir] = lineOk(L, e.P[0], e.P[1], lo, hi) && lineOk(L, e.Q[0], e.Q[1], lo, hi);
      }
    }
    memo.set(key, w);
    return w;
  };
}

/** a triangle of identities oriented so its normal (identity positions) points along `out` (the box mesher's rule) */
export function orientIds(scene: MeshScene, a: VertexId, b: VertexId, c: VertexId, out: Vec3): [VertexId, VertexId, VertexId] {
  const pa = toWorld(scene, a.L, a.cx, a.cy, a.z);
  const pb = toWorld(scene, b.L, b.cx, b.cy, b.z);
  const pc = toWorld(scene, c.L, c.cx, c.cy, c.z);
  const u = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
  const w = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
  const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  return n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0 ? [a, c, b] : [a, b, c];
}

export interface TemplateTri {
  v: [VertexId, VertexId, VertexId];
  /** the template slot: the column (X, Y), part 0 cap, 1 + 6 dir + i wall fan triangle i of edge dir */
  L: number;
  X: number;
  Y: number;
  part: number;
  kind: number;
  mat: number;
}
/** template triangles per column: 2 cap + 2 edges x 6 wall = 14, most degenerate */
export const TEMPLATE_TRIS = 14;
const OUT: Vec3[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
];

/** the template expanded from the cache and the mask alone, as the vertex stage does it: every slot, degenerate ones
 *  included. A wall: the higher column's top is hi, the lower's lo, on both lines; each line's two other slots clamp to
 *  [lo, hi] and sort (a clamped slot IS the identity (line, lo) or (line, hi)); the strip zips the two sorted lists of
 *  four from the bottom, the side whose next height is lower first, ties to P (the box mesher's wall rule): 6 steps. */
export function templateTris(scene: MeshScene, cache: SmoothCache, mask: (L: number, X: number, Y: number) => TemplateWord): TemplateTri[] {
  const out: TemplateTri[] = [];
  for (let L = 0; L < scene.levels.length; L++) {
    const w = scene.levels[L];
    for (let Y = w.gy; Y < w.gy + w.n; Y++)
      for (let X = w.gx; X < w.gx + w.n; X++) {
        const m = mask(L, X, Y);
        if (m.cap) {
          const c = [0, 1, 2, 3].map((i): VertexId => {
            const CX = X + (i & 1);
            const CY = Y + (i >> 1);
            return { L, cx: CX, cy: CY, z: cache.line(L, CX, CY).raw[slotOf(X, Y, CX, CY)] };
          });
          out.push({ v: [c[0], c[1], c[3]], L, X, Y, part: 0, kind: 4, mat: m.mat });
          out.push({ v: [c[0], c[3], c[2]], L, X, Y, part: 0, kind: 4, mat: m.mat });
        }
        for (let dir = 0; dir < 2; dir++) {
          if (!m.w[dir]) continue;
          const e = edgeOf(X, Y, dir);
          const sP = cache.line(L, e.P[0], e.P[1]);
          const sQ = cache.line(L, e.Q[0], e.Q[1]);
          const tC = sP.raw[slotOf(X, Y, e.P[0], e.P[1])];
          const tB = sP.raw[slotOf(e.BX, e.BY, e.P[0], e.P[1])];
          const lo = Math.min(tC, tB);
          const hi = Math.max(tC, tB);
          const aIsC = tC > tB;
          const kind = dir === 0 ? (aIsC ? 0 : 1) : aIsC ? 2 : 3;
          const mat = aIsC ? m.mat : mask(L, e.BX, e.BY).mat;
          const list = (s: LineSlots, CX: number, CY: number) => {
            const own = [slotOf(X, Y, CX, CY), slotOf(e.BX, e.BY, CX, CY)];
            const o = [0, 1, 2, 3].filter((q) => !own.includes(q)).map((q) => Math.min(Math.max(s.raw[q], lo), hi));
            return [lo, Math.min(o[0], o[1]), Math.max(o[0], o[1]), hi];
          };
          const pl = list(sP, e.P[0], e.P[1]);
          const ql = list(sQ, e.Q[0], e.Q[1]);
          const P = (i: number): VertexId => ({ L, cx: e.P[0], cy: e.P[1], z: pl[i] });
          const Q = (j: number): VertexId => ({ L, cx: e.Q[0], cy: e.Q[1], z: ql[j] });
          let i = 0;
          let j = 0;
          for (let s = 0; s < 6; s++) {
            let v: [VertexId, VertexId, VertexId];
            if (i < 3 && (j === 3 || pl[i + 1] <= ql[j + 1])) {
              v = [P(i), Q(j), P(i + 1)];
              i++;
            } else {
              v = [P(i), Q(j), Q(j + 1)];
              j++;
            }
            out.push({ v: orientIds(scene, v[0], v[1], v[2], OUT[kind]), L, X, Y, part: 1 + 6 * dir + s, kind, mat });
          }
        }
      }
  }
  return out;
}

export interface SmoothSplit {
  mesh: BoxMesh;
  /** the reference: collapseCols placement, then dropCapPairs */
  ref: PlacedMesh;
  /** template + exceptions, on the reference's placed vertices; src indexes `lv` (each triangle's level) */
  union: PlacedMesh;
  lv: number[];
  /** the union's triangles as identity triangles (for rimJunctionsRef) */
  unionIds: BoxMesh;
  /** identity triangles in one and not the other (multiset), and template triangles naming an identity the box mesh lacks */
  missing: number;
  extra: number;
  unknown: number;
  stats: {
    L: number;
    windowCols: number;
    drawn: number;
    simple: number;
    templateSlots: number;
    templateVisible: number;
    templateCaps: number;
    exceptionTris: number;
    exceptionBottomTris: number;
    exceptionCells: number;
  }[];
}

/** the split, checked against the reference */
export function smoothSplit(scene: MeshScene, T: number): SmoothSplit {
  const solid = scene.solid ?? ((m: number) => m !== AIR);
  const mesh = boxMesh(scene);
  const cache = smoothCache(mesh, T);
  const mask = templateMask(scene, mesh, cache);
  const tt = templateTris(scene, cache, mask);
  const placed = place(mesh, collapseCols(mesh, T), scene);
  const ref = dropCapPairs(mesh, placed);
  const top = (p: Part) => p.top[p.top.length - 1];
  // which box triangles the template draws (a face of the template's parts)
  const isTemplate = (t: Tri) => {
    if (t.down) return false;
    if (t.kind === 4) return mask(t.L, t.X, t.Y).cap;
    if (t.kind === 5) return false;
    const [ex, ey, dir] = t.kind === 0 ? [t.X, t.Y, 0] : t.kind === 1 ? [t.X - 1, t.Y, 0] : t.kind === 2 ? [t.X, t.Y, 1] : [t.X, t.Y - 1, 1];
    if (!mask(t.L, ex, ey).w[dir]) return false;
    const e = edgeOf(ex, ey, dir);
    const a = top(mesh.col(t.L, ex, ey)!);
    const b = top(mesh.col(t.L, e.BX, e.BY)!);
    return t.p0 === Math.min(a, b) && t.p1 === Math.max(a, b);
  };
  const tmplBox = mesh.tris.map(isTemplate);
  const keepIdx = placed.tris.map((_, i) => i).filter((i) => !tmplBox[placed.src[i]]);
  const ex = dropCapPairs(mesh, { ...placed, tris: keepIdx.map((i) => placed.tris[i]), src: keepIdx.map((i) => placed.src[i]) });
  // the template's triangles on the placed vertices: identities -> box ids -> merged vertices
  const idIndex = new Map<string, number>();
  mesh.ids.forEach((v, i) => idIndex.set(idKey(v), i));
  let unknown = 0;
  const tIds: [number, number, number][] = [];
  const tLv: number[] = [];
  const visible = new Map<string, number>();
  for (const t of tt) {
    const ks = t.v.map(idKey);
    if (ks[0] === ks[1] || ks[1] === ks[2] || ks[0] === ks[2]) continue;
    const ii = ks.map((k) => idIndex.get(k));
    if (ii.some((i) => i === undefined)) {
      unknown++;
      continue;
    }
    const [a, b, c] = ii.map((i) => placed.of[i!]);
    if (a === b || b === c || a === c) continue;
    tIds.push(ii as [number, number, number]);
    tLv.push(t.L);
    const vk = `${t.L}:${t.part === 0 ? 'cap' : 'wall'}`;
    visible.set(vk, (visible.get(vk) ?? 0) + 1);
  }
  // compare identity triangles (rotation-canonical, orientation kept) as multisets
  const canon = (v: number[]) => {
    const r = v.indexOf(Math.min(...v));
    return `${v[r]},${v[(r + 1) % 3]},${v[(r + 2) % 3]}`;
  };
  const count = new Map<string, number>();
  for (const s of ref.src) {
    const k = canon(mesh.tris[s].v);
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  for (const s of ex.src) {
    const k = canon(mesh.tris[s].v);
    count.set(k, (count.get(k) ?? 0) - 1);
  }
  for (const v of tIds) {
    const k = canon(v);
    count.set(k, (count.get(k) ?? 0) - 1);
  }
  let missing = 0;
  let extra = 0;
  for (const c of count.values()) {
    if (c > 0) missing += c;
    if (c < 0) extra -= c;
  }
  // the union on the placed vertices
  const lv: number[] = [];
  const utris: [number, number, number][] = [];
  const src: number[] = [];
  const uTri: Tri[] = [];
  ex.tris.forEach((t, i) => {
    const b = mesh.tris[ex.src[i]];
    utris.push(t);
    src.push(lv.length);
    lv.push(b.L);
    uTri.push(b);
  });
  tIds.forEach((v, i) => {
    utris.push([placed.of[v[0]], placed.of[v[1]], placed.of[v[2]]]);
    src.push(lv.length);
    lv.push(tLv[i]);
    uTri.push({ v, kind: 0, mat: 0, L: tLv[i], X: 0, Y: 0 });
  });
  const union: PlacedMesh = { pos: placed.pos, of: placed.of, tris: utris, src, dropped: 0 };
  const unionIds = { ...mesh, tris: uTri };
  // stats per level
  const stats: SmoothSplit['stats'] = [];
  for (let L = 0; L < scene.levels.length; L++) {
    const w = scene.levels[L];
    let simple = 0;
    for (let Y = w.gy; Y < w.gy + w.n; Y++)
      for (let X = w.gx; X < w.gx + w.n; X++) {
        const p = mesh.col(L, X, Y);
        if (p && p.mat.every(solid)) simple++;
      }
    const cells = new Set<string>();
    let exT = 0;
    let exB = 0;
    ex.src.forEach((s) => {
      const t = mesh.tris[s];
      if (t.L !== L) return;
      exT++;
      let bottom = !!t.down;
      if (!bottom && t.kind < 4) {
        const nb = mesh.col(L, t.X + [1, -1, 0, 0][t.kind], t.Y + [0, 0, 1, -1][t.kind]);
        if (nb && t.p1! <= nb.top[0]) bottom = true;
      }
      if (bottom) exB++;
      else cells.add(`${t.X}:${t.Y}`);
    });
    stats.push({
      L,
      windowCols: w.n * w.n,
      drawn: mesh.drawn[L],
      simple,
      templateSlots: w.n * w.n * TEMPLATE_TRIS,
      templateVisible: (visible.get(`${L}:cap`) ?? 0) + (visible.get(`${L}:wall`) ?? 0),
      templateCaps: visible.get(`${L}:cap`) ?? 0,
      exceptionTris: exT,
      exceptionBottomTris: exB,
      exceptionCells: cells.size,
    });
  }
  return { mesh, ref, union, lv, unionIds, missing, extra, unknown, stats };
}

/** (the cross-check with the GPU's test) a level's box triangles in the capture's format (watertight.ts manifold: three
 *  vec4 a triangle, local units: x, y relative to the window, z, w = 1) */
export function asCapture(mesh: BoxMesh, scene: MeshScene, L: number): { depth: number; n: number; tris: Float32Array } {
  const w = scene.levels[L];
  const ts = mesh.tris.filter((t) => t.L === L);
  const out = new Float32Array(ts.length * 12);
  ts.forEach((t, i) => {
    for (let v = 0; v < 3; v++) {
      const id = mesh.ids[t.v[v]];
      // (a rim vertex: the child's corner line and units, as the GPU's capture writes it, w 2)
      if (id.L !== L) out.set([id.cx / scene.k - w.gx, id.cy / scene.k - w.gy, id.z, 2], i * 12 + v * 4);
      else out.set([id.cx - w.gx, id.cy - w.gy, id.z, 1], i * 12 + v * 4);
    }
  });
  return { depth: L, n: w.n, tris: out };
}
