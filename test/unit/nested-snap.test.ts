// Nested scales lab, round 23 (docs/design/NESTED_SCALES.md "As built (round 23)"): the owner's snap rule in the
// reference (boxmesh.ts sheetMesh with rimSnap): a crossed corner goes to the least-squares point of its members' edge
// lines inside its own box, at the original surface's height. Measures the folded sheet triangles at each box size,
// with the fixed diagonal and with the diagonal chosen per quad, over random carve / add sequences, tight circles and
// crossing rims; checks the rim vertices lie on the true circle at the uncarved height, closure, and which columns hold
// the wall's triangles.
import { describe, expect, it } from 'vitest';
import { SNAP_BOX, edgeDec } from '../../src/nested/edge';
import { Level, MAT, Nest, OPEN_BOTTOM, makeRoot, type Frame } from '../../src/nested/oracle';
import { sheetClosure, sheetMesh, type MeshScene } from '../../src/nested/boxmesh';

const K = 4;

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}
function flatRoot(n: number, top: number): Level {
  const lv = new Level({ depth: 0, gx: 0, gy: 0, n, z0: 0 });
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) lv.set(x, y, { mat: [MAT.stone, MAT.soil], z0: [OPEN_BOTTOM, top - 1], z1: [top - 1, top] });
  return lv;
}
interface Opt {
  snap: boolean;
  box?: number;
  diag?: 'fixed' | 'surface' | 'column';
}
const sceneOf = (n: Nest, o: Opt): MeshScene => ({
  k: n.k,
  rimSnap: o.snap,
  snapBox: o.box,
  snapDiag: o.diag,
  levels: n.levels.map((lv) => ({ depth: lv.f.depth, gx: lv.f.gx, gy: lv.f.gy, n: lv.f.n, zo: lv.f.z0, parts: lv.parts.map((p) => ({ ...p, top: p.top.map(Math.fround) })) })),
});
/** sheet triangles whose horizontal orientation is reversed against the lattice's (folded), and those flattened to a
 *  line or point (degenerate: allowed) */
function folds(n: Nest, o: Opt): { tris: number; folded: number; flat: number; slid: number; where: string[] } {
  const m = sheetMesh(sceneOf(n, o));
  let folded = 0;
  let flat = 0;
  let slid = 0;
  const where: string[] = [];
  for (const l of m.lines.values()) for (const c of l.clusters) if (c.ox || c.oy) slid++;
  const lat = (key: string) => {
    const [L, cx, cy] = key.split(':').map(Number);
    const s = n.k ** L;
    return [cx / s, cy / s];
  };
  for (const t of m.tris) {
    const p = t.v.map((v) => m.pos.get(v)!);
    const q = t.v.map(lat);
    const a1 = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0]);
    const a0 = (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[1][1] - q[0][1]) * (q[2][0] - q[0][0]);
    // (world units: a root column is 1; a fold smaller than 1e-9 is a rounding tie)
    if (a0 !== 0 && a1 * Math.sign(a0) < -1e-9) {
      folded++;
      if (where.length < 3) where.push(`L${t.L} ${t.X},${t.Y} j${t.j} a1 ${a1.toExponential(2)}`);
    } else if (a0 !== 0 && Math.abs(a1) <= 1e-9) flat++;
  }
  return { tris: m.tris.length, folded, flat, slid, where };
}

