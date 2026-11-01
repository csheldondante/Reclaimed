// The purposes' and the dressing's modules (round 120, `cities`; BACKLOG STR32, STR33, STR36), made in code as the rest
// of the library (modules.ts). Two kinds of frame:
//  - tile frames (u, v, w ∈ [0, 1], warped into a quad as every building piece is): the quay's edge, kerbs, a pier's deck
//    and piles, the lighthouse, the headframe, the windmill, the light pool;
//  - metres (affine pieces, any heading — assets.ts AFFINE): the props (log piles, logs, stalls, wagons, crates, cranes,
//    spoil, ore carts, banners, torches, waterwheels, haystacks, troughs), the ships and the windmill's sails. A prop's
//    module is made at a canonical size (`PROP_SIZE`) and scaled to the prop's.
// Cloth (banners, sails, a wagon's hood) is its own part so a host can move it with the wind (structmesh.wgsl WIND);
// a flame is its own so it flickers; a lamp's glass glows.
import { Kit, Part, type Module } from './modules';

/** a prop module's canonical size (m): the prop's `size` over this is its scale */
export const PROP_SIZE: Record<string, number> = {
  logpile: 3.2,
  log: 3.5,
  stall: 2.8,
  wagon: 3.6,
  crates: 1.6,
  crane: 7,
  spoil: 6,
  cart: 1.6,
  banner: 6,
  torch: 2.3,
  waterwheel: 4.2,
  haystack: 2.6,
  trough: 2,
};

/** a quad seen from both sides (thin things: cloth, spokes, a rim — the hosts cull back faces) */
function q2(k: Kit, a: number[], b: number[], c: number[], d: number[], part: Part): void {
  k.quad(a, b, c, d, part);
  k.quad(a, d, c, b, part);
}

/** a horizontal cylinder along x (n sides), centre (y, z), radius r */
function xcyl(k: Kit, x0: number, x1: number, y: number, z: number, r: number, n: number, part: Part, caps = true): void {
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    const P = (x: number, a: number) => [x, y + Math.cos(a) * r, z + Math.sin(a) * r];
    k.quad(P(x0, a0), P(x0, a1), P(x1, a1), P(x1, a0), part);
    if (caps) {
      k.tri([x1, y, z], P(x1, a0), P(x1, a1), part);
      k.tri([x0, y, z], P(x0, a1), P(x0, a0), part);
    }
  }
}

/** a disc (a wheel) in the x-z plane, `t` thick along y, centre (x, y, z), radius r */
function ydisc(k: Kit, x: number, y: number, z: number, r: number, t: number, n: number, part: Part): void {
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    const P = (a: number, yy: number) => [x + Math.cos(a) * r, yy, z + Math.sin(a) * r];
    k.quad(P(a0, y - t / 2), P(a0, y + t / 2), P(a1, y + t / 2), P(a1, y - t / 2), part);
    k.tri([x, y + t / 2, z], P(a1, y + t / 2), P(a0, y + t / 2), part);
    k.tri([x, y - t / 2, z], P(a0, y - t / 2), P(a1, y - t / 2), part);
  }
}

/** a lathe about the vertical through (cx, cy): (radius, z) bottom to top */
function lathe(k: Kit, prof: [number, number][], n: number, part: Part, cx = 0, cy = 0, rs = 1): void {
  for (let i = 0; i + 1 < prof.length; i++)
    for (let s = 0; s < n; s++) {
      const a0 = (s / n) * Math.PI * 2;
      const a1 = ((s + 1) / n) * Math.PI * 2;
      const P = (r: number, z: number, a: number) => [cx + Math.cos(a) * r * rs, cy + Math.sin(a) * r, z];
      k.quad(P(prof[i][0], prof[i][1], a0), P(prof[i][0], prof[i][1], a1), P(prof[i + 1][0], prof[i + 1][1], a1), P(prof[i + 1][0], prof[i + 1][1], a0), part);
    }
}

// ------------------------------------------------------------------ props (metres; x along the heading, z up)

