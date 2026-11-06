// The sandbox editor's brush tools: layer edits and pours, the break tool, the brush ring, undo, and the surface
// probes they use. API: editTool, pickSmash, smashAt, drawRing, brush, undo, countSurface, hostileAt.
import { EventKind } from '../../sim/globals';
import { EDIT_OP, LAYER_TOOLS } from '../../ui/editor';
import { ignoreTeardown } from '../../gpu/pipeline';
import { PK } from '../../sim/particles';
import { LEVEL_H } from '../../build/town';
import { cellPos } from '../../world/lattice';
import { drawPlan, editorTown, placeRect } from './town-tools';
import { placeModel } from './impacts';
import type { LevelScene } from '../level';
import { worldApiOf } from './world-api';

/** LevelScene.editTool (the class keeps the method, documented there) */
export function editTool(scene: LevelScene, wx: number, wy: number, tap: boolean): boolean {
  const ed = scene.editor;
  if (!ed || ed.tool === 'wind') return false;
  const w = scene.core.weather;
  if (ed.tool === 'storm') {
    const s = w.spawn(wx, wy);
    if (s) s.age = 5;
    return true;
  }
  if (ed.tool === 'duststorm') {
    w.placeDust(wx, wy);
    return true;
  }
  if (ed.tool === 'cyclone') {
    w.spawnCyclone(wx, wy, 1);
    return true;
  }
  if (ed.tool === 'place') {
    void placeModel(scene, wx, wy);
    return true;
  }
  // landforms: a stroke the world API raises as it goes (round 64)
  if (ed.tool === 'range' || ed.tool === 'mesa') {
    scene.core.snapshot();
    const api = worldApiOf(scene);
    // (round 128o: a mesa's level from the ground there — not read yet: the press waits a frame)
    const here = scene.heightAt(wx, wy);
    if (ed.tool === 'mesa' && here === null) {
      requestAnimationFrame(() => editTool(scene, wx, wy, tap));
      return true;
    }
    scene.raising = api.terrain!.raise(ed.tool, ed.tool === 'range' ? { radius: ed.radius, height: ed.radius * 2.6 } : { radius: ed.radius, level: here! + 10 });
    scene.raising.to(wx, wy);
    if (tap) {
      scene.raising.end();
      scene.raising = undefined;
    } else scene.brushAt = [wx, wy];
    return true;
  }
  // each press can be undone
  if (EDIT_OP[ed.tool]) scene.core.snapshot();
  scene.strokeStart = true;
  if (tap) brush(scene, wx, wy);
  else scene.brushAt = [wx, wy];
  return true;
}

/** Break tool: find the voxel under the cursor for the sphere outline (one pick in flight at a time). */
export function pickSmash(scene: LevelScene, sx: number, sy: number): void {
  if (scene.smashPicking) return;
  scene.smashPicking = true;
  const { core } = scene;
  const { camera } = core;
  core.renderer.pick((sx / camera.viewportW) * scene.renderW, (sy / camera.viewportH) * scene.renderH).then((hit) => {
    scene.smashPicking = false;
    scene.smashHover = hit ? [...cellPos(hit.cell % core.dims.w, Math.floor(hit.cell / core.dims.w)), hit.z] : undefined;
  }, ignoreTeardown);
}

/**
 * Sandbox smash (F7): knock a hole in whatever structure is under the
 * cursor — at the exact point picked, so a pylon's leg can be cut at its
 * foot — with a spray of chips. `press` starts an undo step.
 */
