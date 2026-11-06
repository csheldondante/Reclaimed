// (round 128m, townlab) The placement bench's points (perf/placebench.ts; the user: "build a bench for me to run that
// places buildings"): where round the town each building type is tried. Pure: what it reads of the world comes in.
//   inside   the town's middle (the gates' centroid) out half its wall's radius, four ways
//   ring     out from the stores 30, 60 and 120 m, eight ways
//   river    across water: the first dry ground past a wet run on rays out from the stores (the nearest two, apart)
//   hill     the highest dry ground within 110 m of the stores outside the town's wall (its roofs aren't hills), if it
//            stands 3 m over them
export type V2 = [number, number];

export interface PlacePoint {
  name: string;
  group: 'inside' | 'ring' | 'river' | 'hill';
  at: V2;
}

export interface PointsIn {
  /** the stores (window world) */
  stores: V2;
  /** the town wall's gate posts (window world; none: no wall) */
  gates: V2[];
  /** in the fortress's box */
  inBox(x: number, y: number): boolean;
  /** water over the lanes' limit (the reach's wet bits) */
  wet(x: number, y: number): boolean;
  ground(x: number, y: number): number;
}

const WAYS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
export const RING_DISTS = [30, 60, 120];

export function placePoints(p: PointsIn): PlacePoint[] {
  const out: PlacePoint[] = [];
  const [sx, sy] = p.stores;
  const dir = (k: number, n: number): V2 => [Math.cos((k / n) * 2 * Math.PI), Math.sin((k / n) * 2 * Math.PI)];
  // (the town: its gates' centroid and their mean distance from it)
  const c: V2 = p.gates.length ? [p.gates.reduce((a, g) => a + g[0], 0) / p.gates.length, p.gates.reduce((a, g) => a + g[1], 0) / p.gates.length] : [sx, sy];
  const r = p.gates.length ? p.gates.reduce((a, g) => a + Math.hypot(g[0] - c[0], g[1] - c[1]), 0) / p.gates.length : 0;
  if (p.gates.length) {
    for (let k = 0; k < 4; k++) {
      const d = dir(k * 2, 8);
      out.push({ name: `inside ${WAYS[k * 2]}`, group: 'inside', at: [c[0] + d[0] * r * 0.5, c[1] + d[1] * r * 0.5] });
    }
  }
  for (const dist of RING_DISTS)
    for (let k = 0; k < 8; k++) {
      const d = dir(k, 8);
      out.push({ name: `${WAYS[k]} ${dist} m`, group: 'ring', at: [sx + d[0] * dist, sy + d[1] * dist] });
    }
  // across water: on 32 rays, the first dry ground 4 m past a wet run of 2 m or more
  const across: { at: V2; d: number; a: number }[] = [];
  for (let k = 0; k < 32; k++) {
    const d = dir(k, 32);
    let wetRun = 0;
    let crossed = false;
    let dry = 0;
    for (let t = 2; t <= 150; t += 1) {
      const x = sx + d[0] * t;
      const y = sy + d[1] * t;
      if (!p.inBox(x, y)) break;
      if (p.wet(x, y)) {
        wetRun++;
        dry = 0;
        if (wetRun >= 2) crossed = true;
      } else if (crossed) {
        if (++dry >= 4) {
          across.push({ at: [x, y], d: t, a: (k / 32) * 2 * Math.PI });
          break;
        }
      } else wetRun = 0;
    }
  }
  across.sort((a, b) => a.d - b.d);
  const picked: typeof across = [];
  for (const a of across) {
    if (picked.some((q) => Math.abs(Math.atan2(Math.sin(a.a - q.a), Math.cos(a.a - q.a))) < Math.PI / 4)) continue;
    picked.push(a);
    if (picked.length === 2) break;
  }
  picked.forEach((a, i) => out.push({ name: `across the water ${i + 1} (${Math.round(a.d)} m)`, group: 'river', at: a.at }));
  // the hill
  const g0 = p.ground(sx, sy);
  let best: { at: V2; z: number } | null = null;
  for (let y = sy - 110; y <= sy + 110; y += 4)
    for (let x = sx - 110; x <= sx + 110; x += 4) {
      if (Math.hypot(x - sx, y - sy) > 110 || Math.hypot(x - c[0], y - c[1]) < r * 1.15 + 4 || !p.inBox(x, y) || p.wet(x, y)) continue;
      const z = p.ground(x, y);
      if (!best || z > best.z) best = { at: [x, y], z };
    }
  if (best && best.z >= g0 + 3) out.push({ name: `hill (${(best.z - g0).toFixed(0)} m up)`, group: 'hill', at: best.at });
  return out;
}
