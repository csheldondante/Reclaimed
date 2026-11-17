// (tilekit, docs/design/TILEKIT.md §4) The vertex case set of the irregular grid with occupancy on cells: round a
// vertex of valence n the occupied cells form a cyclic binary word; its classes under rotation (necklaces) and under
// rotation + reflection (bracelets). The kit itself only needs a pattern's occupied runs (each run is one wall joint);
// this table is the count the design note quotes, and runsOf is what a joint is built from.

/** the canonical form of an n-bit cyclic word: the smallest over rotations (and reflections when `reflect`) */
export function canonical(word: number, n: number, reflect: boolean): number {
  const mask = (1 << n) - 1;
  let best = word & mask;
  const rev = (w: number) => {
    let r = 0;
    for (let i = 0; i < n; i++) if (w & (1 << i)) r |= 1 << (n - 1 - i);
    return r;
  };
  for (const start of reflect ? [word & mask, rev(word & mask)] : [word & mask]) {
    let w = start;
    for (let i = 0; i < n; i++) {
      if (w < best) best = w;
      w = ((w << 1) | (w >> (n - 1))) & mask;
    }
  }
  return best;
}

/** the classes of n-bit cyclic words */
export function classes(n: number, reflect: boolean): number[] {
  const s = new Set<number>();
  for (let w = 0; w < 1 << n; w++) s.add(canonical(w, n, reflect));
  return [...s].sort((a, b) => a - b);
}

/** the maximal runs of set bits round a cyclic n-bit word, as [first, length] (a full word: one run of n from 0) */
export function runsOf(word: number, n: number): [number, number][] {
  const on = (i: number) => ((word >> (((i % n) + n) % n)) & 1) === 1;
  let all = true;
  for (let i = 0; i < n; i++) if (!on(i)) all = false;
  if (all) return [[0, n]];
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    if (on(i) && !on(i - 1)) {
      let len = 0;
      while (on(i + len)) len++;
      out.push([i, len]);
    }
  }
  return out;
}

/** the joint kind of a run's interior angle (degrees): 0 convex, 1 straight, 2 concave (TILEKIT.md §4) */
export const JOINT = { convex: 0, straight: 1, concave: 2 } as const;
export function jointKind(angleDeg: number): number {
  if (angleDeg < 160) return JOINT.convex;
  if (angleDeg > 200) return JOINT.concave;
  return JOINT.straight;
}
