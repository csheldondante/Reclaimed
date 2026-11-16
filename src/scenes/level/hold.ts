// The telekinesis tool's hold (round 120; PQ1): a second press dragged makes a hold at once, so the gesture is the
// tool's and the screen stays; the body is taken when the ground under the press is read. A finger has no hover
// before its press, so the first ask for that ground is often not answered yet (scene.heightAt: null, its page asked
// for); the hold waits a frame for it instead of letting the drag fall to a pan.
import type { LevelScene } from '../level';

/** Take the body under the hold's press, if the ground there is read. True once the hold has its answer (a body or
 *  none); false while it waits. A hold that found nothing stays (the screen kept, nothing pulled) till the lift. */
export function takeHold(scene: LevelScene): boolean {
  const hold = scene.dragHold;
  const ig = scene.integrity;
  if (!hold || !ig) return true;
  if (hold.g || hold.none) return true;
  const camera = scene.core.camera;
  const [sx, sy] = hold.from;
  const p = camera.groundAt(sx, sy, scene.heightAt);
  if (!p) return false;
  const [gx, gy, gz] = p;
  const reach = 48 / camera.zoom + 2;
  // (on the ground under the finger or anything stood on it up to a body's height above; the engine's rows: what the
  // finger's view ray passes within a thumb of, the nearest the eye)
  const g = ig.grabAt(gx, gy, gz + 2, reach + 2, { ...camera.ray(sx, sy), r: 20 / camera.zoom });
  if (!g) {
    hold.none = true;
    return true;
  }
  hold.g = g;
  // (the height it is held at: 2 over where it was; the engine's rows keep theirs on the GPU)
  hold.h = (ig.grabState(g)?.pos[2] ?? gz + 2) + 2;
  return true;
}
