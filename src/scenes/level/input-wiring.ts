// The level's pointer and key input: Controls' taps, drags, pinches and wheel routed to the powers, the tools, the
// the story and the camera; the window's key bindings (debug keys, the lens, flying). API: wireInput(scene).
// Listeners are removed by the scene's abort signal.
import { Controls } from '../../input/controls';
import { cellAt } from '../../world/lattice';
import { worldAt } from './atlas-controls';
import { pickTown, townAtPick } from './town-tools';
import { pickSmash, smashAt, undo } from './sandbox-tools';
import { beamAim, dropAtPick, meteorAtPick, placeAtPick, ventAtPick } from './impacts';
import { takeHold } from './hold';
import { cannonAtPick, meteorRowAtPick } from './shots';
import type { LevelScene } from '../level';

/** the canvas controls and the window's keys */
export function wireInput(scene: LevelScene): void {
  const { core, host } = scene;
  const { camera } = core;
  const zoomAt = (sx: number, sy: number, factor: number) => {
    // (flying: the wheel moves along the view)
    if (camera.fly) {
      const { f } = camera.basis();
      const step = Math.log(factor) * 40;
      for (let i = 0; i < 3; i++) camera.fly.pos[i] += f[i] * step;
      return;
    }
    const before = camera.screenDeltaToWorld(sx - camera.viewportW / 2, sy - camera.viewportH / 2);
    camera.zoom = Math.max(0.8, Math.min(24, camera.zoom * factor));
    const after = camera.screenDeltaToWorld(sx - camera.viewportW / 2, sy - camera.viewportH / 2);
    camera.target[0] += before[0] - after[0];
    camera.target[1] += before[1] - after[1];
  };
  const toRender = (x: number, y: number): [number, number] => [
    (x / camera.viewportW) * scene.renderW,
    (y / camera.viewportH) * scene.renderH,
  ];
  // (round 83, dialog: a talk or a story shot has the screen — a tap cuts a reveal short, the rest waits)
  const held = () => !!scene.storyPlay?.holdsInput;
  // (round 128o, DA-B19: the ground under the pointer — null while its page isn't read yet: a tap waits a frame, a drag
  // doesn't start, a move or a hover is skipped; never a stand-in height)
  const under = (sx: number, sy: number) => camera.groundAt(sx, sy, scene.heightAt);
  const tap = (sx: number, sy: number): void => {
    // (round 83: flying, the pointer only turns the view)
    if (camera.fly) return;
    // (street lab, m3a: a tap places, moves, selects or removes a point)
    if (scene.streetLab) {
      const g = under(sx, sy);
      if (!g) return void requestAnimationFrame(() => tap(sx, sy));
      return void scene.streetLab.tapAt(g[0], g[1]);
    }
    if (scene.editor?.tool === 'smash') return void smashAt(scene, sx, sy, true);
    if (scene.editor?.tool === 'place') return void placeAtPick(scene, sx, sy);
    if (scene.editor?.tool === 'town') return void townAtPick(scene, sx, sy);
    if (scene.editor?.tool === 'drop') return void dropAtPick(scene, sx, sy);
    // (telekinesis: a tap is the first half of the double tap that starts a grab — nothing else answers it)
    if (scene.editor?.tool === 'beam' || scene.editor?.tool === 'drag') return;
    if (scene.editor?.tool === 'volcano') return void ventAtPick(scene, sx, sy);
    // (PQ9) the cannon: a ball of the engine at the place tapped
    if (scene.editor?.tool === 'cannon') return void cannonAtPick(scene, sx, sy);
    // (PQ3: under ?solver=engine the meteor is a body of the engine, and what it breaks it breaks by its hit)
    if (scene.editor?.tool === 'meteor') return void (scene.engine ? meteorRowAtPick(scene, sx, sy) : meteorAtPick(scene, sx, sy));
    const g = under(sx, sy);
    if (!g) return void requestAnimationFrame(() => tap(sx, sy));
    const [wx, wy] = g;
    if (scene.editTool(wx, wy, true)) return;
    // (story: nothing answers out in the fog beyond the green's reach)
    if (scene.reach && !scene.reach.contains(wx, wy)) return;
    const [rx, ry] = toRender(sx, sy);
    core.renderer.pick(rx, ry).then((hit) => scene.powers.tap(hit, wx, wy, sx, sy));
  };
  scene.controls = new Controls(host.canvas, {
    tap: (sx, sy) => {
      if (held()) return void scene.storyPlay!.cam.skip();
      tap(sx, sy);
    },
    dragStart: (sx, sy, second) => {
      if (held()) return false;
      if (camera.fly) {
        scene.flyDrag = [sx, sy];
        return true;
      }
      if (scene.editor?.tool === 'smash') {
        smashAt(scene, sx, sy, true);
        scene.smashing = true;
        return true;
      }
      if (scene.editor?.tool === 'drop') {
        dropAtPick(scene, sx, sy);
        return true;
      }
      // (round 120) telekinesis: the body nearest the press, within a thumb's reach, held while dragging. (the user,
      // 2026-11-15: "the telekinesis needs a double tap to start because drag moves the screen") Only a drag whose
      // press came straight after a tap in the same place grabs; any other pans as with no tool.
      if (scene.editor?.tool === 'drag') {
        if (!second) return false;
        if (!scene.integrity) return false;
        // (PQ1: the gesture is the tool's from here, so the screen stays; the body is taken once the ground under the
        // press is read — a finger has no hover before it, so the first ask is often not answered yet, and the drag
        // used to fall to a pan: the owner's phone, "drag moves the screen")
        scene.dragHold = { h: 0, at: [sx, sy], from: [sx, sy] };
        takeHold(scene);
        return true;
      }
      // the heat beam: on while held, aimed at what's under the pointer (frame())
      if (scene.editor?.tool === 'beam') {
        scene.beamAt = beamAim(scene, sx, sy);
        return true;
      }
      // (a press that turns into a drag still places, once)
      if (scene.editor?.tool === 'place') {
        placeAtPick(scene, sx, sy);
        return true;
      }
      if (scene.editor?.tool === 'town') {
        townAtPick(scene, sx, sy);
        return true;
      }
      const g = under(sx, sy);
      if (!g) return false;
      const [wx, wy] = g;
      if (scene.editTool(wx, wy, false)) return true;
      if (scene.reach && !scene.reach.contains(wx, wy)) return false;
      return scene.powers.gustStart(wx, wy);
    },
    dragMove: (sx, sy) => {
      if (scene.flyDrag) {
        const [px, py] = scene.flyDrag;
        scene.flyDrag = [sx, sy];
        if (camera.fly) {
          camera.fly.yaw -= (sx - px) * 0.004;
          camera.fly.pitch = Math.max(-1.5, Math.min(1.5, camera.fly.pitch - (sy - py) * 0.004));
        }
        return;
      }
      if (scene.beamAt) return void (scene.beamAt = beamAim(scene, sx, sy));
      if (scene.dragHold) return void (scene.dragHold.at = [sx, sy]);
      if (scene.smashing) {
        pickSmash(scene, sx, sy);
        return void smashAt(scene, sx, sy, false);
      }
      const g = under(sx, sy);
      if (!g) return;
      const [wx, wy] = g;
      if (scene.brushAt) scene.brushAt = [wx, wy];
      else scene.powers.gustMove(wx, wy);
    },
    dragEnd: () => {
      if (scene.flyDrag) return void (scene.flyDrag = undefined);
      // (let go: it flies on with the speed it had)
      if (scene.dragHold) {
        if (scene.dragHold.g) scene.integrity?.letGo(scene.dragHold.g);
        return void (scene.dragHold = undefined);
      }
      if (scene.beamAt) {
        scene.beamAt = undefined;
        if (scene.physics) scene.physics.beam = null;
        if (scene.lava) scene.lava.beam = null;
        scene.beamLine?.setAttribute('x1', '0');
        scene.beamLine?.setAttribute('x2', '0');
        scene.beamLine?.setAttribute('y1', '0');
        scene.beamLine?.setAttribute('y2', '0');
        scene.beamDot?.setAttribute('r', '0');
        return;
      }
      scene.smashing = false;
      scene.raising?.end();
      scene.raising = undefined;
      if (scene.brushAt) scene.brushAt = undefined;
      else scene.powers.gustEnd();
    },
    hover: (sx, sy) => {
      const g = under(sx, sy);
      const hw = g ? ([g[0], g[1]] as [number, number]) : null;
      scene.hoverWorld = !hw || (scene.reach && !scene.reach.contains(hw[0], hw[1])) ? null : hw;
      if (scene.editor?.tool === 'smash') pickSmash(scene, sx, sy);
      if (scene.editor?.tool === 'town') pickTown(scene, sx, sy);
    },
    // (PQ1: while a body is held, or being taken, the camera neither pans nor zooms)
    gestureKeeps: () => !!scene.dragHold,
    pan: (dx, dy) => {
      if (held() || scene.dragHold) return;
      // (flying: a right drag looks round)
      if (camera.fly) {
        camera.fly.yaw -= dx * 0.004;
        camera.fly.pitch = Math.max(-1.5, Math.min(1.5, camera.fly.pitch - dy * 0.004));
        return;
      }
      const [wx, wy] = camera.screenDeltaToWorld(dx, dy);
      camera.target[0] -= wx;
      camera.target[1] -= wy;
    },
    zoomAt: (sx, sy, f) => {
      if (!held() && !scene.dragHold) zoomAt(sx, sy, f);
    },
  });

  const signal = scene.abort.signal;
  window.addEventListener(
    'keydown',
    (e) => {
      scene.keys.add(e.key.toLowerCase());
      if (e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey) && scene.editor) {
        e.preventDefault();
        undo(scene);
        return;
      }
      if (e.key.toLowerCase() === 'e' && scene.editor?.tool === 'place') scene.editor.rotate();
      if (e.key === 'Escape' && scene.intro) scene.director.cancel();
      // (the atlas level, round 71) M: a great meteor where the pointer is; V: an eruption there
      if (scene.opts.atlas && scene.hoverWorld && !e.ctrlKey && !e.metaKey && !(e.target instanceof HTMLInputElement)) {
        const [hx, hy] = cellAt(scene.hoverWorld[0], scene.hoverWorld[1]);
        if (e.key.toLowerCase() === 'm') worldAt(scene, hx, hy, (wx, wy, c) => c.meteor(wx, wy));
        if (e.key.toLowerCase() === 'v') worldAt(scene, hx, hy, (wx, wy, c) => c.erupt(wx, wy));
      }
      // F: the free camera (round 69: fly round the world in perspective), and back
      if (e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.metaKey && !(e.target instanceof HTMLInputElement)) scene.toggleFly();
      if (e.key === ' ') {
        e.preventDefault();
        if (!scene.lensOn) scene.hud.say('Life lens — green: growing · magenta: toxic · grey: sealed · amber: too dry · blue: ready for life', 4);
        scene.lensOn = true;
      }
    },
    { signal },
  );
  window.addEventListener(
    'keyup',
    (e) => {
      scene.keys.delete(e.key.toLowerCase());
      if (e.key === ' ') scene.lensOn = false;
    },
    { signal },
  );
}
