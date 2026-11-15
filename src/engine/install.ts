// The physics engine into a WorldCore (docs/design/PHYSICS_ENGINE.md, build step 1; `?solver=engine`): its system in
// the sim's order right after the surface pass (the terrain test reads the column tops that pass derives, so it sees
// this tick's edits), and its rows' meshes — one mesh a body (render/bodymeshbuild.ts), placed on the GPU by the row's
// pose (render/bodymesh.ts): nothing about a row is read back or uploaded to draw it.
import { BodyMeshes } from '../render/bodymesh';
import { buildBodyMesh } from '../render/bodymeshbuild';
import type { WorldCore } from '../scenes/world-core';
import { Engine, type EngineBody, type EngineCell, type V3 } from './engine';

export interface EngineKit {
  engine: Engine;
  meshes: BodyMeshes;
  /** a body of these cells (storage column, row, cell z), as a rigid row with its mesh */
  drop(cells: readonly EngineCell[], vel?: V3, spin?: V3): EngineBody | null;
  /** every row and mesh let go */
  clear(): void;
}

export function installEngine(core: WorldCore): EngineKit {
  const device = core.host.gpu.device;
  const engine = new Engine(device, core.world, core.host.profiler);
  const sys = core.sim.systems;
  const at = sys.findIndex((s) => s.name === 'surface');
  if (at < 0) throw new Error('installEngine: the sim has no surface system');
  sys.splice(at + 1, 0, engine);
  const meshes = new BodyMeshes(device, core.world, core.host.profiler);
  meshes.setRows(engine.pose);
  engine.onBuffers = () => meshes.setRows(engine.pose);
  core.renderer.addMesh(meshes.out, meshes.args);
  meshes.onBuffers = () => {
    core.renderer.removeMesh(meshes.args);
    core.renderer.addMesh(meshes.out, meshes.args);
  };
  core.renderer.frameCompute.push((enc) => meshes.encode(enc, core.renderAlpha()));
  return {
    engine,
    meshes,
    drop: (cells, vel, spin) => {
      const b = engine.add({ cells, vel, spin });
      if (b) meshes.add(buildBodyMesh(cells), { kind: 'row', row: b.row, com: b.restCom });
      return b;
    },
    clear: () => {
      engine.clear();
      meshes.clear();
    },
  };
}
