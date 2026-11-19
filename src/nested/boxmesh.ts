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
  return { ids, tris, drawn, fan, col: drawnPart, zb, rim: (L, CX, CY) => rimP(L, CX, CY) || rimC(L, CX, CY) };
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

// ---- (round 16) the sheet form: the owner's spec, the reference -----------------------------------------------------
// (docs/design/NESTED_SCALES.md "As built (round 16)".) A layer is an n x n quad lattice: column (X, Y)'s j-th surface
// (bottom up: every solid/air change of its records; a column continues downward as its first record, so its bottom is
// no surface) is a quad on its four corner lines. A vertex is a CLUSTER of its corner line: the line's breakpoints (the
// surface heights of the columns in its four quadrants) chained while the segment between two of them is joined (the
// quadrants' columns are not all solid or all air there: an exposed wall stands on the line). Every wall collapses (no
// threshold), so lips, cave back walls and the face over a cave mouth pinch shut; nothing else is drawn (no walls, no
// skirts, no down caps, no ring outside the coarsest window). This is the box mesh (columns extended down, walls facing
// outside the root window left out) under the collapse map at T unlimited, so it is closed by construction except along
// the root window's edge (open by design).
// Level edges: a quadrant outside a child's window is owned by the parent's column there, so a child's edge lines see
// the parent's surfaces (toKid) and the parent's rim lines are the child's lines (canon); a parent column along the
// footprint splits its edge there at the child's k - 1 lines (its quad becomes a fan of k + 1 triangles). Then the two
// levels share every vertex of the edge (no T-junction) and the union is closed by the same argument (the parent's cap
// is a polygon with the split edge; the walls between the parent's column and the child's collapse like any wall). A
// cave or overhang one side has and the other lacks has a wall at the edge, which collapses: it pinches shut there.
// Placement: a cluster's height is the mean of its breakpoints as fixed point (floor(z * SHEET_FIX), an integer sum, one
// division); on a child's edge line between two rim lines a cluster holding parent surfaces is placed on the parent's
// edge instead: per parent surface the interpolation of the clusters holding it on the edge's two rim lines (integer
// i of k), averaged; positions never decide closure (identities do).
export const SHEET_FIX = 256;
/** (round 18) a cluster's height from the sum `s` of its n heights in 1/8 units (every stored bound is on the 1/8 grid):
 *  exact integer arithmetic, floored to 1/256 (q = floor(s / n), then the remainder's 32nds); nest.wgsl sMean */
export function fixMean(s: number, n: number): number {
  const q = Math.floor(s / n);
  const rem = s - q * n;
  return (q * 32 + Math.floor((rem * 32) / n)) / 256;
}

export interface SheetCluster {
  /** breakpoints (line units) bottom up */
  bps: number[];
  /** the chain reaches below the lowest breakpoint (columns of different states all the way down) */
  bottomless: boolean;
  /** placed height (line units) */
  z: number;
  /** placed on the parent's edge */
  interp: boolean;
}
export interface SheetLine {
  L: number;
  cx: number;
  cy: number;
  clusters: SheetCluster[];
  /** on the root window's edge (open edges allowed along it): a bit a side (west, east, south, north) */
  rootEdge: number;
  /** on a child window's edge (a level edge) */
  levelEdge: boolean;
}
export interface SheetTri {
  /** vertex keys (line key + cluster index) */
  v: [string, string, string];
  L: number;
  X: number;
  Y: number;
  /** surface index in the column, bottom up, and its facing */
  j: number;
  up: boolean;
  /** a triangle of a fan along a level edge */
  fan: boolean;
}
export interface SheetMesh {
  tris: SheetTri[];
  /** vertex key -> world position */
  pos: Map<string, Vec3>;
  lines: Map<string, SheetLine>;
  /** per level: drawn columns, quads (surfaces), triangles dropped as repeated-vertex, triangle pairs dropped as
   *  coincident, solid layers and air gaps that vanished (both their quads gone), fan triangles kept */
  stats: { L: number; drawn: number; surfaces: number; degenerate: number; pairs: number; layersGone: number; fan: number }[];
}

