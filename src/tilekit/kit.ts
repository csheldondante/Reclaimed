// (tilekit, docs/design/TILEKIT.md §4, §5, §10) A theme's modules, generated once on the CPU: wall panels (window,
// door, blank; ground and upper), the swept bands (plinth, band, cornice) and a corner stack (quoins or a timber post).
// A module vertex is (x along the panel with an anchor, w out of the wall, z up), metres: the vertex shader sweeps it
// along a cell edge with mitred ends (sweep.ts is the same on the CPU). Chamfered boxes so edges catch the light;
// per-vertex occlusion baked by rays against the module itself.

import type { Profile, RGB, Theme } from './theme';

/** x anchors: measured from the panel's start, from its end (backwards), from its middle, or a fraction of it */
export const A = { start: 0, end: 1, mid: 2, prop: 3, world: 4 } as const;
export interface X {
  v: number;
  a: number;
}
const S = (v: number): X => ({ v, a: A.start });
const E = (v: number): X => ({ v, a: A.end });
const M = (v: number): X => ({ v, a: A.mid });
/** x moved d metres along the panel */
const addX = (x: X, d: number): X => ({ v: x.a === A.end ? x.v - d : x.v + d, a: x.a });

/** materials (the fragment shader's) */
export const MAT = { wall: 0, trim: 1, glass: 2, roof: 3, ground: 4, wood: 5 } as const;

/** floats a vertex: x w z anchor | nx nw nz ao | r g b mat */
export const VF = 12;

/** the panel length modules are authored (and their occlusion baked) at */
export const LREF = 2.7;

export const along = (x: number, a: number, L: number): number => (a === A.end ? L - x : a === A.mid ? L / 2 + x : a === A.prop ? x * L : x);

type V3 = [number, number, number];
interface Pt {
  x: X;
  w: number;
  z: number;
}

export class ModuleBuilder {
  v: number[] = [];
  /** (step 2) lod ≥ 1: no chamfers anywhere (a box is its 5–6 faces) */
  constructor(readonly bevel: number, readonly lod = 0) {}

