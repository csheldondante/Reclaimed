// Rapier (round 24, BACKLOG Q5): the rigid-body solver the falling pieces
// move with. Loaded on demand (the sandbox is the only scene with pieces);
// the WASM ships inlined in the -compat build.

import type * as RapierNS from '@dimforge/rapier3d-compat';

export type Rapier = typeof RapierNS;

let rapier: Rapier | null = null;

/** Load and initialise Rapier once (awaited before a scene with pieces starts). */
export async function initPhysics(): Promise<Rapier> {
  if (rapier) return rapier;
  const R = await import('@dimforge/rapier3d-compat');
  await R.init();
  rapier = R;
  return R;
}

/** The loaded module (initPhysics must have finished). */
export function physics(): Rapier {
  if (!rapier) throw new Error('Rapier used before initPhysics()');
  return rapier;
}
