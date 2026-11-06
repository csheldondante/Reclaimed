// A road's grade over the land (DA-A10, round 128o; DESIGN section 12: "It conforms to the land where that makes sense,
// and otherwise changes it: grading, cuts and fills, bridges, ramps, switchbacks and tunnels"). Pure: a lane's ground
// sampled along it in, the land it's laid on out — the target height a metre along, the cut (down) or fill (up) there,
// and the stretches too steep to grade within `maxCut` (stairs or a switchback there: `steep`, the user's choice).
// Waits on the user's answers (BACKLOG DA-A10): the steepest grade, stairs or switchbacks, whether the start town's own
// roads are graded at generation. Nothing here edits the world: the road's works do, when built.
//
// The grade: the highest profile under the ground whose slope is at most `maxGrade` (cut only: min over j of
// g[j] + maxGrade |i - j|) and the lowest over it (fill only: max over j of g[j] - maxGrade |i - j|) both keep the slope;
// their mean does too, and balances cut and fill. Where it leaves the ground by more than `maxCut` the land is too steep
// to grade there: that stretch keeps its ground and is declared `steep`.

export interface GradeOpts {
  /** the steepest a road may rise (metres up a metre along) */
  maxGrade: number;
  /** the deepest cut or highest fill a grade makes (m); past it the stretch is steep */
  maxCut: number;
  /** what a steep stretch becomes: a stair (a path kind, as the wall's stairs) or a switchback (a longer road) */
  steep: 'stairs' | 'switchback';
  /** metres between samples along the lane */
  step?: number;
}

export interface LaneGrade {
  /** the samples along the lane (from a to b, every `step` m, both ends): where, the ground, the road's height */
  at: [number, number][];
  ground: number[];
  road: number[];
  /** the stretches left at their ground (sample index from, to inclusive), each what it becomes */
  steep: { from: number; to: number; rise: number; kind: GradeOpts['steep'] }[];
  /** ground moved: cut (taken, m of height summed over samples) and fill (put) */
  cut: number;
  fill: number;
}

/** A lane from a to b over `ground` graded. */
export function gradeLane(a: readonly [number, number], b: readonly [number, number], ground: (x: number, y: number) => number, o: GradeOpts): LaneGrade {
  const step = o.step ?? 1;
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(1, Math.ceil(L / step));
  const at: [number, number][] = [];
  const g: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p: [number, number] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    at.push(p);
    g.push(ground(p[0], p[1]));
  }
  const d = (L / n) * o.maxGrade;
  const road = gradeProfile(g, d);
  // (past maxCut: the stretch keeps its ground, joined to the grade either side within the slope where it can)
  const over = road.map((r, i) => Math.abs(r - g[i]) > o.maxCut);
  const steep: LaneGrade['steep'] = [];
  for (let i = 0; i <= n; i++) {
    if (!over[i]) continue;
    let j = i;
    while (j + 1 <= n && over[j + 1]) j++;
    const from = Math.max(0, i - 1);
    const to = Math.min(n, j + 1);
    for (let k = i; k <= j; k++) road[k] = g[k];
    steep.push({ from, to, rise: g[to] - g[from], kind: o.steep });
    i = j;
  }
  let cut = 0;
  let fill = 0;
  for (let i = 0; i <= n; i++) {
    const dz = road[i] - g[i];
    if (dz < 0) cut -= dz;
    else fill += dz;
  }
  return { at, ground: g, road, steep, cut, fill };
}

/** the profile nearest `g` (cut and fill balanced) whose step between samples is at most `d` */
export function gradeProfile(g: readonly number[], d: number): number[] {
  const n = g.length;
  const lo = new Array<number>(n);
  const hi = new Array<number>(n);
  // (the lower envelope: min over j of g[j] + d|i - j|, two sweeps; the upper likewise)
  for (let i = 0; i < n; i++) lo[i] = Math.min(g[i], i ? lo[i - 1] + d : Infinity);
  for (let i = n - 2; i >= 0; i--) lo[i] = Math.min(lo[i], lo[i + 1] + d);
  for (let i = 0; i < n; i++) hi[i] = Math.max(g[i], i ? hi[i - 1] - d : -Infinity);
  for (let i = n - 2; i >= 0; i--) hi[i] = Math.max(hi[i], hi[i + 1] - d);
  return g.map((_, i) => (lo[i] + hi[i]) / 2);
}