  private put(p: Pt, n: V3, col: RGB, mat: number) {
    this.v.push(p.x.v, p.w, p.z, p.x.a, n[0], n[1], n[2], 1, col[0], col[1], col[2], mat);
  }
  tri(a: Pt, b: Pt, c: Pt, n: V3, col: RGB, mat: number) {
    this.put(a, n, col, mat);
    this.put(b, n, col, mat);
    this.put(c, n, col, mat);
  }
  quad(a: Pt, b: Pt, c: Pt, d: Pt, n: V3, col: RGB, mat: number) {
    this.tri(a, b, c, n, col, mat);
    this.tri(a, c, d, n, col, mat);
  }
  /** a flat rectangle in the wall plane (w), facing out (+w) or in */
  wallRect(x0: X, x1: X, z0: number, z1: number, w: number, col: RGB, mat: number, n: V3 = [0, 1, 0]) {
    this.quad({ x: x0, w, z: z0 }, { x: x1, w, z: z0 }, { x: x1, w, z: z1 }, { x: x0, w, z: z1 }, n, col, mat);
  }
  /** a box [x0,x1]×[w0,w1]×[z0,z1] with every edge chamfered by the bevel (a chamfered box: 6 faces, 12 edge strips,
   *  8 corner triangles) */
  box(x0: X, x1: X, w0: number, w1: number, z0: number, z1: number, col: RGB, mat: number, bevel = this.bevel) {
    const b = this.lod > 0 ? 0 : Math.min(bevel, (w1 - w0) / 2.01, (z1 - z0) / 2.01);
    const xo = [x0, x1];
    const xi = [addX(x0, b), addX(x1, -b)];
    const wo = [w0, w1];
    const wi = [w0 + b, w1 - b];
    const zo = [z0, z1];
    const zi = [z0 + b, z1 - b];
    // a corner's three points: on its x face, its w face, its z face
    const px = (i: number, j: number, k: number): Pt => ({ x: xo[i], w: wi[j], z: zi[k] });
    const pw = (i: number, j: number, k: number): Pt => ({ x: xi[i], w: wo[j], z: zi[k] });
    const pz = (i: number, j: number, k: number): Pt => ({ x: xi[i], w: wi[j], z: zo[k] });
    const sg = (i: number) => (i ? 1 : -1);
    // (a box set into the wall — its back at or behind the face — has no back to draw: its −w face, the strips and
    // corners on that side skipped; about a third of a box's vertices)
    const js = w0 <= 1e-3 ? [1] : [0, 1];
    for (const i of [0, 1]) this.quad(px(i, 0, 0), px(i, 1, 0), px(i, 1, 1), px(i, 0, 1), [sg(i), 0, 0], col, mat);
    for (const j of js) this.quad(pw(0, j, 0), pw(1, j, 0), pw(1, j, 1), pw(0, j, 1), [0, sg(j), 0], col, mat);
    for (const k of [0, 1]) this.quad(pz(0, 0, k), pz(1, 0, k), pz(1, 1, k), pz(0, 1, k), [0, 0, sg(k)], col, mat);
    if (b <= 0) return;
    const r = Math.SQRT1_2;
    for (const i of [0, 1])
      for (const j of js) this.quad(px(i, j, 0), pw(i, j, 0), pw(i, j, 1), px(i, j, 1), [sg(i) * r, sg(j) * r, 0], col, mat);
    for (const i of [0, 1])
      for (const k of [0, 1]) this.quad(px(i, 0, k), pz(i, 0, k), pz(i, 1, k), px(i, 1, k), [sg(i) * r, 0, sg(k) * r], col, mat);
    for (const j of js)
      for (const k of [0, 1]) this.quad(pw(0, j, k), pz(0, j, k), pz(1, j, k), pw(1, j, k), [0, sg(j) * r, sg(k) * r], col, mat);
    const t = 1 / Math.sqrt(3);
    for (const i of [0, 1]) for (const j of js) for (const k of [0, 1]) this.tri(px(i, j, k), pw(i, j, k), pz(i, j, k), [sg(i) * t, sg(j) * t, sg(k) * t], col, mat);
  }
  /** a profile (w, z) swept from x0 to x1, z lifted by z0; flat-shaded a segment */
  sweep(pr: Profile, x0: X, x1: X, z0: number, mat = MAT.trim) {
    for (let i = 0; i + 1 < pr.pts.length; i++) {
      const [wa, za] = pr.pts[i];
      const [wb, zb] = pr.pts[i + 1];
      const dw = wb - wa;
      const dz = zb - za;
      const l = Math.hypot(dw, dz);
      if (l < 1e-6) continue;
      const n: V3 = [0, dz / l, -dw / l];
      this.quad({ x: x0, w: wa, z: z0 + za }, { x: x1, w: wa, z: z0 + za }, { x: x1, w: wb, z: z0 + zb }, { x: x0, w: wb, z: z0 + zb }, n, pr.col, mat);
    }
  }
  /** a prism over a quad in (x, z) (any shape: braces), from w0 to w1 */
  prismXZ(q: [X, number][], w0: number, w1: number, col: RGB, mat: number) {
    const f = (i: number, w: number): Pt => ({ x: q[i][0], w, z: q[i][1] });
    this.quad(f(0, w1), f(1, w1), f(2, w1), f(3, w1), [0, 1, 0], col, mat);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const ax = along(q[i][0].v, q[i][0].a, LREF);
      const bx = along(q[j][0].v, q[j][0].a, LREF);
      const dz = q[j][1] - q[i][1];
      const dx = bx - ax;
      const l = Math.hypot(dx, dz) || 1;
      this.quad(f(i, w0), f(j, w0), f(j, w1), f(i, w1), [dz / l, 0, -dx / l], col, mat);
    }
  }
}

export interface ModuleMesh {
  name: string;
  /** VF floats a vertex */
  verts: Float32Array;
  /** whether its occlusion saw the ground (storey 0) */
  ground: boolean;
}

export interface Opening {
  kind: 'window' | 'door' | 'blank';
}

/** a wall panel of height H: the face at w = 0 with the opening's hole, reveals, glass or leaf, frame, sill, shutters;
 *  timber rails, braces */
