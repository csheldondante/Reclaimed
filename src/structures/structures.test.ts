// The structures system at its contract, on tiny cities (vitest, Node; no GPU). `npx vitest run src/structures`.
import { describe, expect, it } from 'vitest';
import type { CitySpec, GroundFn } from '../api/contracts/structures';
import { planCity, isolate, grown } from './plan';
import { piecesOf, PIECE_FLOATS, ROOF_LIFT } from './pieces';
import { columnsOf } from './columns';
import { buriable, assetPieces, AFFINE } from './assets';
import { navPath } from './nav';
import { library, roofHeight } from './modules';
import { solve, WfcContradiction } from './wfc';
import { adjacency, quadArea, quadCorners } from './tiles/builder';
import { tileSystem } from './tiles/systems';
import { fbm } from './rng';
import { profile, GRADE } from './linear';

const hill: GroundFn = (x, y) => 20 + 12 * fbm(x * 0.012, y * 0.012, 4) + 0.04 * x;
const flat: GroundFn = () => 10;
const SYSTEMS = ['irregular', 'contour-voronoi', 'radial', 'orthogonal'] as const;
const spec = (system: CitySpec['system'], o: Partial<CitySpec> = {}): CitySpec => ({ seed: 7, system, style: 'hearth', at: [500, 500], radius: 48, ...o });

describe('tile systems', () => {
  for (const system of SYSTEMS)
    it(`${system}: a counter-clockwise quad mesh, deterministic, conforming enough to have neighbours`, () => {
      const t = tileSystem({ spec: spec(system), ground: hill });
      const n = t.use.length;
      expect(n).toBeGreaterThan(60);
      for (let q = 0; q < n; q++) expect(quadArea(t, q)).toBeGreaterThan(0.01);
      const again = tileSystem({ spec: spec(system), ground: hill });
      expect(Array.from(again.quads)).toEqual(Array.from(t.quads));
      const adj = adjacency(t);
      let inner = 0;
      for (let i = 0; i < adj.length; i++) if (adj[i] >= 0) inner++;
      // most sides are shared (T-junctions where radial rings double, Voronoi bands meet plots)
      expect(inner / adj.length).toBeGreaterThan(0.6);
      expect(t.use.filter((u) => u === 'lot').length).toBeGreaterThan(n * 0.2);
      expect(t.use.some((u) => u === 'street')).toBe(true);
    });

  it('irregular: relaxed toward squares (no sliver tiles)', () => {
    const t = tileSystem({ spec: spec('irregular'), ground: flat });
    let worst = 180;
    for (let q = 0; q < t.use.length; q++) {
      const p = quadCorners(t, q);
      for (let k = 0; k < 4; k++) {
        const a = p[(k + 3) % 4];
        const b = p[k];
        const c = p[(k + 1) % 4];
        const ang = Math.abs(Math.atan2((a[0] - b[0]) * (c[1] - b[1]) - (a[1] - b[1]) * (c[0] - b[0]), (a[0] - b[0]) * (c[0] - b[0]) + (a[1] - b[1]) * (c[1] - b[1])));
        worst = Math.min(worst, (ang * 180) / Math.PI);
      }
    }
    expect(worst).toBeGreaterThan(30);
  });

  it('radial has a wall and gates on its rim', () => {
    const t = tileSystem({ spec: spec('radial'), ground: flat });
    expect(t.use.filter((u) => u === 'wall').length).toBeGreaterThan(10);
    expect(t.use.filter((u) => u === 'gate').length).toBeGreaterThan(0);
  });
});

describe('roofs', () => {
  it('a ridge carries on across a joined side: two tiles in a row meet at the same heights', () => {
    // tile A free on sides 0, 2, 3 (its side 1 joined to B); B free on 0, 1, 2 (its side 3 joined to A)
    for (const v of [0, 0.2, 0.5, 0.8, 1]) expect(roofHeight(1, v, 1 | 4 | 8, 0)).toBeCloseTo(roofHeight(0, v, 1 | 2 | 4, 0));
  });
  it('the inside of an L slopes down to its corner on both arms', () => {
    // corner tile: free sides 0 and 3, joined 1 and 2, corner 2 (1,1) free; the arm across side 1 is free on 0 and 2
    for (const v of [0, 0.25, 0.5, 0.75, 1]) expect(roofHeight(1, v, 1 | 8, 4)).toBeCloseTo(roofHeight(0, v, 1 | 4, 0));
  });
  it('every roof module is made of finite vertices in a sane frame', () => {
    const lib = library();
    const id = lib.id('roof:5:0:10:5:0:tile');
    const m = lib.modules[id];
    expect(m.index.length % 3).toBe(0);
    for (const x of m.verts) expect(Number.isFinite(x)).toBe(true);
  });
});