/** the scenes: random carve / add sequences on two levels (as round 22's test), tight circles, crossing rims */
function scenes(): { name: string; n: Nest }[] {
  const out: { name: string; n: Nest }[] = [];
  const r = rng(17);
  for (let run = 0; run < 6; run++) {
    const n = new Nest(makeRoot(32, 5 + run), K, 5 + run);
    const f: Frame = { depth: 1, gx: 32, gy: 32, n: 48, z0: 0 };
    const p = n.levels[0].at((f.gx + f.n / 2) / K, (f.gy + f.n / 2) / K)!;
    n.promote({ ...f, z0: Math.round(p.z1[p.z1.length - 1]) });
    for (let i = 0; i < 8; i++) {
      const d = r() < 0.6 ? 1 : 0;
      const lv = n.levels[d];
      const x = lv.f.gx + 4 + r() * (lv.f.n - 8);
      const y = lv.f.gy + 4 + r() * (lv.f.n - 8);
      const c = lv.at(Math.floor(x), Math.floor(y))!;
      const s = c.z1[c.z1.length - 1];
      const rad = d ? 2 + r() * 8 : 1 + r() * 3;
      n.edit(d, r() < 0.7 ? 'carve' : 'add', x, y, rad, 0, s + (r() - 0.5) * rad);
    }
    out.push({ name: `random ${run}`, n });
  }
  // tight circles: carves and adds of plan radius 1.5 to 3 columns at sub-column offsets, on a flat root
  const t = rng(5);
  for (let i = 0; i < 12; i++) {
    const n = new Nest(flatRoot(24, 10), K, 3);
    for (let b = 0; b < 4; b++) {
      const R = 1.5 + t() * 1.5;
      const cz = 10 + (t() - 0.5) * R;
      const r = Math.sqrt(R * R + (10 - cz) ** 2);
      n.edit(0, b % 2 && i % 3 === 2 ? 'add' : 'carve', 4 + (b % 2) * 10 + t() * 3, 4 + (b >> 1) * 10 + t() * 3, r, 0, cz);
    }
    out.push({ name: `tight ${i}`, n });
  }
  // crossing rims: two carves (and a carve over an add) whose outlines cross
  for (let i = 0; i < 8; i++) {
    const n = new Nest(flatRoot(40, 10), K, 3);
    const a = 4 + t() * 4;
    const b = 4 + t() * 4;
    n.edit(0, i % 4 === 3 ? 'add' : 'carve', 16 + t(), 16 + t(), a, 0, 10 + 0.5);
    n.edit(0, 'carve', 16 + a * (0.6 + t() * 0.6), 16 + t() * 4, b, 0, 10 + 0.5 - (i % 2) * 1.5);
    out.push({ name: `crossing ${i}`, n });
  }
  return out;
}

