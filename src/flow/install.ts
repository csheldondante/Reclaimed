// The flow model in a world (?flow=1, docs/ARCHITECTURE.md "The flow model"): one call, as installPhysics. Water's system is replaced by
// the liquid runs (water publishes the same contract), lava runs alongside as the same kernels with lava's
// numbers, and the steady state decides what sleeps (the world needs a Sleep: the level makes one).

import type { WorldCore } from '../scenes/world-core';
import type { Sleep } from '../sim/sleep';
import type { SimSystem } from '../sim/system';
import { LAVA, LiquidSystem, WATER } from './liquid';
import { Steady, WAKE_TOL } from './steady';

export interface FlowKit {
  water: LiquidSystem;
  lava: LiquidSystem;
  steady: Steady;
}

export function installFlow(core: WorldCore, sleep: Sleep): FlowKit {
  const { host, sim, renderer, world } = core;
  const device = host.gpu.device;
  const chunks = (world.w / core.globals.chunkSize) * (world.h / core.globals.chunkSize);
  const steady = new Steady(device, world, sleep, chunks);
  const water = new LiquidSystem(device, world, host.profiler, WATER, steady.act, WAKE_TOL);
  const lava = new LiquidSystem(device, world, host.profiler, LAVA, steady.act, WAKE_TOL);
  const at = sim.systems.findIndex((s) => s.name === 'water');
  if (at < 0) throw new Error('installFlow: no water system to replace');
  sim.systems.splice(at, 1, water, lava);
  // (everything with liquid frozen: no simulation passes, only the draw lists made from the frozen state)
  water.skip = lava.skip = () => sleep.awake === 0 && core.globals.sleep !== undefined;
  steady.onRescale = (k, r) => {
    water.rescale.set(k, r);
    lava.rescale.set(k, r);
  };
  const steadySys: SimSystem & { afterSubmit(): void } = {
    name: 'flow-steady',
    period: 1,
    encode: (enc) => steady.encode(enc),
    afterSubmit: () => steady.afterSubmit(),
  };
  sim.systems.push(steadySys);
  renderer.addWaterPrisms(water.inst, water.indirect);
  renderer.addWaterPrisms(lava.inst, lava.indirect);
  renderer.addPrisms(lava.instO, lava.indirectO);
  // (an event's chunks awake a moment; the steady state keeps them so while they flow unsteadily)
  sleep.eventSecs = 1.5;
  return { water, lava, steady };
}
