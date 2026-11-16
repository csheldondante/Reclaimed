// (loop-skeleton) The story camera on a streamed window: a shot's points are window coordinates, so they slide with
// the window. Before `shift`, a move under way kept easing to where its target used to be — on the atlas level that
// slid the window again and the view ran away from the town (the petition shot ended two towns over).
import { describe, expect, it } from 'vitest';
import type { Camera } from '../../src/render/camera';
import { StoryCamera } from '../../src/story/camera';

const camera = () => ({ target: [0, 0, 0] as [number, number, number], zoom: 4, viewportW: 400, viewportH: 900, screenDeltaToWorld: () => [0, 0] as [number, number] });

describe('StoryCamera on a sliding window', () => {
  it('a move under way lands on its point after the window slides', async () => {
    const c = camera();
    const cam = new StoryCamera(c as unknown as Camera);
    const there = cam.frame([100, 100, 5], { zoom: 8, ease: 1, place: [0.5, 0.5] });
    await Promise.resolve();
    cam.update(0.5);
    // (the window slides 64 east: the camera's own target moves with it, and the shot's)
    c.target[0] -= 64;
    cam.shift(64, 0, 0);
    cam.update(0.6);
    await there;
    expect(c.target).toEqual([36, 100, 5]);
    expect(c.zoom).toBeCloseTo(8);
    // (and the way home: where the player had the view, as the window is now)
    const back = cam.release(1);
    cam.update(1.1);
    await back;
    expect(c.target).toEqual([-64, 0, 0]);
  });
});
