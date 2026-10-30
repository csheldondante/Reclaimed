// Buriable pieces (the user, round 117: "buried statues and fallen structures and stones. These being skew add visual
// interest and they make great props for telekenisis or excavation sites"). Each is a mesh in its own frame (metres,
// z up from its foot) plus a coarse solid of the same shape, so the terrain track can lay it at any skew, claim the cells
// it fills as External intervals (sim/external.ts) and draw it as an instanced mesh (render/meshinst.ts part 2 takes a
// vertex as it is). The solid is primitives, not the mesh: "is this point inside" is what a claim needs, cheaply.
import type { BuriableAsset, BuriableKind, ColumnSpan, V3 } from '../api/contracts/structures';
import { Kit, Part } from './modules';
import { rng } from './rng';
import { cellAt } from '../world/lattice';

type Solid = { kind: 'box'; min: V3; max: V3 } | { kind: 'cyl'; c: [number, number]; r: number; z0: number; z1: number };

/** a surface of revolution about z: (radius, z) pairs bottom to top */
function lathe(k: Kit, prof: [number, number][], n: number, part: Part, cx = 0, cy = 0): void {
  for (let i = 0; i + 1 < prof.length; i++)
    for (let s = 0; s < n; s++) {
      const a0 = (s / n) * Math.PI * 2;
      const a1 = ((s + 1) / n) * Math.PI * 2;
      const [r0, z0] = prof[i];
      const [r1, z1] = prof[i + 1];
      const P = (r: number, z: number, a: number) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r, z];
      k.quad(P(r0, z0, a0), P(r0, z0, a1), P(r1, z1, a1), P(r1, z1, a0), part);
    }
}

function make(kind: BuriableKind, seed: number): { k: Kit; solids: Solid[] } {
  const r = rng(seed * 101 + 17);
  const k = new Kit();
  const solids: Solid[] = [];
  const box = (u0: number, u1: number, v0: number, v1: number, w0: number, w1: number, part: Part) => {
    k.box(u0, u1, v0, v1, w0, w1, part);
    solids.push({ kind: 'box', min: [u0, v0, w0], max: [u1, v1, w1] });
  };
  if (kind === 'statue') {
    // a robed figure on a plinth, one arm raised (a lantern, a sword: the seed decides how high)
    const H = 2.6 + r() * 1.4;
    box(-0.8, 0.8, -0.8, 0.8, 0, 0.9, Part.Stone);
    box(-0.65, 0.65, -0.65, 0.65, 0.9, 1.05, Part.Stone);
    const b = 1.05;
    lathe(k, [[0.55, b], [0.5, b + H * 0.35], [0.34, b + H * 0.62], [0.36, b + H * 0.7], [0.18, b + H * 0.76]], 10, Part.Stone);
    solids.push({ kind: 'cyl', c: [0, 0], r: 0.5, z0: b, z1: b + H * 0.76 });
    // the head
    lathe(k, [[0.0, b + H * 0.76], [0.16, b + H * 0.8], [0.18, b + H * 0.88], [0.12, b + H * 0.96], [0.0, b + H * 0.98]], 8, Part.Stone);
    // the raised arm and the lowered one
    const lift = 0.5 + r() * 0.5;
    k.box(0.28, 0.44, -0.08, 0.08, b + H * 0.6, b + H * (0.7 + lift * 0.3), Part.Stone);
    k.box(-0.42, -0.3, -0.08, 0.08, b + H * 0.36, b + H * 0.68, Part.Stone);
  } else if (kind === 'column') {
    // a fluted column on its base, a capital; long (it's what lies in the sand)
    const H = 5 + r() * 4;
    box(-0.7, 0.7, -0.7, 0.7, 0, 0.35, Part.Stone);
    const fl: [number, number][] = [];
    for (let i = 0; i <= 6; i++) fl.push([0.46 - 0.06 * (i / 6), 0.35 + (H - 0.8) * (i / 6)]);
    lathe(k, fl, 16, Part.Stone);
    solids.push({ kind: 'cyl', c: [0, 0], r: 0.45, z0: 0.35, z1: H - 0.45 });
    lathe(k, [[0.4, H - 0.45], [0.62, H - 0.2], [0.62, H - 0.15]], 16, Part.Stone);
    box(-0.75, 0.75, -0.75, 0.75, H - 0.15, H, Part.Stone);
  } else if (kind === 'fallen-tower') {
    // a tower's drum broken off: a ring of stone, its top ragged, windows
    const H = 6 + r() * 5;
    const R = 2.2 + r() * 1.2;
    const n = 14;
    for (let s = 0; s < n; s++) {
      const a0 = (s / n) * Math.PI * 2;
      const a1 = ((s + 1) / n) * Math.PI * 2;
      const h0 = H * (0.6 + 0.4 * r());
      const P = (rad: number, a: number, z: number) => [Math.cos(a) * rad, Math.sin(a) * rad, z];
      k.quad(P(R, a0, 0), P(R, a1, 0), P(R, a1, h0), P(R, a0, h0), Part.Stone);
      k.quad(P(R - 0.6, a1, 0), P(R - 0.6, a0, 0), P(R - 0.6, a0, h0), P(R - 0.6, a1, h0), Part.Stone);
      k.quad(P(R, a0, h0), P(R, a1, h0), P(R - 0.6, a1, h0), P(R - 0.6, a0, h0), Part.Stone);
    }
    solids.push({ kind: 'cyl', c: [0, 0], r: R, z0: 0, z1: H * 0.8 });
  } else if (kind === 'arch') {
    const W = 4 + r() * 3;
    const H = 5 + r() * 2;
    box(-W / 2 - 1, -W / 2, -0.8, 0.8, 0, H, Part.Stone);
    box(W / 2, W / 2 + 1, -0.8, 0.8, 0, H, Part.Stone);
    box(-W / 2 - 1, W / 2 + 1, -0.8, 0.8, H, H + 1.2, Part.Stone);
  } else {
    // a bell, bronze gone green
    const H = 1.6 + r() * 1.2;
    lathe(k, [[H * 0.62, 0], [H * 0.58, 0.08 * H], [H * 0.42, 0.35 * H], [H * 0.34, 0.7 * H], [H * 0.3, 0.9 * H], [0, H]], 18, Part.Metal);
    k.box(-0.08, 0.08, -0.3, 0.3, H, H + 0.25, Part.Metal);
    solids.push({ kind: 'cyl', c: [0, 0], r: H * 0.5, z0: 0, z1: H });
  }
  return { k, solids };
}

