// A growth field (round 89): the user — "vegetation and settlements should work similarly actually. Both are
// fields with intensity and maybe some material (different biomes or settlement styles) and sensitive to
// conditions on the map grow and spread." The shape is the ecology pass's (ecology.wgsl: succession), on the
// CPU and generic over what grows:
//  - per cell an intensity `v` (0 none .. 1 its full) and a kind (a settlement's style, a biome);
//  - per kind and cell a suitability 0..1 (the conditions: for a settlement, flat dry ground near water and
//    the quarry and the woods, away from danger; for plants, substrate, moisture, poison) — what it can reach;
//  - each step it grows toward its suitability (logistic), spreads to its neighbours (a share of the
//    difference, only uphill in suitability's terms: it creeps along what suits it), and colonises empty cells
//    next to it once it's strong enough there (the kind passed on: a style spreads with its people);
//  - a stronger kind takes over a weaker one's cell where it suits it better (a frontier, not a blend).
// The settlements grow one over their box; their lots are built where it's high (plan.ts), and in play it goes
// on growing as the stores allow and new lots become houses to build (life.ts). Vegetation can share it later.

export interface GrowthOpts {
  /** growth a step toward the suitability (fraction of the gap) */
  rate: number;
  /** share of a neighbour's surplus that flows in a step */
  spread: number;
  /** a neighbour this strong colonises an empty cell */
  colonise: number;
}

export class GrowthField {
  readonly v: Float32Array;
  readonly kind: Uint8Array;
  /** per kind: suitability 0..1 a cell */
  readonly suit: Float32Array[];
  private nv: Float32Array;
  private nk: Uint8Array;

  constructor(readonly w: number, readonly h: number, kinds: number) {
    const N = w * h;
    this.v = new Float32Array(N);
    this.kind = new Uint8Array(N);
    this.suit = Array.from({ length: kinds }, () => new Float32Array(N));
    this.nv = new Float32Array(N);
    this.nk = new Uint8Array(N);
  }

  /** seed a kind at (x, y) (cells) with intensity v over a small disc */
  seed(x: number, y: number, kind: number, v: number, r = 1): void {
    for (let j = Math.floor(y - r); j <= Math.ceil(y + r); j++)
      for (let i = Math.floor(x - r); i <= Math.ceil(x + r); i++) {
        if (i < 0 || j < 0 || i >= this.w || j >= this.h || Math.hypot(i - x, j - y) > r) continue;
        const c = j * this.w + i;
        if (v > this.v[c]) {
          this.v[c] = v;
          this.kind[c] = kind;
        }
      }
  }

  step(o: GrowthOpts, steps = 1): void {
    const { w, h } = this;
    for (let s = 0; s < steps; s++) {
      const v = this.v;
      const k = this.kind;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const c = y * w + x;
          let vi = v[c];
          let ki = k[c];
          // the neighbours: what flows in, who could colonise or take it over
          let inflow = 0;
          let bestV = 0;
          let bestK = ki;
          for (let d = 0; d < 4; d++) {
            const nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0);
            const ny = y + (d === 2 ? 1 : d === 3 ? -1 : 0);
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const n = ny * w + nx;
            const vn = v[n];
            if (vn <= 0) continue;
            const kn = k[n];
            if (vn > bestV) {
              bestV = vn;
              bestK = kn;
            }
            // (a neighbour of its own kind with more than it shares some; it creeps where it suits)
            if (kn === ki && vn > vi) inflow += (vn - vi) * this.suit[ki][c];
          }
          if (vi <= 0.001) {
            // colonised from a strong neighbour, if it suits that one here
            if (bestV >= o.colonise && this.suit[bestK][c] > 0.05) {
              vi = 0.05;
              ki = bestK;
            }
          } else if (bestK !== ki && bestV > vi * 1.5 && this.suit[bestK][c] > this.suit[ki][c]) {
            // a stronger kind where it suits better takes the cell over
            ki = bestK;
            vi *= 0.5;
          }
          const cap = this.suit[ki][c];
          if (vi > 0) vi += o.rate * vi * (1 - vi / Math.max(cap, 1e-3)) + o.spread * inflow;
          this.nv[c] = Math.max(0, Math.min(1, vi));
          this.nk[c] = ki;
        }
      this.v.set(this.nv);
      this.kind.set(this.nk);
    }
  }

  /** the intensity at (x, y) (cells), bilinear; and the kind of the nearest cell */
  at(x: number, y: number): { v: number; kind: number } {
    const fx = Math.max(0, Math.min(this.w - 1.001, x - 0.5));
    const fy = Math.max(0, Math.min(this.h - 1.001, y - 0.5));
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const tx = fx - i;
    const ty = fy - j;
    const g = (a: number, b: number) => this.v[b * this.w + a];
    const v = (g(i, j) * (1 - tx) + g(i + 1, j) * tx) * (1 - ty) + (g(i, j + 1) * (1 - tx) + g(i + 1, j + 1) * tx) * ty;
    return { v, kind: this.kind[Math.round(fy) * this.w + Math.round(fx)] };
  }
}
