// The level's URL flags and constants (read once at load): test and comparison switches (?cutaway, ?planner,
// ?camclamp, ?flyspeed ...) and the sizes the level's modules share. Owns no state; touches nothing.
import { STRUCTURAL } from '../../physics/wake';
import { K_HEADROOM } from '../../world/layout';
import { MAT } from '../../world/materials';

/** (round 120) what a ruin wakes as besides its metal, where the metal wakes into the picked solver variant */
export const NON_METAL: ReadonlySet<number> = new Set([...STRUCTURAL].filter((m) => m !== MAT.Steel && m !== MAT.Rust));
/** round 83, V21: ?cutaway=1 — the camera on a puck (api/puck.ts), sliced under a roof and orbiting round a cliff */
export const CUTAWAY = new URLSearchParams(location.search).get('cutaway') === '1';
/** (round 113) ?planner=0: no planner — each layer's own fixed look-ahead, the sim's ticks never cut */
export const PLANNER_OFF = new URLSearchParams(location.search).get('planner') === '0';
/** (round 114, framepace) ?coarseparts=0: the coarse world's whole step on every 4th frame (as before), not a part a frame */
export const COARSE_PARTS = new URLSearchParams(location.search).get('coarseparts') !== '0';
/** (round 113, SF10) ?camclamp=1: the camera held a region in from the streamed window's edge (round 91), as before */
export const CAM_CLAMP = new URLSearchParams(location.search).get('camclamp') === '1';
export const PLAN_OFF = new Set((new URLSearchParams(location.search).get('planoff') ?? '').split(',').filter(Boolean));
/** (round 113, tilesfirst, SF7) ?arriveprep=0: land written into the window waits READY_TICKS sim ticks for the grid, as before */
export const ARRIVE_PREP = new URLSearchParams(location.search).get('arriveprep') !== '0';
/** (round 98) ?flyspeed=: the free camera's speed (cells a second; Shift 120) — on a phone, the speed ✈'s ⇧ flies at */
export const FLY_SPEED = Number(new URLSearchParams(location.search).get('flyspeed') ?? 35);

/** (round 128e, FT-50) how fast Skip to done runs time (the ticks a frame are the quality tier's times this), and how
 *  long (sim s) it lets the plan look blocked before it stops */
export const SKIP_SPEED = 32;
export const SKIP_GRACE = 4;
/** sandbox: column slots per chunk, so placed models and strata have room */
// (round 79: 16, the most a column holds — layers.wgsl MAX_K: the mesas' undercuts, lips, talus, bigger caves
// and alcoves had 344 columns merged to fit in 12 after a tier's slide)
/** (round 106) the four neighbours two columns off (heard: frogs by green) */
export const NEAR2: readonly [number, number][] = [[2, 0], [-2, 0], [0, 2], [0, -2]];
export const SANDBOX_K = 16;
/** the atlas's columns: what a sandbox chunk holds less its headroom (more and the chunk would grow: a streamed world's chunks are all one K) */
export const ATLAS_COL_K = SANDBOX_K - K_HEADROOM;
export const WARMUP_TICKS = 1800; // ~30 s of sim: rivers reach equilibrium before the player looks