function wallModule(t: Theme, kind: 'window' | 'door' | 'blank', ground: boolean, lod = 0): ModuleBuilder {
  const H = ground ? t.groundH : t.storeyH;
  const mb = new ModuleBuilder(t.bevel, lod);
  const wallCol: RGB = ground && t.wall.ground ? t.wall.ground : [1, 1, 1];
  const wallMat = ground && t.wall.ground ? MAT.trim : MAT.wall;
  const s0 = S(0);
  const e0 = E(0);
  if (kind === 'blank') {
    mb.wallRect(s0, e0, 0, H, 0, wallCol, wallMat);
  } else if (lod >= 2) {
    // far: the wall in one sheet, the opening painted on it a hair proud (no hole, no reveals, no frame)
    const door = kind === 'door';
    const ow = door ? t.door.w : t.window.w;
    const z0 = door ? 0 : t.window.sill;
    const z1 = door ? t.door.h : t.window.sill + t.window.h;
    mb.wallRect(s0, e0, 0, H, 0, wallCol, wallMat);
    mb.wallRect(M(-ow / 2), M(ow / 2), z0, z1, 0.012, door ? t.door.col : t.window.glass, door ? MAT.wood : MAT.glass);
  } else {
    const door = kind === 'door';
    const ow = door ? t.door.w : t.window.w;
    const z0 = door ? 0 : t.window.sill;
    const z1 = door ? t.door.h : t.window.sill + t.window.h;
    const r = door ? t.door.recess : t.window.recess;
    const L = M(-ow / 2);
    const R = M(ow / 2);
    // the face round the hole
    mb.wallRect(s0, L, 0, H, 0, wallCol, wallMat);
    mb.wallRect(R, e0, 0, H, 0, wallCol, wallMat);
    if (z0 > 0) mb.wallRect(L, R, 0, z0, 0, wallCol, wallMat);
    mb.wallRect(L, R, z1, H, 0, wallCol, wallMat);
    // reveals (the wall's thickness, lit as wall)
    const rv: RGB = ground && t.wall.ground ? t.wall.ground : [0.92, 0.92, 0.92];
    mb.quad({ x: L, w: 0, z: z0 }, { x: L, w: -r, z: z0 }, { x: L, w: -r, z: z1 }, { x: L, w: 0, z: z1 }, [1, 0, 0], rv, wallMat);
    mb.quad({ x: R, w: 0, z: z0 }, { x: R, w: -r, z: z0 }, { x: R, w: -r, z: z1 }, { x: R, w: 0, z: z1 }, [-1, 0, 0], rv, wallMat);
    mb.quad({ x: L, w: 0, z: z1 }, { x: R, w: 0, z: z1 }, { x: R, w: -r, z: z1 }, { x: L, w: -r, z: z1 }, [0, 0, -1], rv, wallMat);
    if (z0 > 0) mb.quad({ x: L, w: 0, z: z0 }, { x: R, w: 0, z: z0 }, { x: R, w: -r, z: z0 }, { x: L, w: -r, z: z0 }, [0, 0, 1], rv, wallMat);
    // the back: glass with a cross, or the door's leaf with planks
    if (door) {
      mb.wallRect(L, R, z0, z1, -r, t.door.col, MAT.wood);
      for (let i = 1; i < 4 && lod === 0; i++) mb.box(M(-ow / 2 + (ow * i) / 4 - 0.015), M(-ow / 2 + (ow * i) / 4 + 0.015), -r, -r + 0.02, 0.05, z1 - 0.05, t.door.col, MAT.wood, 0);
      const f = t.door.frame;
      mb.box(M(-ow / 2 - f), L, 0, 0.06, 0, z1 + f, t.door.frameCol, MAT.trim);
      mb.box(R, M(ow / 2 + f), 0, 0.06, 0, z1 + f, t.door.frameCol, MAT.trim);
      mb.box(L, R, 0, 0.06, z1, z1 + f, t.door.frameCol, MAT.trim);
      // a step
      mb.box(M(-ow / 2 - 0.12), M(ow / 2 + 0.12), -r, 0.3, 0, 0.14, [0.72, 0.68, 0.6], MAT.trim);
    } else {
      mb.wallRect(L, R, z0, z1, -r, t.window.glass, MAT.glass);
      if (t.window.cross && lod === 0) {
        mb.box(M(-0.025), M(0.025), -r, -r + 0.05, z0, z1, t.window.frameCol, MAT.trim, 0.01);
        mb.box(L, R, -r, -r + 0.05, z0 + t.window.h * 0.62 - 0.025, z0 + t.window.h * 0.62 + 0.025, t.window.frameCol, MAT.trim, 0.01);
      }
      const f = t.window.frame;
      const fd = t.window.frameDepth;
      mb.box(M(-ow / 2 - f), L, -0.02, fd, z0, z1 + f, t.window.frameCol, MAT.trim);
      mb.box(R, M(ow / 2 + f), -0.02, fd, z0, z1 + f, t.window.frameCol, MAT.trim);
      mb.box(L, R, -0.02, fd, z1, z1 + f, t.window.frameCol, MAT.trim);
      mb.box(M(-ow / 2 - f - 0.06), M(ow / 2 + f + 0.06), -0.04, t.window.sillDepth, z0 - 0.09, z0 + 0.01, t.window.frameCol, MAT.trim);
      if (t.window.shutters) {
        const sw = ow * 0.5;
        const g = 0.03;
        mb.box(M(-ow / 2 - f - g - sw), M(-ow / 2 - f - g), 0, 0.045, z0 + 0.02, z1 - 0.02, t.window.shutters, MAT.trim, 0.015);
        mb.box(M(ow / 2 + f + g), M(ow / 2 + f + g + sw), 0, 0.045, z0 + 0.02, z1 - 0.02, t.window.shutters, MAT.trim, 0.015);
      }
    }
  }
  // the timber frame over the wall: rails at the floor and the head, braces on blank panels
  const tb = t.timber;
  if (tb && (!ground || tb.groundToo) && lod >= 2) {
    // far: the frame painted flat on the wall (rails, and studs either side of a window)
    mb.wallRect(s0, e0, 0, tb.rail, 0.01, tb.col, MAT.wood);
    mb.wallRect(s0, e0, H - tb.rail, H, 0.01, tb.col, MAT.wood);
    if (kind === 'window') {
      const ow = t.window.w / 2 + 0.05;
      mb.wallRect(M(-ow - 0.16), M(-ow), tb.rail, H - tb.rail, 0.01, tb.col, MAT.wood);
      mb.wallRect(M(ow), M(ow + 0.16), tb.rail, H - tb.rail, 0.01, tb.col, MAT.wood);
    }
  } else if (tb && (!ground || tb.groundToo)) {
    mb.box(s0, e0, 0, tb.depth, 0, tb.rail, tb.col, MAT.wood, 0.02);
    mb.box(s0, e0, 0, tb.depth, H - tb.rail, H, tb.col, MAT.wood, 0.02);
    if (kind === 'window') {
      // a rail under the windows, studs either side of the frame
      const ow = t.window.w + t.window.frame * 2;
      mb.box(s0, M(-ow / 2), 0, tb.depth, t.window.sill - 0.2, t.window.sill - 0.05, tb.col, MAT.wood, 0.02);
      mb.box(M(ow / 2), e0, 0, tb.depth, t.window.sill - 0.2, t.window.sill - 0.05, tb.col, MAT.wood, 0.02);
      mb.box(M(-ow / 2 - 0.16), M(-ow / 2), 0, tb.depth, tb.rail, H - tb.rail, tb.col, MAT.wood, 0.02);
      mb.box(M(ow / 2), M(ow / 2 + 0.16), 0, tb.depth, tb.rail, H - tb.rail, tb.col, MAT.wood, 0.02);
    }
    if (kind === 'blank' && tb.braces) {
      // two braces leaning in from the ends (end-anchored and start-anchored: metric whatever the panel's length)
      const bw = 0.16;
      const run = Math.min(0.95, H * 0.42);
      mb.prismXZ([[S(tb.post), tb.rail], [S(tb.post + bw), tb.rail], [S(tb.post + run + bw), H - tb.rail], [S(tb.post + run), H - tb.rail]], 0, tb.depth * 0.8, tb.col, MAT.wood);
      mb.prismXZ([[E(tb.post + bw), tb.rail], [E(tb.post), tb.rail], [E(tb.post + run), H - tb.rail], [E(tb.post + run + bw), H - tb.rail]], 0, tb.depth * 0.8, tb.col, MAT.wood);
    }
  }
  return mb;
}

