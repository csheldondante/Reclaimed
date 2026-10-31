import { describe, expect, it } from 'vitest';
import { placeBuried, PROP_TILE } from './props';
import type { TerrainSamples } from './partition';

/** land over [0, side)² world units at step 4: a plain with a cliff at x = 300 and a lake in one corner */
function land(side: number): TerrainSamples {
  const step = 4;
  const w = side / step + 1;
  const N = w * w;
  const S: TerrainSamples = { w, h: w, x0: 0, y0: 0, step, ground: new Float32Array(N), water: new Float32Array(N).fill(NaN), wet: new Uint8Array(N), lava: new Uint8Array(N), veg: new Float32Array(N), seed: 1 };
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    S.ground[i] = x * step < 300 ? 100 : 130;
    if (x * step > side - 120 && y * step > side - 120) { S.water[i] = 104; S.ground[i] = 96; S.wet[i] = 2; }
  }
  return S;
}

describe('buried props', () => {
  const side = PROP_TILE * 8;
  const S = land(side);
  const all = placeBuried(S, 7, { x0: 0, y0: 0, x1: side, y1: side });
  it('places stones and some excavation sites, skew and half sunk, none in water', () => {
    expect(all.props.length).toBeGreaterThan(10);
    for (const p of all.props) {
      expect(p.buried).toBeGreaterThan(0.2);
      expect(p.buried).toBeLessThan(0.85);
      expect(p.tilt).toBeGreaterThan(0.1);
      expect(p.at[0] > side - 120 && p.at[1] > side - 120).toBe(false);
    }
    expect(new Set(all.props.map((p) => p.id)).size).toBe(all.props.length);
  });
  it('is the same whatever rectangle asks (decided per world tile)', () => {
    const part = placeBuried(S, 7, { x0: 2 * PROP_TILE, y0: PROP_TILE, x1: 5 * PROP_TILE, y1: 6 * PROP_TILE });
    const byId = new Map(all.props.map((p) => [p.id, p]));
    expect(part.props.length).toBeGreaterThan(0);
    for (const p of part.props) expect(byId.get(p.id)).toEqual(p);
  });
  it('a different seed, different props', () => {
    const other = placeBuried(S, 8, { x0: 0, y0: 0, x1: side, y1: side });
    expect(other.props.map((p) => p.at[0]).join()).not.toBe(all.props.map((p) => p.at[0]).join());
  });
});
