// The sandbox's world-changing tools: meteors and their impacts, volcano vents, dropped bodies, the heat beam and
// placed models. API: meteorAtPick, stepMeteors, impact, bowlVolume, impactFx, ventAtPick, dropAtPick, beamAim,
// aimBeam, placeAtPick, placeModel. Edits go through the sim's edit ops and the integrity/physics APIs.
import { EventKind } from '../../sim/globals';
import { ignoreTeardown } from '../../gpu/pipeline';
import { PK } from '../../sim/particles';
import { BODIES } from '../../ui/editor';
import { LINEUP } from '../../physics/shapes';
import { Sleep } from '../../sim/sleep';
import { columnSlots, readColumn } from '../../world/layout';
import { modelById, modelColumns, restingBase, seatColumn, type VoxelModel } from '../../world/models';
import { MAT } from '../../world/materials';
import { cellAt, cellPos, ROW_H } from '../../world/lattice';
import { qYawPitchRoll } from '../../grids/structures';
import { placeRect } from './town-tools';
import type { LevelScene } from '../level';

/** A meteor at what's under the pointer: it comes in from the sky, smoking (stepMeteors). */
export function meteorAtPick(scene: LevelScene, sx: number, sy: number): void {
  const { core } = scene;
  const [rx, ry] = [(sx / core.camera.viewportW) * scene.renderW, (sy / core.camera.viewportH) * scene.renderH];
  core.renderer.pick(rx, ry).then((hit) => {
    if (!hit) return;
    const [x, y] = cellPos(hit.cell % core.dims.w, Math.floor(hit.cell / core.dims.w));
    const to: [number, number, number] = [x, y, hit.z + 0.5];
    scene.meteors.push({ from: [x - 45, y + 35, to[2] + 110], to, t: 0, dur: 1.6 });
  }, ignoreTeardown);
}

/**
 * Meteors in flight: a burning head (embers) and a trail of smoke; on
 * arrival the impact (round 48): a crater blown out of everything there
 * (edit.wgsl OP_CRATER: it's gone to dust, ejecta round it), the ruins
 * there woken and crumbled by the blast, the bodies near thrown, a ring of
 * wind out every way (ripples) that lifts the loose ground, a flash, a
 * cloud of dust and debris, and a molten pool in the bowl.
 */
export function stepMeteors(scene: LevelScene, dt: number): void {
  const { core } = scene;
  const parts = core.sim.particles;
  for (let k = scene.meteors.length - 1; k >= 0; k--) {
    const m = scene.meteors[k];
    m.t += dt;
    const f = Math.min(m.t / m.dur, 1);
    const at = [0, 1, 2].map((i) => m.from[i] + (m.to[i] - m.from[i]) * f) as [number, number, number];
    if (f < 1) {
      parts.burst({ kind: PK.Ember, x: at[0], y: at[1], z: at[2], count: 10, speed: 1.5, spread: 0.7 });
      parts.burst({ kind: PK.Smoke, x: at[0], y: at[1], z: at[2], count: 6, speed: 0.4, spread: 1 });
      continue;
    }
    scene.meteors.splice(k, 1);
    impact(scene, m.to);
  }
}

/**
 * A meteor lands at (x, y, z) (round 48). Round 86 — the user: "I would expect it to be like a delete with a
 * shockwave that makes the nearby material melt as magma and glow"; "it should also probably make a big cloud of
 * dust for the deleted material and maybe sparks that fly with the shockwave". The bowl goes on the sim's next
 * tick (edit.wgsl OP_CRATER, the frame after this one; its chunks meshed that frame: fieldmesh.ts urgent; what it
 * undercut judged at once: Integrity's tap), with the blast (impactFx). `crater` false: the blast only (the
 * atlas's great meteor makes its own crater).
 */
export function impact(scene: LevelScene, [x, y, z]: [number, number, number], crater = true): void {
  const BOWL = 12;
  if (crater) scene.core.globals.events.push({ kind: EventKind.Edit, x, y, z: 13 * 32 + 512, radius: BOWL * 2.5, strength: z });
  impactFx(scene, [x, y, z], BOWL);
}

/** (round 86) about how many cells a meteor's bowl of radius `bowl` hitting at height z takes away (edit.wgsl OP_CRATER's ellipsoid, the surface as last read) */
export function bowlVolume(scene: LevelScene, x: number, y: number, z: number, bowl: number): number {
  const { w: W, h: H } = scene.core.dims;
  const surf = scene.core.map.surface;
  const [c0x, c0y] = cellAt(x - bowl, y - bowl);
  const [c1x, c1y] = cellAt(x + bowl, y + bowl);
  let v = 0;
  for (let cy = Math.max(0, c0y); cy <= Math.min(H - 1, c1y); cy++)
    for (let cx = Math.max(0, c0x); cx <= Math.min(W - 1, c1x); cx++) {
      const [px, py] = cellPos(cx, cy);
      const d = Math.hypot(px - x, py - y) / bowl;
      if (d >= 1) continue;
      const hz = bowl * Math.sqrt(1 - d * d);
      const lo = Math.max(z - hz * 0.7, 2);
      v += Math.max(0, Math.min(surf[scene.core.ring.i(cx, cy)], z + hz * 1.5) - lo);
    }
  return v;
}