export function smashAt(scene: LevelScene, sx: number, sy: number, press: boolean): void {
  const ed = scene.editor!;
  const { core } = scene;
  const { camera } = core;
  if (press) core.snapshot();
  const rx = (sx / camera.viewportW) * scene.renderW;
  const ry = (sy / camera.viewportH) * scene.renderH;
  core.renderer.pick(rx, ry).then((hit) => {
    if (!hit) return;
    const [x, y] = cellPos(hit.cell % core.dims.w, Math.floor(hit.cell / core.dims.w));
    const at: [number, number, number] = [x, y, hit.z + 0.5];
    // physics (docs/PHYSICS.md): a ruin hit comes alive first, then a blast
    // where it hit — what's inside crumbles, what's near is thrown — and the
    // ground there is smashed as before
    // (round 88, the user: a concrete tower came down "through the old physics path after 15 taps" — the ruin
    // there woken into physics bodies, its foot pinned: the ground is cut as stone is, what it held falls as the
    // columns' own pieces; physics bodies already about are still blown about and broken by it)
    if (scene.physics) {
      const phys = scene.physics;
      const body = (hit.flags & 0x8000) !== 0;
      phys.blast(at, Math.max(1, ed.radius * 0.5), 6);
      if (!body) core.globals.events.push({ kind: EventKind.Edit, x, y, z: 12 * 32, radius: ed.radius, strength: hit.z });
      core.sim.particles.burst({ kind: PK.Chip, x, y, z: hit.z, count: 6 + ed.radius * 3, speed: 4, spread: ed.radius * 0.5 });
      return;
    }
    // a fallen body under the cursor: break it in its own frame (round 18)
    if (hit.flags & 0x8000) {
      scene.integrity?.breakBodies(at, ed.radius);
      return;
    }
    core.globals.events.push({ kind: EventKind.Edit, x, y, z: 12 * 32, radius: ed.radius, strength: hit.z });
    scene.integrity?.markDirty(x, y, ed.radius + 14);
    core.sim.particles.burst({ kind: PK.Chip, x, y, z: hit.z, count: 6 + ed.radius * 3, speed: 4, spread: ed.radius * 0.5 });
  }, ignoreTeardown);
}

/** Sandbox: outline the brush on the ground (follows the terrain); Break: the sphere it smashes, round the voxel picked. */
export function drawRing(scene: LevelScene): void {
  const ed = scene.editor;
  const ring = scene.ring;
  if (!ed || !ring) return;
  const { camera } = scene.core;
  const ring2 = scene.ring2!;
  if (ed.tool !== 'town' && scene.planAdd) {
    scene.planAdd.setAttribute('d', '');
    scene.planDel!.setAttribute('d', '');
  }
  if (ed.tool === 'town') {
    // the cell's outline at the floor of the block a press would add (or take)
    const b = scene.townHover;
    ring2.setAttribute('points', '');
    const t = editorTown(scene);
    const g = t.grid;
    drawPlan(scene, ring.parentElement as unknown as SVGSVGElement);
    ring.parentElement!.style.display = b || scene.planAdd?.getAttribute('d') || scene.planDel?.getAttribute('d') ? '' : 'none';
    if (!b) return ring.setAttribute('points', '');
    const zs = g.columns[b.cell].map((col) => scene.heightAt(...cellPos(col % scene.core.dims.w, Math.floor(col / scene.core.dims.w))));
    // (round 128o: the ground there not read yet: no outline this frame)
    if (Number.isNaN(t.base[b.cell]) && zs.some((z) => z === null)) return ring.setAttribute('points', '');
    const floor = Number.isNaN(t.base[b.cell]) ? Math.max(...(zs as number[])) : t.floorZ(b.cell, b.level);
    const pts: string[] = [];
    for (const z of [floor + 0.1, floor + LEVEL_H]) {
      for (let k = 0; k <= 4; k++) {
        const [x, y] = g.corner(b.cell, k);
        const [px, py] = camera.project(x, y, z);
        pts.push(`${px.toFixed(1)},${py.toFixed(1)}`);
      }
    }
    ring.setAttribute('points', pts.join(' '));
    return;
  }
  if (ed.tool === 'smash') {
    const c = scene.smashHover;
    ring.parentElement!.style.display = c ? '' : 'none';
    if (!c) return;
    // a sphere seen from any side is a circle: its outline, plus its
    // equator so it reads as a ball sitting in the world
    const [cx, cy] = camera.project(c[0], c[1], c[2]);
    const r = ed.radius * camera.zoom;
    const out: string[] = [];
    const eq: string[] = [];
    for (let k = 0; k <= 48; k++) {
      const a = (k / 48) * Math.PI * 2;
      out.push(`${(cx + Math.cos(a) * r).toFixed(1)},${(cy + Math.sin(a) * r).toFixed(1)}`);
      const [ex, ey] = camera.project(c[0] + Math.cos(a) * ed.radius, c[1] + Math.sin(a) * ed.radius, c[2]);
      eq.push(`${ex.toFixed(1)},${ey.toFixed(1)}`);
    }
    ring.setAttribute('points', out.join(' '));
    ring2.setAttribute('points', eq.join(' '));
    return;
  }
  ring2.setAttribute('points', '');
  const at = scene.brushAt ?? scene.hoverWorld;
  const on = !!at && (!!EDIT_OP[ed.tool] || ed.tool === 'place' || ed.tool === 'range' || ed.tool === 'mesa');
  ring.parentElement!.style.display = on ? '' : 'none';
  if (!on) return;
  const pts: string[] = [];
  if (ed.tool === 'place') {
    // the model's footprint where it would land
    const [fw, fd] = placeRect(scene, at[0], at[1]);
    const c: [number, number][] = [[fw[0], fd[0]], [fw[1], fd[0]], [fw[1], fd[1]], [fw[0], fd[1]], [fw[0], fd[0]]];
    for (const [x, y] of c) {
      const z = scene.heightAt(Math.min(x, fw[1] - 0.5), Math.min(y, fd[1] - 0.5));
      // (round 128o: the ground there not read yet: no outline this frame)
      if (z === null) return ring.setAttribute('points', '');
      const [sx, sy] = camera.project(x, y, z + 0.1);
      pts.push(`${sx.toFixed(1)},${sy.toFixed(1)}`);
    }
    ring.setAttribute('points', pts.join(' '));
    return;
  }
  for (let k = 0; k <= 48; k++) {
    const a = (k / 48) * Math.PI * 2;
    const x = at[0] + Math.cos(a) * ed.radius;
    const y = at[1] + Math.sin(a) * ed.radius;
    const z = scene.heightAt(x, y);
    // (round 128o: the ground there not read yet: no ring this frame)
    if (z === null) return ring.setAttribute('points', '');
    const [sx, sy] = camera.project(x, y, z + 0.1);
    pts.push(`${sx.toFixed(1)},${sy.toFixed(1)}`);
  }
  ring.setAttribute('points', pts.join(' '));
}

