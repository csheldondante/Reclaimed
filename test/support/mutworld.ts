// A small fact world for the mutators' tests: two factions, the settlements given (Settlement.at in world units), each
// an entity on its owner's id — what MemoryWorldState.restore makes of the atlas's wiki snapshot.
import { MemoryWorldState } from '../../src/api/contracts/world-state';
import type { Settlement } from '../../src/api/contracts/settlement';
import { FactWorld } from '../../src/living/world';

export function mutWorld(places: { id: string; name: string; at: readonly [number, number]; radius: number; size: string; faction?: string | null }[]): FactWorld {
  const fac = (id: string, name: string) => ({ id, name, ethos: '', era: 'medieval' as const, relations: {}, attitude: 0 });
  const ws = new MemoryWorldState(1, [{ id: 0, name: 'The Vale', kind: 'valley' }], [fac('locals', 'the Locals'), fac('iron-league', 'the Iron League')] as unknown as ConstructorParameters<typeof MemoryWorldState>[2]);
  for (const p of places) ws.settlements.push({ id: p.id, name: p.name, region: 0, faction: p.faction ?? null, at: [p.at[0], p.at[1]], radius: p.radius, size: p.size as Settlement['size'], condition: 'thriving', grids: [], buildings: [], people: [], stores: {}, needs: [] });
  const w = new FactWorld(ws);
  const f = w.facts;
  f.add({ id: 'locals', kind: 'faction', name: 'the Locals', ref: { faction: 'locals' } });
  f.add({ id: 'iron-league', kind: 'faction', name: 'the Iron League', ref: { faction: 'iron-league' } });
  f.add({ id: 'player', kind: 'person', name: 'the player' });
  for (const p of places) f.add({ id: p.id, kind: 'settlement', name: p.name, ref: { settlement: p.id }, at: { region: 0 } });
  f.drainChanged();
  return w;
}