function logpile(): Module {
  const k = new Kit();
  const r = 0.22;
  const rows = [4, 3, 2];
  rows.forEach((n, j) => {
    for (let i = 0; i < n; i++) {
      const y = (i - (n - 1) / 2) * r * 2.02;
      xcyl(k, -1.6 + j * 0.05, 1.6 - ((i + j) % 2) * 0.12, y, r + j * r * 1.75, r, 7, Part.Plank);
    }
  });
  // stakes either side
  for (const y of [-r * 4.4, r * 4.4]) for (const x of [-1.2, 1.2]) k.box(x - 0.05, x + 0.05, y - 0.05, y + 0.05, 0, 1.1, Part.Trim);
  return k.done('prop:logpile');
}

function log(): Module {
  const k = new Kit();
  xcyl(k, -1.75, 1.75, 0, 0.12, 0.26, 8, Part.Plank);
  return k.done('prop:log');
}

function stall(): Module {
  const k = new Kit();
  for (const [x, y] of [[-1.3, -0.9], [1.3, -0.9], [-1.3, 0.9], [1.3, 0.9]]) k.box(x - 0.06, x + 0.06, y - 0.06, y + 0.06, 0, y < 0 ? 2.5 : 2.1, Part.Trim);
  // the counter at the front (+x), goods on it
  k.box(-1.3, 1.3, 0.55, 0.95, 0, 0.95, Part.Plank);
  for (let i = 0; i < 4; i++) k.box(-1.1 + i * 0.6, -0.75 + i * 0.6, 0.6, 0.9, 0.95, 1.15, i % 2 ? Part.Crop : Part.Awning);
  // the awning: a slope from the back down over the front, and a scalloped valance
  k.quad([-1.45, -1.05, 2.55], [1.45, -1.05, 2.55], [1.45, 1.2, 2.1], [-1.45, 1.2, 2.1], Part.Awning);
  k.quad([-1.45, -1.05, 2.55], [-1.45, 1.2, 2.1], [1.45, 1.2, 2.1], [1.45, -1.05, 2.55], Part.Awning);
  k.box(-1.45, 1.45, 1.18, 1.22, 1.85, 2.1, Part.Awning);
  return k.done('prop:stall');
}

function wagon(): Module {
  const k = new Kit();
  k.box(-1.3, 1.3, -0.7, 0.7, 0.62, 0.72, Part.Plank);
  k.box(-1.3, 1.3, -0.72, -0.66, 0.72, 1.05, Part.Plank);
  k.box(-1.3, 1.3, 0.66, 0.72, 0.72, 1.05, Part.Plank);
  k.box(1.24, 1.3, -0.7, 0.7, 0.72, 1.05, Part.Plank);
  for (const x of [-0.9, 0.9]) for (const y of [-0.78, 0.78]) ydisc(k, x, y, 0.45, 0.45, 0.08, 10, Part.Trim);
  // the hood: hoops of canvas
  const n = 6;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI;
    const a1 = ((i + 1) / n) * Math.PI;
    const P = (x: number, a: number) => [x, Math.cos(a) * 0.72, 1.05 + Math.sin(a) * 0.75];
    q2(k, P(-1.2, a1), P(-1.2, a0), P(1.0, a0), P(1.0, a1), Part.Cloth);
  }
  // the shaft forward
  k.box(1.3, 2.4, -0.04, 0.04, 0.55, 0.62, Part.Trim);
  return k.done('prop:wagon');
}

function crates(): Module {
  const k = new Kit();
  k.box(-0.8, 0, -0.5, 0.3, 0, 0.8, Part.Plank);
  k.box(0.05, 0.75, -0.6, 0.1, 0, 0.7, Part.Plank);
  k.box(-0.6, 0.1, -0.35, 0.3, 0.8, 1.4, Part.Plank);
  lathe(k, [[0.3, 0], [0.36, 0.45], [0.3, 0.9], [0.0, 0.9]], 8, Part.Trim, 0.4, 0.55);
  return k.done('prop:crates');
}

