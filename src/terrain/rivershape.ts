// Terrain track (round 117): the shape of the atlas's rivers along their course — where their water stands.
//
// The user, verbatim (DECISIONS round 117): "Rivers look bad right now. They have serious isotropy issues and they have
// no banks. Use SDF. Have them carve into the ground. Make their banks look eroded. Add reeds. Have rocks and rapids.
// Have waterfalls. So many waterfalls." and (part 3) "They have no banks and they look best only near the cliffs I
// helped make good. Waterfalls and flow are what look pretty good."
//
// Why this file: the river graph (atlas/rivers.ts) is a drainage tree over the macro texels (8 cells each, 8
// neighbours), so a river's line only ran at 0/45/90 degrees and its water stood at the filled ground's level — flush
// with the plain it crosses, so no bank showed. Two of the fixes are about the course, not the cross-section, and are
// cheap once per atlas on the CPU (thousands of nodes, ~1 ms), so they live here as pure functions over the node
// arrays (unit-tested in rivershape.test.ts); the cross-section (bank, bars, boulders, plunge pools) is an SDF per
// cell on the GPU (terrain/river.wgsl).
//  - smooth(): the nodes' positions relaxed along the main stems (a Laplacian, ends pinned): the line's direction
//    follows the land instead of the texel grid. (The GPU also warps its lookup — river.wgsl — for bends at every
//    angle; this only removes the grid's corners.)
//  - shapeLevels(): the water's level lowered under the filled ground by an incision that grows with the river (so it
//    runs between banks it cut), tapered to nothing where it meets the sea or a lake (their water is the datum there);
//    on steep reaches the level made a staircase — still pools and falls — rather than a ramp ("So many waterfalls").
//    The level still only falls downstream (every consumer — the held rivers, the pipes when woken — relies on that).

export interface RiverCourse {
  /** per node: world position (in place: smooth() moves them) */
  x: Float32Array;
  y: Float32Array;
  /** per node: the water's level (world z; in place: shapeLevels() lowers it) */
  level: Float32Array;
  /** per node: half-width (world units) */
  width: Float32Array;
  /** per node: the node downstream (its own index: the river's end) */
  next: Int32Array;
  /** per node: 1 where the node ends a river in standing water (the sea, a lake): its level is that water's */
  still: Uint8Array;
  /** per node: what drains through it (texels, dryness-weighted): picks each confluence's main stem */
  acc: Float32Array;
  /** the torus (world units) */
  worldW: number;
  worldH: number;
}

/** the incision a river of half-width w cuts under the filled ground (cells): its banks' height at its mouth's end */
export function incisionFor(w: number): number {
  return Math.min(4.5, Math.max(1.2, 0.8 + 0.35 * w));
}
/** a staircase's step (cells): over RIVER_FALL (1.5) so each is a fall the water pours over as a sheet */
export const CASCADE_STEP = 3.5;
/** a reach falls this much a node or more (cells / node) to be made a staircase */
export const CASCADE_SLOPE = 0.6;
/** nodes from its end over which a river's incision grows to its full depth */
const INCISE_RAMP = 4;

const wrapD = (d: number, W: number) => d - Math.round(d / W) * W;

/** each node's main upstream node (the one draining most into it; −1: a source) */
export function mainUpstream(c: RiverCourse): Int32Array {
  const n = c.next.length;
  const up = new Int32Array(n).fill(-1);
  for (let k = 0; k < n; k++) {
    const j = c.next[k];
    if (j === k) continue;
    if (up[j] < 0 || c.acc[k] > c.acc[up[j]]) up[j] = k;
  }
  return up;
}

/**
 * Relax the nodes' positions along their stems `iters` times: each moves `rate` of the way toward the midpoint of
 * its main upstream and its downstream node. Sources, ends and still-water nodes stay (a mouth is where the sea is).
 * A node moves at most `maxMove` (world units) from where it was: the GPU finds a river by the nodes nearest a
 * point's texels, so a node must stay near its own texel.
 */
export function smooth(c: RiverCourse, iters = 6, rate = 0.5, maxMove = 7): void {
  const n = c.next.length;
  const up = mainUpstream(c);
  const x0 = Float32Array.from(c.x);
  const y0 = Float32Array.from(c.y);
  const nx = new Float32Array(n);
  const ny = new Float32Array(n);
  for (let it = 0; it < iters; it++) {
    for (let k = 0; k < n; k++) {
      const j = c.next[k];
      const u = up[k];
      nx[k] = c.x[k];
      ny[k] = c.y[k];
      if (j === k || u < 0 || c.still[k]) continue;
      // (the neighbours unwrapped round this node: a river may cross the torus's seam)
      const mx = 0.5 * (wrapD(c.x[j] - c.x[k], c.worldW) + wrapD(c.x[u] - c.x[k], c.worldW));
      const my = 0.5 * (wrapD(c.y[j] - c.y[k], c.worldH) + wrapD(c.y[u] - c.y[k], c.worldH));
      let px = c.x[k] + rate * mx;
      let py = c.y[k] + rate * my;
      const dx = wrapD(px - x0[k], c.worldW);
      const dy = wrapD(py - y0[k], c.worldH);
      const d = Math.hypot(dx, dy);
      if (d > maxMove) {
        px = x0[k] + (dx / d) * maxMove;
        py = y0[k] + (dy / d) * maxMove;
      }
      nx[k] = px;
      ny[k] = py;
    }
    c.x.set(nx);
    c.y.set(ny);
  }
}

