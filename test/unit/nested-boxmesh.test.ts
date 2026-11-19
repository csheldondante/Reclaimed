// Nested scales lab, round 11 (docs/design/NESTED_SCALES.md "The smooth draw (agreed 2026-11-19)"): the reference box
// mesher (src/nested/boxmesh.ts, the GPU bake's rule) and the smooth draw's step 1. For every placement (the boxes,
// collapse, a seeded random displacement) on random and adversarial columns, one and several levels: every edge used by
// an even number of triangles and every directed edge cancelled (exact, by vertex identity, nothing exempt), no triangle
// with a repeated vertex, each level closed by itself, and no T-junction across a rim line.
import { describe, expect, it } from 'vitest';
import { AIR, type Part } from '../../src/nested/oracle';
import { asCapture, boxMesh, closure, collapse, collapseCols, dropCapPairs, identity, place, random, rimJunctionsRef, type MeshLevel, type MeshScene, type Placement } from '../../src/nested/boxmesh';
import { manifold } from '../../src/nested/watertight';

const STONE = 1;
const SOIL = 2;
const SAND = 3;
const WATER = 5;

/** a partition from (top, material) pairs, bottom up (normalised: equal neighbours merged, empty records dropped, no
 *  trailing air) */
function part(...r: number[]): Part {
  const p: Part = { top: [], mat: [] };
  for (let i = 0; i < r.length; i += 2) {
    // (heights are f32 as stored on the GPU)
    const t = Math.fround(r[i]);
    const m = r[i + 1];
    const n = p.top.length;
    if (n && t <= p.top[n - 1]) continue;
    if (n && p.mat[n - 1] === m) p.top[n - 1] = t;
    else {
      p.top.push(t);
      p.mat.push(m);
    }
  }
  while (p.mat.length && p.mat[p.mat.length - 1] === AIR) {
    p.mat.pop();
    p.top.pop();
  }
  return p;
}
function level(depth: number, gx: number, gy: number, n: number, zo: number, f: (x: number, y: number) => Part): MeshLevel {
  const parts: Part[] = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) parts.push(f(gx + x, gy + y));
  return { depth, gx, gy, n, zo, parts };
}
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}
const q = (v: number, step = 0.25) => Math.round(v / step) * step;
const one = (f: (x: number, y: number) => Part, n = 20, k = 8): MeshScene => ({ k, levels: [level(0, 0, 0, n, 0, f)] });

