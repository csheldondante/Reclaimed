// Nested scales lab, round 24 deliverable A (docs/design/NESTED_SCALES.md "As built (round 24)"): edge-aware enhance in
// the reference (oracle.ts enhanceTops / homeTop, Nest.edgeEnh). A circle carved at level 1 is round at levels 2 and 3
// (not the parent's staircase): the corners near the rim lie on the true surface, the rim corners the snap moves lie on
// the true circle. And the drift: carve at 1, zoom in to 3, zoom out, zoom in again reproduces the same columns; a
// restrict over enhanced blocks gives the parents back (parent = mean of its home children).
import { describe, expect, it } from 'vitest';
import { Level, MAT, Nest, OPEN_BOTTOM, type Frame } from '../../src/nested/oracle';
import { sheetMesh, type MeshScene } from '../../src/nested/boxmesh';

const K = 4;
const TOP = 10;
function flatRoot(n: number, top: number): Level {
  const lv = new Level({ depth: 0, gx: 0, gy: 0, n, z0: 0 });
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) lv.set(x, y, { mat: [MAT.stone, MAT.soil], z0: [OPEN_BOTTOM, top - 1.5], z1: [top - 1.5, top] });
  return lv;
}
const sceneOf = (n: Nest, upTo: number, snap: boolean): MeshScene => ({
  k: n.k,
  rimSnap: snap,
  levels: n.levels.slice(0, upTo + 1).map((lv) => ({ depth: lv.f.depth, gx: lv.f.gx, gy: lv.f.gy, n: lv.f.n, zo: lv.f.z0, parts: lv.parts.map((p) => ({ ...p, top: p.top.map(Math.fround) })) })),
});

// the carve (level 1 columns and units; level 1's ground is at 0): a ball whose centre is above the ground, so its wall
// is steep at the rim (slope R / cz, about 4.9)
const C1 = { x: 40.3, y: 39.6, r: 10, cz: 2 };
const R1 = Math.sqrt(C1.r * C1.r - C1.cz * C1.cz);
const F1: Frame = { depth: 1, gx: 16, gy: 16, n: 64, z0: TOP };
const F2: Frame = { depth: 2, gx: 96, gy: 96, n: 128, z0: 0 };
const F3: Frame = { depth: 3, gx: 448, gy: 576, n: 128, z0: 0 };

function build(edgeEnh: boolean): Nest {
  const n = new Nest(flatRoot(24, TOP), K, 3);
  n.detailAmp = 0;
  n.edgeEnh = edgeEnh;
  n.promote(F1);
  n.edit(1, 'carve', C1.x, C1.y, C1.r, 0, C1.cz);
  n.promote(F2);
  n.promote(F3);
  return n;
}

/** the true surface at level L (its columns and units): the ground, less the ball */
function trueZ(L: number, x: number, y: number): number {
  const s = K ** (L - 1);
  const rho = Math.hypot(x / s - C1.x, y / s - C1.y);
  const g = 0;
  if (rho >= C1.r) return g;
  return Math.min(g, C1.cz - Math.sqrt(C1.r * C1.r - rho * rho)) * s;
}

/** per level: the corners within `band` columns of the rim circle (level L's units): max and mean height error against
 *  the true surface (in the drop at the rim's scale: level-L units), and the crossed corners' distance from the circle */
function measure(n: Nest, L: number, snap: boolean) {
  const m = sheetMesh(sceneOf(n, L, snap));
  const s = K ** (L - 1);
  const cx = C1.x * s;
  const cy = C1.y * s;
  const R = R1 * s;
  let worstZ = 0;
  let sumZ = 0;
  let cnt = 0;
  let worstR = 0;
  let rim = 0;
  let worstAt = '';
  for (const l of m.lines.values()) {
    if (l.L !== L || l.levelEdge || l.rootEdge) continue;
    const c = l.clusters[l.clusters.length - 1];
    const x = l.cx + c.ox;
    const y = l.cy + c.oy;
    const dr = Math.hypot(x - cx, y - cy) - R;
    // (the band round the rim; a level edge's neighbours left out)
    const w = n.levels[L].f;
    if (l.cx < w.gx + 2 || l.cy < w.gy + 2 || l.cx > w.gx + w.n - 2 || l.cy > w.gy + w.n - 2) continue;
    if (Math.abs(dr) > 6) continue;
    const ins = [0, 1, 2, 3].map((q) => Math.hypot(l.cx - 0.5 + (q & 1) - cx, l.cy - 0.5 + (q >> 1) - cy) < R);
    const crossed = !(ins.every((v) => v) || ins.every((v) => !v));
    if (crossed && (c.ox || c.oy)) {
      rim++;
      worstR = Math.max(worstR, Math.abs(dr));
    }
    if (crossed) continue;
    const e = Math.abs(c.z - trueZ(L, x, y));
    sumZ += e;
    cnt++;
    if (e > worstZ) {
      worstZ = e;
      worstAt = `${l.cx},${l.cy} dr ${dr.toFixed(2)} z ${c.z.toFixed(2)} true ${trueZ(L, x, y).toFixed(2)}`;
    }
  }
  // the outline in plan: a column carved (its top under the ground by more than a hundredth of a column... of its own
  // units) against the true circle; wrong ones counted by their distance from the circle
  const lv = n.levels[L];
  let wrong = 0;
  let wrongFar = 0;
  let farthest = 0;
  for (let y = lv.f.gy; y < lv.f.gy + lv.f.n; y++)
    for (let x = lv.f.gx; x < lv.f.gx + lv.f.n; x++) {
      const c = lv.at(x, y)!;
      const carved = c.z1[c.mat.length - 1] < -0.05;
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - R;
      if (carved === d < 0) continue;
      wrong++;
      if (Math.abs(d) > 1) wrongFar++;
      farthest = Math.max(farthest, Math.abs(d));
    }
  return { worstZ, meanZ: sumZ / cnt, cnt, rim, worstR, worstAt, wrong, wrongFar, farthest };
}

