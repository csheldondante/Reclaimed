// The wilds (round 64, docs/DECISIONS.md): natural land, generated from a
// room plan (places.ts; BACKLOG W1). The plan's regions each take a
// landform — a mountain range (its crest down the region's middle), mesa
// country (flat-topped plateaus and buttes with banded cliffs), a lake
// basin, wooded valleys, hills — blended across their borders. Then:
//  - rivers: the land drained (priority flood: every pit fills to its spill
//    level), the water's paths accumulated, channels carved where enough
//    gathers, lakes where pits fill; springs at the rivers' heads keep them
//    running, and the water starts where it would settle;
//  - under it: tunnels between neighbouring rooms (caves where they pass
//    under a ridge, open cuts where the land is low), lava tubes lined with
//    basalt, a cave a river comes out of;
//  - rock in bands (stone and sandstone), loose cover (soil, sand, snow on
//    the peaks) only where it lies at its angle of repose, plants by
//    moisture and slope.
// The plan goes with the map (MapData.plan): the level loads it as its
// places, so a game can ask which room or region a spot is in.

import { ColumnGrid, MAX_K, type WorldDims } from './layout';
import { cellPos, nbr, NDIR } from './lattice';
import { MAT } from './materials';
import type { MapData } from './mapgen';
import { fbm, hash2, rng, smoothstep } from './noise';
import { buildPlaces, type Plan } from './places';

export type Landform = 'range' | 'mesa' | 'basin' | 'woods' | 'hills';

export interface LandformsOpts {
  seed?: number;
  /** the plan (default: Voronoi rooms ~28 apart, grouped into 7 regions) */
  plan?: Plan;
  /** landforms by region, in the plan's region order (default: drawn by the seed) */
  forms?: Landform[];
}

/** Lowland level (cells): what the hills and valleys sit at. */
const BASE = 12;

function ridged(x: number, y: number, oct: number, seed: number): number {
  let s = 0;
  let a = 0.5;
  let f = 1;
  let n = 0;
  let w = 1;
  for (let i = 0; i < oct; i++) {
    let v = 1 - Math.abs(fbm(x * f, y * f, 1, seed + i * 31));
    v *= v;
    s += v * a * w;
    w = Math.min(1, v * 1.6);
    n += a;
    a *= 0.5;
    f *= 2.1;
  }
  return s / n;
}

class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size(): number {
    return this.k.length;
  }
  push(key: number, val: number): void {
    const k = this.k;
    const v = this.v;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop(): number {
    const k = this.k;
    const v = this.v;
    const out = v[0];
    const lk = k.pop()!;
    const lv = v.pop()!;
    if (k.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= k.length) break;
        const r = l + 1;
        const c = r < k.length && k[r] < k[l] ? r : l;
        if (k[c] >= lk) break;
        k[i] = k[c];
        v[i] = v[c];
        i = c;
      }
      k[i] = lk;
      v[i] = lv;
    }
    return out;
  }
}

