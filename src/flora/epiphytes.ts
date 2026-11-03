// Epiphytes and winter dressing (round 128, treegen): the geometry that grows on a tree, added from its stems. The
// user: "epiphyte density for lichens, mosses, other plants, vines and lines", "a winter variant with snow and ice".
// Lichens and moss on the limbs are the bark's look (floralook.wgsl, FLORA_EPI) — patches cost no triangles; here:
//   plants   tufts of fronds in the forks (where a limb leaves the trunk or a big limb)
//   vines    climbers spiralling up the trunk, leafy
//   lines    hanging strands from the limbs (lianas, Spanish moss)
//   icicles  under the near-level limbs: part `ice`, drawn only in winter (floralook.wgsl discards them otherwise)
// All in the skeleton's units; `k` world cells a unit (the sizes are given in world cells). Deterministic from the seed.

import { norm, type Skeleton, type V3 } from './lsystem';
import { PART, stemPaths, type MeshBuilder } from './mesh';
import { rng } from './rng';
import type { Epiphytes } from './species';

/** what was added (the tests count them) */
export interface EpiphyteCounts {
  plants: number;
  vines: number;
  lines: number;
  icicles: number;
}

export function addEpiphytes(mb: MeshBuilder, sk: Skeleton, epi: Epiphytes, seed: number, k: number, opts: { icicles: number; cut: number }): EpiphyteCounts {
  const r = rng(seed ^ 0xe919);
  const paths = stemPaths(sk.segments, (g) => g.r0 < opts.cut);
  const trunk = paths.find((p) => p.depth === 0);
  const H = Math.max(sk.height, 0.5);
  const n: EpiphyteCounts = { plants: 0, vines: 0, lines: 0, icicles: 0 };
  const w = (cells: number) => cells / k;

  // plants: a tuft in a fork — a limb's start on the trunk or on a first limb, above a quarter of the height
  if (epi.plants > 0) {
    for (const p of paths) {
      if (p.depth < 1 || p.depth > 2) continue;
      const at = p.p[0];
      if (at[2] < H * 0.25 || r() > epi.plants * 0.7) continue;
      const fronds = 5 + Math.floor(r() * 3);
      const t0 = r() * Math.PI * 2;
      for (let f = 0; f < fronds; f++) {
        const a = t0 + (f / fronds) * Math.PI * 2;
        const d = norm([Math.cos(a) * 0.8, Math.sin(a) * 0.8, 0.9]);
        mb.blade(at, d, w(1.3 + 0.8 * r()), w(0.4), 2, [Math.cos(a) * 0.25, Math.sin(a) * 0.25, -0.35], PART.epiphyte, 0.2);
      }
      n.plants++;
    }
  }

  // vines: up to three climbers spiralling up the trunk to its crown, leaves along them
  if (epi.vines > 0 && trunk && trunk.p.length > 1) {
    const count = Math.floor(epi.vines * 3 + r());
    // the trunk's length to the first limb's height or 60% of it
    const S = [0];
    for (let i = 1; i < trunk.p.length; i++) S.push(S[i - 1] + Math.hypot(trunk.p[i][0] - trunk.p[i - 1][0], trunk.p[i][1] - trunk.p[i - 1][1], trunk.p[i][2] - trunk.p[i - 1][2]));
    const L = S[S.length - 1] * (0.45 + 0.25 * r());
    const at = (s: number): [V3, number] => {
      let i = 1;
      while (i < S.length - 1 && S[i] < s) i++;
      const f = Math.min(1, Math.max(0, (s - S[i - 1]) / Math.max(1e-6, S[i] - S[i - 1])));
      const a = trunk.p[i - 1];
      const b = trunk.p[i];
      return [[a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f], trunk.r[i - 1] + (trunk.r[i] - trunk.r[i - 1]) * f];
    };
    for (let v = 0; v < count; v++) {
      const phi0 = r() * Math.PI * 2;
      const turns = (0.6 + 0.8 * r()) / w(4); // a turn every ~4 cells up, give or take
      const step = w(0.6);
      let prev: V3 | null = null;
      for (let s = 0; s <= L; s += step) {
        const [c, rad] = at(s);
        const phi = phi0 + s * turns * Math.PI * 2;
        const off = rad * 1.08 + w(0.04);
        const p: V3 = [c[0] + Math.cos(phi) * off, c[1] + Math.sin(phi) * off, c[2]];
        if (prev) mb.tube({ a: prev, b: p, r0: w(0.05), r1: w(0.045), depth: 1 }, 3, PART.wood, 0.02);
        // a leaf now and then, standing off the bark
        if (prev && r() < 0.7) {
          const o = w(0.18);
          mb.blob([p[0] + Math.cos(phi) * o, p[1] + Math.sin(phi) * o, p[2]], [w(0.22), w(0.22), w(0.16)], PART.epiphyte, r, 0.05);
        }
        prev = p;
      }
      n.vines++;
    }
  }

  // lines: strands hanging from the limbs' points and from inside the crown (the twigs' leaf sites: Spanish moss hangs
  // in the canopy, not only off the bare limbs)
  if (epi.lines > 0) {
    const hang = (at: V3) => {
      const len = w(2 + 4 * r());
      const b: V3 = [(r() - 0.5) * 0.08, (r() - 0.5) * 0.08, 0.04];
      mb.blade(at, [0, 0, -1], len, w(0.3), 3, b, PART.strand, 0.35);
      n.lines++;
    };
    for (const p of paths) {
      if (p.depth < 1 || p.depth > 2) continue;
      for (let i = 1; i < p.p.length; i++) if (r() < epi.lines * 0.5) hang(p.p[i]);
    }
    for (const l of sk.leaves) if (l.depth >= 1 && l.p[2] > H * 0.3 && r() < epi.lines * 0.12) hang(l.p);
  }

  // icicles: under the near-level stretches of the trunk's first limbs (winter only, by the look)
  if (opts.icicles > 0) {
    for (const p of paths) {
      if (p.depth < 1 || p.depth > 2 || n.icicles >= opts.icicles) continue;
      for (let i = 1; i < p.p.length && n.icicles < opts.icicles; i++) {
        const a = p.p[i - 1];
        const b = p.p[i];
        const d = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
        if (Math.abs(d[2]) > 0.6 || r() > 0.5) continue;
        const m: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2 - p.r[i] * 0.8];
        mb.cone(m, [0, 0, -1], w(0.3 + 0.5 * r()), w(0.06), 3, PART.ice, 0.02);
        n.icicles++;
      }
    }
  }
  return n;
}