const N = 20;
const scenes: Record<string, () => MeshScene> = {
  gentle: () => one((x, y) => part(10 + 0.9 * Math.sin(x / 6) + 0.7 * Math.cos(y / 5), STONE)),
  slope: () => one((x, y) => part(0.7 * x + 0.3 * y, STONE)),
  cliff: () => one((x, y) => part((x < 10 ? 4 : 12) + 0.1 * Math.sin(y), STONE)),
  tunnel: () => one((x, y) => (y >= 8 && y < 11 ? part(4, STONE, 6.5, AIR, 10, STONE) : part(10, STONE))),
  'tunnel mouth': () => one((x, y) => {
    const top = x < 10 ? 10 : 10 - (x - 10) * 1.5;
    return y >= 8 && y < 11 && x < 14 ? part(4, STONE, Math.min(6.5, top), AIR, top, SOIL) : part(top, STONE);
  }),
  overhang: () => one((x, y) => (x >= 8 && x < 14 ? part(5, STONE, 7, AIR, 9, SOIL) : part(5, STONE))),
  'one-column pillars and pits': () => one((x, y) => (x === 10 && y === 10 ? part(2.5, STONE) : x === 5 && y === 5 ? part(9, STONE) : x === 15 && y === 15 ? part(0, STONE) : part(2, STONE))),
  'one-column tunnels': () => one((x, y) => (y === 8 ? part(3, STONE, 3.6, AIR, 6, STONE) : x === 4 && y === 4 ? part(2, STONE, 2.5, AIR, 6, STONE) : x === 12 ? part(3, STONE, 5, AIR, 6, STONE) : part(6, STONE))),
  'deep thin stacks': () => {
    const r = rng(11);
    return one(() => {
      const a: number[] = [];
      let z = 0;
      for (let i = 0; i < 30; i++) {
        z += q(0.05 + r() * 0.35, 0.05);
        a.push(z, [STONE, SOIL, AIR, SAND][Math.floor(r() * 4)]);
      }
      a.push(z + 1, STONE);
      return part(...a);
    });
  },
  'diagonal saddles': () => one((x, y) => part((x + y) % 2 ? 2 : 8, STONE)),
  'fluids next to air': () => one((x, y) => (x >= 5 && x < 12 && y >= 5 && y < 12 ? part(2, STONE, 4, WATER) : x === 12 && y >= 5 && y < 12 ? part(2, STONE, 3, WATER) : part(x < 5 ? 6 : 3, STONE))),
  random: () => {
    const r = rng(5);
    return one(() => {
      const a: number[] = [];
      let z = q(-4 + r() * 4);
      const n = 1 + Math.floor(r() * 7);
      for (let i = 0; i < n; i++) {
        z += q(0.25 + r() * 3);
        a.push(z, [AIR, STONE, SOIL, SAND, WATER][Math.floor(r() * 5)]);
      }
      return part(...a);
    });
  },
  // a child window inside its parent (k = 4), surfaces that differ at the rim (a tunnel and a pit in the child only)
  'child in parent': () => {
    const k = 4;
    const p = level(0, 0, 0, 12, 0, (x, y) => part(5 + 0.3 * x - 0.2 * y, STONE));
    const zo = 3;
    const c = level(1, 16, 16, 16, zo, (x, y) => {
      const zw = 5 + (0.3 * x - 0.2 * y) / k + 0.15 * Math.sin(x);
      const top = q((zw - zo) * k, 0.125);
      if (y >= 22 && y < 25) return part(top - 6, STONE, top - 3, AIR, top, SOIL);
      if (x >= 26 && x < 29 && y >= 26 && y < 30) return part(top - 9, STONE);
      return part(top, STONE);
    });
    return { k, levels: [p, c] };
  },
  // three levels, random columns on every level (structures unrelated across the rims)
  'three random levels': () => {
    const k = 4;
    const r = rng(9);
    const rnd = () => {
      const a: number[] = [];
      let z = q(r() * 4);
      const n = 1 + Math.floor(r() * 5);
      for (let i = 0; i < n; i++) {
        z += q(0.25 + r() * 4);
        a.push(z, [AIR, STONE, SOIL, WATER][Math.floor(r() * 4)]);
      }
      return part(...a);
    };
    return { k, levels: [level(0, 0, 0, 12, 0, rnd), level(1, 16, 16, 16, 2, rnd), level(2, 88, 88, 16, 1, rnd)] };
  },
};

const placements: Record<string, Placement> = { boxes: identity, 'collapse T=2': collapse(2), 'collapse T=0.5': collapse(0.5), 'random 1': random(1), 'random 2': random(2), 'random 3': random(3) };

