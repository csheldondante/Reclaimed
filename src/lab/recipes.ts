// (round 128l, tooling) The behaviour lab's land (?level=lab&lab=<recipe>): a few small deterministic recipes, made on
// the CPU in a few milliseconds — no atlas, no generation — so a scripted behaviour check boots in seconds. Each says
// where the lab's town keeps its heap (the stores until a warehouse stands, lab/town.ts) and its houses' doors, and
// (`town`) what of the fortress stands at the start: the walled town is a ring of wall with a gate, a keep, houses and a
// warehouse already built round the heap (the atlas's starting town, small). Pure: no GPU, no DOM.
import { ColumnGrid, type WorldDims } from '../world/layout';
import { MAT } from '../world/materials';
import { cellAt, cellPos, ROW_H } from '../world/lattice';
import type { MapData } from '../world/mapgen';
import type { StructureType } from '../api/contracts/fortress';

type V2 = [number, number];

/** what of the fortress stands when the lab opens (lab.plan's JSON: see lab/lab.ts LabPlan) */
export interface LabTownSpec {
  /** a ring of wall round the heap: its radius (world units) and the side its gate is on */
  walls?: { r: number; gate: 'east' | 'west' | 'north' | 'south' };
  /** blocks round the heap: offsets from it (world units), level 0 unless given */
  blocks?: { type: StructureType; d: V2; level?: number }[];
}

export interface LabRecipe {
  name: string;
  blurb: string;
  /** the ground's top (z, cells) at window world (x, y) */
  ground: (x: number, y: number) => number;
  /** a river: the water's depth over the ground at (x, y) (0: dry) and the springs that keep it running */
  water?: (x: number, y: number) => number;
  springs?: (x: number, y: number) => number;
  /** woods (the succession field: 3.6+ is trees) at (x, y) */
  woods?: (x: number, y: number) => number;
  /** the town: its heap (world units) and its houses' doors, and what of the fortress stands at the start */
  heap: V2;
  homes: V2[];
  town?: LabTownSpec;
}

/** the lab's window: one fixed window, the plain levels' size */
export const LAB_DIMS: WorldDims = { w: 256, h: 256, zMax: 64 };
/** the window's middle (world units) */
export const LAB_MID: V2 = [LAB_DIMS.w / 2, (LAB_DIMS.h / 2) * ROW_H];
const BASE = 10;

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
/** a wood: a disc of trees at c, radius r */
const wood = (c: V2, r: number) => (x: number, y: number) => (Math.hypot(x - c[0], y - c[1]) < r ? 4.2 : 0.6);
/** the heap a little west of the middle: the box round it (240 a side) holds the window */
const HEAP: V2 = [LAB_MID[0] - 30, LAB_MID[1]];
const HOMES: V2[] = [
  [HEAP[0] - 6, HEAP[1] + 5],
  [HEAP[0] - 6, HEAP[1] - 5],
];

