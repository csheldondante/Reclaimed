// The sandbox's town tool: picking blocks of the editor's town, the plan outline, placing rectangles, and sending
// the build crew. API: editorTown(scene), townPick, townAtPick, sendBuilders, pickTown, drawPlan, placeRect.
import { ignoreTeardown } from '../../gpu/pipeline';
import { LEVEL_H, type Block, type Town } from '../../build/town';
import { modelById } from '../../world/models';
import type { LevelScene } from '../level';
import { worldApiOf } from './world-api';

/** The town (round 65): made on first use, its grid seeded by the map. */
export function editorTown(scene: LevelScene): Town {
  return worldApiOf(scene).town({ seed: 7 });
}

/** Town tool: the block a press there would add (or, shift held, take away). */
export function townPick(scene: LevelScene, sx: number, sy: number): Promise<Block | null> {
  const { core } = scene;
  const { camera } = core;
  const remove = scene.keys.has('shift');
  return core.renderer.pick((sx / camera.viewportW) * scene.renderW, (sy / camera.viewportH) * scene.renderH).then((hit) => {
    if (!hit) return null;
    return editorTown(scene).pickBlock(hit.cell, hit.z + 0.5, remove, !!scene.editor?.plan);
  });
}

/** Town tool: add the block a press lands on (Townscaper's way: town.pickBlock), or take it away with shift; in plan mode, plan it. */
export function townAtPick(scene: LevelScene, sx: number, sy: number): void {
  const remove = scene.keys.has('shift');
  const plan = !!scene.editor?.plan;
  townPick(scene, sx, sy).then((b) => {
    if (!b) return;
    if (plan) editorTown(scene).plan(b.cell, b.level, !remove);
    else if (remove) editorTown(scene).remove(b.cell, b.level);
    else editorTown(scene).add(b.cell, b.level);
    scene.townHover = undefined;
  }, ignoreTeardown);
}

/**
 * Town tool, plan mode: six workers to build the plan (agents/buildcrew.ts)
 * from the nearest pile of bricks or logs to the view's centre (lay one
 * with ▲ Build, brick). Groups 10-12 and fields 0-1 (a crew at a time).
 */
export function sendBuilders(scene: LevelScene): void {
  const api = worldApiOf(scene);
  const A = api.agents;
  const T = api.terrain;
  if (!A || !T) return;
  const { camera } = scene.core;
  const [tx, ty] = [camera.target[0], camera.target[1]];
  let pile: { x: number; y: number; n: number } | null = null;
  for (let r = 0; r <= 60 && !pile; r += 3) {
    for (let k = 0; k < Math.max(1, Math.round(r * 2)); k++) {
      const a = (k / Math.max(1, Math.round(r * 2))) * Math.PI * 2;
      const x = tx + Math.cos(a) * r;
      const y = ty + Math.sin(a) * r;
      const m = T.materialAt(x, y);
      if (m === 'brick' || m === 'log') {
        pile = { x, y, n: 1 };
        break;
      }
    }
  }
  if (!pile) {
    scene.hud.say('No pile of bricks or logs near: lay some with ▲ Build (brick) first.', 4);
    return;
  }
  scene.buildCrew?.stop();
  if (scene.builders) A.remove(scene.builders);
  scene.builders = A.spawn(6, pile.x + 2, pile.y + 2, { kind: 'worker', group: 10, spread: 0.8 });
  scene.buildCrew = api.buildCrew({ units: scene.builders, groups: [10, 11, 12], fields: [0, 1], town: editorTown(scene), pile: { x: pile.x, y: pile.y, radius: 2.5 }, materials: ['brick', 'log'] });
  scene.hud.say(`Six workers build the plan from the pile (${editorTown(scene).delta().length} blocks to do).`, 4);
  const tick = async () => {
    const crew = scene.buildCrew;
    if (!crew || scene.abort.signal.aborted) return;
    try {
      const { units } = await A.sync();
      if (scene.buildCrew === crew) crew.update(units);
    } catch (e) {
      ignoreTeardown(e);
      return;
    }
    requestAnimationFrame(() => void tick());
  };
  void tick();
}

/** Town tool: find the block under the cursor for the outline (one pick in flight at a time). */
export function pickTown(scene: LevelScene, sx: number, sy: number): void {
  if (scene.townPicking) return;
  scene.townPicking = true;
  townPick(scene, sx, sy).then(
    (b) => {
      scene.townPicking = false;
      scene.townHover = b ?? undefined;
    },
    (e) => {
      scene.townPicking = false;
      ignoreTeardown(e);
    },
  );
}

/** Town tool: the plan's difference from what stands, outlined — green to build, red to take down (the blocks a crew is on, brighter). */
export function drawPlan(scene: LevelScene, svg: SVGSVGElement): void {
  const mk = (cls: string) => {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('class', cls);
    svg.appendChild(p);
    return p;
  };
  scene.planAdd ??= mk('plan-add');
  scene.planDel ??= mk('plan-del');
  const t = editorTown(scene);
  const g = t.grid;
  const { camera } = scene.core;
  let add = '';
  let del = '';
  for (const d of t.delta()) {
    const z0 = t.floorZ(d.cell, d.level) + 0.05;
    const z1 = z0 + LEVEL_H;
    const lo: string[] = [];
    const hi: string[] = [];
    for (let k = 0; k < 4; k++) {
      const [x, y] = g.corner(d.cell, k);
      const a = camera.project(x, y, z0);
      const c = camera.project(x, y, z1);
      lo.push(`${a[0].toFixed(1)},${a[1].toFixed(1)}`);
      hi.push(`${c[0].toFixed(1)},${c[1].toFixed(1)}`);
    }
    let path = `M${lo.join('L')}ZM${hi.join('L')}Z`;
    for (let k = 0; k < 4; k++) path += `M${lo[k]}L${hi[k]}`;
    if (d.add) add += path;
    else del += path;
  }
  scene.planAdd.setAttribute('d', add);
  scene.planDel.setAttribute('d', del);
}

/** Sandbox place tool: the footprint [x0, x1], [y0, y1] centred on (wx, wy). */
export function placeRect(scene: LevelScene, wx: number, wy: number): [[number, number], [number, number]] {
  const ed = scene.editor!;
  const m = modelById(ed.model)!;
  const fw = ed.rot % 2 ? m.size[1] : m.size[0];
  const fd = ed.rot % 2 ? m.size[0] : m.size[1];
  const x0 = Math.round(wx - fw / 2);
  const y0 = Math.round(wy - fd / 2);
  return [[x0, x0 + fw], [y0, y0 + fd]];
}