/**
 * Nodes upstream of each before it (an order where every node comes before the one it runs into). Kahn's algorithm
 * over the tree; a cycle (none in a drainage tree) throws.
 */
export function upstreamFirst(next: Int32Array): Int32Array {
  const n = next.length;
  const ins = new Int32Array(n);
  for (let k = 0; k < n; k++) if (next[k] !== k) ins[next[k]]++;
  const out = new Int32Array(n);
  let h = 0;
  let t = 0;
  for (let k = 0; k < n; k++) if (ins[k] === 0) out[t++] = k;
  while (h < t) {
    const k = out[h++];
    const j = next[k];
    if (j !== k && --ins[j] === 0) out[t++] = j;
  }
  if (t !== n) throw new Error(`rivershape: the river graph has a cycle (${n - t} nodes in it)`);
  return out;
}

export interface LevelStats {
  /** nodes on a staircase, and the falls the staircases made (a step ≥ CASCADE_STEP − 0.01 between two nodes) */
  cascaded: number;
  falls: number;
  /** the mean incision (cells) */
  incision: number;
}

/**
 * The water's level along each river: incised under the filled ground (incisionFor its width, ramped in over
 * INCISE_RAMP nodes from its end), on steep reaches a staircase of CASCADE_STEP, still falling downstream everywhere.
 * `ground` is the level before (the filled ground's: rivers.ts lev), in place in c.level.
 */
export function shapeLevels(c: RiverCourse): LevelStats {
  const n = c.next.length;
  const order = upstreamFirst(c.next);
  // hops to the end (downstream first: the reverse order)
  const hops = new Int32Array(n);
  for (let i = n - 1; i >= 0; i--) {
    const k = order[i];
    const j = c.next[k];
    hops[k] = j === k || c.still[k] ? 0 : c.still[j] ? 1 : hops[j] + 1;
  }
  // the still water each river ends in (its level: no node of it lower — a channel under the lake it runs into would
  // drain the lake backwards up it); a river ending on land: none
  const floor = new Float32Array(n).fill(-Infinity);
  for (let i = n - 1; i >= 0; i--) {
    const k = order[i];
    const j = c.next[k];
    floor[k] = c.still[k] ? c.level[k] : j === k ? -Infinity : floor[j];
  }
  const base = Float32Array.from(c.level);
  // the slope a node falls by (over its next two)
  const steep = (k: number) => {
    const j = c.next[k];
    const jj = c.next[j];
    // (not into the still water: the drop to the sea is no reach to step)
    if (j === k || c.still[j] || c.still[jj]) return 0;
    return (base[k] - base[jj]) / (jj === j ? 1 : 2);
  };
  let cascaded = 0;
  let incSum = 0;
  for (let k = 0; k < n; k++) {
    if (c.still[k]) continue;
    const inc = incisionFor(c.width[k]) * Math.min(1, hops[k] / INCISE_RAMP);
    incSum += inc;
    let L = base[k] - inc;
    // (a staircase's treads at whole steps of the world's z: a river's steps line up along it, whatever its source)
    if (hops[k] > 1 && steep(k) >= CASCADE_SLOPE) {
      L = Math.floor(L / CASCADE_STEP) * CASCADE_STEP;
      cascaded++;
    }
    // (never under the still water it runs into: a channel lower than the lake beside it would drain it backwards)
    c.level[k] = Math.max(L, floor[k]);
  }
  // still falling where the filled ground falls: each node no higher than the node above it — but only where the
  // ground's own level fell between them. (The graph's levels aren't monotone everywhere: a river through a hollow too
  // small to be a lake follows its floor and rises out of it, rivers.ts. Pushing every node under the hollow's floor
  // cut the whole reach past it into a trench — one ran 9 cells deep along a plateau's top, round 117.)
  for (const k of order) {
    const j = c.next[k];
    if (j !== k && !c.still[j] && base[j] <= base[k] && c.level[j] > c.level[k]) c.level[j] = c.level[k];
  }
  let falls = 0;
  for (let k = 0; k < n; k++) {
    const j = c.next[k];
    if (j !== k && c.level[k] - c.level[j] >= CASCADE_STEP - 0.01) falls++;
  }
  return { cascaded, falls, incision: +(incSum / Math.max(1, n)).toFixed(2) };
}
