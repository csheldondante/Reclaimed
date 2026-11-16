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

// (BACKLOG LS-54) The queue of shots. A petition holds a frame and lets it go when the dialog closes; a look sent just
// before the frame (the camera back over the town) put the frame behind it. `release` did nothing for a frame that had
// not begun, and a look never started the shot waiting behind it: every later shot waited for good (the attack's
// camera never went down the road, the raid was never called).
describe("StoryCamera's queue", () => {
  /** let the promises' continuations run */
  const settle = async () => {
    for (let k = 0; k < 8; k++) await Promise.resolve();
  };
  /** `seconds` of frames */
  const run = async (cam: StoryCamera, seconds: number) => {
    for (let t = 0; t < seconds; t += 0.1) {
      cam.update(0.1);
      await settle();
    }
  };
  const flag = (p: Promise<void>) => {
    const f = { done: false };
    void p.then(() => (f.done = true));
    return f;
  };
  const centre = { place: [0.5, 0.5] as [number, number] };

  it('a frame released while it waits behind a look is taken out: the queue drains and the next look runs', async () => {
    const c = camera();
    const cam = new StoryCamera(c as unknown as Camera);
    const first = flag(cam.look([50, 0, 0], { ease: 1, ...centre }));
    await settle();
    await run(cam, 0.3);
    const framed = flag(cam.frame([100, 100, 0], { ease: 1, ...centre }));
    await settle();
    // (the petition answered before the camera got there)
    const let_go = flag(cam.release());
    await settle();
    expect(framed.done).toBe(true);
    expect(let_go.done).toBe(true);
    const second = flag(cam.look([200, 0, 0], { ease: 1, zoom: 6, ...centre }));
    await run(cam, 1);
    expect(first.done).toBe(true);
    await run(cam, 1.2);
    expect(second.done).toBe(true);
    expect(c.target).toEqual([200, 0, 0]);
    expect(c.zoom).toBeCloseTo(6);
    expect(cam.busy).toBe(false);
    // (the frame never took the view)
    await run(cam, 2);
    expect(c.target).toEqual([200, 0, 0]);
  });

  it('a frame behind a look begins when the look ends, holds, and on release goes back to where the look left the view', async () => {
    const c = camera();
    const cam = new StoryCamera(c as unknown as Camera);
    void cam.look([50, 0, 0], { ease: 1, ...centre });
    await settle();
    const framed = flag(cam.frame([100, 100, 0], { ease: 1, zoom: 12, ...centre }));
    await run(cam, 1.1);
    expect(framed.done).toBe(false);
    await run(cam, 1.1);
    expect(framed.done).toBe(true);
    expect(c.target).toEqual([100, 100, 0]);
    await run(cam, 3);
    expect(cam.busy).toBe(true);
    expect(c.target).toEqual([100, 100, 0]);
    const back = flag(cam.release(0.5));
    await run(cam, 0.6);
    expect(back.done).toBe(true);
    expect(c.target).toEqual([50, 0, 0]);
    expect(c.zoom).toBeCloseTo(8);
    expect(cam.busy).toBe(false);
  });

  it('a held frame let go goes straight on to the look waiting behind it; a second release does nothing', async () => {
    const c = camera();
    const cam = new StoryCamera(c as unknown as Camera);
    void cam.frame([100, 100, 0], { ease: 1, ...centre });
    await run(cam, 1.1);
    const looked = flag(cam.look([300, 0, 0], { ease: 1, ...centre }));
    await run(cam, 2);
    expect(looked.done).toBe(false);
    expect(c.target).toEqual([100, 100, 0]);
    void cam.release(0.2);
    // (the petition's own release, after the event's)
    const again = flag(cam.release());
    await settle();
    expect(again.done).toBe(true);
    await run(cam, 1.1);
    expect(looked.done).toBe(true);
    expect(c.target).toEqual([300, 0, 0]);
    void cam.release();
    await run(cam, 2);
    expect(c.target).toEqual([300, 0, 0]);
    expect(cam.busy).toBe(false);
  });

  it('a release with a look and a frame both waiting takes out the frame only', async () => {
    const c = camera();
    const cam = new StoryCamera(c as unknown as Camera);
    void cam.look([50, 0, 0], { ease: 1, ...centre });
    await settle();
    void cam.frame([100, 100, 0], { ease: 1, ...centre });
    const last = flag(cam.look([300, 0, 0], { ease: 1, ...centre }));
    void cam.release();
    void cam.release();
    await run(cam, 2.2);
    expect(last.done).toBe(true);
    expect(c.target).toEqual([300, 0, 0]);
    expect(cam.busy).toBe(false);
  });

  it('shots sent in the same step run in turn: three looks take three eases, a frame after a look waits for it', async () => {
    const c = camera();
    const cam = new StoryCamera(c as unknown as Camera);
    const first = flag(cam.look([50, 0, 0], { ease: 1, ...centre }));
    const second = flag(cam.look([60, 0, 0], { ease: 1, ...centre }));
    const third = flag(cam.look([70, 0, 0], { ease: 1, ...centre }));
    const framed = flag(cam.frame([100, 100, 0], { ease: 1, ...centre }));
    // (each takes its second: at 1.5 s one is through, at 2.5 s two, at 3.5 s three, at 4.5 s the frame is there)
    await run(cam, 0.5);
    expect(first.done).toBe(false);
    await run(cam, 1);
    expect([first.done, second.done]).toEqual([true, false]);
    await run(cam, 1);
    expect([second.done, third.done]).toEqual([true, false]);
    await run(cam, 1);
    expect([third.done, framed.done]).toEqual([true, false]);
    await run(cam, 1);
    expect(framed.done).toBe(true);
    expect(c.target).toEqual([100, 100, 0]);
    void cam.release(0.5);
    await run(cam, 0.6);
    expect(c.target).toEqual([70, 0, 0]);
    expect(cam.busy).toBe(false);
  });

  it('a look sent while a look is under way runs after it', async () => {
    const c = camera();
    const cam = new StoryCamera(c as unknown as Camera);
    void cam.look([50, 0, 0], { ease: 1, ...centre });
    await settle();
    const second = flag(cam.look([300, 0, 0], { ease: 1, ...centre }));
    const idle = flag(cam.idle());
    await run(cam, 2.2);
    expect(second.done).toBe(true);
    expect(idle.done).toBe(true);
    expect(c.target).toEqual([300, 0, 0]);
  });
});