function crane(): Module {
  const k = new Kit();
  k.box(-0.3, 0.3, -0.3, 0.3, 0, 0.5, Part.Stone);
  k.box(-0.15, 0.15, -0.15, 0.15, 0.5, 6.2, Part.Trim);
  // the jib out over the water (+x), a brace, the rope and a hanging bale
  k.quad([0, -0.1, 6.0], [4.2, -0.1, 5.2], [4.2, 0.1, 5.2], [0, 0.1, 6.0], Part.Trim);
  k.quad([0, -0.1, 6.0], [0, 0.1, 6.0], [4.2, 0.1, 5.2], [4.2, -0.1, 5.2], Part.Trim);
  k.box(0, 0.12, -0.08, 0.08, 6, 6.25, Part.Trim);
  q2(k, [0.1, -0.06, 3.6], [2.6, -0.06, 5.55], [2.6, 0.06, 5.55], [0.1, 0.06, 3.6], Part.Trim);
  k.box(4.1, 4.14, -0.02, 0.02, 2.6, 5.2, Part.Metal);
  k.box(3.7, 4.55, -0.4, 0.4, 1.9, 2.6, Part.Plank);
  return k.done('prop:crane');
}

function spoil(): Module {
  const k = new Kit();
  // a lumpy heap: rings at each height, pushed in and out by angle
  const n = 12;
  const rings: [number, number][] = [[1, 0], [0.85, 0.2], [0.6, 0.42], [0.32, 0.6], [0.08, 0.68]];
  for (let i = 0; i + 1 < rings.length; i++)
    for (let s = 0; s < n; s++) {
      const a0 = (s / n) * Math.PI * 2;
      const a1 = ((s + 1) / n) * Math.PI * 2;
      const j = (a: number, r: number) => r * (0.86 + 0.14 * Math.sin(a * 3 + i * 1.7));
      const P = (r: number, z: number, a: number) => [Math.cos(a) * j(a, r) * 3, Math.sin(a) * j(a, r) * 3, z * 3];
      k.quad(P(rings[i][0], rings[i][1], a0), P(rings[i][0], rings[i][1], a1), P(rings[i + 1][0], rings[i + 1][1], a1), P(rings[i + 1][0], rings[i + 1][1], a0), Part.Stone);
    }
  return k.done('prop:spoil');
}

function cart(): Module {
  const k = new Kit();
  k.quad([-0.7, -0.45, 0.35], [0.7, -0.45, 0.35], [0.8, -0.55, 0.95], [-0.8, -0.55, 0.95], Part.Metal);
  k.quad([0.7, 0.45, 0.35], [-0.7, 0.45, 0.35], [-0.8, 0.55, 0.95], [0.8, 0.55, 0.95], Part.Metal);
  k.quad([0.7, -0.45, 0.35], [0.7, 0.45, 0.35], [0.8, 0.55, 0.95], [0.8, -0.55, 0.95], Part.Metal);
  k.quad([-0.7, 0.45, 0.35], [-0.7, -0.45, 0.35], [-0.8, -0.55, 0.95], [-0.8, 0.55, 0.95], Part.Metal);
  // the ore heaped in it
  k.quad([-0.75, -0.5, 0.9], [0.75, -0.5, 0.9], [0.3, 0, 1.2], [-0.3, 0, 1.2], Part.Stone);
  k.quad([0.75, 0.5, 0.9], [-0.75, 0.5, 0.9], [-0.3, 0, 1.2], [0.3, 0, 1.2], Part.Stone);
  for (const x of [-0.45, 0.45]) for (const y of [-0.42, 0.42]) ydisc(k, x, y, 0.2, 0.18, 0.06, 8, Part.Metal);
  return k.done('prop:cart');
}

