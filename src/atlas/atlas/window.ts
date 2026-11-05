// The first window made from the atlas: its map data, height offset, what's outside and the ground. API: window
// (Atlas.window).
import { ColumnGrid, fitColumn, splitColumn, waterInWindow, type Interval, type WorldDims } from '../../world/layout';
import type { MapData } from '../../world/mapgen';
import type { Atlas } from '../atlas';

/** Atlas.window (the class keeps the method, documented there) */
export async function window(atl: Atlas, dims: WorldDims, ox: number, oy: number, K: number, tier: number, floor = 8): Promise<{ map: MapData; oz: number; outside: Interval[][]; ground: Float32Array }> {
  const { w, h, zMax } = dims;
  const N = w * h;
  // (in tiles of a region, as the streamer asks: one batch of the whole window is too much
  // work for one dispatch where forms stand thick — the GPU's watchdog resets the device)
  const T = 64;
  if (w % T || h % T) throw new Error(`the window (${w} × ${h}) must be whole tiles of ${T}`);
  const tiles: [number, number][] = [];
  for (let ty = 0; ty < h; ty += T) for (let tx = 0; tx < w; tx += T) tiles.push([tx, ty]);
  const lands = await Promise.all(tiles.map(([tx, ty]) => atl.regionLand(ox + tx, oy + ty, T, T)));
  // the window's oz: the tier holding the most of the ground's tops (`floor` over its bottom, 24
  // under its top), the ground at its middle in it
  const mx = w >> 1;
  const my = h >> 1;
  const mid = lands[tiles.findIndex(([tx, ty]) => tx === Math.floor(mx / T) * T && ty === Math.floor(my / T) * T)];
  // (the ground's own top, not what stands on it: a giant's point isn't where the land is)
  const gMid = mid.ground![(my % T) * T + (mx % T)];
  let oz = 0;
  let most = -1;
  for (let c = 0; c + zMax <= atl.p.zTop + tier; c += tier) {
    if (gMid < c + 8 || gMid > c + zMax - 40) continue;
    let n = 0;
    for (const t of lands) for (let i = 0; i < T * T; i += 7) if (t.ground![i] >= c + floor && t.ground![i] <= c + zMax - 24) n++;
    if (n > most) {
      most = n;
      oz = c;
    }
  }
  const outside: Interval[][] = new Array(N);
  const ground = new Float32Array(N);
  const grid = new ColumnGrid(dims);
  const land = { water: new Float32Array(N), moisture: new Float32Array(N), vegetation: new Float32Array(N), contam: new Float32Array(N * 2), lava: new Float32Array(N * 4), lavaSpring: new Float32Array(N), waterSource: new Float32Array(N), riverFlow: new Float32Array(N * 4), surface: new Float32Array(N), structural: new Uint8Array(N) };
  tiles.forEach(([tx, ty], k) => {
    const t = lands[k];
    for (let y = 0; y < T; y++)
      for (let x = 0; x < T; x++) {
        const i = y * T + x;
        const j = (ty + y) * w + tx + x;
        const cut = splitColumn(t.cols[i], oz, zMax);
        if (fitColumn(cut.inside, K)) atl.gapsFilled++;
        grid.cols[j] = cut.inside;
        outside[j] = cut.outside;
        const top = cut.inside.length > 0 && !cut.outside.some((iv) => iv.z0 >= oz + zMax - 1e-4);
        // (round 88: over the floor where the ground is under it — the sea's — layout.ts waterInWindow)
        const tc = t.cols[i];
        land.water[j] = waterInWindow(cut, oz, zMax, tc[tc.length - 1].z1 + t.water[i]);
        land.moisture[j] = t.moisture[i];
        land.vegetation[j] = t.vegetation[i];
        land.surface[j] = cut.inside.length ? cut.inside[cut.inside.length - 1].z1 : 0;
        ground[j] = (t.ground ? t.ground[i] : land.surface[j] + oz) - oz;
        land.contam[j * 2] = t.contam[i * 2];
        land.contam[j * 2 + 1] = t.contam[i * 2 + 1];
        if (t.lava && top && t.lava[i * 4] > 0) land.lava.set([t.lava[i * 4], t.lava[i * 4 + 1], t.lava[i * 4 + 2], t.lava[i * 4 + 3] - oz], j * 4);
        if (t.lavaSpring) land.lavaSpring[j] = t.lavaSpring[i];
        if (t.structural) land.structural[j] = t.structural[i];
        if (t.waterSource && top) land.waterSource[j] = t.waterSource[i];
        if (t.riverFlow && top) land.riverFlow.set(t.riverFlow.subarray(i * 4, i * 4 + 4), j * 4);
      }
  });
  const map: MapData = {
    grid,
    water: land.water,
    contam: land.contam,
    moisture: land.moisture,
    vegetation: land.vegetation,
    oil: new Float32Array(N),
    drift: new Float32Array(N),
    oilStored: new Float32Array(N * 2),
    waterSource: land.waterSource,
    riverFlow: land.riverFlow,
    lava: land.lava,
    lavaSpring: land.lavaSpring,
    structural: land.structural,
    surface: land.surface,
    poi: Object.fromEntries(['healthy', 'tutorial', 'dam', 'reservoir', 'site', 'landfill', 'heap'].map((k) => [k, [w / 2, h / 2]])) as Record<string, [number, number]>,
  };
  return { map, oz, outside, ground };
}
