// Where the painted wind is (round 104, simscale — the user: "Why does wind and climate need to run everywhere and at
// what frequency? Most wind effects I've seen are gusts near the player and maybe a global Atlas level tick that can
// be very infrequent").
//
// The wind field (windfield.wgsl) is the map's own wind (mapWind: prevailing, gust patches, dust storms, eddies) plus
// the wind the player and the world paint into it (strokes, blows, a click's ripple, things landing). The painted part
// lives only round what painted it: it drifts at 30% of its speed, spreads a little and dies down (e-folding 7 s,
// none under PAINT_MIN). So it's updated only over the box of what was painted lately, each stamp's box grown by how
// far its wind can have drifted and spread since; once the newest is LIFE_S old, nothing is (it's all under PAINT_MIN
// by then). Everywhere else the field is the map's own wind, refreshed a band at a time (WindFieldSystem).
//
// Texel units throughout: the field is one texel per 2 x 2 world cells (texel t's centre is world (t + 0.5) * 2).

/** how long after its stamp a painted texel can still hold wind (s): MAX_W 24 e^(-t / 7) < PAINT_MIN 0.05 at 43 s */
export const LIFE_S = 45;
const DECAY_S = 7;
const MAX_W = 24;

interface Stamp {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** the tick (60 Hz ticks, the sim's) it was last stamped */
  at: number;
}

/** how far (texels) painted wind can have gone from where it was stamped, `ticks` 60 Hz steps on */
export function reach(ticks: number): number {
  const s = ticks / 60;
  // drift: 30% of its own speed, at most MAX_W, dying down (cells → texels: / 2)
  const drift = (0.3 * MAX_W * DECAY_S * (1 - Math.exp(-s / DECAY_S))) / 2;
  // spread: 6% a step toward the 4-neighbour mean — a variance of 0.03 texels² a step; three sigma
  const spread = 3 * Math.sqrt(0.03 * ticks);
  return 2 + drift + spread;
}

export class WindRects {
  private stamps: Stamp[] = [];
  /** true while the whole field is painted (physics: things landing shove the air anywhere) */
  private wholeAt = -1e9;
  constructor(
    readonly w: number,
    readonly h: number,
    /** 60 Hz ticks a sim tick stands for (sim/flow.ts FLOW_SUB) */
    private step: number,
  ) {}

  /** something painted the wind round world (x, y), radius r (world cells), at sim tick `tick` */
  stir(x: number, y: number, r: number, tick: number): void {
    const t = tick * this.step;
    const s: Stamp = { x0: Math.floor((x - r) / 2) - 1, y0: Math.floor((y - r) / 2) - 1, x1: Math.ceil((x + r) / 2) + 1, y1: Math.ceil((y + r) / 2) + 1, at: t };
    if (s.x1 < 0 || s.y1 < 0 || s.x0 >= this.w || s.y0 >= this.h) return;
    // (a held blow stamps the same box every tick: one stamp, renewed)
    const same = this.stamps.find((o) => o.x0 === s.x0 && o.y0 === s.y0 && o.x1 === s.x1 && o.y1 === s.y1);
    if (same) same.at = t;
    else this.stamps.push(s);
  }

  /** the whole field painted (things landing anywhere in it) */
  stirAll(tick: number): void {
    this.wholeAt = tick * this.step;
  }

  /** The window slid (texels): the stamps go with the land. */
  shift(dx: number, dy: number): void {
    for (const s of this.stamps) {
      s.x0 -= dx;
      s.x1 -= dx;
      s.y0 -= dy;
      s.y1 -= dy;
    }
  }

  /** The box (texels, [x0, y0, x1, y1), clipped) to update at sim tick `tick`, or null: nothing painted lately. */
  box(tick: number): [number, number, number, number] | null {
    const t = tick * this.step;
    const life = LIFE_S * 60;
    if (t - this.wholeAt < life) return [0, 0, this.w, this.h];
    this.stamps = this.stamps.filter((s) => t - s.at < life);
    if (!this.stamps.length) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const s of this.stamps) {
      const m = Math.ceil(reach(t - s.at));
      x0 = Math.min(x0, s.x0 - m);
      y0 = Math.min(y0, s.y0 - m);
      x1 = Math.max(x1, s.x1 + m);
      y1 = Math.max(y1, s.y1 + m);
    }
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    x1 = Math.min(this.w, x1);
    y1 = Math.min(this.h, y1);
    return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
  }
}
