// (round 128n, phonefix; round 128o, DA-B1) The level's world API (api/world.ts), attached once. Its mirror reads by
// pages when a query asks (api/mirror.ts) — never on a timer: before, the first use of the API (the fortress's Build,
// its first painted cell, the cutaway) started 35 MB mapped every 250 ms. API: worldApiOf.
import { attachSim, type Sim } from '../../api/world';
import type { LevelScene } from '../level';

/** the level's world API: edits, effects, the units' terrain; its queries read pages on demand */
export function worldApiOf(scene: LevelScene): Sim {
  return (scene.worldApi ??= attachSim(scene.core));
}
