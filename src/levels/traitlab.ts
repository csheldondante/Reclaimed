// The traits lab (?level=traitlab, or "The Traits Lab" on the title screen; merge123): the trait system's station (LW1) on a plain of its own. On the traits
// branch it sat on the playground's back row (x 128..256, rows 192..256); merge121's node-solver stations (slide, house,
// metal) took that row, so it moved here rather than squeeze or overlap them. The station's crowd, lich, sanctuary and
// buttons are levels/traitstation.ts; scenes/level.ts gives a level with a 'traits' station its driver.

import { ColumnGrid, type WorldDims } from '../world/layout';
import { MAT } from '../world/materials';
import type { MapData } from '../world/mapgen';
import { stationMiddle, type Station, type StationKit } from './playground';
import type { TraitStationDriver } from './traitstation';

const PLAIN = 10;

/** (LW1) the traits station's driver, or a clear error */
const tk = (k: StationKit): TraitStationDriver => {
  if (!k.traits) throw new Error('the traits station needs the trait system on the agents (scenes/level.ts installTraits)');
  return k.traits;
};

const RECT: [number, number, number, number] = [96, 96, 192, 160];
const MID = stationMiddle({ rect: RECT } as Station);

export const TRAITLAB_STATIONS: Station[] = [
  {
    id: 'traits',
    name: 'traits',
    rect: RECT,
    look: [MID[0] - 2, MID[1], 11, 9],
    hint: 'traits: the living and the walking dead; a lich raises the fallen; a sanctuary heals the living and burns the undead',
    actions: [
      { label: 'crowd', run: (k) => tk(k).crowd() },
      { label: 'smite', run: (k) => tk(k).smite() },
      { label: 'raise', run: (k) => tk(k).raise() },
      { label: 'sanctuary', run: (k) => tk(k).sanctuary() },
      { label: 'fear', run: (k) => tk(k).fear() },
      { label: 'petrify', run: (k) => tk(k).petrify() },
      { label: 'clear', run: (k) => tk(k).clear() },
    ],
  },
];

/** a flat plain: soil over stone */
export function generateTraitlab(dims: WorldDims): MapData {
  const { w, h } = dims;
  const N = w * h;
  const grid = new ColumnGrid(dims);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      grid.push(x, y, 0, PLAIN - 2, MAT.Stone);
      grid.push(x, y, PLAIN - 2, PLAIN, MAT.Soil);
    }
  const z = (n: number) => new Float32Array(n);
  const mid: [number, number] = [Math.round(w * 0.55), Math.round(h * 0.5)];
  return {
    grid,
    water: z(N),
    contam: z(N * 2),
    moisture: z(N).fill(0.3),
    vegetation: z(N),
    waterSource: z(N),
    oil: z(N),
    oilStored: z(N * 2),
    drift: z(N),
    driftMat: z(N),
    surface: z(N).fill(PLAIN),
    poi: { healthy: mid, dam: mid, pool: mid, tutorial: mid, heap: mid },
  };
}