/** One frame of the brush: an EV_EDIT event for edit.wgsl. */
export function brush(scene: LevelScene, x: number, y: number): void {
  const ed = scene.editor!;
  if (scene.raising) return void scene.raising.to(x, y);
  const op = EDIT_OP[ed.tool];
  if (!op) return;
  const layered = LAYER_TOOLS.has(ed.tool);
  const z = op * 32 + ed.material + (scene.strokeStart ? 512 : 0);
  scene.strokeStart = false;
  scene.core.globals.events.push({ kind: EventKind.Edit, x, y, z, radius: ed.radius, strength: layered ? ed.layers : ed.strength });
  // (round 48 woke a ruin dug under into physics bodies; round 88: the dig's cut is judged as every cut is —
  // what it undercut falls as the columns' pieces, Integrity's tap)
}

/** Sandbox: put the world back as it was before the last brush press. */
export function undo(scene: LevelScene): void {
  scene.brushAt = undefined;
  scene.integrity?.clear();
  if (!scene.core.undo()) scene.hud.say('Nothing to undo.', 2);
}

/** How many columns within r of (x, y) have this top material (round 128o: the world API's terrain, its pages asked; a column not read yet doesn't count). */
export function countSurface(scene: LevelScene, x: number, y: number, r: number, mat: number): number {
  const { dims } = scene.core;
  const t = scene.worldApi?.terrain;
  let n = 0;
  for (let yy = Math.floor(y - r); yy <= y + r; yy++)
    for (let xx = Math.floor(x - r); xx <= x + r; xx++) {
      if (xx < 0 || yy < 0 || xx >= dims.w || yy >= dims.h || Math.hypot(xx - x, yy - y) > r) continue;
      if (t?.surfaceAt(...cellPos(xx, yy))?.mat === mat) n++;
    }
  return n;
}

/** CPU guess at whether a tapped spot is hostile ground (polluted or littered/trashed). */
export function hostileAt(scene: LevelScene, [x, y]: [number, number]): boolean {
  const { dims, map } = scene.core;
  const i = Math.floor(y) * dims.w + Math.floor(x);
  // (round 128o: the world API's terrain, its page asked; not read yet: no top material)
  const top = scene.worldApi?.terrain?.surfaceAt(...cellPos(Math.floor(x), Math.floor(y)))?.mat;
  return top === 12 || top === 18 || map.contam[i * 2] > 0.2;
}
