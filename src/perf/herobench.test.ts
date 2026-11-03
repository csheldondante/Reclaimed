// (round 128, herolab) the hero bench's pairs and its card's lines
import { describe, expect, it } from 'vitest';
import { HERO_BENCH_PAIRS, heroBenchLines, parsePair, type HeroBenchRow } from './herosummary';

const row = (pair: string, p50: number, cut = false): HeroBenchRow => ({
  pair, station: 'canyon', frames: 1200, fps: 60, p50, p95: p50 + 4, p99: p50 + 9, worst: 40, gpu: null, playMs: 0.2, cells: 300,
  cutToggle: cut ? { frameMs: 0.4, gpuMs: null, on: { frameMs: 16.9, gpuMs: null }, off: { frameMs: 16.5, gpuMs: null }, windows: 3 } : null,
});

describe('hero bench', () => {
  it('pairs every hero with the chase and the cut, the chase first; the tour under auto', () => {
    expect(HERO_BENCH_PAIRS).toEqual(['hoverbike:chase', 'hoverbike:cutaway+tilt', 'lich:chase', 'lich:cutaway+tilt', 'knight:chase', 'knight:cutaway+tilt', 'hoverbike:chase@tour', 'hoverbike:auto+cutfade@tour']);
    expect(parsePair('knight:cutaway+tilt')).toEqual({ hero: 'knight', cam: 'cutaway+tilt', station: 'canyon' });
    expect(parsePair('hoverbike:auto+cutfade@tour')).toEqual({ hero: 'hoverbike', cam: 'auto+cutfade', station: 'tour' });
    expect(() => parsePair('walker:chase')).toThrow(/hero:cam/);
  });
  it('says what a camera adds', () => {
    const l = heroBenchLines([row('knight:chase', 16.6), row('knight:cutaway+tilt', 16.8, true)]);
    expect(l).toEqual([
      'knight:chase: p50 16.6 p95 20.6 p99 25.6 ms',
      'knight:cutaway+tilt: p50 16.8 p95 20.8 p99 25.8 ms',
      'knight:cutaway+tilt: the camera adds 0.4 ms a frame (GPU n/a ms) over the chase, toggled',
    ]);
  });
});
