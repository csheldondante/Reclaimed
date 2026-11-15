// The physics engine into a WorldCore (docs/design/PHYSICS_ENGINE.md, build step 1; `?solver=engine`): its system in
// the sim's order right after the surface pass (the terrain test reads the column tops that pass derives, so it sees
// this tick's edits), and its rows' meshes — one mesh a body (render/bodymeshbuild.ts), placed on the GPU by the row's
// pose (render/bodymesh.ts): nothing about a row is read back or uploaded to draw it.
import type { WorldCore } from '../scenes/world-core';
import { Engine, type EngineBody, type EngineCell, type EngineModel, type V3 } from './engine';
import { modelMesh } from './modelmesh';

export interface EngineKit {
  engine: Engine;
  /** a model with its mesh, for bodies that share it (engine.add({ model })) */
  model(cells: readonly EngineCell[]): EngineModel;
  /** a body of these cells (storage column, row, cell z), as a rigid row with its mesh */
  drop(cells: readonly EngineCell[], vel?: V3, spin?: V3): EngineBody | null;
  /** every row and mesh let go */
  clear(): void;
}

/**
 * The host's edits reach the engine: a tick that sends the world an event (an edit, a blow) tells the engine something
 * may have changed under its rows (`Engine.kick`), so a quiet engine looks again. Whoever puts an engine in a sim
 * calls this (installEngine does; the tests' rigs and the bench do).
 */
export function kickOnEvents(sim: WorldCore['sim'], engine: Engine): void {
  sim.eventTaps.push((sent) => {
    if (sent.length) engine.kick();
  });
}

export function installEngine(core: WorldCore): EngineKit {
  const device = core.host.gpu.device;
  const engine = new Engine(device, core.world, core.host.profiler);
  const sys = core.sim.systems;
  const at = sys.findIndex((s) => s.name === 'surface');
  if (at < 0) throw new Error('installEngine: the sim has no surface system');
  sys.splice(at + 1, 0, engine);
  kickOnEvents(core.sim, engine);
  // (build step 2: one mesh a body in every state, listed and placed on the GPU — engine_draw.wgsl; the draw list and
  // its triangles are made again when they grow)
  let drawn = { out: engine.drawOut, args: engine.drawArgs };
  core.renderer.addMesh(drawn.out, drawn.args);
  engine.onBuffers = () => {
    if (drawn.out === engine.drawOut && drawn.args === engine.drawArgs) return;
    core.renderer.removeMesh(drawn.args);
    drawn = { out: engine.drawOut, args: engine.drawArgs };
    core.renderer.addMesh(drawn.out, drawn.args);
  };
  core.renderer.frameCompute.push((enc) => engine.skin(enc, core.renderAlpha()));
  return {
    engine,
    drop: (cells, vel, spin) => engine.add({ cells, mesh: modelMesh(cells), vel, spin }),
    model: (cells) => engine.addModel(cells, modelMesh(cells)),
    clear: () => engine.clear(),
  };
}