describe('nested scales round 23: the snap (the owner\'s rule)', () => {
  const all = scenes();

  it('fold counts at each box, fixed and chosen diagonal (measurement; the chosen setting must be zero)', () => {
    const rows: string[] = [];
    const settings: Opt[] = [
      { snap: false },
      ...[0.49, 0.45, 0.4, 0.35].flatMap((box): Opt[] => [{ snap: true, box, diag: 'fixed' }, { snap: true, box, diag: 'surface' }, { snap: true, box, diag: 'column' }]),
      // (the setting built: SNAP_BOX, per surface)
      { snap: true },
    ];
    const total = new Map<string, { folded: number; flat: number; tris: number }>();
    for (const o of settings) {
      const key = !o.snap ? 'round 22 (disc 0.35, rimtop 0)' : !o.diag ? 'built' : `box ${o.box} ${o.diag === 'fixed' ? 'fixed diagonal' : `diagonal chosen per ${o.diag}`}`;
      let folded = 0;
      let flat = 0;
      let tris = 0;
      const byKind = new Map<string, number>();
      const where: string[] = [];
      for (const s of all) {
        const f = folds(s.n, o);
        folded += f.folded;
        flat += f.flat;
        tris += f.tris;
        const kind = s.name.split(' ')[0];
        byKind.set(kind, (byKind.get(kind) ?? 0) + f.folded);
        if (f.folded && where.length < 2) where.push(`${s.name}: ${f.where.join(', ')}`);
      }
      total.set(key, { folded, flat, tris });
      rows.push(`${key}: folded ${folded} (${[...byKind].map(([k, v]) => `${k} ${v}`).join(', ')}), degenerate ${flat}, of ${tris}${where.length ? `; ${where.join('; ')}` : ''}`);
    }
    console.log(`[snap] folds over ${all.length} scenes\n${rows.join('\n')}`);
    expect(total.get('round 22 (disc 0.35, rimtop 0)')!.folded).toBe(0);
    expect(total.get('built')!.folded).toBe(0);
  });

  it('closure is unchanged by the snap (vertex identities), fixed or chosen diagonal', () => {
    for (const s of all) {
      const b = sheetClosure(sheetMesh(sceneOf(s.n, { snap: false })));
      const a = sheetClosure(sheetMesh(sceneOf(s.n, { snap: true, diag: 'fixed' })));
      expect({ ...a, where: [] }, s.name).toEqual({ ...b, where: [] });
      // (a chosen diagonal can leave a thin pocket triangulated the other way, so the pair rule cancels a different
      // number of triangles there; closure, coincident faces and repeated vertices stay as with the fixed one)
      for (const diag of ['surface', 'column'] as const) {
        const c = sheetClosure(sheetMesh(sceneOf(s.n, { snap: true, diag })));
        if (c.tris !== b.tris) console.log(`[snap] diagonal per ${diag}, ${s.name}: ${c.tris - b.tris} more triangles; open ${c.openInterior} (fixed ${b.openInterior}), coincident ${c.coincident}, repeated ${c.repeated}`);
        expect({ ...c, tris: 0, where: [] }, `${s.name} ${diag}`).toEqual({ ...b, tris: 0, where: [] });
      }
    }
  });

  it('a carve\'s rim: every crossed corner on the true circle, at the uncarved height; the wall\'s triangles in the carved columns', () => {
    const top = 10;
    const n = new Nest(flatRoot(40, top), K, 7);
    const cx = 20.3;
    const cy = 19.6;
    const r = 7.2;
    const cz = top + 0.8;
    n.edit(0, 'carve', cx, cy, r, 0, cz);
    const R = Math.sqrt(r * r - (top - cz) ** 2);
    const m = sheetMesh(sceneOf(n, { snap: true }));
    let rim = 0;
    let worst = 0;
    for (const l of m.lines.values()) {
      const ins = [0, 1, 2, 3].map((q) => Math.hypot(l.cx - 0.5 + (q & 1) - cx, l.cy - 0.5 + (q >> 1) - cy) < R);
      if (ins.every((v) => v) || ins.every((v) => !v)) continue;
      const c = l.clusters[l.clusters.length - 1];
      rim++;
      worst = Math.max(worst, Math.abs(Math.hypot(l.cx + c.ox - cx, l.cy + c.oy - cy) - R));
      expect(c.z).toBeCloseTo(top, 2);
    }
    // the wall: a triangle whose corners span more than a quarter of the drop; its column inside the circle (carved) or
    // outside (uncarved: the alternation of round 22 when there are any)
    let wallIn = 0;
    let wallOut = 0;
    for (const t of m.tris) {
      if (!t.up) continue;
      const z = t.v.map((v) => m.pos.get(v)![2]);
      if (Math.max(...z) - Math.min(...z) < 0.25) continue;
      if (Math.hypot(t.X + 0.5 - cx, t.Y + 0.5 - cy) < R) wallIn++;
      else wallOut++;
    }
    console.log(`[snap] carve r ${r}: ${rim} rim corners, farthest from the circle ${worst.toFixed(4)} columns; wall triangles in carved columns ${wallIn}, in uncarved ${wallOut}`);
    expect(rim).toBeGreaterThan(30);
    // (the least-squares point of four tangent lines of a circle lies outside it by about the sagitta of the cell: 0.075
    // at R 7.2; a curvature bias of dual contouring, not the reach)
    expect(worst).toBeLessThan(0.1);
    expect(wallOut).toBe(0);
    // (the mound: the same check, the "low" side being the ground outside its foot)
    const n2 = new Nest(flatRoot(40, top), K, 7);
    n2.edit(0, 'add', cx, cy, r, 0, top - 2);
    const R2 = Math.sqrt(r * r - 4);
    const m2 = sheetMesh(sceneOf(n2, { snap: true }));
    let footOut = 0;
    let footIn = 0;
    let footZ = 0;
    for (const l of m2.lines.values()) {
      const ins = [0, 1, 2, 3].map((q) => Math.hypot(l.cx - 0.5 + (q & 1) - cx, l.cy - 0.5 + (q >> 1) - cy) < R2);
      if (ins.every((v) => v) || ins.every((v) => !v)) continue;
      const c = l.clusters[l.clusters.length - 1];
      footZ = Math.max(footZ, Math.abs(c.z - top));
    }
    for (const t of m2.tris) {
      if (!t.up) continue;
      const z = t.v.map((v) => m2.pos.get(v)![2]);
      if (Math.max(...z) - Math.min(...z) < 0.25) continue;
      if (Math.hypot(t.X + 0.5 - cx, t.Y + 0.5 - cy) < R2) footIn++;
      else footOut++;
    }
    console.log(`[snap] add r ${r}: foot corners within ${footZ.toFixed(4)} of the ground; steep triangles in the mound's columns ${footIn}, outside ${footOut}`);
    expect(footZ).toBeLessThan(0.01);
    expect(footOut).toBe(0);
    void edgeDec;
    void SNAP_BOX;
  });
});