describe('wfc', () => {
  it('meets the constraints of a chain', () => {
    // 3 tiles, a chain of 20 nodes: tile t may be followed only by t or t+1 (mod 3)
    const n = 20;
    const allow = new Uint32Array([0b011, 0b110, 0b101]);
    const sol = solve({ tiles: 3, domain: new Uint32Array(n).fill(7), weight: new Float64Array(n * 3).fill(1), edges: Array.from({ length: n - 1 }, (_, i) => [i, i + 1, 0] as [number, number, number]), allow: [allow] }, 3);
    for (let i = 0; i + 1 < n; i++) expect(allow[sol[i]] & (1 << sol[i + 1])).toBeTruthy();
  });
  it('throws when the rules cannot be met', () => {
    // two nodes that must differ, both forced to tile 0
    expect(() => solve({ tiles: 2, domain: new Uint32Array([1, 1]), weight: new Float64Array(4).fill(1), edges: [[0, 1, 0]], allow: [new Uint32Array([0b10, 0b01])] }, 1)).toThrow(WfcContradiction);
  });
});

describe('plans', () => {
  for (const system of SYSTEMS)
    it(`${system}: buildings in one block each, a front door each, façades only where open`, () => {
      const p = planCity(spec(system), hill);
      expect(p.buildings.length).toBeGreaterThan(5);
      for (const b of p.buildings) {
        const blocks = new Set(b.quads.map((q) => p.tiles.block[q]));
        expect(blocks.size).toBe(1);
        if (!b.mega && p.facades.some((f) => f.building === b.id && f.level === 0)) expect(p.facades.some((f) => f.building === b.id && f.kind === 'door' && f.level === 0)).toBe(true);
      }
      // a door is only ever on the ground floor; a balcony never is
      for (const f of p.facades) {
        if (f.kind === 'door' || f.kind === 'shop') expect(f.level).toBe(0);
        if (f.kind === 'balcony') expect(f.level).toBeGreaterThan(0);
      }
    });

  it('the same spec and ground make the same plan', () => {
    const a = planCity(spec('irregular'), hill);
    const b = planCity(spec('irregular'), hill);
    expect(JSON.stringify(b.facades)).toBe(JSON.stringify(a.facades));
    expect(b.buildings.map((x) => x.storeys)).toEqual(a.buildings.map((x) => x.storeys));
  });

  it('nav: from every building’s top storey to the street, and onto the rampart at a gate', () => {
    const p = planCity(spec('radial'), flat);
    const g = p.nav;
    const street = g.nodes.find((n) => n.surface === 'plaza')!;
    expect(street).toBeTruthy();
    let reached = 0;
    let tried = 0;
    for (const b of p.buildings.slice(0, 12)) {
      const top = g.nodes.filter((n) => n.building === b.id).sort((x, y) => y.at[2] - x.at[2])[0];
      if (!top) continue;
      tried++;
      if (navPath(g, top.id, street.id).length) reached++;
    }
    expect(reached).toBe(tried);
    const rampart = g.nodes.find((n) => n.surface === 'rampart')!;
    const path = navPath(g, street.id, rampart.id);
    expect(path.length).toBeGreaterThan(1);
    const kinds = new Set<string>();
    for (let i = 0; i + 1 < path.length; i++) {
      const l = g.links.find((l) => (l.a === path[i] && l.b === path[i + 1]) || (l.b === path[i] && l.a === path[i + 1]))!;
      kinds.add(l.kind);
    }
    expect(kinds.has('stairs')).toBe(true);
  });
});

