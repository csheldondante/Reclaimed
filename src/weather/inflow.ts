// A region's river inflow factor carried down the river graph (mutators round 4, 'dried': "a river running dry").
// A factor cuts what RUNS THROUGH its region, so it carries on downstream: a node's inflow is what still reaches it —
// its own catchment's runoff and what the reaches upstream of it carry, times its own factor — over its reference
// discharge. A river dried in one region runs low below it until its tributaries make it up. Pure (no GPU): unit
// tested in test/unit/catchwet-inflow.test.ts; weather/catchwet.ts setInflow calls it.

/**
 * @param order the nodes, every node before the one it runs into (atlas/rivers.ts Catchments.order)
 * @param next per node: the node it runs into (itself: a mouth)
 * @param own per node: its own catchment's runoff
 * @param ref per node: its discharge at the reference (its own and everything upstream)
 * @param local a node's own factor (its region's; 1: the atlas's own)
 * @param out per node: its inflow over the reference
 */
export function carryInflow(order: ArrayLike<number>, next: ArrayLike<number>, own: ArrayLike<number>, ref: ArrayLike<number>, local: (k: number) => number, out: Float32Array): void {
  const carried = new Float32Array(out.length);
  for (let i = 0; i < order.length; i++) {
    const k = order[i];
    const l = local(k);
    const q = (own[k] + carried[k]) * l;
    out[k] = ref[k] > 0 ? q / ref[k] : l;
    const nx = next[k];
    if (nx !== k) carried[nx] += q;
  }
}

/**
 * The nodes of the reaches above the seeded ones (mutators round 5, 'dried': a river that runs dry at a place fails
 * from its springs down — the water that reached the place came from above it): a node is marked when it is seeded or
 * runs, by any number of reaches, into a seeded one. With those nodes' factor cut, carryInflow takes the cut on
 * downstream of the place until tributaries make it up.
 * @param order the nodes, every node before the one it runs into
 * @param next per node: the node it runs into (itself: a mouth)
 * @param seeded per node: 1 where the cut is made (the river's nodes at the place)
 * @returns per node: 1 where it is seeded or upstream of a seeded node
 */
export function reachAbove(order: ArrayLike<number>, next: ArrayLike<number>, seeded: ArrayLike<number>): Uint8Array {
  const up = new Uint8Array(seeded.length);
  // (downstream first: a node's mark is known before the nodes that run into it ask)
  for (let i = order.length - 1; i >= 0; i--) {
    const k = order[i];
    const nx = next[k];
    up[k] = seeded[k] || (nx !== k && up[nx]) ? 1 : 0;
  }
  return up;
}