/** the stills' crater (scripts/nested-r23-stills.mjs): k 8, a hillside, the seeded detail on, a ball of radius 1.4 root
 *  columns centred 0.3 over the ground, carved at level 1; levels 2 and 3 open over a piece of its rim */
function buildHill(on: boolean): Nest {
  const k = 8;
  const lv = new Level({ depth: 0, gx: 0, gy: 0, n: 16, z0: 0 });
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const s = 10 + 0.45 * x + 0.2 * y;
    lv.set(x, y, { mat: [MAT.stone, MAT.soil], z0: [OPEN_BOTTOM, s - 0.3], z1: [s - 0.3, s] });
  }
  const n = new Nest(lv, k, 11);
  n.edgeEnh = on;
  n.promote({ depth: 1, gx: 32, gy: 32, n: 64, z0: 13 });
  // the ball: centre (8.1, 7.9) root columns, 0.3 over the ground there; level 1 units are root * 8
  const g = 10 + 0.45 * 7.5 + 0.2 * 7.5;
  n.edit(1, 'carve', 8.1 * k, 7.9 * k, 1.4 * k, 0, (g + 0.3 - 13) * k);
  // level 2 over the rim's west side (level-1 columns 54 .. 70 across x = 8.1*8 - 11.2 = 53.6)
  n.promote({ depth: 2, gx: 50 * k, gy: 56 * k, n: 128, z0: Math.round((g - 13) * k) });
  const z2 = n.levels[2].f.z0;
  void z2;
  n.promote({ depth: 3, gx: 52 * k * k, gy: 62 * k * k, n: 128, z0: n.levels[2].at(52 * k + 8, 62 * k + 8)!.z1.at(-1)! | 0 });
  return n;
}

/** the spikes: a slid (crossed) corner standing above the highest of its four axial neighbour corners (level-L units),
 *  with what made it: its members' heights and samples */
function spikes(n: Nest, L: number) {
  const m = sheetMesh(sceneOf(n, L, true));
  const lvl = n.levels[L];
  const out: { up: number; at: string }[] = [];
  for (const l of m.lines.values()) {
    if (l.L !== L || l.levelEdge) continue;
    const c = l.clusters[l.clusters.length - 1];
    if (!c.ox && !c.oy) continue;
    const nb = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ].map(([dx, dy]) => m.lines.get(`${L}:${l.cx + dx}:${l.cy + dy}`));
    if (nb.some((x) => !x)) continue;
    const zs = nb.map((x) => x!.clusters[x!.clusters.length - 1].z);
    // (how far it stands out of its neighbours' range, up or down)
    const up = Math.max(c.z - Math.max(...zs), Math.min(...zs) - c.z);
    if (up <= 0.5) continue;
    const mem = [0, 1, 2, 3].map((q) => {
      const col = lvl.at(l.cx - 1 + (q & 1), l.cy - 1 + (q >> 1))!;
      const e = col.edge?.[col.mat.length - 1] ?? 0;
      const d = e ? ((e >>> 18) & 4095) / 1024 - 2 : NaN;
      return `q${q} z ${col.z1[col.mat.length - 1].toFixed(2)} d ${Number.isNaN(d) ? 'none' : d.toFixed(2)}`;
    });
    out.push({ up, at: `corner ${l.cx},${l.cy} at ${c.z.toFixed(2)} slid ${c.ox.toFixed(2)},${c.oy.toFixed(2)}, ${up.toFixed(2)} out of its neighbours' range [${Math.min(...zs).toFixed(2)}, ${Math.max(...zs).toFixed(2)}]; members ${mem.join(', ')}` });
  }
  out.sort((a, b) => b.up - a.up);
  return out;
}