function insideSolid(s: Solid, x: number, y: number, z: number): boolean {
  if (s.kind === 'box') return x >= s.min[0] && x <= s.max[0] && y >= s.min[1] && y <= s.max[1] && z >= s.min[2] && z <= s.max[2];
  return z >= s.z0 && z <= s.z1 && Math.hypot(x - s.c[0], y - s.c[1]) <= s.r;
}

export function buriable(kind: BuriableKind, seed: number): BuriableAsset {
  const { k, solids } = make(kind, seed);
  const n = k.verts.length / 4;
  const verts = new Float32Array(k.verts);
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], verts[i * 4 + a]);
      hi[a] = Math.max(hi[a], verts[i * 4 + a]);
    }
  return {
    kind,
    seed,
    verts,
    index: new Uint32Array(k.index),
    bounds: [lo, hi],
    cells(m: Float32Array): ColumnSpan[] {
      // sample the solid at 0.4 m, each point taken to the world, its column's span grown to hold it
      const step = 0.4;
      const cols = new Map<string, ColumnSpan>();
      for (let z = lo[2]; z <= hi[2]; z += step)
        for (let y = lo[1]; y <= hi[1]; y += step)
          for (let x = lo[0]; x <= hi[0]; x += step) {
            if (!solids.some((s) => insideSolid(s, x, y, z))) continue;
            const wx = m[0] * x + m[1] * y + m[2] * z + m[3];
            const wy = m[4] * x + m[5] * y + m[6] * z + m[7];
            const wz = m[8] * x + m[9] * y + m[10] * z + m[11];
            const [cx, cy] = cellAt(wx, wy);
            const key = `${cx},${cy}`;
            const c = cols.get(key);
            if (c) {
              c.z0 = Math.min(c.z0, wz);
              c.z1 = Math.max(c.z1, wz);
            } else cols.set(key, { x: cx, y: cy, z0: wz, z1: wz, building: -1 });
          }
      return [...cols.values()];
    },
  };
}
