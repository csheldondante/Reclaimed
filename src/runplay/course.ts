// ---- runplay/course.ts ------------------------------------------------------------------------------------------
// (round 119, `runplay`) A race course on the land as it is: a loop of gates from the start line round and back to it,
// each gate moved onto the nearest crest (the bike launches off crests: core/bike.ts — the user's "launch over hills
// and kick up dust", round 117 "going fast, launching off ramps"), and kickers (a mound to jump) on the flat stretches
// between gates where the land has no crest of its own. Pure: the land comes in as functions (Node tests use made-up
// hills); stage.ts reads the live world's heights and builds the kickers with the world API.

export type P2 = [number, number];

export interface CourseOpts {
  gates: number;
  /** cells between gates (the loop's length is about gates × spacing) */
  spacing: number;
  /** the window (x cells, y world units) and how far in from its edge gates stay */
  bounds: [number, number];
  margin: number;
  /** cells round a gate's nominal spot searched for a crest */
  search?: number;
}

export interface Course {
  /** the gates in order; the last is the finish line (back by the start) */
  gates: P2[];
  /** where the riders line up, and the way they face */
  start: P2;
  heading: number;
  /** mounds to build between gates (no crest there) */
  kickers: P2[];
}

/** how much a spot stands over the ground round it (cells): a crest's prominence */
export function prominence(h: (x: number, y: number) => number | null, x: number, y: number, r = 6): number {
  const c = h(x, y);
  if (c === null) return -Infinity;
  let s = 0;
  let n = 0;
  for (let k = 0; k < 8; k++) {
    const z = h(x + Math.cos((k * Math.PI) / 4) * r, y + Math.sin((k * Math.PI) / 4) * r);
    if (z === null) return -Infinity;
    s += z;
    n++;
  }
  return c - s / n;
}

/**
 * A loop of gates starting at `start` heading `heading` (radians): a circle through the start whose centre is off to
 * the left of the heading, gates spaced round it, each moved to the most prominent dry spot within `search` cells.
 */
export function layCourse(h: (x: number, y: number) => number | null, depth: (x: number, y: number) => number, start: P2, heading: number, o: CourseOpts): Course {
  const n = o.gates;
  const R = (n * o.spacing) / (2 * Math.PI);
  const search = o.search ?? 14;
  // (the circle's centre to the left of the way it faces, so the loop turns left from the line; pulled into the window)
  let cx = start[0] + Math.cos(heading + Math.PI / 2) * R;
  let cy = start[1] + Math.sin(heading + Math.PI / 2) * R;
  const lo = o.margin + R;
  cx = Math.max(lo, Math.min(o.bounds[0] - lo, cx));
  cy = Math.max(lo, Math.min(o.bounds[1] - lo, cy));
  const a0 = Math.atan2(start[1] - cy, start[0] - cx);
  const inside = (x: number, y: number) => x > o.margin && y > o.margin && x < o.bounds[0] - o.margin && y < o.bounds[1] - o.margin;
  const gates: P2[] = [];
  for (let i = 1; i <= n; i++) {
    // (counter-clockwise from the start: left turns)
    const a = a0 + (2 * Math.PI * i) / n;
    const nx = cx + Math.cos(a) * R;
    const ny = cy + Math.sin(a) * R;
    if (i === n) {
      gates.push([nx, ny]);
      break;
    }
    let best: P2 = [nx, ny];
    let bs = -Infinity;
    for (let r = 0; r <= search; r += 3.5)
      for (let k = 0; k < (r ? 8 : 1); k++) {
        const x = nx + Math.cos((k * Math.PI) / 4) * r;
        const y = ny + Math.sin((k * Math.PI) / 4) * r;
        if (!inside(x, y)) continue;
        // (a crest, dry, not far off the line: prominence less a little for the detour and a lot for water)
        const s = prominence(h, x, y) - r * 0.08 - depth(x, y) * 4;
        if (s > bs) (bs = s), (best = [x, y]);
      }
    gates.push(best);
  }
  // kickers: half way between gates where neither end has a crest to launch off
  const kickers: P2[] = [];
  const all: P2[] = [start, ...gates];
  for (let i = 1; i < all.length - 1; i++) {
    const a = all[i - 1];
    const b = all[i];
    const m: P2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (prominence(h, m[0], m[1]) < 0.6 && prominence(h, b[0], b[1]) < 0.6 && depth(m[0], m[1]) < 0.05 && inside(m[0], m[1])) kickers.push(m);
  }
  return { gates, start, heading: a0 + Math.PI / 2, kickers };
}

/** a rider's progress along the course: gates passed plus the share of the way to the next (for who's leading) */
export function progress(gates: P2[], passed: number, at: P2, from: P2): number {
  if (passed >= gates.length) return gates.length;
  const prev = passed === 0 ? from : gates[passed - 1];
  const next = gates[passed];
  const seg = Math.hypot(next[0] - prev[0], next[1] - prev[1]) || 1;
  const left = Math.hypot(next[0] - at[0], next[1] - at[1]);
  return passed + Math.max(0, Math.min(0.99, 1 - left / seg));
}