/**
 * (round 86) What a meteor's landing looks like: the flash; a ring of dust and embers racing out from the bowl's
 * rim (the shockwave — the wind's ripples carry on past it, lifting the loose ground); a cloud of dust as big as
 * what the bowl took away (capped by the tier's particles); chips and smoke; the ground round the rim melted to
 * lava and glowing past it (lava.ts blast: it cools to basalt); a molten pool in the bowl.
 */
export function impactFx(scene: LevelScene, [x, y, z]: [number, number, number], BOWL: number): void {
  const { core } = scene;
  const g = core.globals;
  for (let k = 0; k < 6; k++) g.events.push({ kind: EventKind.Ripple, x, y, radius: 55, strength: 16 });
  g.flash = 1;
  const parts = core.sim.particles;
  const dust = MAT.Drift;
  // the cloud: a grain of haze for every two cells taken, within an eighth of the tier's particles
  const vol = bowlVolume(scene, x, y, z, BOWL);
  const budget = core.world.particleCap / 8;
  const cloud = Math.min(budget, Math.max(600, vol * 0.5));
  parts.burst({ kind: PK.Haze, x, y, z: z + 1, count: Math.round(cloud * 0.4), speed: 16, spread: BOWL, payload: dust });
  parts.burst({ kind: PK.Haze, x, y, z: z + 4, count: Math.round(cloud * 0.35), speed: 9, spread: BOWL * 0.6, payload: MAT.Ash });
  parts.burst({ kind: PK.Haze, x, y, z: z + 10, count: Math.round(cloud * 0.25), speed: 4, spread: BOWL * 0.4, payload: MAT.Ash });
  parts.burst({ kind: PK.Dust, x, y, z: z + 1, count: 300, speed: 14, spread: BOWL * 0.7 });
  parts.burst({ kind: PK.Chip, x, y, z: z + 1, count: 160, speed: 22, spread: BOWL * 0.5 });
  parts.burst({ kind: PK.Ember, x, y, z: z + 1, count: 90, speed: 18, spread: BOWL * 0.4 });
  parts.burst({ kind: PK.Smoke, x, y, z: z + 2, count: 150, speed: 5, spread: BOWL * 0.5 });
  // the shockwave: dust low along the ground and embers, out every way from the rim
  const RING = 16;
  for (let k = 0; k < RING; k++) {
    const a = (k / RING) * Math.PI * 2;
    const [dx, dy] = [Math.cos(a), Math.sin(a)];
    const at = { x: x + dx * BOWL * 0.9, y: y + dy * BOWL * 0.9, z: z + 0.8 };
    parts.burst({ kind: PK.Haze, ...at, count: 14, speed: 1.5, spread: 1.5, payload: dust, vel: [dx * 22, dy * 22, 1] });
    parts.burst({ kind: PK.Ember, ...at, count: 5, speed: 2, spread: 1, vel: [dx * 16, dy * 16, 5] });
  }
  // the rim's ground molten, glowing past it; a molten pool in the bowl (no cone)
  scene.lava?.blast(x, y, BOWL, BOWL * 1.45, 2.5, z);
  // (round 88: the rim melting and setting over the next seconds — judged until it's done)
  scene.integrity?.watch(x, y, BOWL * 1.6, 15);
  scene.lava?.addVent(x, y, 2.5, 12, 3, 0);
  const phys = scene.physics;
  // (round 88: what the bowl undercut falls as the columns' pieces — the ruins there aren't woken into bodies first)
  if (phys) phys.blast([x, y, z], BOWL, 28);
}

/** Open a volcano vent where the pointer is (sim/lava.ts). */
export function ventAtPick(scene: LevelScene, sx: number, sy: number): void {
  const { core } = scene;
  if (!scene.lava) return;
  const [rx, ry] = [(sx / core.camera.viewportW) * scene.renderW, (sy / core.camera.viewportH) * scene.renderH];
  core.renderer.pick(rx, ry).then((hit) => {
    if (!hit || !scene.lava) return;
    const [x, y] = cellPos(hit.cell % core.dims.w, Math.floor(hit.cell / core.dims.w));
    scene.lava.addVent(x, y);
    core.sim.particles.burst({ kind: PK.Ember, x, y, z: hit.z + 1, count: 12, speed: 6, spread: 0.6 });
  }, ignoreTeardown);
}

