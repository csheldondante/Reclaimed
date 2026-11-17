// Terrain rivers, step 3 (docs/design/TERRAIN_RIVERS.md §9.8 (a), flag a.rivers2=1): the lakes the walks find. The owner
// (2026-11-17): "Yeah that sounds good. Use the GPU flood fill I think?" — so the basins are the depressions of the
// macro ground's filled surface (terrain/flood.ts fillTorus: Planchon–Darboux on the GPU over the whole torus, the sea
// the outlets). A basin becomes a lake only when a walk reaches it (or it is placed: a crater's); the walk ends in it
// and a new walk leaves from its outlet (walks.ts). Pure functions over typed arrays (unit tests: lakes.test.ts).

/** the basins: deeper than EPS under the filled surface; kept when at least MIN_DEPTH deep and MIN_TEXELS large */
export const LAKES2 = { EPS: 0.25, MIN_DEPTH: 1.5, MIN_TEXELS: 12 };

export interface Basin {
  id: number;
  /** its spill level (the filled surface over it) */
  level: number;
  /** its texels (all under the level) */
  texels: number[];
  /** the lowest ground in it */
  floor: number;
  /** the rim texel it spills over (the lowest ground round it) */
  outlet: number;
}

const DX = [1, -1, 0, 0, 1, -1, -1, 1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];
const wi = (v: number, n: number) => ((v % n) + n) % n;

/** the basins of the filled surface W over the ground G (n × n, a torus; water: the sea, never a basin) */
export function basinsOf(n: number, G: Float32Array, W: Float32Array, water: Uint8Array): { basinOf: Int32Array; basins: Basin[] } {
  const N = n * n;
  const basinOf = new Int32Array(N).fill(-1);
  const seen = new Uint8Array(N);
  const basins: Basin[] = [];
  const inside = (i: number) => !water[i] && W[i] - G[i] > LAKES2.EPS;
  const stack: number[] = [];
  for (let s = 0; s < N; s++) {
    if (seen[s] || !inside(s)) continue;
    const mem: number[] = [];
    seen[s] = 1;
    stack.push(s);
    let floor = Infinity;
    let level = Infinity;
    while (stack.length) {
      const c = stack.pop()!;
      mem.push(c);
      floor = Math.min(floor, G[c]);
      level = Math.min(level, W[c]);
      const x = c % n;
      const y = (c - x) / n;
      for (let k = 0; k < 8; k++) {
        const j = wi(y + DY[k], n) * n + wi(x + DX[k], n);
        if (!seen[j] && inside(j)) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    if (level - floor < LAKES2.MIN_DEPTH || mem.length < LAKES2.MIN_TEXELS) continue;
    const id = basins.length;
    for (const c of mem) basinOf[c] = id;
    // the outlet: the rim's lowest ground
    let outlet = -1;
    for (const c of mem) {
      const x = c % n;
      const y = (c - x) / n;
      for (let k = 0; k < 8; k++) {
        const j = wi(y + DY[k], n) * n + wi(x + DX[k], n);
        if (basinOf[j] === id) continue;
        if (outlet < 0 || G[j] < G[outlet] || (G[j] === G[outlet] && j < outlet)) outlet = j;
      }
    }
    basins.push({ id, level, texels: mem, floor, outlet });
  }
  return { basinOf, basins };
}

/** a basin's rim (texels outside it with a neighbour in it; the torus wraps) */
export function rimOfBasin(n: number, b: Basin, basinOf: Int32Array): number[] {
  const out = new Set<number>();
  for (const c of b.texels) {
    const x = c % n;
    const y = (c - x) / n;
    for (let k = 0; k < 8; k++) {
      const j = wi(y + DY[k], n) * n + wi(x + DX[k], n);
      if (basinOf[j] !== b.id) out.add(j);
    }
  }
  return [...out];
}