/** a banner on a pole: the cloth hangs from the pole's top along +x (WIND: the host turns it downwind and flutters it) */
function banner(): Module {
  const k = new Kit();
  k.cyl(0, 0, 0.05, 0.05, 0, 6, 6, Part.Trim);
  lathe(k, [[0.0, 6.0], [0.1, 6.08], [0.0, 6.25]], 6, Part.Metal);
  // the cloth: a grid of quads (so it can bend), 2.6 long, 1.6 deep, a swallowtail
  const L = 2.6;
  const N = 6;
  const top = 5.85;
  const drop = (u: number) => 1.6 - (u > 0.75 ? (u - 0.75) * 2.4 : 0);
  for (let i = 0; i < N; i++) {
    const u0 = i / N;
    const u1 = (i + 1) / N;
    k.quad([u0 * L, 0, top - drop(u0)], [u1 * L, 0, top - drop(u1)], [u1 * L, 0, top], [u0 * L, 0, top], Part.Cloth);
    k.quad([u0 * L, 0, top], [u1 * L, 0, top], [u1 * L, 0, top - drop(u1)], [u0 * L, 0, top - drop(u0)], Part.Cloth);
  }
  return k.done('prop:banner');
}

function torch(): Module {
  const k = new Kit();
  k.box(-0.03, 0.03, -0.03, 0.03, 0, 1.95, Part.Metal);
  lathe(k, [[0.03, 1.9], [0.11, 2.0], [0.12, 2.05]], 6, Part.Metal);
  // the flame: a teardrop
  lathe(k, [[0.1, 2.02], [0.13, 2.12], [0.08, 2.24], [0.0, 2.36]], 6, Part.Flame);
  return k.done('prop:torch');
}

/** a waterwheel: its hub at the origin, its plane x-z, the axle along y (into the wall); spun by the host (SPIN) */
function waterwheel(): Module {
  const k = new Kit();
  const R = 2.1;
  const n = 12;
  for (const y of [-0.35, 0.35]) {
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      const P = (a: number, r: number, yy: number) => [Math.cos(a) * r, yy, Math.sin(a) * r];
      q2(k, P(a0, R, y - 0.05), P(a1, R, y - 0.05), P(a1, R, y + 0.05), P(a0, R, y + 0.05), Part.Trim);
      q2(k, P(a0, R - 0.15, y + 0.05), P(a1, R - 0.15, y + 0.05), P(a1, R - 0.15, y - 0.05), P(a0, R - 0.15, y - 0.05), Part.Trim);
      q2(k, P(a0, R - 0.15, y + 0.05), P(a0, R, y + 0.05), P(a1, R, y + 0.05), P(a1, R - 0.15, y + 0.05), Part.Trim);
      q2(k, P(a1, R - 0.15, y - 0.05), P(a1, R, y - 0.05), P(a0, R, y - 0.05), P(a0, R - 0.15, y - 0.05), Part.Trim);
    }
  }
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    // a spoke each side and a paddle across
    q2(k, [0, -0.33, 0], [c * R, -0.33, s * R], [c * R, -0.27, s * R + 0.01], [0, -0.27, 0.01], Part.Trim);
    q2(k, [0, 0.27, 0], [c * R, 0.27, s * R], [c * R, 0.33, s * R + 0.01], [0, 0.33, 0.01], Part.Trim);
    const r0 = R - 0.6;
    q2(k, [c * r0, -0.4, s * r0], [c * R, -0.4, s * R], [c * R, 0.4, s * R], [c * r0, 0.4, s * r0], Part.Plank);
    q2(k, [c * r0, 0.4, s * r0], [c * R, 0.4, s * R], [c * R, -0.4, s * R], [c * r0, -0.4, s * r0], Part.Plank);
  }
  ydisc(k, 0, 0, 0, 0.25, 1.1, 8, Part.Trim);
  return k.done('prop:waterwheel');
}

function haystack(): Module {
  const k = new Kit();
  lathe(k, [[1.25, 0], [1.3, 0.6], [1.15, 1.3], [0.7, 2.0], [0.0, 2.35]], 10, Part.Thatch);
  return k.done('prop:haystack');
}

function trough(): Module {
  const k = new Kit();
  k.box(-1, 1, -0.4, 0.4, 0, 0.6, Part.Plank, 32);
  k.box(-0.92, 0.92, -0.32, 0.32, 0.45, 0.5, Part.Water);
  return k.done('prop:trough');
}