/**
 * Drop the chosen body (or, drop all, the line-up) over what's under the cursor (docs/PHYSICS.md). (round 120) Where
 * the level has the rigid rock (the playground, the rock lab, the atlas) it falls by the picked solver variant —
 * ?solver=old|nodes|lattice|hybrid (Integrity.dropModels → dropBody); elsewhere on the physics voxels, as before.
 */
export function dropAtPick(scene: LevelScene, sx: number, sy: number): void {
  const { core } = scene;
  const ed = scene.editor!;
  const kind = BODIES.find((b) => b.id === ed.body);
  if (!kind || !scene.physics) return;
  const [rx, ry] = [(sx / core.camera.viewportW) * scene.renderW, (sy / core.camera.viewportH) * scene.renderH];
  core.renderer.pick(rx, ry).then(async (hit) => {
    if (!hit) return;
    const ig = scene.integrity;
    if (ig?.rigid) {
      const kinds = ed.dropAll ? LINEUP.map((id) => BODIES.find((b) => b.id === id)!) : [kind];
      const n = await ig.dropModels(kinds.map((k) => k.make()), hit.cell % core.dims.w, Math.floor(hit.cell / core.dims.w), ed.dropHeight);
      if (n < kinds.length) scene.hud.say('No room for more bodies.', 2);
      return;
    }
    if (ed.dropAll) {
      scene.hud.say('Drop all needs a level with the solvers (the playground, the rock lab).', 3);
      return;
    }
    const [x, y] = cellPos(hit.cell % core.dims.w, Math.floor(hit.cell / core.dims.w));
    // (over a body already there: above it)
    const api = (window as unknown as { reclaimed: { phys: { spawn: (m: VoxelModel, x: number, y: number, above: number, yaw: number, pitch: number, roll: number, vel: [number, number, number], floor: number) => Promise<unknown> } } }).reclaimed;
    const b = await api.phys.spawn(kind.make(), x, y, ed.dropHeight, Math.random() * 360, 0, 0, [0, 0, 0], hit.z + 1);
    if (!b) scene.hud.say('No room for more bodies.', 2);
  }, ignoreTeardown);
}

/** Where the beam aims for a pointer at (sx, sy): on a touch screen a little above the finger, so it can be seen. */
export function beamAim(scene: LevelScene, sx: number, sy: number): [number, number] {
  const touch = window.matchMedia('(pointer: coarse)').matches;
  return [sx, sy - (touch ? 80 : 0)];
}

/** Aim the heat beam at what's under the pointer: down the camera's view, into the surface hit. */
export function aimBeam(scene: LevelScene, [sx, sy]: [number, number]): void {
  const { core } = scene;
  const { camera } = core;
  // drawn from the top of the screen, leaning a little, to the aim point
  const flick = 2 + Math.random() * 1.5;
  scene.beamLine?.setAttribute('x1', String(sx + 120));
  scene.beamLine?.setAttribute('y1', '-20');
  scene.beamLine?.setAttribute('x2', String(sx));
  scene.beamLine?.setAttribute('y2', String(sy));
  scene.beamLine?.setAttribute('stroke-width', String(flick));
  scene.beamDot?.setAttribute('cx', String(sx));
  scene.beamDot?.setAttribute('cy', String(sy));
  scene.beamDot?.setAttribute('r', String(4 + flick));
  scene.beamPicking = true;
  const [rx, ry] = [(sx / camera.viewportW) * scene.renderW, (sy / camera.viewportH) * scene.renderH];
  core.renderer.pick(rx, ry).then((hit) => {
    scene.beamPicking = false;
    if (!scene.beamAt || !scene.physics) return;
    if (!hit) {
      scene.physics.beam = null;
      if (scene.lava) scene.lava.beam = null;
      return;
    }
    const [x, y] = cellPos(hit.cell % core.dims.w, Math.floor(hit.cell / core.dims.w));
    // (camera.eye is the unit direction toward the eye: the view runs down -eye)
    const z = hit.z + 0.5;
    scene.physics.beam = { at: [x, y, z], dir: [-camera.eye[0], -camera.eye[1], -camera.eye[2]], radius: 1.6, power: 9000 };
    // on the ground (not a body): it melts it (lava.wgsl)
    if (scene.lava) scene.lava.beam = hit.flags & 0x8000 ? null : { at: [x, y, hit.z + 1], radius: 1.6, power: 9000 };
    // a ruin of the map's it touches comes alive
    // (at most a few times a second: each wake reads the layers back)
    if (!(hit.flags & 0x8000) && performance.now() - scene.beamWoke > 300) {
      scene.beamWoke = performance.now();
      void scene.wake(x, y, z, 2);
    }
    core.sim.particles.burst({ kind: PK.Ember, x, y, z: z + 0.3, count: 2, speed: 2.5, spread: 0.3 });
  }, ignoreTeardown);
}

