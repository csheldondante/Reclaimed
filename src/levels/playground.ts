// The physics and water playground (round 108, BACKLOG AR8; the user: "Make a physics and water playground for testing
// collapse and flow and visuals for steady state effects maybe?"): `?skipmenu=1&level=playground`, or "The Playground"
// on the title screen. Stations on one flat plain, each in a whole number of chunks so a station resets alone
// (WorldCore.restoreChunks: as the level opened, after its warmup), each with its buttons (ui/stations.ts):
//   1 rock     (x 16..96,  y 16..80):  the rock lab's pieces (round 92) — a top on a thin leg, an arm off a wall, an
//              arch, a banded tower, a top off to one side of its leg, a tall pillar: rigid rock (game/rockbodies.ts)
//   2 build    (x 112..176, y 16..80): the sandbox's physics garden (round 14) — a concrete tower, a brick chimney, a
//              diving board, a bridge on two pillars, and a brick house: the columns' falling pieces
//   3 soil     (x 192..256, y 16..80): a bank of sand on a shelf held by a wall (the flow lab's D), a soil mound under
//              its repose to undercut: loose ground, slumps and falls
//   4 breach   (x 16..96,  y 112..176): a pool on a plateau held by a concrete plug at its lip (the flow lab's A),
//              breached: it pours off the ledge as an arc into a basin
//   5 river    (x 112..256, y 96..176): a river down a ramp, winding, over a ledge (a fall) and out off the map's edge
//              — (round 110) the game's water: declared in a river table (world/rivertable.ts), carved and held at
//              its steady state as the atlas's rivers are (riverFlow, riverheld.wgsl), asleep until something wakes it
//   6 dust     (x 16..112, y 192..240): a field of drift and ash with a sandstone top on a thin leg in it: dust storms
//              and a collapse's dust
//   (solver step 2, the user round 120: "I want to see rocks and buildings and have metal too so I can see deformation,
//   breaking and getting buried in a variety of materials and geometry") — the node solver's stations:
//   7 slide    (x 112..160, y 192..240): a stone slab on a slope held by two pegs, a thin spire, a mesa to undercut;
//              sand poured over what came down, and dug out
//   8 house    (x 160..208, y 192..240): a stone house, a brick tower, a wooden tower (posts and floors)
//   9 metal    (x 208..256, y 192..240): a steel girder bridge on stone pillars (a boulder dropped on it), a steel
//              pylon (two legs cut), a steel tanker on concrete posts (dropped), sand over it
// Storage coordinates (x column, y row); the camera looks from +x+y, so each station's open side faces it.

import { CHUNK, ColumnGrid, type Interval, type WorldDims } from '../world/layout';
import { MAT } from '../world/materials';
import type { MapData } from '../world/mapgen';
import { cellAt, cellPos, ROW_H } from '../world/lattice';
import { holdRivers, type AuthoredRiver } from '../world/rivertable';

const G = 10;

/** What a station's button may do (the level scene gives it: the world's own events and APIs) */
export interface StationKit {
  /** the Break tool's blast at world (x, y), height z */
  smash(x: number, y: number, z: number, r: number): void;
  /** dig a hole at world (x, y), `layers` deep */
  dig(x: number, y: number, r: number, layers: number): void;
  /** a spring: water poured in at these columns (storage), `rate` cells³ a second over them all (0: none) */
  source(cols: [number, number][], rate: number): void;
  /** a dust storm over world (x, y) */
  dust(x: number, y: number): void;
  /** a rain storm over world (x, y) */
  rain(x: number, y: number): void;
  /** after `secs` (sim time is not waited for: wall time) */
  later(secs: number, f: () => void): void;
  /** (solver step 2) loose ground poured over world (x, y): `layers` cells of it within r (burying what's there) */
  pour(x: number, y: number, r: number, layers: number, mat: number): void;
  /** (solver step 2) a body of these cells (storage x, y, cell z; air there) dropped into the node solver */
  drop(cells: { x: number; y: number; z: number; mat: number }[], vel?: [number, number, number]): void;
  /** (solver step 2) the metal at this cell (storage x, y, cell z) and all it connects to woken into the node solver */
  wakeMetal(x: number, y: number, z: number): void;
}

