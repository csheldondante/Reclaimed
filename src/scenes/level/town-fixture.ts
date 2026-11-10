// (round 128m, townlab) The window round a site as a street-lab fixture (src/lab/townfixture.ts): read back once, by the
// capture script (scripts/labtown.mjs site), never by the game. API: captureTownFixture(scene, site) → base64.
import { GEN_VERSION } from '../../world/region-record';
import { ROW_H } from '../../world/lattice';
import { encodeTownFixture } from '../../lab/townfixture';
import type { LevelScene } from '../level';
import { urlFlags } from '../../flags';
import { MAT } from '../../world/materials';

export async function captureTownFixture(scene: LevelScene, siteName: string, centre?: [number, number]): Promise<string> {
  const S = scene.stream;
  const { core } = scene;
  const { w, h, zMax } = core.dims;
  // (street lab sites: a bare window of atlas land — its middle stands for the town's place. Switchover: the old town's
  // own capture, its site and spots for the behaviour lab's `town` recipe, is gone with the old towns)
  if (!S) throw new Error('siteFixture: the atlas level');
  return encodeBase64(await encodeTownFixture({
    header: {
      gen: GEN_VERSION,
      link: `?${urlFlags()}`,
      capturedAt: new Date().toISOString(),
      origin: [S.origin[0], S.origin[1]],
      town: { id: '', name: siteName, at: centre ?? [(w + 0.5) / 2, (h * ROW_H) / 2] },
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
  // (bare land: no woods — the street lab's layout reads without trees in the way)
  return { cols, water: map.water, vegetation: new Float32Array(map.vegetation.length), waterSource: map.waterSource, riverFlow: rf.data };
}

function encodeBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