/**
 * Place the chosen model on whatever is under the cursor: the picked column
 * and its surface height (round 14: "spawn those voxels at the height of
 * the mouse pick") — on the ground, a roof, another wreck.
 */
export function placeAtPick(scene: LevelScene, sx: number, sy: number): void {
  const { core } = scene;
  const { camera } = core;
  const rx = (sx / camera.viewportW) * scene.renderW;
  const ry = (sy / camera.viewportH) * scene.renderH;
  core.renderer.pick(rx, ry).then((hit) => {
    if (!hit) return;
    const [x, y] = cellPos(hit.cell % core.dims.w, Math.floor(hit.cell / core.dims.w));
    void placeModel(scene, x, y, hit.z);
  }, ignoreTeardown);
}

/** @param atZ the height to sit on (a pick); otherwise the mean ground under the footprint */
export async function placeModel(scene: LevelScene, wx: number, wy: number, atZ?: number): Promise<void> {
  const ed = scene.editor!;
  const m = modelById(ed.model)!;
  const { core } = scene;
  if (ed.tilt > 0) {
    // a tilted model is its own grid (docs/GRIDS.md): toppled over its
    // quarter turn, with a little roll so no face lines up with the hexes
    const r = Math.PI / 180;
    const q = qYawPitchRoll(ed.rot * 90 * r + 0.3, ed.tilt * r, (ed.tilt / 9) * r);
    // (heightAt is the loose run's base: the pick's height says how deep
    // the sand lies over it here, and that depth is taken to hold under the
    // whole footprint — otherwise it rests sunk into the drift)
    // (round 128o: the ground not read yet — its pages asked — the press waits a frame)
    const here = scene.heightAt(wx, wy);
    if (here === null) return void requestAnimationFrame(() => void placeModel(scene, wx, wy, atZ));
    const over = atZ === undefined ? 0 : Math.max(0, atZ - here);
    const ground = (x: number, y: number) => {
      const h = scene.heightAt(x, y);
      return h === null ? null : h + over;
    };
    const s = core.structures.place(m, wx, wy, q, ground, ed.bury);
    if (s === undefined) return void requestAnimationFrame(() => void placeModel(scene, wx, wy, atZ));
    if (!s) scene.hud.say('No room for more tilted structures (8 at most).', 3);
    return;
  }
  const { dims, packed } = core;
  const { fw, fd, cols } = modelColumns(m, ed.rot);
  const [[x0], [y0]] = placeRect(scene, wx, wy);
  core.snapshot();
  const slots = new Uint32Array((await core.readBuffer('layers')).buffer);
  const inMap = (x: number, y: number) => x >= 0 && y >= 0 && x < dims.w && y < dims.h;
  const topAt = (x: number, y: number) => {
    if (!inMap(x, y)) return 0;
    const c = readColumn(packed, slots, x, y);
    return c.length ? c[c.length - 1].z1 : 0;
  };
  const base = atZ !== undefined ? Math.max(1, atZ - ed.bury) : restingBase(topAt, x0, y0, fw, fd, ed.bury);
  if (base + m.size[2] >= dims.zMax - 1) {
    scene.hud.say('Too high to place that here.', 2);
    return;
  }
  // placed at full support: the structure system bleeds it away only where something is really unsupported
  // (starting at 0, every overhang would collapse before support could spread to it)
  const aux = 15 << 4;
  const seat: { x: number; y: number; runs: { z0: number; z1: number; mat: number }[] }[] = [];
  for (let fy = 0; fy < fd; fy++)
    for (let fx = 0; fx < fw; fx++) {
      const x = x0 + fx;
      const y = y0 + fy;
      const runs = cols[fx + fw * fy];
      if (!runs.length || !inMap(x, y)) continue;
      const at = runs.map((r) => ({ z0: r.z0 + base, z1: r.z1 + base, mat: r.mat }));
      // (the column as read: room for it checked here; the GPU seats it in its own column)
      if (seatColumn(readColumn(packed, slots, x, y), at, base, aux).length > columnSlots(packed, x, y).k) {
        scene.hud.say('Too many layers here to fit that model.', 2);
        return;
      }
      seat.push({ x, y, runs: at });
    }
  // (round 128, INT16: the GPU's stamp — colapply.wgsl seat, seatColumn's rule — into the layers and layersNext alike)
  core.stampColumns([{ cuts: [], seat: { cols: seat, base, aux } }]);
  core.sleep?.wake(x0 + fw / 2, (y0 + fd / 2) * ROW_H, Math.max(fw, fd) + 16, Sleep.EVENT_S, performance.now() / 1000);
  // (the loose ground under it stays in the layers, under the model)
  if (!scene.physics) scene.integrity?.markBox(x0 - 2, y0 - 2, x0 + fw + 2, y0 + fd + 2);
}
