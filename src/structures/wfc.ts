// Wave function collapse on any graph (the user, round 117: "some WFC"). Nodes take one of up to 32 tiles; each edge
// has a relation (above, beside, …) and a relation says which tile pairs may meet across it; each node may weight its
// tiles. Lowest entropy first, arc consistency after each pick, a fresh attempt from the next seed on a contradiction.
// Used for the façades (which wall a storey shows, so bays line up and doors face the street) and open for more (street
// furniture, district layouts). Why a general solver: one tested piece, many uses; the rules stay data.
import { rng } from './rng';

export interface WfcProblem {
  /** tiles (≤ 32) */
  tiles: number;
  /** per node, the allowed tiles as a bit mask (its unary constraints) */
  domain: Uint32Array;
  /** per node, per tile, its weight (0 = never) — nodes × tiles */
  weight: Float64Array;
  /** edges: a, b, relation */
  edges: [number, number, number][];
  /** per relation, per tile of a, the tiles b may be (bit masks) — relations × tiles */
  allow: Uint32Array[];
  /** the inverse relation's table (b's tile → a's tiles); computed if omitted */
  allowInv?: Uint32Array[];
}

export class WfcContradiction extends Error {}

const popcount = (x: number) => {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

function invert(allow: Uint32Array, tiles: number): Uint32Array {
  const inv = new Uint32Array(tiles);
  for (let a = 0; a < tiles; a++) for (let b = 0; b < tiles; b++) if (allow[a] & (1 << b)) inv[b] |= 1 << a;
  return inv;
}

/** Solve: one tile a node. Throws WfcContradiction after `attempts` failures (the rules can't be met). */
export function solve(p: WfcProblem, seed: number, attempts = 12): Int32Array {
  const inv = p.allowInv ?? p.allow.map((a) => invert(a, p.tiles));
  const n = p.domain.length;
  // adjacency: per node, its (other, table) pairs
  const adj: { o: number; t: Uint32Array }[][] = Array.from({ length: n }, () => []);
  for (const [a, b, rel] of p.edges) {
    adj[a].push({ o: b, t: p.allow[rel] });
    adj[b].push({ o: a, t: inv[rel] });
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    const r = rng(seed + attempt * 7919);
    const dom = p.domain.slice();
    for (let i = 0; i < n; i++) {
      let m = dom[i];
      for (let t = 0; t < p.tiles; t++) if (p.weight[i * p.tiles + t] <= 0) m &= ~(1 << t);
      dom[i] = m;
    }
    const ok = propagate(dom, adj, p.tiles, Array.from({ length: n }, (_, i) => i));
    if (!ok) continue;
    let failed = false;
    for (;;) {
      // the undecided node with the least entropy (ties broken by a little noise)
      let best = -1;
      let bestE = Infinity;
      for (let i = 0; i < n; i++) {
        const c = popcount(dom[i]);
        if (c <= 1) continue;
        let sw = 0;
        let swl = 0;
        for (let t = 0; t < p.tiles; t++)
          if (dom[i] & (1 << t)) {
            const w = p.weight[i * p.tiles + t];
            sw += w;
            swl += w * Math.log(w);
          }
        const e = Math.log(sw) - swl / sw + r() * 1e-3;
        if (e < bestE) {
          bestE = e;
          best = i;
        }
      }
      if (best < 0) break;
      // pick by weight
      let sw = 0;
      for (let t = 0; t < p.tiles; t++) if (dom[best] & (1 << t)) sw += p.weight[best * p.tiles + t];
      let x = r() * sw;
      let pick = -1;
      for (let t = 0; t < p.tiles; t++)
        if (dom[best] & (1 << t)) {
          pick = t;
          x -= p.weight[best * p.tiles + t];
          if (x <= 0) break;
        }
      dom[best] = 1 << pick;
      if (!propagate(dom, adj, p.tiles, [best])) {
        failed = true;
        break;
      }
    }
    if (failed) continue;
    const out = new Int32Array(n);
    for (let i = 0; i < n; i++) out[i] = 31 - Math.clz32(dom[i]);
    return out;
  }
  throw new WfcContradiction(`wfc: no solution in ${attempts} attempts (${n} nodes, ${p.tiles} tiles)`);
}

/** arc consistency from the changed nodes; false on an emptied domain */
function propagate(dom: Uint32Array, adj: { o: number; t: Uint32Array }[][], tiles: number, start: number[]): boolean {
  const stack = start.slice();
  const queued = new Uint8Array(dom.length);
  for (const s of start) queued[s] = 1;
  while (stack.length) {
    const i = stack.pop()!;
    queued[i] = 0;
    if (dom[i] === 0) return false;
    for (const { o, t } of adj[i]) {
      let can = 0;
      for (let a = 0; a < tiles; a++) if (dom[i] & (1 << a)) can |= t[a];
      const next = dom[o] & can;
      if (next !== dom[o]) {
        if (next === 0) return false;
        dom[o] = next;
        if (!queued[o]) {
          queued[o] = 1;
          stack.push(o);
        }
      }
    }
  }
  return true;
}