/** the windmill's sails: hub at the origin, in the x-z plane, the axle along y; spun by the host (SPIN) */
function millSails(): Module {
  const k = new Kit();
  ydisc(k, 0, 0, 0, 0.3, 0.6, 8, Part.Trim);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.3;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const P = (r: number, w: number, y: number) => [c * r - s * w, y, s * r + c * w];
    // the stock, then the lattice frame with its sailcloth
    k.quad(P(0.2, -0.08, -0.32), P(5.4, -0.08, -0.32), P(5.4, 0.08, -0.32), P(0.2, 0.08, -0.32), Part.Trim);
    k.quad(P(0.2, 0.08, -0.32), P(5.4, 0.08, -0.32), P(5.4, -0.08, -0.32), P(0.2, -0.08, -0.32), Part.Trim);
    k.quad(P(1.0, 0.1, -0.36), P(5.2, 0.1, -0.36), P(5.2, 1.1, -0.36), P(1.0, 1.1, -0.36), Part.Cloth);
    k.quad(P(1.0, 1.1, -0.36), P(5.2, 1.1, -0.36), P(5.2, 0.1, -0.36), P(1.0, 0.1, -0.36), Part.Cloth);
    for (let j = 0; j <= 4; j++) {
      const r = 1.0 + j * 1.05;
      q2(k, P(r - 0.03, 0.08, -0.38), P(r + 0.03, 0.08, -0.38), P(r + 0.03, 1.12, -0.38), P(r - 0.03, 1.12, -0.38), Part.Trim);
    }
  }
  return k.done('prop:millsails');
}

// ------------------------------------------------------------------ ships (metres; bow +x, the waterline z = 0)

/** a hull lofted through stations: half-beam, keel depth and sheer along x; a transom at the stern */
function hull(k: Kit, L: number, B: number, D: number, F: number, pointed: number): void {
  const N = 12;
  const half = L / 2;
  const st = (i: number) => {
    const x = -half + (L * i) / N;
    const t = x / half;
    const b = t > 0 ? B * Math.sqrt(Math.max(0, 1 - Math.pow(t, pointed))) : B * (1 - 0.3 * t * t);
    const d = D * (1 - 0.55 * t * t);
    const s = F + 0.35 * t * t;
    return { x, b, d, s };
  };
  // a section's points: gunwale, waterline, bilge, keel (one side; y > 0)
  const sec = (q: ReturnType<typeof st>): number[][] => [
    [q.x, q.b, q.s],
    [q.x, q.b * 0.96, 0],
    [q.x, q.b * 0.6, -q.d * 0.72],
    [q.x, 0, -q.d],
  ];
  for (let i = 0; i < N; i++) {
    const a = sec(st(i));
    const b = sec(st(i + 1));
    for (let j = 0; j < 3; j++) {
      k.quad(a[j], b[j], b[j + 1], a[j + 1], Part.Plank);
      const m = (p: number[]) => [p[0], -p[1], p[2]];
      k.quad(m(a[j]), m(a[j + 1]), m(b[j + 1]), m(b[j]), Part.Plank);
    }
    // the deck and the gunwale's cap
    const qa = st(i);
    const qb = st(i + 1);
    k.quad([qa.x, -qa.b * 0.94, F - 0.25], [qb.x, -qb.b * 0.94, F - 0.25], [qb.x, qb.b * 0.94, F - 0.25], [qa.x, qa.b * 0.94, F - 0.25], Part.Plank);
    for (const sgn of [1, -1]) q2(k, [qa.x, sgn * qa.b, qa.s + 0.08], [qb.x, sgn * qb.b, qb.s + 0.08], [qb.x, sgn * qb.b * 0.9, qb.s + 0.08], [qa.x, sgn * qa.b * 0.9, qa.s + 0.08], Part.Trim);
  }
  // the transom
  const s0 = sec(st(0));
  const m0 = s0.map((p) => [p[0], -p[1], p[2]]);
  for (let j = 0; j < 3; j++) k.quad(s0[j], s0[j + 1], m0[j + 1], m0[j], Part.Plank);
}