describe('pieces and columns', () => {
  for (const style of ['hearth', 'bastion', 'terrace'] as const)
    it(`${style}: every piece a module that exists, every frame finite`, () => {
      const p = planCity(spec('irregular', { style }), hill);
      const pc = piecesOf(p);
      const lib = library();
      expect(pc.count).toBeGreaterThan(100);
      for (let i = 0; i < pc.count; i++) expect(pc.module[i]).toBeLessThan(lib.modules.length);
      for (let i = 0; i < pc.count * PIECE_FLOATS; i++) expect(Number.isFinite(pc.data[i])).toBe(true);
    });

  it('columns: one span a column, solid upward, under the buildings', () => {
    const p = planCity(spec('orthogonal'), flat);
    const cols = columnsOf(p);
    expect(cols.length).toBeGreaterThan(50);
    const seen = new Set<string>();
    for (const c of cols) {
      expect(c.z1).toBeGreaterThan(c.z0);
      const k = `${c.x},${c.y}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });
});

describe('buriable assets', () => {
  for (const kind of ['statue', 'column', 'fallen-tower', 'arch', 'bell'] as const)
    it(`${kind}: a mesh and the cells it fills, skewed`, () => {
      const a = buriable(kind, 3);
      expect(a.index.length).toBeGreaterThan(30);
      const id = new Float32Array([1, 0, 0, 100, 0, 1, 0, 100, 0, 0, 1, 5]);
      const up = a.cells(id);
      expect(up.length).toBeGreaterThan(0);
      // lying on its side (turned 90° about x): wider, lower
      const c = Math.cos(Math.PI / 2);
      const s = Math.sin(Math.PI / 2);
      const side = a.cells(new Float32Array([1, 0, 0, 100, 0, c, -s, 100, 0, s, c, 5]));
      const top = (cs: typeof up) => Math.max(...cs.map((x) => x.z1));
      if (a.bounds[1][2] > (a.bounds[1][1] - a.bounds[0][1]) * 1.2) expect(top(side)).toBeLessThan(top(up));
    });
});

/** a piece's vertex in the world (structmesh.wgsl spVertex, on the CPU) */
function warp(d: Float32Array, o: number, u: number, v: number, w: number) {
  const P = (k: number) => [d[o + k * 2], d[o + k * 2 + 1]];
  const [c0, c1, c2, c3] = [P(0), P(1), P(2), P(3)];
  const x = (1 - u) * (1 - v) * c0[0] + u * (1 - v) * c1[0] + u * v * c2[0] + (1 - u) * v * c3[0];
  const y = (1 - u) * (1 - v) * c0[1] + u * (1 - v) * c1[1] + u * v * c2[1] + (1 - u) * v * c3[1];
  const zf = (1 - u) * (1 - v) * d[o + 8] + u * (1 - v) * d[o + 9] + u * v * d[o + 10] + (1 - u) * v * d[o + 11];
  return [x, y, zf + (d[o + 12] - zf) * w];
}
describe('roofs meet walls', () => {
  it('no wall pokes up through a roof at its height (mitred walls, eaves held back, the roof lifted)', () => {
  const plan = planCity({ seed: 7, system: 'irregular', style: 'hearth', at: [0, 0], radius: 40, density: 0.8 }, hill);
  let worst = 0;
  let report = '';
  for (const b of plan.buildings) {
    const pc = piecesOf(isolate(plan, b.id));
    const lib = library();
    // roof triangles (world)
    const tris: number[][][] = [];
    for (let i = 0; i < pc.count; i++) {
      const m = lib.modules[pc.module[i]];
      if (!m.name.startsWith('roof:')) continue;
      for (let t = 0; t < m.index.length; t += 3) {
        const vs = [0, 1, 2].map((k) => m.index[t + k]);
        if (m.verts[vs[0] * 4 + 3] !== 2) continue;
        tris.push([...vs.map((vi) => warp(pc.data, i * PIECE_FLOATS, m.verts[vi * 4], m.verts[vi * 4 + 1], m.verts[vi * 4 + 2])), [pc.data[i * PIECE_FLOATS + 8], i, 0]]);
      }
    }
    for (let i = 0; i < pc.count; i++) {
      const m = lib.modules[pc.module[i]];
      if (!m.name.startsWith('plaster')) continue;
      for (const [u, v] of [[0.02, 0], [0.5, 0], [0.98, 0], [0.02, 1], [0.98, 1]]) {
        const p = warp(pc.data, i * PIECE_FLOATS, u, v, 1);
        for (const t of tris) {
          const [a, bb, c, meta] = t;
          if (Math.abs(meta[0] - ROOF_LIFT - p[2]) > 0.01) continue;
          const den = (bb[1] - c[1]) * (a[0] - c[0]) + (c[0] - bb[0]) * (a[1] - c[1]);
          if (Math.abs(den) < 1e-9) continue;
          const l1 = ((bb[1] - c[1]) * (p[0] - c[0]) + (c[0] - bb[0]) * (p[1] - c[1])) / den;
          const l2 = ((c[1] - a[1]) * (p[0] - c[0]) + (a[0] - c[0]) * (p[1] - c[1])) / den;
          const l3 = 1 - l1 - l2;
          if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
          const z = l1 * a[2] + l2 * bb[2] + l3 * c[2];
          const poke = p[2] - z;
          if (poke > worst && Math.abs(z - p[2]) < 4) {
            worst = poke;
            report = `b${b.id} piece ${i} ${m.name} uv ${u},${v} wall top ${p[2].toFixed(2)} roof ${z.toFixed(2)} roofTri ${JSON.stringify(t.map((q) => q.map((x) => +x.toFixed(2))))} roofmod ${lib.modules[pc.module[t[3][1]]].name}`;
          }
        }
      }
    }
  }
  expect(worst, report).toBeLessThan(0.02);
});
});

describe('linear features', () => {
  const gorge: GroundFn = (x, y) => {
    const g = Math.abs(Math.hypot(x - 500, y - 500) - 110);
    return 26 - 24 * Math.max(0, 1 - (g / 20) ** 2);
  };
  it('a road over a valley: never steeper than its grade, a bridge where it stands high over the ground', () => {
    const g = Array.from({ length: 60 }, (_, i) => 20 - 15 * Math.max(0, 1 - ((i - 30) / 12) ** 2));
    const { z, bridge } = profile(g, 2, g.map(() => false));
    for (let i = 1; i < z.length; i++) expect(Math.abs(z[i] - z[i - 1])).toBeLessThanOrEqual(GRADE * 2 + 1e-9);
    expect(bridge[30]).toBe(true);
    expect(bridge[2]).toBe(false);
    for (let i = 0; i < z.length; i++) expect(z[i]).toBeGreaterThanOrEqual(g[i]);
  });
  it('roads out of a town in a gorge cross it on arched bridges; their far ends reach the plaza', () => {
    const p = planCity(spec('irregular', { roads: 3 }), gorge);
    const bridges = p.linear.filter((f) => f.kind === 'bridge');
    expect(bridges.length).toBeGreaterThanOrEqual(2);
    const lib = library();
    const pc = piecesOf(p);
    const names = new Set(Array.from(pc.module, (m) => lib.modules[m].name));
    expect(names.has('deck') && names.has('archspan') && names.has('road')).toBe(true);
    const g = p.nav;
    const plaza = g.nodes.find((n) => n.surface === 'plaza')!;
    const far = g.nodes.filter((n) => n.surface === 'street' && n.building < 0).sort((a, b) => Math.hypot(b.at[0] - 500, b.at[1] - 500) - Math.hypot(a.at[0] - 500, a.at[1] - 500))[0];
    expect(navPath(g, far.id, plaza.id).length).toBeGreaterThan(5);
  });
  it('a walled town: wall runs with towers, the rampart walk reached by stairs', () => {
    const p = planCity(spec('contour-voronoi', { roads: 2, walls: true }), hill);
    expect(p.linear.some((f) => f.kind === 'wall')).toBe(true);
    const lib = library();
    const pc = piecesOf(p);
    expect(Array.from(pc.module).some((m) => lib.modules[m].name === 'wallwalk')).toBe(true);
    const g = p.nav;
    const plaza = g.nodes.find((n) => n.surface === 'plaza' || n.surface === 'street')!;
    const walk = g.nodes.find((n) => n.surface === 'rampart')!;
    const path = navPath(g, plaza.id, walk.id);
    expect(path.length).toBeGreaterThan(1);
  });
});

describe('mega tiles', () => {
  it('a domed temple over four tiles meeting at a vertex; a keep at a radial city\u2019s heart, its top reached by a lift', () => {
    const p = planCity(spec('irregular'), flat);
    const dome = p.megas.find((m) => m.kind === 'dome')!;
    expect(dome.quads.length).toBe(4);
    const b = p.buildings[p.quadBuilding[dome.quads[0]]];
    expect(b.mega).toBe('dome');
    expect(dome.quads.every((q) => p.quadBuilding[q] === b.id)).toBe(true);
    const r = planCity(spec('radial'), flat);
    expect(r.megas.some((m) => m.kind === 'keep')).toBe(true);
    const g = r.nav;
    const plaza = g.nodes.find((n) => n.surface === 'plaza')!;
    const top = g.nodes.filter((n) => n.surface === 'roof').sort((a, c) => c.at[2] - a.at[2])[0];
    const path = navPath(g, plaza.id, top.id);
    expect(path.length).toBeGreaterThan(1);
    expect(g.links.some((l) => l.kind === 'lift')).toBe(true);
  });
});

describe('placed assets', () => {
  it('a kind and seed is one module however often it is placed; each placement an affine piece with its transform', () => {
    const t = new Float32Array([0, -1, 0, 5, 1, 0, 0, 6, 0, 0, 1, 7]);
    const pc = assetPieces([
      { kind: 'statue', seed: 4, transform: t },
      { kind: 'statue', seed: 4, transform: t },
      { kind: 'bell', seed: 1, transform: t },
    ]);
    expect(pc.count).toBe(3);
    expect(pc.module[0]).toBe(pc.module[1]);
    expect(pc.module[2]).not.toBe(pc.module[0]);
    expect(pc.data[15]).toBe(AFFINE);
    expect(Array.from(pc.data.subarray(0, 12))).toEqual(Array.from(t));
  });
});

describe('growth (stored progress)', () => {
  it('a share of the build order stands, the old core first; the next building a site without a roof', () => {
    const p = planCity(spec('irregular'), flat);
    expect(new Set(p.order).size).toBe(p.buildings.length);
    const g = grown(p, 0.4);
    const standing = new Set<number>();
    for (let q = 0; q < g.quadBuilding.length; q++) if (g.quadBuilding[q] >= 0) standing.add(g.quadBuilding[q]);
    expect(standing.size).toBeGreaterThan(p.buildings.length * 0.35);
    expect(standing.size).toBeLessThan(p.buildings.length * 0.45);
    for (const f of g.facades) expect(standing.has(f.building)).toBe(true);
    const pc = piecesOf(g);
    const lib = library();
    for (const s of g.sites ?? []) for (let i = 0; i < pc.count; i++) if (pc.building[i] === s) expect(lib.modules[pc.module[i]].name.startsWith('roof:')).toBe(false);
    expect(grown(p, 1)).toBe(p);
  });
});

describe('density drives what is built (round 119)', () => {
  const dist = (p: ReturnType<typeof planCity>, b: { quads: number[] }) => {
    const [x, y] = quadCentreOf(p, b.quads[0]);
    return Math.hypot(x - 500, y - 500);
  };
  const quadCentreOf = (p: ReturnType<typeof planCity>, q: number): [number, number] => {
    const c = quadCorners(p.tiles, q);
    return [(c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4, (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4];
  };
  it('dense: town houses of several storeys; thin: huts of one or two', () => {
    const dense = planCity(spec('irregular'), flat, undefined, () => 1);
    expect(dense.buildings.every((b) => b.kind === 'house')).toBe(true);
    expect(dense.buildings.filter((b) => !b.mega).reduce((s, b) => s + b.storeys, 0) / dense.buildings.length).toBeGreaterThan(2.5);
    const thin = planCity(spec('irregular'), flat, undefined, () => 0.3);
    expect(thin.buildings.length).toBeGreaterThan(5);
    expect(thin.buildings.every((b) => b.kind === 'hut' && b.storeys <= 2)).toBe(true);
    // (fewer built where fewer live)
    expect(thin.buildings.length).toBeLessThan(dense.buildings.length);
  });
  it('a falling density: houses in the middle, huts further out, the two mixed where they meet (no hard ring)', () => {
    const p = planCity(spec('irregular', { radius: 60 }), flat);
    const houses = p.buildings.filter((b) => b.kind === 'house' && !b.mega);
    const huts = p.buildings.filter((b) => b.kind === 'hut');
    expect(houses.length).toBeGreaterThan(5);
    expect(huts.length).toBeGreaterThan(5);
    const mean = (bs: typeof houses) => bs.reduce((s, b) => s + dist(p, b), 0) / bs.length;
    expect(mean(huts)).toBeGreaterThan(mean(houses));
    // where they meet, the bands overlap: the farthest house is further out than the nearest hut
    expect(Math.max(...houses.map((b) => dist(p, b)))).toBeGreaterThan(Math.min(...huts.map((b) => dist(p, b))));
  });
  it('farmland: strips of crops, orchards or pastures fenced by plot, farmsteads of a farmhouse and a barn', () => {
    const p = planCity(spec('irregular', { radius: 40, farmland: 110 }), hill);
    expect(p.tiles.use.filter((u) => u === 'field').length).toBeGreaterThan(30);
    const farm = p.buildings.filter((b) => b.kind === 'farmhouse' || b.kind === 'barn');
    expect(farm.some((b) => b.kind === 'farmhouse')).toBe(true);
    expect(farm.some((b) => b.kind === 'barn')).toBe(true);
    const perBlock = new Map<number, number>();
    for (const b of farm) perBlock.set(p.tiles.block[b.quads[0]], (perBlock.get(p.tiles.block[b.quads[0]]) ?? 0) + 1);
    for (const n of perBlock.values()) expect(n).toBeLessThanOrEqual(2);
    const lib = library();
    const pc = piecesOf(p);
    const names = new Set(Array.from(pc.module, (m) => lib.modules[m].name));
    expect(names.has('crop')).toBe(true);
    expect(names.has('fence') || names.has('hedge')).toBe(true);
    expect([...names].some((n) => n.startsWith('barn:'))).toBe(true);
    expect([...names].some((n) => n.includes(':thatch'))).toBe(true);
  });
});
