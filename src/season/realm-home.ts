// (draft 8; card-table CT-53, moved here in loop round 10 so both front ends use one path) A run's home town across
// runs: what a town built is written on the town when a run there ends (`built:<card>` tags on its entity in the fact
// world), and a run that starts in another town makes the old home a far town and takes the new home's own list.
// The card table (table/game.ts) and the 3D loop (scenes/level/loop.ts) both call these; nothing else keeps a town's
// buildings between runs.
// FIXED-CITY (BACKLOG CT-53, CT-56 (2)): the ledger is one town's; other towns keep only this list — no pools, people
// or projects.
import type { EntityId } from '../api/contracts/facts';
import type { WorldSnapshot } from '../api/contracts/world';
import { MemoryWorldState } from '../api/contracts/world-state';
import { farHolder } from '../packs/load';
import { FactWorld } from '../living/world';

/** the tag prefix of what a town built (`built:<card>`, scope `condition`) */
export const BUILT = 'built:';

/** what a town's record says it built (its `built:<card>` tags) */
export function builtOn(w: FactWorld, town: EntityId): string[] {
  return (w.facts.entity(town)?.tags ?? []).filter((t) => t.scope === 'condition' && t.key.startsWith(BUILT) && t.value).map((t) => t.key.slice(BUILT.length));
}

/** a run there ended: what the town built written on it, for a run that comes back to it */
export function keepBuilt(w: FactWorld, town: EntityId, built: readonly string[]): void {
  for (const b of built) w.facts.setTag(town, 'condition', `${BUILT}${b}`, true, 'run-ended');
}

/**
 * A run that starts in another town than the last run's: the old home becomes a far town (still yours if nobody else
 * holds it, with its record and state; a `home-moved` record line), and the new home's buildings are what its record
 * says it built. Returns the world so changed and the new home's list.
 */
export function moveHome(world: WorldSnapshot, was: EntityId, home: EntityId): { world: WorldSnapshot; built: string[] } {
  const w = new FactWorld(MemoryWorldState.restore(structuredClone(world)));
  if (!farHolder(w, was)) w.facts.relate({ type: 'controls', from: 'player', to: was, cause: 'home-moved' });
  w.facts.record({ kind: 'home-moved', by: ['player'], to: [home, was], note: `the next leader rules from ${w.name(home)}; ${w.name(was)} is a far town now` });
  return { world: w.ws.snapshot(), built: builtOn(w, home) };
}

/** the town the world's last run was played from (its `run-began` record line), or null: no run yet */
export function lastHome(w: FactWorld): EntityId | null {
  const e = w.facts.events({ kind: 'run-began' }).at(-1);
  return e?.to[0] ?? null;
}