export function sheetMesh(scene: MeshScene): SheetMesh {
  const { k, levels } = scene;
  const solid = scene.solid ?? ((m: number) => m !== AIR);
  const fdiv = (a: number, b: number) => Math.floor(a / b);
  const inWin = (L: number, X: number, Y: number) => {
    const w = levels[L];
    return !!w && X >= w.gx && Y >= w.gy && X < w.gx + w.n && Y < w.gy + w.n;
  };
  const underKid = (L: number, X: number, Y: number) => {
    const c = levels[L + 1];
    return !!c && X * k >= c.gx && Y * k >= c.gy && X * k < c.gx + c.n && Y * k < c.gy + c.n;
  };
  const part = (L: number, X: number, Y: number): Part | null => {
    if (!inWin(L, X, Y) || underKid(L, X, Y)) return null;
    const w = levels[L];
    // (a drawn column with no records is air all the way: present, not absent)
    return w.parts[(Y - w.gy) * w.n + (X - w.gx)];
  };
  /** a column's surfaces (height, facing up), bottom up */
  const surfCache = new Map<string, { h: number; up: boolean }[]>();
  const surfaces = (L: number, X: number, Y: number) => {
    const key = `${L}:${X}:${Y}`;
    let s = surfCache.get(key);
    if (!s) {
      s = [];
      const p = part(L, X, Y);
      if (p)
        for (let j = 0; j < p.top.length; j++) {
          const a = solid(p.mat[j]);
          const b = j + 1 < p.top.length ? solid(p.mat[j + 1]) : false;
          if (a !== b) s.push({ h: p.top[j], up: a });
        }
      surfCache.set(key, s);
    }
    return s;
  };
  /** solid just above z (a column continues downward as its first record) */
  const solidAt = (p: Part, z: number) => {
    for (let j = 0; j < p.top.length; j++) if (p.top[j] > z) return solid(p.mat[j]);
    return false;
  };
  const toKid = (lv: number, z: number) => Math.fround((z - levels[lv + 1].zo) * k);
  /** the canonical line: a parent's line on its child's footprint boundary is the child's */
  const onWinEdge = (L: number, cx: number, cy: number) => {
    const w = levels[L];
    if (!w || cx < w.gx || cy < w.gy || cx > w.gx + w.n || cy > w.gy + w.n) return false;
    return cx === w.gx || cy === w.gy || cx === w.gx + w.n || cy === w.gy + w.n;
  };
  const canon = (L: number, cx: number, cy: number): [number, number, number] => (L + 1 < levels.length && onWinEdge(L + 1, cx * k, cy * k) ? [L + 1, cx * k, cy * k] : [L, cx, cy]);
  /** the column owning quadrant q of a canonical line (null: nobody draws it) */
  const owner = (L: number, cx: number, cy: number, q: number): { lv: number; X: number; Y: number } | null => {
    const X = cx - 1 + (q & 1);
    const Y = cy - 1 + (q >> 1);
    if (part(L, X, Y)) return { lv: L, X, Y };
    if (inWin(L, X, Y)) return null;
    if (L > 0 && part(L - 1, fdiv(X, k), fdiv(Y, k))) return { lv: L - 1, X: fdiv(X, k), Y: fdiv(Y, k) };
    return null;
  };
  const r = levels[0];
  const lines = new Map<string, SheetLine>();
  const lineKey = (L: number, cx: number, cy: number) => `${L}:${cx}:${cy}`;
  const fixOf = (z: number) => Math.floor(z * SHEET_FIX);
  /** a canonical line's clusters (own means; the edge interpolation is applied in a second step) */
  const lineRaw = (L: number, cx: number, cy: number): SheetLine & { parentBps: Set<number>[] } => {
    const own: { lv: number; X: number; Y: number }[] = [];
    const quads: (Part | null)[] = [];
    for (let q = 0; q < 4; q++) {
      const o = owner(L, cx, cy, q);
      quads.push(o ? part(o.lv, o.X, o.Y) : null);
      if (o && !own.some((u) => u.lv === o.lv && u.X === o.X && u.Y === o.Y)) own.push(o);
    }
    const toLine = (lv: number, z: number) => (lv === L ? z : toKid(lv, z));
    const bpSet = new Set<number>();
    const fromParent = new Set<number>();
    for (const o of own)
      for (const s of surfaces(o.lv, o.X, o.Y)) {
        const z = toLine(o.lv, s.h);
        bpSet.add(z);
        if (o.lv !== L) fromParent.add(z);
      }
    const bps = [...bpSet].sort((a, b) => a - b);
    // quadrant states in line units: a parent quadrant's part is read in its own units
    const qlv: number[] = [];
    for (let q = 0; q < 4; q++) qlv.push(owner(L, cx, cy, q)?.lv ?? -1);
    const stateAbove = (q: number, z: number) => {
      const p = quads[q]!;
      return qlv[q] === L ? solidAt(p, z) : solidAt(p, levels[L].zo + z / k);
    };
    const joined = (z: number) => {
      let s: boolean | null = null;
      for (let q = 0; q < 4; q++) {
        if (!quads[q]) continue;
        const v = stateAbove(q, z);
        if (s === null) s = v;
        else if (v !== s) return true;
      }
      return false;
    };
    const joinedBelow = (() => {
      let s: boolean | null = null;
      for (let q = 0; q < 4; q++) {
        if (!quads[q]) continue;
        const v = quads[q]!.top.length > 0 && solid(quads[q]!.mat[0]);
        if (s === null) s = v;
        else if (v !== s) return true;
      }
      return false;
    })();
    const clusters: SheetCluster[] = [];
    const parentBps: Set<number>[] = [];
    for (let i = 0; i < bps.length; i++) {
      if (i === 0 || !joined(bps[i - 1])) {
        clusters.push({ bps: [], bottomless: i === 0 && joinedBelow, z: 0, interp: false });
        parentBps.push(new Set());
      }
      clusters[clusters.length - 1].bps.push(bps[i]);
      if (fromParent.has(bps[i])) parentBps[parentBps.length - 1].add(bps[i]);
    }
    for (const c of clusters) {
      let sum = 0;
      for (const z of c.bps) sum += Math.floor(z * 8);
      c.z = fixMean(sum, c.bps.length);
    }
    const wx = cx / Math.pow(k, L);
    const wy = cy / Math.pow(k, L);
    // (a bit a side: an open edge is allowed along one side, not across a corner)
    const rootEdge = (wx === r.gx ? 1 : 0) | (wx === r.gx + r.n ? 2 : 0) | (wy === r.gy ? 4 : 0) | (wy === r.gy + r.n ? 8 : 0);
    return { L, cx, cy, clusters, rootEdge, levelEdge: L > 0 && onWinEdge(L, cx, cy), parentBps };
  };
  const raw = new Map<string, ReturnType<typeof lineRaw>>();
  const getRaw = (L: number, cx: number, cy: number) => {
    const key = lineKey(L, cx, cy);
    let l = raw.get(key);
    if (!l) raw.set(key, (l = lineRaw(L, cx, cy)));
    return l;
  };
  const clusterIndex = (l: SheetLine, z: number) => {
    const i = l.clusters.findIndex((c) => c.bps.includes(z));
    if (i < 0) throw new Error(`sheetMesh: no cluster holds ${z} on line ${l.L}:${l.cx}:${l.cy}`);
    return i;
  };
  const getLine = (L: number, cx: number, cy: number): SheetLine => {
    const key = lineKey(L, cx, cy);
    let l = lines.get(key);
    if (l) return l;
    const a = getRaw(L, cx, cy);
    // a child's edge line between two rim lines: clusters holding parent surfaces placed on the parent's edge
    const onX = cx === levels[L]?.gx || cx === (levels[L]?.gx ?? 0) + (levels[L]?.n ?? 0);
    const rim = cx % k === 0 && cy % k === 0;
    if (a.levelEdge && !rim) {
      const i = onX ? cy - fdiv(cy, k) * k : cx - fdiv(cx, k) * k;
      const P = onX ? getRaw(L, cx, fdiv(cy, k) * k) : getRaw(L, fdiv(cx, k) * k, cy);
      const Q = onX ? getRaw(L, cx, fdiv(cy, k) * k + k) : getRaw(L, fdiv(cx, k) * k + k, cy);
      a.clusters.forEach((c, ci) => {
        const ps = [...a.parentBps[ci]].sort((x, y) => x - y);
        if (!ps.length) return;
        let sum = 0;
        for (const z of ps) {
          const zp = fixOf(P.clusters[clusterIndex(P, z)].z);
          const zq = fixOf(Q.clusters[clusterIndex(Q, z)].z);
          sum += zp * k + (zq - zp) * i;
        }
        c.z = Math.floor(sum / (ps.length * k)) / SHEET_FIX;
        c.interp = true;
      });
    }
    lines.set(key, a);
    return a;
  };
  const tris: SheetTri[] = [];
  const pos = new Map<string, Vec3>();
  const vkey = (l: SheetLine, ci: number) => `${l.L}:${l.cx}:${l.cy}:${ci}`;
  const stats: SheetMesh['stats'] = [];
  // the polygon of a column, counter-clockwise from above: corners and the split points of an edge on a footprint
  const CORNERS = [0, 1, 3, 2];
  for (let L = 0; L < levels.length; L++) {
    const w = levels[L];
    const st = { L, drawn: 0, surfaces: 0, degenerate: 0, pairs: 0, layersGone: 0, fan: 0 };
    for (let Y = w.gy; Y < w.gy + w.n; Y++)
      for (let X = w.gx; X < w.gx + w.n; X++) {
        const ss = surfaces(L, X, Y);
        if (!ss.length) continue;
        st.drawn++;
        // the polygon: (level, cx, cy) of the lines in its own level's coordinates, canonical
        const poly: [number, number, number][] = [];
        const cornerAt: number[] = [];
        let split = -1;
        for (let e = 0; e < 4; e++) {
          cornerAt.push(poly.length);
          const c0 = CORNERS[e];
          const c1 = CORNERS[(e + 1) % 4];
          const ax = X + (c0 & 1);
          const ay = Y + (c0 >> 1);
          const bx = X + (c1 & 1);
          const by = Y + (c1 >> 1);
          const A = canon(L, ax, ay);
          const B = canon(L, bx, by);
          poly.push(A);
          if (A[0] === L + 1 && B[0] === L + 1) {
            split = e;
            for (let t = 1; t < k; t++) poly.push([L + 1, A[1] + ((B[1] - A[1]) / k) * t, A[2] + ((B[2] - A[2]) / k) * t]);
          }
        }
        // the quad's two triangles on its four corners (c0, c1, c3), (c0, c3, c2); then, along a split edge from corner A
        // to B (counter-clockwise), the zipper (A, s_t, s_t+1), t = 1 .. k - 1 (s_k = B): the same polygon cut into a
        // plain quad and a fan that closes the sliver between the straight edge and the child's vertices (the GPU's
        // child draws the zipper: every vertex of it is on the child's edge lines)
        const tri: [number, number, number][] = [
          [cornerAt[0], cornerAt[1], cornerAt[2]],
          [cornerAt[0], cornerAt[2], cornerAt[3]],
        ];
        if (split >= 0) for (let t = 1; t < k; t++) tri.push([cornerAt[split], (cornerAt[split] + t) % poly.length, (cornerAt[split] + t + 1) % poly.length]);
        // per surface: each polygon vertex's cluster
        const keys: (string[] | null)[][] = [];
        ss.forEach((s, j) => {
          st.surfaces++;
          const vk = poly.map(([cl, cx, cy]) => {
            const l = getLine(cl, cx, cy);
            const z = cl === L ? s.h : toKid(L, s.h);
            const ci = clusterIndex(l, z);
            const key = vkey(l, ci);
            if (!pos.has(key)) pos.set(key, toWorld(scene, cl, cx, cy, l.clusters[ci].z));
            return key;
          });
          keys.push(tri.map((t) => {
            const a = vk[t[0]];
            const b = vk[t[1]];
            const c = vk[t[2]];
            return a === b || b === c || a === c ? null : [a, b, c];
          }));
        });
        // the pair rule per triangle slot: a run of consecutive surfaces on the same three vertices keeps its top one
        // when the run is odd, none when even
        const kept: boolean[][] = ss.map(() => tri.map(() => true));
        for (let t = 0; t < tri.length; t++) {
          let j = 0;
          while (j < ss.length) {
            const kk = keys[j][t];
            if (!kk) {
              kept[j][t] = false;
              st.degenerate++;
              j++;
              continue;
            }
            const sk = [...kk].sort().join('|');
            let e = j + 1;
            while (e < ss.length && keys[e][t] && [...keys[e][t]!].sort().join('|') === sk) e++;
            for (let u = j; u < e; u++) kept[u][t] = (e - j) % 2 === 1 && u === e - 1;
            st.pairs += (e - j - ((e - j) % 2)) / 2;
            j = e;
          }
        }
        for (let j = 0; j + 1 < ss.length; j++) if (kept[j].every((x) => !x) && kept[j + 1].every((x) => !x)) st.layersGone++;
        ss.forEach((s, j) =>
          tri.forEach((t, ti) => {
            if (!kept[j][ti]) return;
            const [a, b, c] = keys[j][ti]!;
            const isFan = ti >= 2;
            if (isFan) st.fan++;
            tris.push({ v: s.up ? [a, b, c] : [a, c, b], L, X, Y, j, up: s.up, fan: isFan });
          }),
        );
      }
    stats.push(st);
  }
  return { tris, pos, lines, stats };
}

