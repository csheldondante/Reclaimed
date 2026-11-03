// The foliage bench's card (round 128): each animated variant against the static run with the same scene settings.
import { describe, expect, it } from 'vitest';
import { BURN_VARIANTS, GRASS_VARIANTS, summaryLines, variantSettings, type FoliageRow } from './foliagecard';

const row = (variant: string, p50: number): FoliageRow => ({ variant, stage: 'open calm', frames: 100, fps: 60, p50, p95: p50 + 2, p99: p50 + 3, worst: p50 + 4, gpu: null, plants: null, tris: null, draws: null });

describe('foliage bench', () => {
  it('the grass pairs: every bending run has its static run at the same density', () => {
    for (const v of GRASS_VARIANTS) {
      const s = variantSettings(v);
      const dens = s.find(([k]) => k === 'fgrass')?.[1];
      expect(dens).toBeDefined();
      expect(GRASS_VARIANTS).toContain(`fwind:static+fgrass:${dens}`);
    }
  });
  it('compares a variant with the static run of its own density', () => {
    const lines = summaryLines([row('fwind:static+fgrass:2', 20), row('fwind:sway+fgrass:2', 23), row('fwind:static+fgrass:1', 10)]);
    expect(lines.find((l) => l.startsWith('fwind:sway+fgrass:2'))).toMatch(/vs static \+3\.0/);
  });
});

describe('the burn pair', () => {
  it('a burning run is compared with the same run unburned, and shows the chunks awake', () => {
    const r = (variant: string, p50: number, awake?: number) => ({ ...row(variant, p50), awake: awake ?? null, burning: awake ? 3 : null });
    const lines = summaryLines([r('fwind:1A1C', 12), r('fwind:1A1C+burn:1', 15, 9)]);
    const l = lines.find((x) => x.startsWith('fwind:1A1C+burn:1'))!;
    expect(l).toMatch(/vs unburned \+3\.0/);
    expect(l).toMatch(/awake 9 burning 3/);
    expect(BURN_VARIANTS).toContain('fwind:1A1C+burn:1');
  });
});