export const LAB_RECIPES: Record<string, LabRecipe> = {
  flat: {
    name: 'flat',
    blurb: 'a dry plain, a wood to the north-east',
    ground: () => BASE,
    woods: wood([LAB_MID[0] + 70, LAB_MID[1] - 60], 22),
    heap: HEAP,
    homes: HOMES,
  },
  hill: {
    name: 'hill',
    blurb: 'a plain with a broad hill to the east (a rise of about 1 in 5 on its flanks)',
    ground: (x, y) => {
      const d = Math.hypot(x - (LAB_MID[0] + 55), y - LAB_MID[1]);
      return BASE + 22 * (0.5 + 0.5 * Math.cos(Math.PI * Math.min(1, d / 95)));
    },
    woods: wood([LAB_MID[0] - 70, LAB_MID[1] - 70], 20),
    heap: [LAB_MID[0] - 60, LAB_MID[1]],
    homes: [
      [LAB_MID[0] - 66, LAB_MID[1] + 5],
      [LAB_MID[0] - 66, LAB_MID[1] - 5],
    ],
  },
  valley: {
    name: 'valley',
    blurb: 'two slopes down to a river running north to south east of the town; a lake at its foot',
    ground: (x, y) => {
      const d = Math.abs(x - (LAB_MID[0] + 45));
      const bank = BASE + Math.min(14, d * 0.18);
      // (the channel: 3 deep, 6 across; the lake at the south end)
      const ch = d < 4 ? 3 * smooth((4 - d) / 2) : 0;
      const lake = Math.hypot(x - (LAB_MID[0] + 45), y - (LAB_MID[1] + 85)) < 18 ? 3 : 0;
      return Math.max(1, bank - Math.max(ch, lake));
    },
    water: (x, y) => {
      const d = Math.abs(x - (LAB_MID[0] + 45));
      const lake = Math.hypot(x - (LAB_MID[0] + 45), y - (LAB_MID[1] + 85)) < 18;
      return d < 3 || lake ? 2 : 0;
    },
    springs: (x, y) => (Math.abs(x - (LAB_MID[0] + 45)) < 2 && y < 6 ? 0.01 : 0),
    woods: wood([LAB_MID[0] - 75, LAB_MID[1] + 60], 20),
    heap: HEAP,
    homes: HOMES,
  },
  plateau: {
    // (round 128m, quarry: the lab's window holds z 0-64 and never slides — a pit needs ground high in it to go down)
    name: 'plateau',
    blurb: 'a dry plain 44 m up the window (the others lie at 10): room under it for a quarry pit about ten tiers deep',
    ground: () => 44,
    woods: wood([LAB_MID[0] + 70, LAB_MID[1] - 60], 22),
    heap: HEAP,
    homes: HOMES,
  },
  walled: {
    name: 'walled',
    blurb: "the flat plain with a small walled town already built round the heap (a gate on its east side): the atlas's starting town, small",
    ground: () => BASE,
    woods: wood([LAB_MID[0] + 70, LAB_MID[1] - 60], 22),
    heap: HEAP,
    homes: HOMES,
    town: {
      walls: { r: 16, gate: 'east' },
      blocks: [
        // (the heap's own cell left free: the builders take from it)
        { type: 'fortress', d: [-8, -6] },
        { type: 'fortress', d: [-8, -6], level: 1 },
        { type: 'house', d: [-9, 5] },
        { type: 'house', d: [3, 9] },
        { type: 'warehouse', d: [3, -9] },
      ],
    },
  },
};

export function labRecipe(name: string | null | undefined): LabRecipe {
  const r = LAB_RECIPES[name ?? 'flat'];
  if (!r) throw new Error(`?lab=${name}: no such lab recipe (${Object.keys(LAB_RECIPES).join(', ')})`);
  return r;
}

/** The recipe's land as the level's map: soil over stone to the ground, water and springs, the woods. */
export function generateLab(dims: WorldDims, recipe: LabRecipe): MapData {
  const { w, h } = dims;
  const N = w * h;
  const grid = new ColumnGrid(dims);
  const f = (n: number) => new Float32Array(n);
  const surface = f(N);
  const water = f(N);
  const waterSource = f(N);
  const vegetation = f(N);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      // (a column's middle in world units: world/lattice.ts)
      const [wx, wy] = cellPos(x, y);
      const z = Math.max(2, Math.min(dims.zMax - 8, Math.round(recipe.ground(wx, wy))));
      grid.push(x, y, 0, z - 2, MAT.Stone);
      grid.push(x, y, z - 2, z, MAT.Soil);
      const i = y * w + x;
      surface[i] = z;
      water[i] = recipe.water?.(wx, wy) ?? 0;
      waterSource[i] = recipe.springs?.(wx, wy) ?? 0;
      vegetation[i] = water[i] > 0 ? 0 : (recipe.woods?.(wx, wy) ?? 0.6);
    }
  const heapCell = cellAt(recipe.heap[0], recipe.heap[1]);
  return {
    grid,
    water,
    contam: f(N * 2),
    moisture: f(N).fill(0.35),
    vegetation,
    waterSource,
    oil: f(N),
    oilStored: f(N * 2),
    drift: f(N),
    driftMat: f(N),
    surface,
    poi: { healthy: heapCell, dam: heapCell, pool: heapCell, tutorial: heapCell, heap: heapCell },
  };
}