/** the corner stack at a panel's end (mirrored by the instance for its start, `phase` 1 there so the two faces of a
 *  corner alternate long and short): quoins, or half a timber post (the two halves make one post on the joint) */
function cornerModule(t: Theme, ground: boolean, phase: number, lod = 0): ModuleBuilder | null {
  const H = ground ? t.groundH : t.storeyH;
  const mb = new ModuleBuilder(t.bevel, lod);
  if (lod >= 2) {
    // far: no quoins; a timber post as a flat strip
    if (t.timber && !t.quoins && (!ground || t.timber.groundToo)) mb.wallRect(E(t.timber.post / 2), E(0), 0, H, 0.01, t.timber.col, MAT.wood);
    return mb;
  }
  if (t.quoins) {
    const q = t.quoins;
    let z = ground ? t.plinth.pts[t.plinth.pts.length - 1][1] : 0;
    let i = (ground ? 0 : 1) + phase;
    while (z + q.h <= H + 1e-3) {
      const len = i % 2 ? q.short : q.long;
      if (lod >= 1) {
        // mid: a block as the two faces that show — its front and its inner side (the end at the corner lies in the
        // mitre plane, hidden by the other face's block): 12 vertices, not a box's 30 (or ~130 chamfered)
        mb.quad({ x: E(len), w: q.depth, z: z + 0.015 }, { x: E(0), w: q.depth, z: z + 0.015 }, { x: E(0), w: q.depth, z: z + q.h - 0.015 }, { x: E(len), w: q.depth, z: z + q.h - 0.015 }, [0, 1, 0], q.col, MAT.trim);
        mb.quad({ x: E(len), w: 0, z: z + 0.015 }, { x: E(len), w: q.depth, z: z + 0.015 }, { x: E(len), w: q.depth, z: z + q.h - 0.015 }, { x: E(len), w: 0, z: z + q.h - 0.015 }, [-1, 0, 0], q.col, MAT.trim);
      } else mb.box(E(len), E(0), 0, q.depth, z + 0.015, z + q.h - 0.015, q.col, MAT.trim);
      z += q.h;
      i++;
    }
    return mb;
  }
  if (t.timber && (!ground || t.timber.groundToo)) {
    mb.box(E(t.timber.post / 2), E(0), 0, t.timber.depth, 0, H, t.timber.col, MAT.wood, 0.025);
    return mb;
  }
  return null;
}

