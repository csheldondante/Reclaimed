// The walkers' rules as numbers (agents.wgsl's constants, mirrored: keep them in step) — what the agents step, what the
// reach (shaders/fortreach.wgsl, fortress/reach.ts) and the town's ways (build/ways.ts) judge by. Pure.

/** the room a walker needs over a surface (m) */
export const AGENT_H = 1.5;
/** the highest rise a walker steps up (m) */
export const STEP = 1.1;
/** the deepest drop a walker steps down (m) */
export const DROP = 2.6;
/** water this deep over a surface is no way */
export const DEEP = 0.9;
/** the surfaces a column keeps */
export const NAV_K = 4;