export interface Station {
  id: string;
  name: string;
  /** the chunks it lies in (storage cells, multiples of CHUNK; x1, y1 past the end) */
  rect: [number, number, number, number];
  /** where the camera looks: world x, y, z, zoom */
  look: [number, number, number, number];
  /** one line: what to try */
  hint: string;
  actions: { label: string; run: (k: StationKit) => void }[];
  /** the springs it starts with (re-made after a reset) */
  springs?: { cols: [number, number][]; rate: number }[];
}

// ---- the layout (storage cells) ---------------------------------------------------------------------------
const BUILD = { x: 116, y: 30 };
const SOIL = { shelf: { x0: 196, x1: 234, y0: 20, y1: 48, top: G + 12 }, bank: { x0: 210, y0: 26, y1: 42, top: G + 17 }, wall: [232, 234] as [number, number], mound: { x: 212, y: 64, r: 10, slope: 1.1 } };
const BREACH = { plateau: { x0: 16, x1: 56, y0: 116, y1: 172, top: G + 24 }, pool: { c: [32, 144] as [number, number], r: 9, floor: G + 21, level: G + 23.6 }, notch: { y0: 141, y1: 147, floor: G + 22 }, plug: [52, 54] as [number, number], basin: { x0: 56, x1: 92, y0: 116, y1: 172, floor: G - 4 } };
const RIVER = { x0: 112, x1: 256, y0: 100, y1: 172, ledge: 196, top: G + 20, lip: G + 12, low: G + 3, foot: G, mid: 136, amp: 7, wave: 13, width: 4, discharge: 0.3 };
const DUST = { x0: 16, x1: 112, y0: 192, y1: 240 };
// (solver step 2) the node solver's stations
/** the slope's top at column x (storage): up toward −x, a cell a column and a quarter, whole cells */
const slopeTop = (x: number) => G + Math.max(0, Math.round((132 - x) * 0.8));
const SLIDE = { slab: { x0: 116, x1: 124, y0: 204, y1: 212 }, pegs: [[118, 206], [122, 210]] as [number, number][], spire: { x: 150, y: 200, r: 1.3, h: 22 }, mesa: { x0: 136, x1: 148, y0: 220, y1: 232, h: 12 } };
const HOUSE = { house: { x0: 164, x1: 174, y0: 196, y1: 204, h: 7 }, tower: { x0: 194, x1: 198, y0: 198, y1: 202, h: 20 }, wood: { x0: 180, x1: 186, y0: 218, y1: 224, h: 16 } };
const METAL = {
  pillars: [[212, 196], [236, 196]] as [number, number][],
  girder: { x0: 212, x1: 240, y0: 197, y1: 199, z0: G + 10 },
  pylon: { x0: 222, x1: 228, y0: 214, y1: 220, h: 20 },
  tanker: { x0: 238, x1: 250, y0: 226, y1: 231, z0: G + 8, h: 5 },
};
const cellsBox = (x0: number, y0: number, z0: number, w: number, d: number, h: number, mat: number) => {
  const out: { x: number; y: number; z: number; mat: number }[] = [];
  for (let z = z0; z < z0 + h; z++) for (let y = y0; y < y0 + d; y++) for (let x = x0; x < x0 + w; x++) out.push({ x, y, z, mat });
  return out;
};

/** the river's channel's middle row at column x */
const riverMid = (x: number) => RIVER.mid + RIVER.amp * Math.sin((x - RIVER.x0) / RIVER.wave);
/** the ramp's top at column x */
const rampTop = (x: number) => RIVER.top - ((x - RIVER.x0) * (RIVER.top - RIVER.lip)) / (RIVER.ledge - RIVER.x0);
const lowTop = (x: number) => RIVER.low - ((x - RIVER.ledge) * (RIVER.low - RIVER.foot - 1)) / (RIVER.x1 - RIVER.ledge);
/** (round 110) the ledge's face: a steep chute CHUTE columns across (9 cells down over 4: every column of it a fall,
 *  RIVER_FALL a step, as the atlas's falls run down their cliff's slope) */
const CHUTE = 4;
const riverTop = (x: number) => {
  const a = RIVER.ledge - CHUTE / 2;
  const b = RIVER.ledge + CHUTE / 2;
  return x < a ? rampTop(x) : x >= b ? lowTop(x) : rampTop(a) + ((x - a) * (lowTop(b) - rampTop(a))) / CHUTE;
};
/** (round 110) the river as a river table declares it (world/rivertable.ts): its line down the ramp's middle, its water
 *  on the ground there (a river's level, the atlas's: the land before its channel is cut), a step at the ledge — the
 *  fall — and on past the map's edge, where it's held as a river leaving the atlas's window */
