// Deterministic randomness for the flora generators (round 117, track `flora`).
// Why a local PRNG and not Math.random: every plant is a pure function of (species, seed) so the library, the viewer,
// the tiles' bake and a test all make the same plant (the user: generation "deterministic from the seed").

/** mulberry32: small, fast, good enough for shapes; returns floats in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A u32 hash of several integers (seeds for sub-generators: species × variant × part). */
export function hashSeed(...xs: number[]): number {
  let h = 2166136261 >>> 0;
  for (const x of xs) {
    h ^= x >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
    h ^= h >>> 13;
  }
  return h >>> 0;
}
