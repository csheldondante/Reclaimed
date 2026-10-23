// Physics in a world (round 49: the level and games built on Reclaimed do it
// the same way; docs/PHYSICS.md "For games"). One call puts the solver, lava
// and waking into a WorldCore: the systems in their order, their draws on the
// renderer, the map's ruins woken where bodies touch them.

import type { WorldCore } from '../scenes/world-core';
import { LavaSystem } from '../sim/lava';
import { cellPos } from '../world/lattice';
import { Physics } from './physics';
import { Waker } from './wake';

export interface PhysicsKit {
  physics: Physics;
  lava: LavaSystem;
  waker: Waker;
}

/**
 * Add physics bodies and lava to `core`: the solver before the particles
 * (they carry its chips and dust), lava before the solver (bodies feel this
 * tick's lava), their voxels, meshes and lava drawn, and a structure a body
 * runs into woken (radius 1.5; `wakeOnTouch: false` leaves that to the game).
 */
export function installPhysics(core: WorldCore, opts: { wakeOnTouch?: boolean } = {}): PhysicsKit {
  const { host, sim, renderer, dims } = core;
  const physics = new Physics(host.gpu.device, core.world, host.profiler);
  sim.systems.splice(sim.systems.indexOf(sim.particles), 0, physics);
  renderer.addVoxels(physics.inst, physics.indirect);
  renderer.addMesh(physics.skinOut, physics.skinArgs);
  const lava = new LavaSystem(host.gpu.device, core.world, host.profiler);
  sim.systems.splice(sim.systems.indexOf(physics), 0, lava);
  renderer.addPrisms(lava.inst, lava.indirect);
  const waker = new Waker(core, physics);
  if (opts.wakeOnTouch ?? true) {
    physics.onTouch = (cols) => {
      for (const c of cols) {
        const [x, y] = cellPos(c % dims.w, Math.floor(c / dims.w));
        void waker.wake(x, y, -1, 1.5);
      }
    };
  }
  return { physics, lava, waker };
}