const RIVER_TABLE: AuthoredRiver[] = (() => {
  const R = RIVER;
  const path: AuthoredRiver['path'] = [];
  // (world units: a row's half-cell shift averaged — the line runs between rows)
  const at = (x: number, level = riverTop(x), row = riverMid(x)) => path.push({ x: x + 0.75, y: (row + 0.5) * ROW_H, level });
  // (the fall: the line square to the ledge across it, down the chute — its points at the chute's top and foot)
  const ym = riverMid(R.ledge);
  const a = R.ledge - CHUTE / 2;
  const b = R.ledge + CHUTE / 2;
  for (let x = R.x0 + 4; x < a - 8; x += 6) at(x);
  at(a - 4, riverTop(a - 4), ym);
  at(a, riverTop(a), ym);
  at(b, riverTop(b), ym);
  at(b + 4, riverTop(b + 4), ym);
  for (let x = b + 12; x < R.x1; x += 8) at(x);
  at(R.x1 + 6, R.foot + 0.5);
  // (its watershed: the station — rain on it raises the river, lagged down it)
  const [cx0, cy0] = [R.x0, 96 * ROW_H];
  const [cx1, cy1] = [R.x1, 176 * ROW_H];
  return [{ path, width: R.width, discharge: R.discharge, catchment: [cx0, cy0, cx1, cy1] }];
})();
/** where the river starts: what a surge pours in */
const SPRING_COLS: [number, number][] = [-1, 0, 1].map((d) => [RIVER.x0 + 5, Math.round(riverMid(RIVER.x0 + 5)) + d]);
const POOL_COLS: [number, number][] = [-1, 0, 1].map((d) => [BREACH.pool.c[0], BREACH.pool.c[1] + d]);

const wp = (x: number, y: number): [number, number] => cellPos(x, y);

