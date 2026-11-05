// Scripted and keyed camera motion: the drive and pan benches (?drive, ?pan), the free flyer's keys, and the turn
// buttons (round 90). API: driveOn, panOn, flyKeys (per frame), turnControls (once), turnPivot, turnStep.
// Moves only the camera and the turn's own UI.
import { ROW_H } from '../../world/lattice';
import { chooseRange, nextRange } from '../range';
import { Turn, TURN_STEP } from '../../render/turn';
import { Compass, NORTH_AZIMUTH } from '../../ui/compass';
import { CUTAWAY, FLY_SPEED } from './flags';
import type { LevelScene } from '../level';

/** ?drive: along the road from where it is, back again at its end (world points, the window's origin taken off) */
export function driveOn(scene: LevelScene, dt: number): void {
  const d = scene.drive!;
  const S = scene.stream;
  if (!S || d.path.length < 2) return;
  d.s += d.dir * d.speed * dt;
  let len = 0;
  for (let k = 1; k < d.path.length; k++) {
    const seg = Math.hypot(d.path[k][0] - d.path[k - 1][0], d.path[k][1] - d.path[k - 1][1]);
    if (d.s <= len + seg || k === d.path.length - 1) {
      const t = Math.max(0, Math.min(1, (d.s - len) / seg));
      const wx = d.path[k - 1][0] + (d.path[k][0] - d.path[k - 1][0]) * t;
      const wy = d.path[k - 1][1] + (d.path[k][1] - d.path[k - 1][1]) * t;
      if (d.s > len + seg) d.dir = -1;
      const cam = scene.core.camera;
      cam.target[0] = wx - S.origin[0];
      cam.target[1] = wy - S.origin[1] * ROW_H;
      break;
    }
    len += seg;
  }
  if (d.s < 0) d.dir = 1;
  scene.core.camera.zoom = d.zoom / (1 + d.speed / 40);
}