/** the module set of a theme: name → mesh (occlusion baked) */
export function buildKit(t: Theme, bake = true, lod = 0): ModuleMesh[] {
  const out: ModuleMesh[] = [];
  const add = (name: string, mb: ModuleBuilder | null, ground: boolean) => {
    // (an empty module is still listed: the far kit has no quoins, and instances asking for them draw nothing)
    const verts = new Float32Array(mb?.v ?? []);
    if (bake && verts.length) bakeAO(verts, ground);
    out.push({ name, verts, ground });
  };
  for (const g of [true, false]) {
    const tag = g ? 'ground' : 'upper';
    add(`wall-window-${tag}`, wallModule(t, 'window', g, lod), g);
    add(`wall-blank-${tag}`, wallModule(t, 'blank', g, lod), g);
    add(`corner-${tag}`, cornerModule(t, g, 0, lod), g);
    add(`corner-${tag}-alt`, cornerModule(t, g, 1, lod), g);
  }
  add('wall-door', wallModule(t, 'door', true, lod), true);
  // (far: each profile reduced to its bounding step — out, up, in)
  const prof = (pr: Profile): Profile => {
    if (lod < 2) return pr;
    const ws = pr.pts.map((p) => p[0]);
    const zs = pr.pts.map((p) => p[1]);
    const w = Math.max(...ws);
    const z0 = Math.min(...zs);
    const z1 = Math.max(...zs);
    return { pts: [[0, z0], [w, z0], [w, z1], [0, z1]], col: pr.col };
  };
  const p = new ModuleBuilder(t.bevel, lod);
  p.sweep(prof(t.plinth), S(0), E(0), 0);
  add('plinth', p, true);
  const b = new ModuleBuilder(t.bevel, lod);
  if (t.band) b.sweep(prof(t.band), S(0), E(0), 0);
  add('band', b, false);
  const c = new ModuleBuilder(t.bevel, lod);
  c.sweep(prof(t.cornice), S(0), E(0), 0);
  add('cornice', c, false);
  return out;
}

// ---- baked occlusion: rays from each vertex against the module's own triangles (at LREF), the ground for storey 0 ----

