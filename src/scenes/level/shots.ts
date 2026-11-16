// Shots under `?solver=engine` (PQ9, PQ3): bodies of the physics engine fired at what's under the pointer. The
// cannonball (the owner, 2026-11-15: "a button to shoot cannonballs at the places you tap") comes from off to the side
// of the view on a ballistic arc; the meteor comes down from the sky. Each has a stated speed: the launch velocity is
// that speed aimed (game/ballistic.ts), and a target out of its range is refused, never given more.
// What a ball does when it lands is the engine's: it meets rows and breaks them, a hard hit on a building knocks its
// lot down and a hard hit on the ground crumbles it (level/housefall.ts).
// API: cannonAtPick, meteorRowAtPick.
import { ignoreTeardown } from '../../gpu/pipeline';
import { ballCells, launch, type V3 } from '../../game/ballistic';
import { worldG } from '../../tune/params';
import { cellAt, cellPos } from '../../world/lattice';
import { MAT } from '../../world/materials';
import type { LevelScene } from '../level';

/** the cannonball: a steel ball of radius 2 (57 cells), 40 cells/s at the muzzle, fired from 30 cells to the left of
 *  the target as the view has it, 8 over the higher of the target and the ground it starts over */
export const CANNON = { r: 2, mat: MAT.Steel, speed: 40, back: 30, up: 8 };
/** the engine's meteor: a stone ball of radius 3 (123 cells), 60 cells/s, from up and behind as the old meteor came */
export const METEOR = { r: 3, mat: MAT.Stone, speed: 60, from: [-30, 22, 70] as V3 };

/** what's under the pointer, as the renderer's pick has it: world place of the cell's top */
function pickAt(scene: LevelScene, sx: number, sy: number): Promise<V3 | null> {
  const { core } = scene;
  const [rx, ry] = [(sx / core.camera.viewportW) * scene.renderW, (sy / core.camera.viewportH) * scene.renderH];
  return core.renderer.pick(rx, ry).then((hit) => {
    if (!hit) return null;
    const [x, y] = cellPos(hit.cell % core.dims.w, Math.floor(hit.cell / core.dims.w));
    return [x, y, hit.z + 0.5] as V3;
  });
}

/** the ground at world (x, y), waited for (scene.heightAt: null until its page is read) */
async function groundAt(scene: LevelScene, x: number, y: number): Promise<number> {
  for (;;) {
    const z = scene.heightAt(x, y);
    if (z !== null) return z;
    await new Promise((res) => requestAnimationFrame(res));
  }
}

/** a ball of the engine from near `start` (world) at `speed` through `to`; false with a word to the player if it can't be */
function fire(scene: LevelScene, start: V3, to: V3, shot: { r: number; mat: number; speed: number }): boolean {
  const kit = scene.engine;
  if (!kit) return false;
  const { w, h, zMax } = scene.core.dims;
  const [cx, cy] = cellAt(start[0], start[1]);
  const cz = Math.min(Math.round(start[2]), zMax - shot.r - 2);
  if (cx < shot.r || cy < shot.r || cx >= w - shot.r || cy >= h - shot.r) {
    scene.hud.say('Too near the edge of the map to fire from there.', 3);
    return false;
  }
  // (aimed from where the ball's middle really is: its cell's)
  const [px, py] = cellPos(cx, cy);
  const v = launch([px, py, cz + 0.5], to, shot.speed, worldG());
  if (!v) {
    scene.hud.say('Out of range.', 2);
    return false;
  }
  if (!kit.drop(ballCells(cx, cy, cz, shot.r, shot.mat), v)) {
    scene.hud.say('No room for more bodies.', 2);
    return false;
  }
  return true;
}

/** The cannon tool's tap: a steel ball at what's under the pointer, from the left of the view. */
export function cannonAtPick(scene: LevelScene, sx: number, sy: number): void {
  if (!scene.engine) return void scene.hud.say('The cannon needs the new physics. Add ?solver=engine to the address.', 4);
  pickAt(scene, sx, sy).then(async (to) => {
    if (!to) return;
    // (the view's right on the ground: the ball comes from the other side)
    const [rx, ry] = scene.core.camera.screenDeltaToWorld(1, 0);
    const len = Math.hypot(rx, ry) || 1;
    const sxw = to[0] - (rx / len) * CANNON.back;
    const syw = to[1] - (ry / len) * CANNON.back;
    const g = await groundAt(scene, sxw, syw);
    fire(scene, [sxw, syw, Math.max(g, to[2]) + CANNON.up], to, CANNON);
  }, ignoreTeardown);
}

/** The meteor tool's tap under `?solver=engine`: a stone ball of the engine from the sky at what's under the pointer. */
export function meteorRowAtPick(scene: LevelScene, sx: number, sy: number): void {
  pickAt(scene, sx, sy).then((to) => {
    if (!to) return;
    fire(scene, [to[0] + METEOR.from[0], to[1] + METEOR.from[1], to[2] + METEOR.from[2]], to, METEOR);
  }, ignoreTeardown);
}
