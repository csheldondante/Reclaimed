// Deterministic randomness for the generators: same seed, same city, on every machine (no Math.random).

/** xorshift32 from a seed: a stream of [0, 1) */
export function rng(seed: number): () => number {
  let s = hash32(seed >>> 0) || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** a 32-bit integer hash (lowbias32) */
export function hash32(x: number): number {
  x = x >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** a hash of several integers → [0, 1) */
export function hashf(...k: number[]): number {
  let h = 0x811c9dc5;
  for (const v of k) h = hash32(h ^ Math.imul((v | 0) >>> 0, 0x9e3779b1));
  return h / 4294967296;
}

/** smooth value noise in 2D (for the massing and the test grounds), about [0, 1] */
export function vnoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const s = (t: number) => t * t * (3 - 2 * t);
  const a = hashf(ix, iy, seed);
  const b = hashf(ix + 1, iy, seed);
  const c = hashf(ix, iy + 1, seed);
  const d = hashf(ix + 1, iy + 1, seed);
  const u = s(fx);
  const v = s(fy);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/** fractal value noise, about [0, 1] */
export function fbm(x: number, y: number, seed: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += vnoise(x, y, seed + o * 131) * amp;
    norm += amp;
    x *= 2.03;
    y *= 2.03;
    amp *= 0.5;
  }
  return sum / norm;
}
