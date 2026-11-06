// Integrity's flags, budgets and impact tuning (METAL, PASS, READ_NEAR, IMP ...), the Grab type, and the small
// helpers its modules share (cellsToRuns, mainMat). Owns no state.
import { type Interval } from '../../world/layout';
import { MAT } from '../../world/materials';
import { type Voxel } from '../fracture';
import { type ColPiece } from '../colbodies';
import { type RockBody } from '../rockbodies';
import { TUNE } from '../../tune/params';
import type { PhysBody } from '../../physics/physics';
import type { SolverBody } from '../../api/contracts/solver';

/** (round 96) what bends: metal — and (solver step 2, but for the baseline variant) wood — goes to a deformable body (the node solver's or the voxel lattice's, by the variant), the rest of what falls stays rigid */
export const METAL: ReadonlySet<number> = new Set<number>([MAT.Steel, MAT.Rust]);
export const WOOD: ReadonlySet<number> = new Set<number>([MAT.Wood, MAT.Log]);
/** (round 96) cells of metal woken at once at most (wake.ts WAKE_MAX) */
export const METAL_MAX = 6000;
/** (round 120) a body held by the drag tool (Integrity.grabAt) */
export type Grab = { kind: 'rigid'; b: RockBody } | { kind: 'solver'; body: SolverBody } | { kind: 'phys'; body: PhysBody };

/** (round 120) a hit harder than this (cells/s) wakes the map's metal it struck (wakeMetalNear) */
export const WAKE_HIT = 3;

export const PASS = 0.35; // s between analyses while anything is dirty or moving
/** (round 100, hitchrec) the structures' boxes a pass judges until it has taken this long (ms); the rest wait for the next */
export const PASS_BUDGET = 8;
/** (round 99, meshinst; round 110: the tuning's rigid.restMax) resting rock kept as meshes at once (their slots are the rock mesh's: render/rockmesh.ts) */
/** (round 100) the streamer's region (scenes/streamer.ts REGION: not imported — the scene imports this) */
export const REGION_CELLS = 64;
/** (round 99) cells under a resting rock's cells, down to the ground, claimed with it (what it stands on) */
export const REST_FILL = 3;

/**
 * (round 86) A falling piece's columns written (and its chunks meshed again) every Nth frame: 2 on the phone's
 * tier (no `q` or q=low), 1 otherwise; `?fallevery=N`. A 46-column piece's chunks rebuilt every frame cost the
 * desktop's iGPU ~1.4 ms a frame of mesh passes; at 4 cells/s, every other frame is a step of 0.13 cells.
 */
export const FALL_EVERY = (() => {
  if (typeof location === 'undefined') return 1;
  const q = new URLSearchParams(location.search);
  const n = q.get('fallevery');
  if (n) return Math.max(1, Number(n));
  return (q.get('q') ?? 'low') === 'low' ? 2 : 1;
})();

/**
 * (perfopt, round 83 audit: ?intread=near) A pass reads back only the layers' chunks it looks at — round the dirty
 * boxes (4 cells), the cut columns (24: the rock hanging from them), the bodies (4) — into a CPU copy of all of
 * them, not all 16 MB of the atlas's window every 0.35 s while anything is dirty (riding: every region come in) or
 * every 1 s while bodies exist. After a slide (the window's epoch) the next read is whole again.
 * (round 86: the default — `?intread=all` reads it all, as before)
 */
export const READ_NEAR = typeof location === 'undefined' || new URLSearchParams(location.search).get('intread') !== 'all';

/**
 * (round 120, JB6 — measuring only) `?jb6=0`: the CPU copy kept and read before every pass whatever the judge and the
 * solver, as before JB6, so the phone bench can toggle what JB6 took away. The default keeps it only where a CPU
 * consumer walks it (Integrity.keepsCopy).
 */
export const JB6_KEEP = typeof location !== 'undefined' && new URLSearchParams(location.search).get('jb6') === '0';

/** (round 120, JB6) a dust cloud's material: the ground's own where it rises (particles.wgsl looks it up) */
export const GROUND_DUST = -1;

// Impacts (round 21: "crumble much more easily, break up more; impacts make
// dust"): a body that hits something at IMPACT_BREAK cells/s or more
// shatters into about weakness · speed² · voxels / SHATTER pieces (the small
// ones near the point hit), then loses the voxels within a radius growing
// with the speed around that point (to loose ground, with dust and chips);
// pieces of up to IMPACT_CRUMB voxels crumble too. Metal breaks far less than
// stone. Softer hits only puff dust.
// (round 108: the tuning's `impact` — breakSpeed (was IMPACT_BREAK, cells/s), shatter (SHATTER), crumb (IMPACT_CRUMB, voxels))
export const IMP = TUNE.impact;
export const impactRadius = (speed: number) => Math.min(2.5, 0.5 + 0.3 * speed);
export const impactReach = (m: number) => (m === MAT.Steel || m === MAT.Rust ? 0.4 : m === MAT.Wood ? 0.7 : 1);


/** (round 86) a structure's cells as runs, column by column (touching cells of a material one run) */
export function cellsToRuns(cells: Voxel[]): ColPiece[] {
  const by = new Map<number, Voxel[]>();
  for (const c of cells) {
    const k = c.y * 65536 + c.x;
    const l = by.get(k);
    if (l) l.push(c);
    else by.set(k, [c]);
  }
  const out: ColPiece[] = [];
  for (const l of by.values()) {
    l.sort((a, b) => a.z - b.z);
    const ivs: Interval[] = [];
    for (const c of l) {
      const last = ivs[ivs.length - 1];
      if (last && last.z1 === c.z && last.mat === c.mat) last.z1 = c.z + 1;
      else ivs.push({ z0: c.z, z1: c.z + 1, mat: c.mat });
    }
    out.push({ x: l[0].x, y: l[0].y, ivs });
  }
  return out;
}

/** The commonest material among some voxels. */
export function mainMat(vox: { mat: number }[]): number {
  const n = new Map<number, number>();
  let best = 0;
  let most = 0;
  for (const v of vox) {
    const c = (n.get(v.mat) ?? 0) + 1;
    n.set(v.mat, c);
    if (c > most) [best, most] = [v.mat, c];
  }
  return best;
}