/** ?pan: a straight line at its speed (world units a second), turning once if asked */
export function panOn(scene: LevelScene, dt: number): void {
  const p = scene.pan!;
  const cam = scene.core.camera;
  p.t += dt;
  if (p.turnBy && p.t > p.turnAt && p.turned < 1) {
    const step = Math.min(1 - p.turned, dt);
    p.turned += step;
    const a = ((p.turnBy * Math.PI) / 180) * step;
    const [x, y] = p.dir;
    p.dir = [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
  }
  // (cells a second along the ground: a row is ROW_H world units)
  const d = p.speed * dt;
  p.asked += d;
  cam.target[0] += p.dir[0] * d;
  cam.target[1] += p.dir[1] * d;
}

/** Flying: WASD along the view (level), Q/E down and up; the window's middle follows the camera. */
export function flyKeys(scene: LevelScene, dt: number): void {
  const { camera, dims } = scene.core;
  const fly = camera.fly!;
  const k = scene.keys;
  const speed = (k.has('shift') ? 120 : FLY_SPEED) * dt;
  const { f } = camera.basis();
  const hl = Math.hypot(f[0], f[1]) || 1;
  const fx = f[0] / hl;
  const fy = f[1] / hl;
  let m = 0;
  let s = 0;
  if (k.has('w') || k.has('arrowup')) m += 1;
  if (k.has('s') || k.has('arrowdown')) m -= 1;
  if (k.has('d') || k.has('arrowright')) s += 1;
  if (k.has('a') || k.has('arrowleft')) s -= 1;
  fly.pos[0] += (fx * m + fy * s) * speed;
  fly.pos[1] += (fy * m - fx * s) * speed;
  if (k.has('e')) fly.pos[2] += speed;
  if (k.has('q')) fly.pos[2] -= speed;
  // (inside the window, over the ground under it)
  fly.pos[0] = Math.max(1, Math.min(dims.w - 1, fly.pos[0]));
  fly.pos[1] = Math.max(1, Math.min(dims.h * ROW_H - 1, fly.pos[1]));
  fly.pos[2] = Math.max(scene.heightAt(fly.pos[0], fly.pos[1]) + 1.5, Math.min(dims.zMax + 200, fly.pos[2]));
  // the window streams round where the camera is
  camera.target[0] = fly.pos[0];
  camera.target[1] = fly.pos[1];
}

/**
 * (round 90, the user on the phone: "add a button or bar to rotate the camera") Bottom left, clear of the tool
 * panel (top right) and the atlas buttons (bottom right): turn the view a sixth either way (a tap; held, it turns
 * on), Q / E on a keyboard; and the range — how far out the land is built in detail (scenes/range.ts; a reload).
 */
export function turnControls(scene: LevelScene): void {
  const camera = scene.core.camera;
  const turn = (scene.turn = new Turn(camera));
  const d = document.createElement('div');
  d.className = 'turn-ctl';
  d.style.cssText = 'position:absolute;left:8px;bottom:8px;display:flex;gap:8px;align-items:center;z-index:5;';
  const btn = (label: string, title: string) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    b.style.cssText = 'min-width:52px;height:52px;font:24px system-ui,sans-serif;border-radius:26px;border:1px solid #888;background:rgba(20,22,24,0.8);color:#eee;touch-action:none;user-select:none;-webkit-user-select:none;';
    d.appendChild(b);
    return b;
  };
  // (a tap steps; held past 0.3 s it turns on until let go, and stays where it's let go)
  const press = (b: HTMLButtonElement, dir: number) => {
    let timer = 0;
    let on = false;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      b.setPointerCapture(e.pointerId);
      on = false;
      timer = window.setTimeout(() => {
        on = true;
        turnPivot(scene);
        turn.held = dir;
      }, 300);
    });
    const up = (step: boolean) => {
      clearTimeout(timer);
      if (on) turn.held = 0;
      else if (step) turnStep(scene, dir);
      on = false;
    };
    b.addEventListener('pointerup', () => up(true));
    b.addEventListener('pointercancel', () => up(false));
  };
  press(btn('↺', 'turn the view (Q; hold to turn on)'), -1);
  press(btn('↻', 'turn the view (E; hold to turn on)'), 1);
  const W = scene.core.dims.w;
  const r = btn(`${W}`, 'range: how far out the land is built in detail (cells across; reloads)');
  r.style.font = '13px system-ui,sans-serif';
  r.style.borderRadius = '8px';
  r.addEventListener('click', () => chooseRange(nextRange(W)));
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.target instanceof HTMLInputElement) return;
      // (flying, Q / E are down and up; with the place tool, E turns the model)
      if (camera.fly || scene.editor?.tool === 'place') return;
      const k = e.key.toLowerCase();
      if (k === 'q') turnStep(scene, -1);
      if (k === 'e') turnStep(scene, 1);
    },
    { signal: scene.abort.signal },
  );
  scene.host.ui.appendChild(d);
  scene.turnCtl = d;
  const compass = (scene.compass = new Compass(scene.host.ui));
  compass.update(camera.azimuth);
  compass.onTap = () => {
    if (camera.fly) return;
    turnPivot(scene);
    const c = CUTAWAY ? scene.cutaway : undefined;
    if (c) c.orbit.goal = camera.azimuth + Math.atan2(Math.sin(NORTH_AZIMUTH - camera.azimuth), Math.cos(NORTH_AZIMUTH - camera.azimuth));
    else turn.face(NORTH_AZIMUTH);
  };
}

/** (the turn goes round the ground under the screen's middle, not a point over it: what's there stays there) */
export function turnPivot(scene: LevelScene): void {
  const cam = scene.core.camera;
  if (cam.fly || scene.cutaway) return;
  cam.target = cam.groundAt(cam.viewportW / 2, cam.viewportH / 2, scene.heightAt);
}

/** a step of the view's turn: the cutaway's Orbit takes it when it's on (it owns the azimuth there) */
export function turnStep(scene: LevelScene, dir: number): void {
  if (scene.core.camera.fly) return;
  turnPivot(scene);
  const c = CUTAWAY ? scene.cutaway : undefined;
  if (c) c.orbit.goal = scene.core.camera.azimuth + dir * TURN_STEP;
  else scene.turn?.step(dir);
}
