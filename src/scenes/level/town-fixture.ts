// (round 128m, townlab) The window round the start town as the lab's fixture (src/lab/townfixture.ts): read back once,
// by the capture script (scripts/labtown.mjs capture), never by the game. API: captureTownFixture(scene) → base64.
import { GEN_VERSION } from '../../world/region-record';
import { MAT } from '../../world/materials';
import { ROW_H } from '../../world/lattice';
import { encodeTownFixture } from '../../lab/townfixture';
import { siteToJson } from '../../build/site';
import type { LevelScene } from '../level';
import { urlFlags } from '../../flags';

export async function captureTownFixture(scene: LevelScene): Promise<string> {
  const S = scene.stream;
  const st = scene.settlements;
  const id = st?.pinnedId;
  if (!S || !st || !id) throw new Error('townFixture: the atlas level with ?town= and ?fortress=1');
  const rec = st.settlement(id);
  if (!rec) throw new Error(`townFixture: no settlement ${id}`);
  const { core } = scene;
  const { w, h, zMax } = core.dims;
  const map = await core.captureMap();
  // (round 128p: the towns' claims — External intervals, sim/external.ts — are runtime state, re-made from the site
  // when the lab loads it (build/claims.ts); left in, the old town stood in the land as solid air 7 m over the plan's
  // ground and buried what the lab drew there. The land the fixture keeps is the ground without them)
  for (const col of map.grid.cols) {
    const kept = col.filter((iv) => iv.mat !== MAT.External);
    if (kept.length !== col.length) col.splice(0, col.length, ...kept);
  }
  const rf = await core.readTexture(core.world.riverFlow);
  const [ox, oy] = S.origin;
  const bytes = await encodeTownFixture({
    header: {
      gen: GEN_VERSION,
      link: `?${urlFlags()}`,
      capturedAt: new Date().toISOString(),
      origin: [ox, oy],
      // (the record's place in window world units: the fortress's box lands where it does in the game)
      town: { id, name: rec.name, at: [rec.at[0] - ox, rec.at[1] - oy * ROW_H], spots: st.spotsOf(id) ?? [] },
      seaZ: core.globals.seaZ ?? -1e9,
      riverWet: core.globals.riverWet ?? 1,
      zMaxWindow: zMax,
      // (onetown: the town's site — its one plan — and the window's oz: the site's heights are world z)
      oz: S.oz,
      site: siteToJson(st.siteOf(id).toData()),
    },
    w,
    h,
    cols: map.grid.cols,
    water: map.water,
    vegetation: map.vegetation,
    waterSource: map.waterSource,
    riverFlow: rf.data,
  });
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
