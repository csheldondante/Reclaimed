// Terraces fixed (round 128p, DA-A13 step 2; DECISIONS round 128p: "We should definitely fix terraces. We also can allow
// building to lower or level terrain somewhat"). A structure with no door at grade (build/edgenet.ts: its floor more
// than a walker's step from the ground at every edge of its perimeter) gets one, at generation and on edits, by the
// user's order of preference:
//  1. level: its floor brought down (or up) to the ground at its best edge, within a storey (LEVEL_H) — the building
//     dug into the slope (its claims take the ground inside it: build/claims.ts) or set on a plinth;
//  2. past that bound: still its floor set to the door edge (the last resort; reported, so the shot shows where);
// stoop stairs (option 2 in the note) are not needed while 1 covers a storey: a stair taking more than the inset's metre
// would fill the path. Its best edge: the walkable one (not cut) whose ground is nearest its floor. Pure: the plan's
// structures' floors and the Town's cells' floors change; nothing else.
import { LEVEL_H } from './town';
import type { TownPlan } from './plan';
import type { EdgeNet } from './edgenet';
import { STEP } from '../agents/rules';

export interface TerraceSite {
  plan: TownPlan;
  grid: { verts: ArrayLike<number> };
  town: { base: Float32Array };
}

export interface TerraceFix {
  id: number;
  /** what it did: level (within a storey) or dug (past it); the floor moved by (m, + up) */
  how: 'level' | 'dug';
  dz: number;
}

/** Each structure with no door at grade levelled to its best edge (in place); what was done. */
export function fixTerraces(site: TerraceSite, net: EdgeNet, ground: (x: number, y: number) => number): TerraceFix[] {
  const { plan, grid, town } = site;
  const out: TerraceFix[] = [];
  const P = (v: number): [number, number] => [grid.verts[v * 2], grid.verts[v * 2 + 1]];
  for (const [id, doors] of net.doors) {
    if (doors.length) continue;
    const st = plan.structure(id);
    if (!st) continue;
    const form = plan.defs[st.type].form;
    if (form !== 'block' && form !== 'keep') continue;
    const cells = [...st.cells.keys()];
    const floor = Math.max(...cells.map((c) => town.base[c]).filter(Number.isFinite));
    if (!Number.isFinite(floor)) continue;
    // its walkable perimeter edges' ground: the one nearest its floor
    let best = NaN;
    for (const c of cells)
      for (let s = 0; s < 4; s++) {
        const e = net.edgeOf[c * 4 + s];
        if (net.inner[e] || net.cut[e]) continue;
        const a = P(net.ends[e * 2]);
        const b = P(net.ends[e * 2 + 1]);
        const g = (ground(a[0], a[1]) + ground(b[0], b[1])) / 2;
        if (Number.isNaN(best) || Math.abs(g - floor) < Math.abs(best - floor)) best = g;
      }
    if (Number.isNaN(best)) continue;
    // (a step under the edge's ground at most: the door sits at grade)
    const target = best + Math.min(STEP / 2, Math.max(0, floor - best));
    const dz = target - floor;
    for (const c of cells) town.base[c] = target;
    st.floor = target;
    out.push({ id, how: Math.abs(dz) <= LEVEL_H ? 'level' : 'dug', dz });
  }
  return out;
}