export const STATIONS: Station[] = [
  {
    id: 'rock',
    name: 'rock',
    rect: [16, 16, 96, 80],
    look: [56, 44, 12, 3.2],
    hint: 'rigid rock: a top on a thin leg, an arm, an arch, a banded tower, a top off its leg, a pillar',
    actions: [
      {
        label: 'nick the legs',
        run: (k) => {
          k.smash(30.4, 30, G + 3, 1.6);
          k.smash(47.5, 28, G + 27.5, 1.5);
          k.smash(70, 30, G + 2, 2.2);
          k.smash(52, 56, G + 3, 1.5);
        },
      },
      {
        label: 'cut the towers',
        run: (k) => {
          k.smash(33.5, 56, G + 2, 2);
          k.smash(80.5, 56, G + 3, 2.6);
        },
      },
    ],
  },
  {
    id: 'build',
    name: 'build',
    rect: [112, 16, 176, 80],
    look: [144, 40, 12, 3.4],
    hint: 'structures: a tower, a chimney, a diving board, a bridge, a house — the columns\' falling pieces',
    actions: [
      {
        label: 'break bases',
        run: (k) => {
          const b = BUILD;
          k.smash(...wp(b.x + 2.5, b.y + 2.5), G + 1, 1.8);
          k.smash(...wp(b.x + 12.5, b.y + 2.5), G + 1, 2);
          k.smash(...wp(b.x + 22, b.y + 2), G + 1, 2.2);
          k.smash(...wp(b.x + 35.5, b.y + 2), G + 1, 2.2);
        },
      },
      { label: 'break the house', run: (k) => k.smash(...wp(BUILD.x + 6, BUILD.y + 26), G + 2, 2.4) },
    ],
  },
  {
    id: 'soil',
    name: 'soil',
    rect: [192, 16, 256, 80],
    look: [222, 36, 14, 3.6],
    hint: 'loose ground: a sand bank held by a wall on a shelf, a soil mound under its repose',
    actions: [
      {
        label: 'open the wall',
        run: (k) => {
          for (let y = SOIL.bank.y0; y < SOIL.bank.y1; y += 2) for (let n = 0; n < 3; n++) k.dig(...wp(SOIL.wall[0] + 1, y + 0.5), 2.2, 4);
        },
      },
      {
        label: 'undercut the mound',
        run: (k) => {
          const m = SOIL.mound;
          for (let d = -4; d <= 4; d += 2) for (let n = 0; n < 2; n++) k.dig(...wp(m.x + m.r - 3, m.y + d), 2, 3);
        },
      },
    ],
  },
  {
    id: 'breach',
    name: 'breach',
    rect: [16, 112, 96, 176],
    look: [56, 124, 14, 3.2],
    hint: 'a pool held by a concrete plug at a ledge\'s lip: breach it, it falls as an arc',
    actions: [
      {
        label: 'breach',
        run: (k) => {
          const b = BREACH;
          for (let y = b.notch.y0; y < b.notch.y1; y += 2) for (let n = 0; n < 3; n++) k.dig(...wp(b.plug[0] + 1, y + 0.5), 2.2, 1);
          // (and a spring in the pool keeps it pouring, as the flow lab's breach)
          k.source(POOL_COLS, 1.5);
        },
      },
    ],
  },
  {
    id: 'river',
    name: 'river',
    rect: [112, 96, 256, 176],
    look: [190, 118, 12, 3],
    hint: 'a river held at its steady state, as the atlas\'s: a winding channel, a fall over a ledge (spray off it)',
    actions: [
      {
        label: 'surge',
        run: (k) => {
          k.source(SPRING_COLS, 6);
          // (round 110: the river is held at its table — no spring of its own to go back to)
          k.later(8, () => k.source(SPRING_COLS, 0));
        },
      },
      { label: 'rain', run: (k) => k.rain(...wp(170, 136)) },
    ],
  },
  {
    id: 'dust',
    name: 'dust',
    rect: [16, 192, 112, 240],
    look: [64, 186, 11, 3.2],
    hint: 'drift and ash: a dust storm; a sandstone top on a thin leg to topple into it',
    actions: [
      { label: 'dust storm', run: (k) => k.dust(...wp(48, 216)) },
      { label: 'topple', run: (k) => k.smash(...wp(82, 214), G + 2.5, 2.4) },
    ],
  },
  {
    id: 'slide',
    name: 'slide',
    rect: [112, 192, 160, 240],
    look: [134, 190, 14, 6],
    hint: 'node solver, rock: a slab on a slope held by pegs, a thin spire, a mesa — slides, topples, shatters; buried, dug out',
    actions: [
      { label: 'release the slab', run: (k) => SLIDE.pegs.forEach(([x, y]) => k.smash(...wp(x + 0.5, y + 0.5), slopeTop(x) + 0.5, 1.1)) },
      { label: 'nick the spire', run: (k) => k.smash(...wp(SLIDE.spire.x - 1, SLIDE.spire.y + 0.5), G + 1.5, 1.6) },
      {
        label: 'undercut the mesa',
        run: (k) => {
          const m = SLIDE.mesa;
          for (let y = m.y0; y < m.y1; y += 3) k.smash(...wp(m.x1 - 0.5, y + 1), G + 1.5, 2.2);
        },
      },
      {
        label: 'bury',
        run: (k) => {
          for (const [x, y] of [[150, 206], [144, 200], [128, 208], [150, 226]] as [number, number][]) k.pour(...wp(x, y), 5, 3, MAT.Sand);
        },
      },
      {
        label: 'dig out',
        run: (k) => {
          for (const [x, y] of [[150, 206], [144, 200], [128, 208], [150, 226]] as [number, number][]) k.dig(...wp(x, y), 5, 4);
        },
      },
    ],
  },
  {
    id: 'house',
    name: 'house',
    rect: [160, 192, 208, 240],
    look: [184, 190, 12, 6],
    hint: 'node solver, buildings: a stone house, a brick tower, a wooden tower — break, topple, the wood bends',
    actions: [
      { label: 'break a corner', run: (k) => k.smash(...wp(HOUSE.house.x0 + 0.5, HOUSE.house.y0 + 0.5), G + 2, 2.4) },
      {
        label: 'topple the towers',
        run: (k) => {
          const t = HOUSE.tower;
          k.smash(...wp(t.x1 - 0.5, (t.y0 + t.y1) / 2), G + 1.5, 2);
          const w = HOUSE.wood;
          k.smash(...wp(w.x1 - 0.5, w.y0 + 0.5), G + 1, 1.2);
          k.smash(...wp(w.x1 - 0.5, w.y1 - 0.5), G + 1, 1.2);
          k.later(0.4, () => k.wakeMetal(w.x0, w.y0, G + 4));
        },
      },
    ],
  },
  {
    id: 'metal',
    name: 'metal',
    rect: [208, 192, 256, 240],
    look: [232, 190, 14, 6],
    hint: 'node solver, metal: a girder bridge (a boulder dropped on it), a pylon (three legs cut), a tanker (dropped) — dents, bends, snaps; buried',
    actions: [
      {
        label: 'boulder on the bridge',
        run: (k) => {
          const g = METAL.girder;
          k.wakeMetal(g.x0 + 12, g.y0, g.z0);
          k.later(0.3, () => k.drop(cellsBox(222, 196, G + 24, 5, 4, 4, MAT.Stone)));
        },
      },
      {
        label: 'cut the pylon',
        run: (k) => {
          const p = METAL.pylon;
          // (three of its four legs: it hangs on the last, which bends at its foot)
          k.smash(...wp(p.x1 + 0.5, p.y0 + 0.5), G + 1, 1.3);
          k.smash(...wp(p.x1 + 0.5, p.y1 + 0.5), G + 1, 1.3);
          k.smash(...wp(p.x0 + 0.5, p.y1 + 0.5), G + 1, 1.3);
          k.later(0.4, () => k.wakeMetal(p.x0, p.y0, G + 6));
        },
      },
      {
        label: 'drop the tanker',
        run: (k) => {
          const t = METAL.tanker;
          for (const x of [t.x0 + 1, t.x1 - 2]) for (const y of [t.y0 + 1, t.y1 - 2]) k.smash(...wp(x + 0.5, y + 0.5), G + 4, 1.4);
          k.later(0.4, () => k.wakeMetal(t.x0, t.y0, t.z0));
        },
      },
      {
        label: 'bury the tanker',
        run: (k) => {
          const t = METAL.tanker;
          for (let x = t.x0; x <= t.x1; x += 5) k.pour(...wp(x, (t.y0 + t.y1) / 2), 6, 4, MAT.Sand);
        },
      },
    ],
  },
];