function ship(kind: 'cog' | 'sloop' | 'barge'): Module {
  const k = new Kit();
  if (kind === 'barge') {
    hull(k, 12, 2.0, 0.7, 0.7, 6);
    for (let i = 0; i < 4; i++) xcyl(k, -4.5, 4, (i - 1.5) * 0.48, 0.75 + (i % 2) * 0.1, 0.24, 7, Part.Plank);
    return k.done('ship:barge');
  }
  const cog = kind === 'cog';
  const B = cog ? 2.2 : 1.6;
  hull(k, 12, B, cog ? 1.5 : 1.1, cog ? 1.3 : 1.0, cog ? 2 : 1.6);
  const F = cog ? 1.3 : 1.0;
  if (cog) {
    // the aftcastle and its rail, the lantern on its stern
    k.box(-6, -3.6, -B * 0.95, B * 0.95, F - 0.25, F + 1.2, Part.Plank);
    k.box(-6, -3.6, -B * 0.95, B * 0.95, F + 1.2, F + 1.3, Part.Trim);
    k.box(-6.35, -6.05, -0.15, 0.15, F + 1.3, F + 1.75, Part.Lamp);
  } else k.box(-6.2, -5.9, -0.12, 0.12, F + 0.6, F + 1.0, Part.Lamp);
  const mx = cog ? 0.5 : 1.2;
  const H = cog ? 11 : 9;
  k.cyl(mx, 0, 0.17, 0.17, F - 0.3, H, 6, Part.Trim);
  if (cog) {
    // a square sail on a yard, bellied forward
    k.box(mx + 0.1, mx + 0.3, -3.3, 3.3, H - 1.5, H - 1.3, Part.Trim);
    const rows = 4;
    const cols = 4;
    const P = (i: number, j: number) => {
      const y = -3.1 + (6.2 * j) / cols;
      const z = H - 1.5 - (5.4 * i) / rows;
      const belly = 0.9 * Math.sin((Math.PI * j) / cols) * Math.sin((Math.PI * i) / rows + 0.4);
      return [mx + 0.3 + belly, y, z];
    };
    for (let i = 0; i < rows; i++)
      for (let j = 0; j < cols; j++) {
        k.quad(P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1), Part.Cloth);
        k.quad(P(i, j), P(i, j + 1), P(i + 1, j + 1), P(i + 1, j), Part.Cloth);
      }
  } else {
    // a gaff sail aft of the mast, a jib forward
    const sail = (a: number[], b: number[], c: number[], d: number[]) => {
      k.quad(a, b, c, d, Part.Cloth);
      k.quad(a, d, c, b, Part.Cloth);
    };
    sail([mx - 0.2, 0, F + 0.6], [mx - 4.6, 0, F + 0.7], [mx - 4.2, 0, H - 2.2], [mx - 0.2, 0, H - 0.4]);
    k.box(mx - 4.8, mx - 0.2, -0.06, 0.06, F + 0.55, F + 0.68, Part.Trim);
    sail([mx + 0.2, 0, F + 0.4], [5.6, 0, F + 0.5], [mx + 0.25, 0, H - 0.6], [mx + 0.2, 0, H - 0.6]);
  }
  return k.done(`ship:${kind}`);
}

// ------------------------------------------------------------------ tile-frame modules

/** a quay's edge: dressed stone down to the bed (side frame; v 0 the water's face), a coping lip */
function quayEdge(): Module {
  const k = new Kit();
  k.box(0, 1, 0, 1, 0, 1, Part.Stone, 1 | 2 | 16);
  k.box(0, 1, -0.12, 1.02, 0.94, 1.03, Part.Stone, 1 | 2);
  return k.done('quayedge');
}

/** a kerb along a street's side (side frame; its top a height over the ground) */
function kerb(): Module {
  const k = new Kit();
  k.box(0, 1, 0, 1, 0, 1, Part.Stone, 1 | 2 | 16);
  return k.done('kerb');
}