export function generateLandforms(dims: WorldDims, opts: LandformsOpts = {}): MapData & { plan: { plan: Plan; seed: number }; forms: Landform[] } {
  const { w, h, zMax } = dims;
  const N = w * h;
  const seed = opts.seed ?? 1;
  const R = rng(seed * 7919 + 13);
  const plan: Plan = opts.plan ?? { partition: 'voronoi', spacing: 28, group: [1, 3], regions: 7, amp: 9, scale: 36 };
  const places = buildPlaces(plan, w, h, seed);
  const regions = places.places.filter((p) => p && p.kind === 'region').map((p) => p!);
  const FORMS: Landform[] = ['range', 'mesa', 'basin', 'woods', 'hills'];
  const forms: Landform[] =
    opts.forms ??
    regions.map((_, i) => {
      // (at least one range and one mesa land, the rest drawn)
      if (i === 0) return 'range';
      if (i === 1) return 'mesa';
      if (i === 2) return 'basin';
      const pick: Landform[] = ['range', 'mesa', 'woods', 'woods', 'hills', 'hills', 'basin'];
      return pick[Math.floor(R() * pick.length)];
    });
  const formOf = new Map<number, Landform>();
  regions.forEach((r, i) => formOf.set(r.id, forms[i % forms.length]));

  // ---- each column's landform, and the distance to its region's border --------
  const regionOf = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    const room = places.cols[i] & 0xffff;
    regionOf[i] = room ? places.place(room).parent || room : 0;
  }
  const pos = (i: number) => cellPos(i % w, (i / w) | 0);
  // distance (steps) to the region's border, by BFS from the border columns
  const toBorder = new Float32Array(N).fill(1e9);
  {
    const q: number[] = [];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        for (let k = 0; k < NDIR; k++) {
          const [nx, ny] = nbr(x, y, k);
          const j = ny * w + nx;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || regionOf[j] !== regionOf[i]) {
            toBorder[i] = 0;
            q.push(i);
            break;
          }
        }
      }
    for (let qi = 0; qi < q.length; qi++) {
      const i = q[qi];
      const x = i % w;
      const y = (i / w) | 0;
      for (let k = 0; k < NDIR; k++) {
        const [nx, ny] = nbr(x, y, k);
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (regionOf[j] !== regionOf[i] || toBorder[j] <= toBorder[i] + 1) continue;
        toBorder[j] = toBorder[i] + 1;
        q.push(j);
      }
    }
  }
  // each landform's weight, blurred across the borders (~10 cells)
  const weight = FORMS.map((f) => {
    const a = new Float32Array(N);
    for (let i = 0; i < N; i++) a[i] = formOf.get(regionOf[i]) === f ? 1 : 0;
    const t = new Float32Array(N);
    const r = 9;
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < h; y++) {
        let s = 0;
        for (let x = -r; x <= r; x++) s += a[y * w + Math.min(w - 1, Math.max(0, x))];
        for (let x = 0; x < w; x++) {
          t[y * w + x] = s / (2 * r + 1);
          s += a[y * w + Math.min(w - 1, x + r + 1)] - a[y * w + Math.max(0, x - r)];
        }
      }
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let y = -r; y <= r; y++) s += t[Math.min(h - 1, Math.max(0, y)) * w + x];
        for (let y = 0; y < h; y++) {
          a[y * w + x] = s / (2 * r + 1);
          s += t[Math.min(h - 1, y + r + 1) * w + x] - t[Math.max(0, y - r) * w + x];
        }
      }
    }
    return a;
  });
  const W = Object.fromEntries(FORMS.map((f, k) => [f, weight[k]])) as Record<Landform, Float32Array>;

  // ---- the height field ------------------------------------------------------
  const H = new Float32Array(N);
  const mesaTop = new Float32Array(N);
  const peakCap = zMax - 8;
  for (let i = 0; i < N; i++) {
    const [px, py] = pos(i);
    // (domain warp: nothing lines up with the lattice)
    const wx = px + 14 * fbm(px / 50, py / 50, 2, seed + 3);
    const wy = py + 14 * fbm(px / 50 + 7, py / 50, 2, seed + 4);
    let z = BASE + 3.5 * fbm(wx / 45, wy / 45, 3, seed + 5);
    // hills
    z += W.hills[i] * (5 + 5 * fbm(wx / 22, wy / 22, 3, seed + 6));
    // woods: gentle valleys
    z += W.woods[i] * (1.5 + 2.5 * fbm(wx / 30, wy / 30, 3, seed + 7));
    // basin: down, a lake bed
    z -= W.basin[i] * (5 + 2 * fbm(wx / 25, wy / 25, 2, seed + 8));
    // ranges: the crest down the region's middle, ridged peaks and spurs
    if (W.range[i] > 0.01) {
      const inner = formOf.get(regionOf[i]) === 'range' ? smoothstep(0, 22, toBorder[i]) : 0;
      const crest = Math.max(inner, 0.35 * W.range[i]);
      // (anisotropic: ridges run one way, spurs off them)
      const rid = ridged((wx * 0.8 + wy * 0.6) / 42, (wy * 0.8 - wx * 0.6) / 24, 6, seed + 9);
      z += W.range[i] * (crest * (10 + 44 * rid * rid) + 5 * rid);
    }
    // mesas: flat tops at two levels, cliffs where the noise crosses them
    if (W.mesa[i] > 0.01) {
      const q = fbm(wx / 26, wy / 26, 4, seed + 10) * 0.5 + 0.5;
      const t1 = smoothstep(0.5, 0.515, q);
      const t2 = smoothstep(0.66, 0.672, q);
      // (talus aprons at the feet of the cliffs)
      const apron = smoothstep(0.43, 0.5, q) * 0.22;
      const lift = 12 * Math.max(t1, apron) + 8 * t2;
      z += W.mesa[i] * (lift + 1.5 * fbm(wx / 12, wy / 12, 2, seed + 11) * (1 - t1));
      mesaTop[i] = W.mesa[i] * t1;
    }
    H[i] = Math.max(z, 3);
  }
  // (the highest peak brought under the cap, the rest scaled with it: no flattened tops)
  {
    let top = 0;
    for (let i = 0; i < N; i++) top = Math.max(top, H[i]);
    if (top > peakCap) for (let i = 0; i < N; i++) if (H[i] > BASE) H[i] = BASE + ((H[i] - BASE) * (peakCap - BASE)) / (top - BASE);
  }
  // a little thermal erosion off the ranges' faces (not the mesas: their cliffs stay)
  for (let it = 0; it < 6; it++) {
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (mesaTop[i] > 0.2 || W.mesa[i] > 0.5) continue;
        for (let k = 0; k < NDIR; k++) {
          const [nx, ny] = nbr(x, y, k);
          const j = ny * w + nx;
          const d = H[i] - H[j];
          if (d > 2.2) {
            const m = (d - 2.2) * 0.12;
            H[i] -= m;
            H[j] += m;
          }
        }
      }
  }

  // ---- rivers and lakes ------------------------------------------------------
  // priority flood from the edges: `fill` the level water stands at
  const fill = new Float32Array(N);
  const order: number[] = [];
  {
    const done = new Uint8Array(N);
    const hp = new Heap();
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
          const i = y * w + x;
          fill[i] = H[i];
          done[i] = 1;
          hp.push(H[i], i);
        }
    while (hp.size) {
      const i = hp.pop();
      order.push(i);
      const x = i % w;
      const y = (i / w) | 0;
      for (let k = 0; k < NDIR; k++) {
        const [nx, ny] = nbr(x, y, k);
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (done[j]) continue;
        done[j] = 1;
        // (+ a hair: the filled flats still drain one way)
        fill[j] = Math.max(H[j], fill[i] + 1e-4);
        hp.push(fill[j], j);
      }
    }
  }
  // each column drains to its lowest filled neighbour; gather the rain down
  const down = new Int32Array(N).fill(-1);
  for (let i = 0; i < N; i++) {
    const x = i % w;
    const y = (i / w) | 0;
    let best = fill[i];
    for (let k = 0; k < NDIR; k++) {
      const [nx, ny] = nbr(x, y, k);
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (fill[j] < best) {
        best = fill[j];
        down[i] = j;
      }
    }
  }
  const acc = new Float32Array(N);
  for (let i = 0; i < N; i++) acc[i] = 1 + W.range[i] * 1.5;
  for (let o = order.length - 1; o >= 0; o--) {
    const i = order[o];
    if (down[i] >= 0) acc[down[i]] += acc[i];
  }
  // channels: carved where enough gathers (deeper downstream), soft banks
  const A0 = 420;
  const carve = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (acc[i] < A0 || fill[i] - H[i] > 0.3) continue;
    const d = Math.min(3.2, 0.9 + 0.7 * Math.log2(acc[i] / A0));
    carve[i] = Math.max(carve[i], d);
    const x = i % w;
    const y = (i / w) | 0;
    for (let k = 0; k < NDIR; k++) {
      const [nx, ny] = nbr(x, y, k);
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      carve[j] = Math.max(carve[j], d * (acc[i] > A0 * 6 ? 0.8 : 0.45));
    }
  }
  for (let i = 0; i < N; i++) H[i] -= carve[i];
  // springs: where a channel begins up in the ranges and mesas
  const waterSource = new Float32Array(N);
  const water = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (acc[i] < A0) continue;
    const up = (() => {
      const x = i % w;
      const y = (i / w) | 0;
      for (let k = 0; k < NDIR; k++) {
        const [nx, ny] = nbr(x, y, k);
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (down[j] === i && acc[j] >= A0) return true;
      }
      return false;
    })();
    if (!up) waterSource[i] = 0.004;
    // the river's water to start with (it settles from there)
    water[i] = Math.max(water[i], Math.min(0.8, 0.25 + 0.15 * Math.log2(acc[i] / A0)));
  }
  // lakes: the pits filled to their spill levels (the basins, mostly)
  for (let i = 0; i < N; i++) {
    const d = fill[i] - (H[i] + carve[i]);
    if (d > 0.35 && H[i] < BASE + 16) water[i] = Math.max(water[i], d);
  }

  // ---- under it: tunnels, tubes, a river cave --------------------------------
  // carved spans per column: [z0, z1] pairs
  const holes: number[][] = Array.from({ length: N }, () => []);
  const lining = new Uint8Array(N);
  const bore = (pts: [number, number, number][], radius: number, tube: boolean) => {
    for (let s = 0; s + 1 < pts.length; s++) {
      const [ax, ay, az] = pts[s];
      const [bx, by, bz] = pts[s + 1];
      const len = Math.hypot(bx - ax, by - ay);
      const steps = Math.max(1, Math.ceil(len / 0.5));
      for (let t = 0; t <= steps; t++) {
        const f = t / steps;
        const cx = ax + (bx - ax) * f;
        const cy = ay + (by - ay) * f;
        const cz = az + (bz - az) * f;
        const r = radius * (0.85 + 0.3 * hash2(Math.round(cx * 3), Math.round(cy * 3), seed + 21));
        const ry = Math.ceil(r / 0.86) + 1;
        const cyi = Math.round(cy / 0.866 - 0.5);
        for (let y = cyi - ry; y <= cyi + ry; y++) {
          if (y < 1 || y >= h - 1) continue;
          for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
            if (x < 1 || x >= w - 1) continue;
            const [px, py] = cellPos(x, y);
            const d = Math.hypot(px - cx, py - cy);
            if (d > r) continue;
            const hz = Math.sqrt(r * r - d * d);
            const i = y * w + x;
            // (a floor never below z 2; a roof of at least 1.5 or it's an open cut)
            holes[i].push(Math.max(cz - hz * 0.8, 2), cz + hz);
            if (tube) lining[i] = 1;
          }
        }
      }
    }
  };
  const groundAt = (x: number, y: number) => {
    const cy = Math.min(h - 1, Math.max(0, Math.round(y / 0.866 - 0.5)));
    const cx = Math.min(w - 1, Math.max(0, Math.round(x - 0.5 - 0.5 * (cy & 1))));
    return H[cy * w + cx];
  };
  // passages between neighbouring rooms: low through the land (caves under ridges)
  const pairs = places.suggested.slice(0, 40);
  let tunnels = 0;
  for (const { a, b } of pairs) {
    const pa = places.place(a).centre;
    const pb = places.place(b).centre;
    // only where something stands between them (a ridge, a mesa): else it's just open ground
    let rise = 0;
    for (let t = 0.2; t <= 0.8; t += 0.1) rise = Math.max(rise, groundAt(pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t) - Math.max(groundAt(...pa), groundAt(...pb)));
    if (rise < 4 || tunnels >= 8) continue;
    tunnels++;
    const pts: [number, number, number][] = [];
    const za = groundAt(...pa) + 1.2;
    const zb = groundAt(...pb) + 1.2;
    for (let t = 0; t <= 1.0001; t += 0.125) {
      const wob = t > 0 && t < 1 ? 5 * fbm(t * 3, a * 0.37, 1, seed + 23) : 0;
      const nx = -(pb[1] - pa[1]);
      const ny = pb[0] - pa[0];
      const nl = Math.hypot(nx, ny) || 1;
      pts.push([pa[0] + (pb[0] - pa[0]) * t + (wob * nx) / nl, pa[1] + (pb[1] - pa[1]) * t + (wob * ny) / nl, za + (zb - za) * t]);
    }
    bore(pts, 2.1, false);
  }
  // cave systems: from the foot of a range or mesa (a mouth in the open) in
  // under it, winding, a branch or two
  const feet: number[] = [];
  for (let i = 0; i < N; i++) {
    const f = formOf.get(regionOf[i]);
    if ((f === 'range' || f === 'mesa') && toBorder[i] > 3 && toBorder[i] < 9 && water[i] < 0.05 && i % 5 === 0) feet.push(i);
  }
  let caveSys = 0;
  for (let c = 0; c < 9 && feet.length; c++) {
    const i0 = feet[Math.floor(R() * feet.length)];
    let [x, y] = pos(i0);
    let z = H[i0] + 1.0;
    // (in: up the slope)
    const gx = groundAt(x + 3, y) - groundAt(x - 3, y);
    const gy = groundAt(x, y + 3) - groundAt(x, y - 3);
    let a = Math.atan2(gy, gx);
    const pts: [number, number, number][] = [[x - Math.cos(a) * 3, y - Math.sin(a) * 3, z]];
    const branches: [number, number, number, number][] = [];
    for (let s = 0; s < 34; s++) {
      a += 0.5 * (R() - 0.5);
      x += Math.cos(a) * 2;
      y += Math.sin(a) * 2;
      if (x < 4 || y < 4 || x > w - 4 || y > (h - 4) * 0.866) break;
      // (it keeps under the ground, rising and falling a little)
      z = Math.min(z + (R() - 0.55) * 0.8, groundAt(x, y) - 5);
      z = Math.max(z, 3);
      pts.push([x, y, z]);
      if (s > 6 && R() < 0.06) branches.push([x, y, z, a + (R() < 0.5 ? 1 : -1) * (0.8 + R() * 0.6)]);
    }
    if (pts.length < 6) continue;
    caveSys++;
    bore(pts, 1.9 + R() * 0.6, false);
    for (const [bx, by, bz, ba] of branches) {
      const bp: [number, number, number][] = [[bx, by, bz]];
      let [cx, cy, cz, ca] = [bx, by, bz, ba];
      for (let s = 0; s < 14; s++) {
        ca += 0.5 * (R() - 0.5);
        cx += Math.cos(ca) * 2;
        cy += Math.sin(ca) * 2;
        if (cx < 4 || cy < 4 || cx > w - 4 || cy > (h - 4) * 0.866) break;
        cz = Math.max(Math.min(cz + (R() - 0.5) * 0.8, groundAt(cx, cy) - 5), 3);
        bp.push([cx, cy, cz]);
      }
      if (bp.length > 3) bore(bp, 1.6, false);
    }
  }
  void caveSys;
  // lava tubes: from high in a range down its flank, lined with basalt
  const rangeCells: number[] = [];
  for (let i = 0; i < N; i++) if (formOf.get(regionOf[i]) === 'range' && H[i] > BASE + 22 && i % 7 === 0) rangeCells.push(i);
  // (their own stream of randoms: how many the caves drew doesn't move them)
  const RT = rng(seed * 104729 + 71);
  let tubes = 0;
  for (let t = 0; t < 12 && tubes < 4 && rangeCells.length; t++) {
    const i0 = rangeCells[Math.floor(RT() * rangeCells.length)];
    let [x, y] = pos(i0);
    let z = H[i0] - 7;
    const pts: [number, number, number][] = [[x, y, z]];
    let a = RT() * Math.PI * 2;
    for (let s = 0; s < 40; s++) {
      // down the slope, wandering
      const gx = groundAt(x + 2, y) - groundAt(x - 2, y);
      const gy = groundAt(x, y + 2) - groundAt(x, y - 2);
      const ga = Math.atan2(-gy, -gx);
      a += 0.35 * Math.sin(ga - a) + 0.3 * (RT() - 0.5);
      x += Math.cos(a) * 2;
      y += Math.sin(a) * 2;
      if (x < 4 || y < 4 || x > w - 4 || y > (h - 4) * 0.866) break;
      z = Math.max(Math.min(z - 0.35, groundAt(x, y) - 2.2), 3);
      pts.push([x, y, z]);
      // (out of the hillside: the tube's mouth)
      if (groundAt(x, y) - z < 2.5) break;
    }
    if (pts.length > 4) {
      bore(pts, 1.6, true);
      tubes++;
    }
  }
  // the river cave: a channel's spring moved back into the hill it rises under
  const springs = [...waterSource.keys()].filter((i) => waterSource[i] > 0 && W.range[i] + W.mesa[i] > 0.3);
  if (springs.length) {
    const i0 = springs[Math.floor(R() * springs.length)];
    const [sx, sy] = pos(i0);
    // uphill from the spring, into the rock
    const gx = groundAt(sx + 2, sy) - groundAt(sx - 2, sy);
    const gy = groundAt(sx, sy + 2) - groundAt(sx, sy - 2);
    const gl = Math.hypot(gx, gy) || 1;
    const pts: [number, number, number][] = [];
    for (let s = 0; s <= 8; s++) pts.push([sx + (gx / gl) * s * 2, sy + (gy / gl) * s * 2, H[i0] + 1.3 + s * 0.15]);
    bore(pts.reverse(), 1.9, false);
  }

  // ---- the columns -----------------------------------------------------------
  const grid = new ColumnGrid(dims);
  const drift = new Float32Array(N);
  const driftMat = new Float32Array(N);
  const moisture = new Float32Array(N);
  const vegetation = new Float32Array(N);
  const contam = new Float32Array(N * 2);
  const slope = (i: number) => {
    const x = i % w;
    const y = (i / w) | 0;
    let s = 0;
    for (let k = 0; k < NDIR; k++) {
      const [nx, ny] = nbr(x, y, k);
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      s = Math.max(s, Math.abs(H[i] - H[ny * w + nx]));
    }
    return s;
  };
  // distance to water (for moisture): BFS
  const wet = new Float32Array(N).fill(99);
  {
    const q: number[] = [];
    for (let i = 0; i < N; i++)
      if (water[i] > 0.1) {
        wet[i] = 0;
        q.push(i);
      }
    for (let qi = 0; qi < q.length; qi++) {
      const i = q[qi];
      if (wet[i] > 30) continue;
      const x = i % w;
      const y = (i / w) | 0;
      for (let k = 0; k < NDIR; k++) {
        const [nx, ny] = nbr(x, y, k);
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (wet[j] <= wet[i] + 1) continue;
        wet[j] = wet[i] + 1;
        q.push(j);
      }
    }
  }
  let capped = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const top = Math.max(Math.floor(H[i]), 3);
      const s = slope(i);
      const form = formOf.get(regionOf[i]);
      // rock: stone below, bands of sandstone and stone where the mesas and ranges stand
      const spans: [number, number, number][] = [];
      const banded = W.mesa[i] > 0.3;
      let z = 0;
      const firstBand = Math.max(BASE - 4, 2);
      spans.push([0, Math.min(firstBand, top), MAT.Stone]);
      z = Math.min(firstBand, top);
      if (banded) {
        let b = 0;
        while (z < top) {
          // bands 3-5 cells, the same heights across the land (strata), a little wavy
          const step = 4 + Math.round(2 * fbm(x / 40, y / 40, 1, seed + 30 + b));
          const z1 = Math.min(top, z + Math.max(3, step));
          const mat = W.mesa[i] > 0.3 ? (b % 2 === 0 ? MAT.Sandstone : b % 4 === 1 ? MAT.Stone : MAT.Sandstone) : b % 3 === 2 ? MAT.Sandstone : MAT.Stone;
          spans.push([z, z1, mat]);
          z = z1;
          b++;
        }
      } else if (z < top) spans.push([z, top, MAT.Stone]);
      // merge same-material neighbours, then cut the holes out
      const merged: [number, number, number][] = [];
      for (const sp of spans) {
        const l = merged[merged.length - 1];
        if (l && l[2] === sp[2] && Math.abs(l[1] - sp[0]) < 1e-4) l[1] = sp[1];
        else if (sp[1] > sp[0]) merged.push([...sp]);
      }
      let col = merged;
      const hs = holes[i];
      if (hs.length) {
        // the holes merged into spans, under a roof of 1.5 at least (or open to the sky)
        const cuts: [number, number][] = [];
        for (let k = 0; k < hs.length; k += 2) cuts.push([hs[k], hs[k + 1]]);
        cuts.sort((p, q) => p[0] - q[0]);
        const mc: [number, number][] = [];
        for (const c of cuts) {
          const l = mc[mc.length - 1];
          if (l && c[0] <= l[1]) l[1] = Math.max(l[1], c[1]);
          else mc.push([...c]);
        }
        for (const c of mc) if (top - c[1] < 3.5) c[1] = top + 1;
        const out: [number, number, number][] = [];
        for (const [a, b, m] of col) {
          let lo = a;
          for (const [c0, c1] of mc) {
            if (c1 <= lo || c0 >= b) continue;
            if (c0 > lo) out.push([lo, c0, m]);
            lo = Math.max(lo, c1);
          }
          if (lo < b) out.push([lo, b, m]);
        }
        // tubes: a basalt skin on the floor and the roof
        if (lining[i]) {
          const lined: [number, number, number][] = [];
          out.forEach((sp, k) => {
            const below = k > 0;
            const above = k + 1 < out.length;
            let [a, b] = [sp[0], sp[1]];
            const roof: [number, number, number] | null = below && b - a > 1.3 ? [a, a + 0.6, MAT.Basalt] : null;
            if (roof) a += 0.6;
            const floor: [number, number, number] | null = above && b - a > 1.3 ? [b - 0.6, b, MAT.Basalt] : null;
            if (floor) b -= 0.6;
            if (roof) lined.push(roof);
            lined.push([a, b, sp[2]]);
            if (floor) lined.push(floor);
          });
          out.length = 0;
          out.push(...lined);
        }
        // (too many for a column's slots: the lowest holes close)
        while (out.length > MAX_K - 3) {
          const a = out.shift()!;
          out[0][0] = a[0];
          capped++;
        }
        col = out;
      }
      for (const [a, b, m] of col) grid.push(x, y, a, b, m);
      const gtop = grid.top(x, y);
      // loose cover where it would lie: soil in the green and the hills,
      // sand in mesa country, snow on the peaks; none on cliffs
      const cover = s < 1.1 ? (1 - s / 1.1) * (form === 'mesa' ? 0.8 : 1.4) : 0;
      if (gtop >= top - 0.01 && cover > 0.05) {
        drift[i] = cover + Math.max(0, H[i] - top);
        driftMat[i] = gtop > BASE + 36 ? MAT.Snow : W.mesa[i] > 0.5 ? MAT.Sand : MAT.Soil;
      }
      // moisture and plants: woods by the water and in the green valleys, grass on
      // the hills, scrub in mesa country, bare rock up high and on cliffs
      const m = Math.max(0.12, 0.65 - wet[i] * 0.02) + W.woods[i] * 0.2 - W.mesa[i] * 0.15;
      moisture[i] = Math.min(0.9, Math.max(0.05, m));
      let v = 0;
      if (water[i] < 0.05 && driftMat[i] === MAT.Soil && s < 1.4) {
        const high = smoothstep(BASE + 18, BASE + 30, H[i]);
        v = (1.2 + 1.6 * moisture[i] + 2.2 * W.woods[i] + 0.8 * (1 - wet[i] / 30)) * (1 - high) + 0.4 * fbm(x / 9, y / 9, 2, seed + 40);
        v = Math.min(4.6, Math.max(0, v));
      } else if (driftMat[i] === MAT.Sand && s < 0.8) {
        v = hash2(x, y, seed + 41) < 0.08 ? 2.7 : 0.3;
      }
      vegetation[i] = v;
    }
  if (capped) console.warn(`landforms: ${capped} cave spans closed (columns past their slots)`);

  const surface = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const col = grid.cols[i];
    surface[i] = col[col.length - 1].z1;
  }
  // points of interest: the highest peak, the biggest lake, the middle
  let peak = 0;
  for (let i = 0; i < N; i++) if (H[i] > H[peak]) peak = i;
  let lake = 0;
  for (let i = 0; i < N; i++) if (water[i] > water[lake]) lake = i;
  const centre: [number, number] = [w / 2, h / 2];
  const cell = (i: number): [number, number] => [i % w, (i / w) | 0];
  return {
    grid,
    water,
    contam,
    moisture,
    vegetation,
    waterSource,
    oil: new Float32Array(N),
    oilStored: new Float32Array(N * 2),
    drift,
    driftMat,
    surface,
    poi: { peak: cell(peak), lake: cell(lake), tutorial: centre, healthy: centre, dam: cell(lake), reservoir: cell(lake), site: centre, landfill: centre, heap: centre },
    plan: { plan, seed },
    forms,
  };
}