export interface SheetClosure {
  tris: number;
  /** directed edges not cancelled, by where they lie */
  openInterior: number;
  openRootEdge: number;
  /** between two bottomless clusters: the ceiling of a column that is air all the way down (open by design: the
   *  bottom is never drawn) */
  openBottom: number;
  openLevelEdge: number;
  /** edges used an odd number of times */
  odd: number;
  coincident: number;
  repeated: number;
  where: string[];
}
/** the sheet mesh's closure, exact by vertex identity: every directed edge cancelled except along the root window's edge */
export function sheetClosure(m: SheetMesh): SheetClosure {
  const dir = new Map<string, number>();
  const und = new Map<string, number>();
  const faces = new Map<string, number>();
  let repeated = 0;
  for (const t of m.tris) {
    const [a, b, c] = t.v;
    if (a === b || b === c || a === c) repeated++;
    const fk = [...t.v].sort().join('|');
    faces.set(fk, (faces.get(fk) ?? 0) + 1);
    for (let e = 0; e < 3; e++) {
      const p = t.v[e];
      const q = t.v[(e + 1) % 3];
      const uk = p < q ? `${p}#${q}` : `${q}#${p}`;
      und.set(uk, (und.get(uk) ?? 0) + 1);
      dir.set(uk, (dir.get(uk) ?? 0) + (p < q ? 1 : -1));
    }
  }
  const lineOf = (v: string) => m.lines.get(v.split(':').slice(0, 3).join(':'))!;
  let openInterior = 0;
  let openRootEdge = 0;
  let openBottom = 0;
  let openLevelEdge = 0;
  const where: string[] = [];
  for (const [uk, c] of dir) {
    if (c === 0) continue;
    const [p, q] = uk.split('#');
    const lp = lineOf(p);
    const lq = lineOf(q);
    const ip = +p.split(':')[3];
    const iq = +q.split(':')[3];
    if (lp.rootEdge & lq.rootEdge) openRootEdge++;
    else if (lp.clusters[ip].bottomless && lq.clusters[iq].bottomless) openBottom++;
    else {
      openInterior++;
      if (lp.levelEdge || lq.levelEdge) openLevelEdge++;
      if (where.length < 6) where.push(`${p} - ${q} (${c})`);
    }
  }
  let odd = 0;
  for (const c of und.values()) if (c % 2) odd++;
  let coincident = 0;
  for (const c of faces.values()) if (c > 1) coincident += c;
  return { tris: m.tris.length, openInterior, openRootEdge, openBottom, openLevelEdge, odd, coincident, repeated, where };
}
