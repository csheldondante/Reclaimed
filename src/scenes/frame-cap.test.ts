// (round 128o, DA-B5) The 30 fps cap's pacing (frame-cap.ts) on 60, 120 and 30 Hz displays, steady and jittery.
import { describe, expect, it } from 'vitest';
import { CAP_FPS, frameDue } from './frame-cap';

/** the frames that run over `ms` of a display at `hz` (with ±`jitter` ms on each frame's time) */
function run(hz: number, ms: number, jitter = 0): number {
  const d = 1000 / hz;
  let last = 0;
  let prev = 0;
  let ran = 0;
  for (let k = 1; k * d <= ms + 1e-6; k++) {
    const now = k * d + (k % 2 ? jitter : -jitter);
    if (frameDue(now - last, now - prev, CAP_FPS)) {
      ran++;
      last = now;
    }
    prev = now;
  }
  return ran;
}

describe('the 30 fps cap', () => {
  it('runs 30 frames a second on 60, 120 and 30 Hz displays', () => {
    expect(run(60, 1000)).toBe(30);
    expect(run(120, 1000)).toBe(30);
    expect(run(30, 1000)).toBe(30);
  });

  it('keeps to 30 when the display frames jitter by a millisecond', () => {
    expect(run(60, 1000, 1)).toBe(30);
    expect(run(120, 1000, 1)).toBe(30);
  });

  it('a 90 Hz display: every third frame', () => {
    expect(run(90, 1000)).toBe(30);
  });
});
