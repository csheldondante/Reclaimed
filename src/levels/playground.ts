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

/** the river's channel's middle row at column x */
const riverMid = (x: number) => RIVER.mid + RIVER.amp * Math.sin((x - RIVER.x0) / RIVER.wave);
/** the ramp's top at column x */
const riverTop = (x: number) =>
  x < RIVER.ledge ? RIVER.top - ((x - RIVER.x0) * (RIVER.top - RIVER.lip)) / (RIVER.ledge - RIVER.x0) : RIVER.low - ((x - RIVER.ledge) * (RIVER.low - RIVER.foot - 1)) / (RIVER.x1 - RIVER.ledge);
/** (round 110) the river as a river table declares it (world/rivertable.ts): its line down the ramp's middle, its water
 *  on the ground there (a river's level, the atlas's: the land before its channel is cut), a step at the ledge — the
 *  fall — and on past the map's edge, where it's held as a river leaving the atlas's window */
const RIVER_TABLE: AuthoredRiver[] = (() => {
  const R = RIVER;
  const path: AuthoredRiver['path'] = [];
  // (world units: a row's half-cell shift averaged — the line runs between rows)
  const at = (x: number, level = riverTop(x), row = riverMid(x)) => path.push({ x: x + 0.75, y: (row + 0.5) * ROW_H, level });
  // (the fall: the line square to the ledge across it — the ledge runs along y at the ground's step between columns
  // ledge − 1 and ledge, whose centres lie at world x ledge − 0.5 .. ledge + 0.5 and ledge + 0.5 .. ledge + 1)
  const ym = riverMid(R.ledge);
  for (let x = R.x0 + 4; x < R.ledge - 8; x += 6) at(x);
  at(R.ledge - 4, riverTop(R.ledge - 4), ym);
  path.push({ x: R.ledge, y: (ym + 0.5) * ROW_H, level: riverTop(R.ledge - 1) });
  path.push({ x: R.ledge + 0.5, y: (ym + 0.5) * ROW_H, level: riverTop(R.ledge) });
  at(R.ledge + 4, riverTop(R.ledge + 4), ym);
  for (let x = R.ledge + 12; x < R.x1; x += 8) at(x);
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
