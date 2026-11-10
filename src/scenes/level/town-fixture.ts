// (round 128m, townlab) The window round the start town as the lab's fixture (src/lab/townfixture.ts): read back once,
// by the capture script (scripts/labtown.mjs capture), never by the game. API: captureTownFixture(scene) → base64.
import { GEN_VERSION } from '../../world/region-record';
import { ROW_H } from '../../world/lattice';
import { encodeTownFixture } from '../../lab/townfixture';
import { siteToJson } from '../../build/site';
import type { LevelScene } from '../level';
import { urlFlags } from '../../flags';
import { MAT } from '../../world/materials';

export async function captureTownFixture(scene: LevelScene, siteName?: string): Promise<string> {
  const S = scene.stream;
  const st = scene.settlements;
  const id = st?.pinnedId;
  const { core } = scene;
  const { w, h, zMax } = core.dims;
  // (street lab sites: a bare window of atlas land, no town pinned — its middle stands for the town's place)
  if (siteName !== undefined) {
    if (!S) throw new Error('siteFixture: the atlas level');
    return encodeBase64(await encodeTownFixture({
      header: {
        gen: GEN_VERSION,
        link: `?${urlFlags()}`,
        capturedAt: new Date().toISOString(),
        origin: [S.origin[0], S.origin[1]],
        town: { id: '', name: siteName, at: [(w + 0.5) / 2, (h * ROW_H) / 2], spots: [] },
        seaZ: core.globals.seaZ ?? -1e9,
        riverWet: core.globals.riverWet ?? 1,
        zMaxWindow: zMax,
        oz: S.oz,
      },
      w,
      h,
      ...(await windowData(scene)),
    }));
  }
  if (!S || !st || !id) throw new Error('townFixture: the atlas level with ?town= and ?fortress=1');
  const rec = st.settlement(id);
  if (!rec) throw new Error(`townFixture: no settlement ${id}`);
  const map = await core.captureMap();
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
  return encodeBase64(bytes);
}

/** a site's column keeps its top intervals up to this; the rest under them merged into one of stone (a mountain's
 *  strata overflow a chunk's MAX_K slots when loaded: the streets read only the top) */
const SITE_KEEP = 10;

async function windowData(scene: LevelScene) {
  const map = await scene.core.captureMap();
  const rf = await scene.core.readTexture(scene.core.world.riverFlow);
  const cols = map.grid.cols.map((col) => {
    if (col.length <= SITE_KEEP) return col;
    const cut = col.length - (SITE_KEEP - 1);
    return [{ z0: col[0].z0, z1: col[cut - 1].z1, mat: MAT.Stone, aux: 0 }, ...col.slice(cut)];
  });
  return { cols, water: map.water, vegetation: map.vegetation, waterSource: map.waterSource, riverFlow: rf.data };
}

function encodeBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