/** a pier's deck along a segment (frame: across it; its top a height over its foot — planks, then posts and a rail) */
function pierDeck(): Module {
  const k = new Kit();
  // (w: 0 the deck's underside, 0.25 its top, 1 the rail's)
  for (let i = 0; i < 8; i++) k.box(i / 8 + 0.005, (i + 1) / 8 - 0.005, 0, 1, 0, 0.25, Part.Plank, 0);
  for (const v of [0.02, 0.98]) {
    k.box(0, 1, v - 0.02, v + 0.02, 0.9, 1, Part.Trim, 1 | 2);
    for (const u of [0, 0.5]) k.box(u, u + 0.04, v - 0.02, v + 0.02, 0.25, 0.9, Part.Trim);
  }
  return k.done('pierdeck');
}

/** a pier's piles under a segment (frame: across it; foot the bed, top the deck's underside) */
function pierPiles(): Module {
  const k = new Kit();
  for (const u of [0.02, 0.52]) for (const v of [0.04, 0.96]) {
    k.box(u - 0.02, u + 0.04, v - 0.04, v + 0.02, 0, 1, Part.Trim);
  }
  k.box(0, 1, 0, 1, 0.9, 1, Part.Trim, 1 | 2 | 16);
  return k.done('pierpiles');
}

/** the lighthouse's tower (frame: the square round it; foot the ground, top its gallery): a tapered drum, banded */
function lhTower(): Module {
  const k = new Kit();
  const n = 14;
  const prof: [number, number][] = [];
  for (let i = 0; i <= 8; i++) prof.push([0.46 - 0.12 * (i / 8), i / 8]);
  for (let i = 0; i < 8; i++) lathe(k, [prof[i], prof[i + 1]], n, i % 3 === 2 ? Part.Awning : Part.Wall, 0.5, 0.5);
  lathe(k, [[0.5, 0], [0.5, 0.06], [0.46, 0.06]], n, Part.Stone, 0.5, 0.5);
  // the door, a window or two, the gallery
  k.box(0.46, 0.54, 0.04, 0.08, 0.0, 0.11, Part.Door);
  for (const w of [0.35, 0.62]) k.box(0.48, 0.52, 0.08 + w * 0.12, 0.12 + w * 0.12, w, w + 0.05, Part.Glass);
  lathe(k, [[0.0, 0.985], [0.46, 0.985], [0.46, 1.0], [0.0, 1.0]], n, Part.Stone, 0.5, 0.5);
  return k.done('lhtower');
}

/** the lighthouse's lantern and cap (frame as the tower's; foot the gallery, top the cap's tip) */
function lhTop(): Module {
  const k = new Kit();
  const n = 10;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    k.box(0.5 + Math.cos(a) * 0.4 - 0.015, 0.5 + Math.cos(a) * 0.4 + 0.015, 0.5 + Math.sin(a) * 0.4 - 0.015, 0.5 + Math.sin(a) * 0.4 + 0.015, 0, 0.18, Part.Metal);
  }
  lathe(k, [[0.24, 0], [0.24, 0.6]], n, Part.Lamp, 0.5, 0.5);
  lathe(k, [[0.3, 0.6], [0.32, 0.64], [0.0, 1]], n, Part.Roof, 0.5, 0.5);
  return k.done('lhtop');
}