export function generatePlayground(dims: WorldDims): MapData {
  const { w, h } = dims;
  const N = w * h;
  for (const s of STATIONS) if (s.rect.some((v) => v % CHUNK !== 0)) throw new Error(`playground station ${s.id}: its rect isn't whole chunks`);
  const cols: Interval[][] = Array.from({ length: N }, () => [{ z0: 0, z1: G - 2, mat: MAT.Stone }, { z0: G - 2, z1: G, mat: MAT.Soil }]);
  const water = new Float32Array(N);
  const waterSource = new Float32Array(N);
  /** column (x, y) with [z0, z1) of mat in it (what was there replaced) */
  const put = (x: number, y: number, z0: number, z1: number, mat: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h || z1 <= z0) return;
    const out: Interval[] = [];
    for (const iv of cols[y * w + x]) {
      if (iv.z1 <= z0 || iv.z0 >= z1) out.push(iv);
      else {
        if (iv.z0 < z0) out.push({ ...iv, z1: z0 });
        if (iv.z1 > z1) out.push({ ...iv, z0: z1 });
      }
    }
    out.push({ z0, z1, mat });
    out.sort((a, b) => a.z0 - b.z0);
    cols[y * w + x] = out;
  };
  /** column (x, y)'s top set to z: ground (stone, a soil skin over 2 cells) to it, nothing above */
  const ground = (x: number, y: number, z: number, skin: number = MAT.Soil) => {
    cols[y * w + x] = z > 2 ? [{ z0: 0, z1: z - 2, mat: MAT.Stone }, { z0: z - 2, z1: z, mat: skin }] : [{ z0: 0, z1: Math.max(0.5, z), mat: MAT.Stone }];
  };
  const top = (x: number, y: number) => {
    const c = cols[y * w + x];
    return c[c.length - 1].z1;
  };
  /** the cells whose centres lie within r of world point (wx, wy) */
  const disc = (wx: number, wy: number, r: number): [number, number][] => {
    const out: [number, number][] = [];
    const [c0x, c0y] = cellAt(wx - r - 1, wy - r - 1);
    const [c1x, c1y] = cellAt(wx + r + 1, wy + r + 1);
    for (let y = Math.max(0, c0y); y <= Math.min(h - 1, c1y); y++)
      for (let x = Math.max(0, c0x); x <= Math.min(w - 1, c1x); x++) {
        const [px, py] = cellPos(x, y);
        if (Math.hypot(px - wx, py - wy) <= r) out.push([x, y]);
      }
    return out;
  };
  /** a box of storage cells */
  const block = (x0: number, y0: number, z0: number, bw: number, bd: number, bh: number, mat: number) => {
    for (let y = y0; y < y0 + bd; y++) for (let x = x0; x < x0 + bw; x++) put(x, y, z0, z0 + bh, mat);
  };

  // 1. rock (world positions: the rock lab's pieces, closer together)
  {
    for (const [a, b] of disc(28, 30, 2.4)) put(a, b, G - 2, G + 30, MAT.Stone);
    for (const [a, b] of disc(28, 30, 6)) put(a, b, G + 20, G + 30, MAT.Stone);
    for (const [a, b] of disc(44, 28, 3)) put(a, b, G - 2, G + 34, MAT.Stone);
    for (let wx = 44; wx <= 58; wx += 0.5) for (const [a, b] of disc(wx, 28, 1.5)) put(a, b, G + 26, G + 29, MAT.Stone);
    for (const dx of [-6, 6]) for (const [a, b] of disc(76 + dx, 30, 2)) put(a, b, G - 2, G + 20, MAT.Sandstone);
    for (let wx = 70; wx <= 82; wx += 0.5)
      for (const [a, b] of disc(wx, 30, 1.6)) {
        const t = 2 + 4 * Math.pow(Math.abs(cellPos(a, b)[0] - 76) / 6, 2);
        put(a, b, G + 20 - t, G + 20, MAT.Sandstone);
      }
    for (const [a, b] of disc(30, 56, 3.5)) {
      put(a, b, G - 2, G + 40, MAT.Stone);
      for (let z = G + 8; z < G + 38; z += 8) put(a, b, z, z + 1, MAT.Soil);
      put(a, b, G + 20, G + 22, MAT.Concrete);
    }
    for (const [a, b] of disc(54, 56, 2.5)) put(a, b, G - 2, G + 24, MAT.Stone);
    for (const [a, b] of disc(56.5, 56, 5)) put(a, b, G + 20, G + 24, MAT.Stone);
    for (const [a, b] of disc(78, 56, 3)) put(a, b, G - 2, G + 50, MAT.Sandstone);
  }
  // 2. build: the sandbox's physics garden, and a brick house
  {
    const { x: X, y: Y } = BUILD;
    block(X + 1, Y + 1, G, 3, 3, 24, MAT.Concrete);
    block(X + 11, Y + 1, G, 4, 4, 18, MAT.Brick);
    block(X + 20, Y, G, 4, 4, 9, MAT.Concrete);
    block(X + 24, Y + 1, G + 8, 6, 2, 1, MAT.Concrete);
    block(X + 34, Y, G, 3, 4, 7, MAT.Brick);
    block(X + 47, Y, G, 3, 4, 7, MAT.Brick);
    block(X + 34, Y, G + 7, 16, 4, 2, MAT.Concrete);
    // the house: brick walls a cell thick, 8 high, a concrete roof
    const hx = X + 5;
    const hy = Y + 22;
    for (let y = hy; y < hy + 9; y++)
      for (let x = hx; x < hx + 12; x++) {
        const wall = x === hx || y === hy || x === hx + 11 || y === hy + 8;
        if (wall) put(x, y, G, G + 8, MAT.Brick);
        put(x, y, G + 8, G + 9, MAT.Concrete);
      }
  }
  // 3. soil: a shelf with a sand bank held by a wall at its lip; a soil mound on the plain
  {
    const s = SOIL.shelf;
    for (let y = s.y0; y < s.y1; y++) for (let x = s.x0; x < s.x1; x++) ground(x, y, s.top, MAT.Stone);
    const b = SOIL.bank;
    for (let y = b.y0; y < b.y1; y++)
      for (let x = b.x0; x < SOIL.wall[1]; x++) {
        if (x >= SOIL.wall[0]) put(x, y, s.top, b.top + 1, MAT.Concrete);
        else {
          // (its free sides at half a cell a cell: under the sand's repose, it lies still until the wall goes)
          const edge = Math.min(y - b.y0, b.y1 - 1 - y, x - b.x0) + 1;
          const z1 = Math.min(b.top, s.top + edge * 0.5);
          if (z1 > s.top + 0.25) put(x, y, s.top, z1, MAT.Sand);
        }
      }
    const m = SOIL.mound;
    const [mx, my] = cellPos(m.x, m.y);
    for (const [a, c] of disc(mx, my, m.r)) {
      const d = Math.hypot(cellPos(a, c)[0] - mx, cellPos(a, c)[1] - my);
      const z1 = G + Math.min(9, (m.r - d) * m.slope);
      if (z1 > G + 0.25) put(a, c, G, z1, MAT.Soil);
    }
  }
  // 4. breach: a pool on a plateau, a plug in a notch at its lip, a basin under the ledge
  {
    const B = BREACH;
    const [pcx, pcy] = cellPos(B.pool.c[0], B.pool.c[1]);
    for (let y = B.plateau.y0; y < B.plateau.y1; y++)
      for (let x = B.plateau.x0; x < B.plateau.x1; x++) {
        const [px, py] = cellPos(x, y);
        const d = Math.hypot(px - pcx, py - pcy);
        let t = B.plateau.top;
        if (d < B.pool.r) t = B.pool.floor;
        else if (y >= B.notch.y0 && y < B.notch.y1 && x > B.pool.c[0]) t = B.notch.floor;
        ground(x, y, t, MAT.Stone);
        if (d < B.pool.r || (t === B.notch.floor && x < B.plug[0])) water[y * w + x] = B.pool.level - t;
        if (y >= B.notch.y0 && y < B.notch.y1 && x >= B.plug[0] && x < B.plug[1]) put(x, y, t, t + 3, MAT.Concrete);
      }
    for (let y = B.basin.y0; y < B.basin.y1; y++) for (let x = B.basin.x0; x < B.basin.x1; x++) ground(x, y, B.basin.floor);
  }
  // 5. river: a ramp, a ledge, a lower run out to the map's edge (its channel the river table's: below)
  {
    const R = RIVER;
    for (let y = R.y0; y < R.y1; y++) for (let x = R.x0; x < Math.min(R.x1, w); x++) ground(x, y, Math.round(riverTop(x) * 4) / 4);
  }
  // 6. dust: drift and ash over the plain, a sandstone top on a thin leg
  {
    const D = DUST;
    for (let y = D.y0; y < D.y1; y++)
      for (let x = D.x0; x < D.x1; x++) {
        const ash = Math.sin(x * 0.21) + Math.cos(y * 0.17) > 0.6;
        put(x, y, G, G + (ash ? 0.6 : 1), ash ? MAT.Ash : MAT.Drift);
      }
    const [lx, ly] = cellPos(82, 214);
    for (const [a, b] of disc(lx, ly, 1.8)) put(a, b, G - 2, G + 18, MAT.Sandstone);
    for (const [a, b] of disc(lx + 1, ly, 5)) put(a, b, G + 14, G + 18, MAT.Sandstone);
  }

  // 7. slide: a slope up toward −x with a stone slab on two concrete pegs a cell over it; a thin spire; a mesa
  {
    for (let y = 192; y < 240; y++) for (let x = 112; x < 136; x++) ground(x, y, slopeTop(x), MAT.Stone);
    const s = SLIDE.slab;
    for (let y = s.y0; y < s.y1; y++)
      for (let x = s.x0; x < s.x1; x++) {
        const z0 = slopeTop(x) + 1;
        put(x, y, z0, z0 + 2, MAT.Stone);
      }
    for (const [x, y] of SLIDE.pegs) put(x, y, slopeTop(x), slopeTop(x) + 1, MAT.Concrete);
    const sp = SLIDE.spire;
    const [sx, sy] = cellPos(sp.x, sp.y);
    for (const [a, b] of disc(sx, sy, sp.r)) put(a, b, G - 2, G + sp.h, MAT.Stone);
    const m = SLIDE.mesa;
    block(m.x0, m.y0, G, m.x1 - m.x0, m.y1 - m.y0, m.h, MAT.Stone);
  }
  // 8. house: a stone house (walls a cell thick, a concrete roof), a brick tower, a wooden tower (posts and floors)
  {
    const hs = HOUSE.house;
    for (let y = hs.y0; y < hs.y1; y++)
      for (let x = hs.x0; x < hs.x1; x++) {
        const wall = x === hs.x0 || y === hs.y0 || x === hs.x1 - 1 || y === hs.y1 - 1;
        if (wall) put(x, y, G, G + hs.h, MAT.Stone);
        put(x, y, G + hs.h, G + hs.h + 1, MAT.Concrete);
      }
    const t = HOUSE.tower;
    block(t.x0, t.y0, G, t.x1 - t.x0, t.y1 - t.y0, t.h, MAT.Brick);
    const w = HOUSE.wood;
    for (const x of [w.x0, w.x1 - 1]) for (const y of [w.y0, w.y1 - 1]) put(x, y, G, G + w.h, MAT.Wood);
    for (let z = G + 5; z < G + w.h; z += 5) block(w.x0, w.y0, z, w.x1 - w.x0, w.y1 - w.y0, 1, MAT.Wood);
  }
  // 9. metal: a steel girder on two stone pillars; a steel pylon (legs, braces, a platform); a steel tanker on posts
  {
    const M = METAL;
    for (const [x, y] of M.pillars) block(x, y, G, 3, 3, 10, MAT.Stone);
    const g = M.girder;
    block(g.x0, g.y0, g.z0, g.x1 - g.x0, g.y1 - g.y0, 2, MAT.Steel);
    const p = M.pylon;
    for (const x of [p.x0, p.x1]) for (const y of [p.y0, p.y1]) put(x, y, G, G + p.h, MAT.Steel);
    for (let z = G + 6; z < G + p.h; z += 6)
      for (let x = p.x0; x <= p.x1; x++)
        for (let y = p.y0; y <= p.y1; y++) if (x === p.x0 || x === p.x1 || y === p.y0 || y === p.y1) put(x, y, z, z + 1, MAT.Steel);
    block(p.x0, p.y0, G + p.h, p.x1 - p.x0 + 1, p.y1 - p.y0 + 1, 1, MAT.Steel);
    const t = M.tanker;
    for (let y = t.y0; y < t.y1; y++)
      for (let x = t.x0; x < t.x1; x++) {
        const shell = x === t.x0 || y === t.y0 || x === t.x1 - 1 || y === t.y1 - 1;
        if (shell) put(x, y, t.z0, t.z0 + t.h, MAT.Steel);
        else {
          put(x, y, t.z0, t.z0 + 1, MAT.Steel);
          put(x, y, t.z0 + t.h - 1, t.z0 + t.h, MAT.Steel);
        }
      }
    for (const x of [t.x0 + 1, t.x1 - 2]) for (const y of [t.y0 + 1, t.y1 - 2]) put(x, y, G, t.z0, MAT.Concrete);
  }

  // (round 110) the rivers: carved, filled and held as the atlas's (world/rivertable.ts → WorldGpu riverFlow)
  const moisture = new Float32Array(N).fill(0.3);
  const held = holdRivers(RIVER_TABLE, { w, h, cols, water, moisture });
  const grid = new ColumnGrid(dims);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      // (touching intervals of a material: one)
      let last: Interval | null = null;
      for (const iv of cols[y * w + x]) {
        if (last && last.mat === iv.mat && Math.abs(last.z1 - iv.z0) < 1e-4) {
          last.z1 = iv.z1;
          continue;
        }
        if (last) grid.push(x, y, last.z0, last.z1, last.mat);
        last = { ...iv };
      }
      if (last) grid.push(x, y, last.z0, last.z1, last.mat);
    }
  const surface = new Float32Array(N);
  for (let i = 0; i < N; i++) surface[i] = top(i % w, Math.floor(i / w));
  const z = (n: number) => new Float32Array(n);
  const corner: [number, number] = [150, 220];
  return {
    grid,
    water,
    contam: z(N * 2),
    moisture,
    riverFlow: held.riverFlow,
    riverGraph: held.graph,
    vegetation: z(N),
    waterSource,
    oil: z(N),
    oilStored: z(N * 2),
    drift: z(N),
    driftMat: z(N),
    surface,
    poi: { healthy: corner, dam: BREACH.pool.c, pool: BREACH.pool.c, tutorial: corner, heap: corner, rock: [56, 50], river: [196, 136] },
  };
}

/** the world point (x, y) of a station's rect's middle (storage cells → world) */
export function stationMiddle(s: Station): [number, number] {
  return [(s.rect[0] + s.rect[2]) / 2, ((s.rect[1] + s.rect[3]) / 2) * ROW_H];
}
