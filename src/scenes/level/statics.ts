// The static grids' claims on the level (sim/static-claims.ts): the GPU towns' buildings and walls claimed in the
// columns, written with the land as the streamer brings it in. API: staticsFor(scene). (Switchover: moved here from
// scenes/level/fortress.ts, deleted with fortress mode.)
import { StaticClaims } from '../../sim/static-claims';
import type { LevelScene } from '../level';

/**
 * (round 128j, claims at load) The static grids' claims: made on first use, with the streamed window and the External
 * registry — the streamer's write of arriving land claims every grid's columns there. Null: no streamed window or no
 * registry (yet).
 */
export function staticsFor(scene: LevelScene): StaticClaims | null {
  if (scene.statics) return scene.statics;
  const S = scene.stream;
  const ext = scene.integrity?.external;
  if (!S || !ext) return null;
  const core = scene.core;
  const st = new StaticClaims({
    device: scene.host.gpu.device,
    apply: () => core.columnApply,
    columns: () => core.columnsGpu(),
    registry: () => scene.integrity?.external ?? null,
    dims: { w: core.dims.w, h: core.dims.h },
    R: S.R,
    unwritten: () => S.unwritten,
    held: () => S.columnsHeld,
    touched: (x0, y0, x1, y1) => scene.hybrid?.edit((x0 + x1) / 2, (y0 + y1) / 2, Math.max(x1 - x0, y1 - y0) / 2),
  });
  ext.statics = st;
  S.onWritten.push((lx, ly, w, h) => st.landWritten(lx, ly, w, h));
  scene.statics = st;
  return st;
}