/** a mine's headframe (frame: the square round it; foot the ground, top the sheave's crown): legs, braces, the wheel */
function headframe(): Module {
  const k = new Kit();
  const leg = (u0: number, v0: number, u1: number, v1: number) => {
    const t = 0.025;
    q2(k, [u0 - t, v0, 0], [u0 + t, v0, 0], [u1 + t, v1, 0.88], [u1 - t, v1, 0.88], Part.Trim);
    q2(k, [u0 + t, v0, 0], [u0 - t, v0, 0], [u1 - t, v1, 0.88], [u1 + t, v1, 0.88], Part.Trim);
    q2(k, [u0, v0 - t, 0], [u0, v0 + t, 0], [u1, v1 + t, 0.88], [u1, v1 - t, 0.88], Part.Trim);
    q2(k, [u0, v0 + t, 0], [u0, v0 - t, 0], [u1, v1 - t, 0.88], [u1, v1 + t, 0.88], Part.Trim);
  };
  leg(0.2, 0.2, 0.38, 0.4);
  leg(0.8, 0.2, 0.62, 0.4);
  leg(0.2, 0.8, 0.38, 0.6);
  leg(0.8, 0.8, 0.62, 0.6);
  // the back legs, raking out behind it
  leg(0.05, 0.98, 0.4, 0.55);
  leg(0.95, 0.98, 0.6, 0.55);
  for (const w of [0.3, 0.6]) {
    const s = 0.2 + 0.18 * (w / 0.88);
    k.box(s, 1 - s, s - 0.02, s + 0.02, w, w + 0.02, Part.Trim);
    k.box(s, 1 - s, 1 - s - 0.02, 1 - s + 0.02, w, w + 0.02, Part.Trim);
  }
  k.box(0.36, 0.64, 0.38, 0.62, 0.86, 0.89, Part.Plank);
  // the sheave: a wheel standing on the head (u-w plane, its radius 0.22 of the frame across ≈ 1 m)
  const n = 12;
  const cu = 0.5;
  const cw = 0.92;
  const ru = 0.22;
  const rw = 0.22 * (4.8 / 13);
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    const P = (a: number, v: number, s = 1) => [cu + Math.cos(a) * ru * s, v, cw + Math.sin(a) * rw * s];
    q2(k, P(a0, 0.47), P(a1, 0.47), P(a1, 0.53), P(a0, 0.53), Part.Metal);
    q2(k, P(a0, 0.53), P(a1, 0.53), P(a1, 0.47), P(a0, 0.47), Part.Metal);
    if (i % 3 === 0) q2(k, [cu, 0.5, cw], P(a0, 0.5), P(a0 + 0.08, 0.5), [cu, 0.5, cw + 0.004], Part.Metal);
  }
  // the shaft's collar at the foot, the rope down it
  k.box(0.32, 0.68, 0.32, 0.68, 0, 0.04, Part.Plank);
  k.box(0.495, 0.505, 0.495, 0.505, 0.04, 0.9, Part.Metal);
  return k.done('headframe');
}

/** a windmill's tower (frame: the square round it; foot the ground, top its cap's seat): tapered, a door, windows */
function millBody(): Module {
  const k = new Kit();
  lathe(k, [[0.44, 0], [0.4, 0.5], [0.33, 1]], 8, Part.Wall, 0.5, 0.5);
  lathe(k, [[0.46, 0], [0.46, 0.05], [0.44, 0.05]], 8, Part.Stone, 0.5, 0.5);
  k.box(0.45, 0.55, 0.04, 0.1, 0, 0.22, Part.Door);
  for (const w of [0.4, 0.7]) k.box(0.47, 0.53, 0.07 + w * 0.08, 0.13 + w * 0.08, w, w + 0.07, Part.Glass);
  return k.done('millbody');
}

/** a windmill's cap (frame as its body's; foot its seat, top the cap's crown): a thatched boat cap */
function millCap(): Module {
  const k = new Kit();
  lathe(k, [[0.37, 0], [0.38, 0.15], [0.3, 0.55], [0.12, 0.88], [0.0, 1]], 8, Part.Thatch, 0.5, 0.5);
  return k.done('millcap');
}

/** a light's pool on the ground (frame: the square round it, draped): a disc the host's glow pass shades by its radius */
function pool(): Module {
  const k = new Kit();
  const n = 16;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    k.tri([0.5, 0.5, 0], [0.5 + Math.cos(a0) * 0.5, 0.5 + Math.sin(a0) * 0.5, 0], [0.5 + Math.cos(a1) * 0.5, 0.5 + Math.sin(a1) * 0.5, 0], Part.Lamp);
  }
  return k.done('pool');
}

/** every module this file makes (the library takes them in at once) */
export function dressModules(): Module[] {
  return [
    logpile(), log(), stall(), wagon(), crates(), crane(), spoil(), cart(), banner(), torch(), waterwheel(), haystack(), trough(), millSails(),
    ship('cog'), ship('sloop'), ship('barge'),
    quayEdge(), kerb(), pierDeck(), pierPiles(), lhTower(), lhTop(), headframe(), millBody(), millCap(), pool(),
  ];
}