describe('nested scales: the box mesh and the smooth draw step 1', () => {
  for (const [sn, make] of Object.entries(scenes))
    it(`${sn}: closed under every placement, each level by itself; no T-junction across a rim`, () => {
      const scene = make();
      const mesh = boxMesh(scene);
      expect(mesh.tris.length).toBeGreaterThan(0);
      // (the box mesh against the GPU suite's manifold check, by exact position, in the capture's format)
      for (let L = 0; L < scene.levels.length; L++) {
        const rep = manifold(asCapture(mesh, scene, L));
        expect(rep.open, `${sn} L${L} manifold`).toBe(0);
        expect(rep.degenerate, `${sn} L${L} degenerate`).toBe(0);
      }
      if (scene.levels.length > 1) {
        const rj = rimJunctionsRef(mesh);
        expect(rj.lines).toBeGreaterThan(0);
        expect(rj.junctions, `${sn} rim junctions`).toBe(0);
      }
      const rows: string[] = [];
      for (const [pn, pl] of Object.entries(placements)) {
        const m = place(mesh, pl, scene);
        for (let L = 0; L < scene.levels.length; L++) {
          const c = closure(m, (s) => mesh.tris[s].L === L);
          expect(c.odd, `${sn} ${pn} L${L} odd edges`).toBe(0);
          expect(c.unbalanced, `${sn} ${pn} L${L} unbalanced`).toBe(0);
          expect(c.repeated).toBe(0);
          if (pn === 'boxes') expect(c.zeroArea).toBe(0);
          rows.push(`${pn} L${L}: ${c.tris} tris (${(c.tris / mesh.drawn[L]).toFixed(2)} a column), dropped ${m.dropped}, zero-area ${c.zeroArea}, coincident ${c.coincident}, volume ${c.volume.toFixed(3)}`);
        }
      }
      console.log(`[boxmesh] ${sn}\n  ${rows.join('\n  ')}`);
    });

  // (round 12, NS-102) the collapse as the GPU would compute it (from the columns round a corner line, no mesh) agrees
  // with the mesh's, and dropping coincident cap pairs keeps every level exactly closed and leaves no coincident pair
  for (const [sn, make] of Object.entries(scenes))
    it(`${sn}: collapse from the columns = from the mesh; coincident cap pairs dropped, still closed`, () => {
      const scene = make();
      const mesh = boxMesh(scene);
      const rows: string[] = [];
      for (const T of [2, 0.5]) {
        const a = place(mesh, collapse(T), scene);
        const b = place(mesh, collapseCols(mesh, T), scene);
        // the same merges (vertex for vertex), the same heights (f32 sums against f64)
        expect(b.pos.length, `${sn} T=${T} merged vertices`).toBe(a.pos.length);
        let worst = 0;
        mesh.ids.forEach((v, i) => {
          const pa = a.pos[a.of[i]];
          const pb = b.pos[b.of[i]];
          worst = Math.max(worst, Math.abs(pa[2] - pb[2]) / Math.max(1, Math.abs(pa[2])));
        });
        expect(worst, `${sn} T=${T} heights`).toBeLessThan(1e-5);
        expect(b.dropped).toBe(a.dropped);
        const before = closure(b);
        const d = dropCapPairs(mesh, b);
        for (let L = 0; L < scene.levels.length; L++) {
          const c = closure(d, (s) => mesh.tris[s].L === L);
          expect(c.odd, `${sn} T=${T} L${L} odd edges`).toBe(0);
          expect(c.unbalanced, `${sn} T=${T} L${L} unbalanced`).toBe(0);
          expect(c.repeated).toBe(0);
          expect(c.coincident, `${sn} T=${T} L${L} coincident left`).toBe(0);
        }
        const after = closure(d);
        expect(Math.abs(after.volume - before.volume)).toBeLessThan(1e-6 * Math.max(1, Math.abs(before.volume)));
        rows.push(`T=${T}: ${before.tris} tris, coincident ${before.coincident} -> ${after.coincident} (${d.pairs} pairs dropped), ${after.tris} left; zero-area ${after.zeroArea}`);
      }
      console.log(`[pairs] ${sn}\n  ${rows.join('\n  ')}`);
    });

  it('collapse: triangles a column on gentle terrain, and what one-column features lose', () => {
    const report = (sn: string, T: number) => {
      const scene = scenes[sn]();
      const mesh = boxMesh(scene);
      const b = closure(place(mesh, identity, scene));
      const m = place(mesh, collapse(T), scene);
      const c = closure(m);
      const tops = m.src.filter((s) => mesh.tris[s].kind === 4).length;
      return { sn, T, boxTris: b.tris / mesh.drawn[0], tris: c.tris / mesh.drawn[0], topCaps: tops / mesh.drawn[0], volumeLost: b.volume - c.volume, coincident: c.coincident };
    };
    const g = report('gentle', 2);
    // (about 2 visible triangles a column on top, as agreed; the down caps under the ground are the other 2)
    expect(g.topCaps).toBeCloseTo(2, 0);
    for (const sn of Object.keys(scenes)) if (scenes[sn]().levels.length === 1) console.log(`[collapse] ${JSON.stringify(report(sn, 2))}`);
    // one-column features: a 0.5 high pillar, a 0.6 high one-column tunnel, a 0.5 bubble collapse; a 7 high pillar and
    // a 2 deep pit do not
    const pill = report('one-column pillars and pits', 2);
    const tun = report('one-column tunnels', 2);
    console.log(`[collapse] thin features: pillars/pits volume change ${pill.volumeLost.toFixed(3)}; one-column tunnels ${tun.volumeLost.toFixed(3)} (negative: air filled)`);
  });
});
