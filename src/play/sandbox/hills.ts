// ---- play/sandbox/hills.ts --------------------------------------------------------------------------------------
// Where to ride (round 118; the user: "I want to bike to be faster and to try on hills"): a spot near the camera with
// rideable relief — slopes the bike can climb and crests and kickers to launch off — read from the ground's heights,
// not from a generator's labels (the terrain track's contract isn't on places yet; when it is, its partition can say
// "hills" directly). Pure: a height function in, a spot out.

export type Height = (x: number, y: number) => number | null;

export interface HillOpts {
  /** cells round the centre it looks within */
  radius: number;
  /** cells between candidates, and between the samples that judge each */
  step: number;
  /** the rise over run the controller rides up (steeper is a wall, not a hill) and the least that counts as a slope */
  climb: number;
  least: number;
  /** water deeper than this (cells) and the spot's no good */
  dry?: (x: number, y: number) => boolean;
  /** stay this far inside [0, bounds) */
  bounds: [number, number];
  margin: number;
}

export interface HillSpot {
  at: [number, number];
  /** what it's worth: rideable slopes round it, how much it rises and falls */
  score: number;
  slopes: number;
  relief: number;
}

/**
 * The hilliest rideable spot within `radius` of `centre`: each candidate judged by the slopes round it (within 12
 * cells) that are steep enough to launch off but not walls, and by its relief, up to 12 cells (taller is mountains,
 * not hills). Null if no candidate has any.
 */
export function findHills(h: Height, centre: [number, number], o: HillOpts): HillSpot | null {
  let best: HillSpot | null = null;
  const inside = (x: number, y: number) => x >= o.margin && y >= o.margin && x < o.bounds[0] - o.margin && y < o.bounds[1] - o.margin;
  for (let dy = -o.radius; dy <= o.radius; dy += o.step)
    for (let dx = -o.radius; dx <= o.radius; dx += o.step) {
      if (dx * dx + dy * dy > o.radius * o.radius) continue;
      const cx = centre[0] + dx;
      const cy = centre[1] + dy;
      if (!inside(cx, cy) || (o.dry && !o.dry(cx, cy))) continue;
      const h0 = h(cx, cy);
      if (h0 === null) continue;
      let slopes = 0;
      let walls = 0;
      let lo = h0;
      let hi = h0;
      for (let r = 3; r <= 12; r += 3)
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          const x = cx + Math.cos(a) * r;
          const y = cy + Math.sin(a) * r;
          const z = h(x, y);
          const z2 = h(x + Math.cos(a) * 1.5, y + Math.sin(a) * 1.5);
          if (z === null || z2 === null) continue;
          lo = Math.min(lo, z);
          hi = Math.max(hi, z);
          const s = Math.abs(z2 - z) / 1.5;
          if (s > o.climb) walls++;
          else if (s >= o.least) slopes++;
        }
      const relief = Math.min(hi - lo, 12);
      const score = slopes + relief * 1.5 - walls * 2;
      if (slopes > 0 && (!best || score > best.score)) best = { at: [cx, cy], score, slopes, relief };
    }
  return best;
}
