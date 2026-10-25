// Agents in a world (round 52, docs/AGENTS.md): one call, as installPhysics.

import type { WorldCore } from '../scenes/world-core';
import { Agents } from './agents';

/** Add the agents layer to `core`: its system after the particles, its units drawn as voxels. */
export function installAgents(core: WorldCore): Agents {
  const { host, sim, renderer } = core;
  const agents = new Agents(host.gpu.device, core.world, host.profiler, host.quality.agentSweeps ?? 8);
  sim.systems.splice(sim.systems.indexOf(sim.particles) + 1, 0, agents);
  renderer.addVoxels(agents.inst, agents.indirect);
  // (round 80: a streamed window's slide moves its fields and its units)
  core.columnBufs.push(...agents.columnBuffers());
  core.onShift.push((dx, dy, dz) => agents.shift(dx, dy, dz));
  return agents;
}
