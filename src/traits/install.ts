// The trait system on a world's agents (LW1): one call, as installAgents — its system ticked just before the agents'.
// The game then registers its rules (src/game/traits/modules.ts registerSlice) — the engine ships none.

import type { Agents } from '../agents/agents';
import type { WorldCore } from '../scenes/world-core';
import { TraitSystem, type TraitSystemOpts } from './system';

export function installTraits(core: WorldCore, agents: Agents, opts: TraitSystemOpts = {}): TraitSystem {
  const t = new TraitSystem(core.host.gpu.device, core.world, agents, core.globals, opts);
  // (its tick before the agents': the effects of the tick ready for their stage)
  const sys = core.sim.systems;
  const at = sys.indexOf(agents);
  if (at < 0) throw new Error('installTraits: the agents are not in this world (installAgents first)');
  sys.splice(at, 0, t);
  // (a streamed window's slide: the effects with the land)
  core.onShift.push((dx, dy) => t.shift(dx, dy));
  // (?traits=0: the stage off — its cost on the phone measured by toggling it, round 120)
  if (core.host.params.get('traits') === '0') t.enabled = false;
  return t;
}