const RAYS = 16;
const REACH = 0.8;
/** cosine-weighted directions round +z (a fixed spiral) */
const DIRS: V3[] = Array.from({ length: RAYS }, (_, i) => {
  const u = (i + 0.5) / RAYS;
  const r = Math.sqrt(u);
  const ph = i * 2.39996;
  return [r * Math.cos(ph), r * Math.sin(ph), Math.sqrt(1 - u)];
});

export function bakeAO(v: Float32Array, ground: boolean): void {
  const n = v.length / VF;
  const P = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    P[i * 3] = along(v[i * VF], v[i * VF + 3], LREF);
    P[i * 3 + 1] = v[i * VF + 1];
    P[i * 3 + 2] = v[i * VF + 2];
  }
  const nt = n / 3;
  // each triangle's box for a cheap reject
  const bb = new Float64Array(nt * 6);
  for (let t = 0; t < nt; t++) {
    for (let a = 0; a < 3; a++) {
      bb[t * 6 + a] = Math.min(P[t * 9 + a], P[t * 9 + 3 + a], P[t * 9 + 6 + a]);
      bb[t * 6 + 3 + a] = Math.max(P[t * 9 + a], P[t * 9 + 3 + a], P[t * 9 + 6 + a]);
    }
  }
  for (let i = 0; i < n; i++) {
    const nx = v[i * VF + 4];
    const ny = v[i * VF + 5];
    const nz = v[i * VF + 6];
    // a basis round the normal
    const tx = Math.abs(nz) < 0.9 ? [-ny, nx, 0] : [0, -nz, ny];
    const tl = Math.hypot(tx[0], tx[1], tx[2]);
    const t1 = [tx[0] / tl, tx[1] / tl, tx[2] / tl];
    const t2 = [ny * t1[2] - nz * t1[1], nz * t1[0] - nx * t1[2], nx * t1[1] - ny * t1[0]];
    const ox = P[i * 3] + nx * 0.01;
    const oy = P[i * 3 + 1] + ny * 0.01;
    const oz = P[i * 3 + 2] + nz * 0.01;
    let hit = 0;
    for (const d of DIRS) {
      const dx = t1[0] * d[0] + t2[0] * d[1] + nx * d[2];
      const dy = t1[1] * d[0] + t2[1] * d[1] + ny * d[2];
      const dz = t1[2] * d[0] + t2[2] * d[1] + nz * d[2];
      if (ground && dz < 0 && oz + dz * REACH < 0) {
        hit++;
        continue;
      }
      if (rayHits(P, bb, nt, ox, oy, oz, dx, dy, dz)) hit++;
    }
    v[i * VF + 7] = 1 - (hit / RAYS) * 0.9;
  }
}

function rayHits(P: Float64Array, bb: Float64Array, nt: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): boolean {
  const ex = ox + dx * REACH;
  const ey = oy + dy * REACH;
  const ez = oz + dz * REACH;
  const lx = Math.min(ox, ex);
  const hx = Math.max(ox, ex);
  const ly = Math.min(oy, ey);
  const hy = Math.max(oy, ey);
  const lz = Math.min(oz, ez);
  const hz = Math.max(oz, ez);
  for (let t = 0; t < nt; t++) {
    const o = t * 6;
    if (bb[o] > hx || bb[o + 3] < lx || bb[o + 1] > hy || bb[o + 4] < ly || bb[o + 2] > hz || bb[o + 5] < lz) continue;
    const a = t * 9;
    const e1x = P[a + 3] - P[a];
    const e1y = P[a + 4] - P[a + 1];
    const e1z = P[a + 5] - P[a + 2];
    const e2x = P[a + 6] - P[a];
    const e2y = P[a + 7] - P[a + 1];
    const e2z = P[a + 8] - P[a + 2];
    const px = dy * e2z - dz * e2y;
    const py = dz * e2x - dx * e2z;
    const pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const sx = ox - P[a];
    const sy = oy - P[a + 1];
    const sz = oz - P[a + 2];
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y;
    const qy = sz * e1x - sx * e1z;
    const qz = sx * e1y - sy * e1x;
    const w = (dx * qx + dy * qy + dz * qz) * inv;
    if (w < 0 || u + w > 1) continue;
    const d = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (d > 1e-4 && d < REACH) return true;
  }
  return false;
}