describe('nested scales round 24 A: edge-aware enhance', () => {
  it('the spikes on derived levels: slid corners above every neighbour (measurement)', () => {
    const rows: string[] = [];
    for (const [name, b] of [
      ['flat k 4', build],
      ['hill k 8', buildHill],
    ] as const)
      for (const on of [false, true]) {
        const nest = b(on);
        for (const L of [1, 2, 3]) {
          const s = spikes(nest, L);
          rows.push(`${name} edge-aware ${on ? 'on ' : 'off'} level ${L}: ${s.length} spikes over 0.5${s.length ? `; tallest ${s.slice(0, 2).map((x) => x.at).join(' | ')}` : ''}`);
        }
      }
    console.log(`[edgeenh] spikes\n${rows.join('\n')}`);
  });

  it('a circle carved at level 1 is round at levels 2 and 3 (measurement and bound)', () => {
    const rows: string[] = [];
    const res = new Map<string, ReturnType<typeof measure>>();
    for (const on of [false, true])
      for (const L of [1, 2, 3]) {
        const r = measure(build(on), L, true);
        res.set(`${on} ${L}`, r);
        rows.push(`edge-aware ${on ? 'on ' : 'off'} level ${L}: corners near the rim (not crossed) ${r.cnt}, height error max ${r.worstZ.toFixed(3)} mean ${r.meanZ.toFixed(3)} (level-${L} units; worst at ${r.worstAt}); crossed corners slid ${r.rim}, farthest from the circle ${r.worstR.toFixed(3)} columns; columns carved on the wrong side ${r.wrong} (${r.wrongFar} more than a column from the circle, farthest ${r.farthest.toFixed(2)})`);
      }
    console.log(`[edgeenh] carve r ${C1.r} at level 1, centre ${C1.cz} above the ground (rim slope ${(R1 / C1.cz).toFixed(1)}), rimsnap on\n${rows.join('\n')}`);
    for (const L of [2, 3]) {
      const r = res.get(`true ${L}`)!;
      expect(r.rim).toBeGreaterThan(20);
      expect(r.worstR).toBeLessThan(0.6);
    }
  });

  it('the zoom cycle reproduces the same columns; restrict gives the enhanced parents back', () => {
    const n = build(true);
    const snap = (L: number) => n.levels[L].parts.map((p) => ({ top: p.top.slice(), mat: p.mat.slice(), edge: (p.edge ?? []).slice() }));
    const before = [2, 3].map(snap);
    n.demote(2);
    n.promote(F2);
    n.promote(F3);
    const after = [2, 3].map(snap);
    let zoom = 0;
    let structs = 0;
    for (let i = 0; i < 2; i++)
      before[i].forEach((p, j) => {
        const q = after[i][j];
        if (p.mat.join() !== q.mat.join() || p.edge.join() !== q.edge.join()) structs++;
        else p.top.forEach((t, r) => (zoom = Math.max(zoom, Math.abs(t - q.top[r]) / K ** (i + 1))));
      });
    // restrict over the whole of level 3 (an edit that changed nothing): every ancestor's change, parent units
    const lv2 = snap(2);
    const lv1 = snap(1);
    const f3 = n.levels[3].f;
    n.propagate(3, { x0: f3.gx, y0: f3.gy, x1: f3.gx + f3.n, y1: f3.gy + f3.n });
    let r2 = 0;
    let r1 = 0;
    let s2 = 0;
    lv2.forEach((p, j) => {
      const q = n.levels[2].parts[j];
      if (p.mat.join() !== q.mat.join()) s2++;
      else p.top.forEach((t, r) => (r2 = Math.max(r2, Math.abs(t - q.top[r]) / K)));
    });
    lv1.forEach((p, j) => {
      const q = n.levels[1].parts[j];
      if (p.mat.join() === q.mat.join()) p.top.forEach((t, r) => (r1 = Math.max(r1, Math.abs(t - q.top[r]))));
    });
    console.log(`[edgeenh] zoom cycle (carve at 1, in to 3, out, in): max change ${zoom} parent units, ${structs} columns of another structure or edge; restrict over level 3: level 2 max change ${r2.toExponential(2)} (level-1 units), ${s2} of another structure; level 1 ${r1.toExponential(2)}`);
    expect(zoom).toBe(0);
    expect(structs).toBe(0);
    expect(r2).toBeLessThan(1e-9);
    expect(s2).toBe(0);
  });
});
