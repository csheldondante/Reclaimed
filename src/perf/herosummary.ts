// The hero bench's pairs, rows and card (round 128; src/perf/herobench.ts). Pure: no page, no GPU (herobench.test.ts).

import type { Toggle } from './physsummary';

export const HERO_BENCH_HEROES = ['hoverbike', 'lich', 'knight', 'horse'] as const;
export const HERO_BENCH_CAMS = ['chase', 'cutaway+tilt'] as const;
/**
 * every pair, `hero:cam[@station]` (the canyon when no station): each hero under the chase, then the cut and tilt
 * (matched by reload); then (round 128, the user's camera intent) the bike on the tour under the chase, then auto
 */
export const HERO_BENCH_PAIRS = [...HERO_BENCH_HEROES.flatMap((h) => HERO_BENCH_CAMS.map((c) => `${h}:${c}`)), 'hoverbike:chase@tour', 'hoverbike:auto+cutfade@tour'];

/** a pair's hero, camera and station */
export function parsePair(pair: string): { hero: string; cam: string; station: string } {
  const m = /^(hoverbike|lich|knight|horse):([a-z+]+)(?:@([a-z-]+))?$/.exec(pair);
  if (!m) throw new Error(`herobench: a pair is hero:cam or hero:cam@station, not "${pair}"`);
  return { hero: m[1], cam: m[2], station: m[3] ?? 'canyon' };
}

export interface HeroBenchRow {
  /** hero:cam */
  pair: string;
  station: string;
  frames: number;
  fps: number;
  p50: number;
  p95: number;
  p99: number;
  worst: number;
  /** the GPU's frame (timestamps; unreliable on a tiler, kept for the record) */
  gpu: number | null;
  /** the play session's main-thread ms a frame (PlaySession.stats) */
  playMs: number | null;
  /** cells ridden in the window (the autopilot moved the hero) */
  cells: number;
  /** (a camera's pages) the camera against the chase alone, toggled within the page */
  cutToggle: Toggle | null;
}

/** the card's lines: each run's frames, and on a camera's run what it adds against the chase, toggled (pure) */
export function heroBenchLines(rows: HeroBenchRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    out.push(`${r.pair}: p50 ${r.p50} p95 ${r.p95} p99 ${r.p99} ms`);
    const t = r.cutToggle;
    if (t) out.push(`${r.pair}: the camera adds ${t.frameMs ?? '?'} ms a frame (GPU ${t.gpuMs ?? 'n/a'} ms) over the chase, toggled`);
  }
  return out;
}
