// (loop-streets, LS-102 option a) Streets as terrain: a town's road records laid into the columns by the grader
// (roadlab/grader.ts GradeLayer, shaders/roadgrade.wgsl roadLay) from the claims' `claimed` hook
// (sim/static-claims.ts) — the riskiest part of docs/design/CITYGEN.md "Streets as terrain", proved on a tiny world
// before the game:
//   - land arriving region by region is claimed, then graded where it lies: the result equals one lay over it all;
//   - land arriving again raw (a pool thaw, a reload) comes back graded the same, bit for bit;
//   - the frame placed elsewhere (a slide) grades where it now lies;
//   - ownership: a road column is the road's surface at the profile with nothing over it (no paving claim floats there);
//     a column another owner claimed (a building in the road's way or its shoulder) is left as it was.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld, type TinyWorld } from './world';
import { tinyMap } from '../support/tinymap';
import { MAT } from '../../src/world/materials';
import { readColumn, type Interval } from '../../src/world/layout';
import { cellPos } from '../../src/world/lattice';
import { packRoads, RoadSurface, type RoadRecord } from '../../src/api/contracts/roadpath';
import { GradeLayer, type GradePlace } from '../../src/roadlab/grader';
import { StaticClaims } from '../../src/sim/static-claims';
import { ExternalRegistry } from '../../src/sim/external';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
  globalThis.requestAnimationFrame ??= ((fn: FrameRequestCallback) => setTimeout(() => fn(performance.now()), 0)) as unknown as typeof requestAnimationFrame;
});
afterAll(() => g?.destroy());

const W = 64;
const R = 32;
/** the frame (a town's grid): GW × GW columns */
const GW = 48;

/** the land: stone under a soil top, rising to the east and a little to the north (window z) */
const ground = (x: number, y: number) => Math.round((6 + 0.14 * x + 0.05 * y) * 16) / 16;
const land = (x: number, y: number): Interval[] => [
  { z0: 0, z1: ground(x, y) - 1, mat: MAT.Stone },
  { z0: ground(x, y) - 1, z1: ground(x, y), mat: MAT.Soil },
];

/** the town's records (its grid's frame, world z = window z − dz): the square (a disc) and two streets out of it */
function records(): RoadRecord[] {
  const base = { surface: RoadSurface.Cobble, graded: true, paved: true, dry: true, revealStart: 0, revealEnd: 0, shoulder: 4, maxDz: 0 };
  return [
    { ...base, points: [ { x: 22, y: 18, z: 9.5, hw: 6 }, { x: 22, y: 18, z: 9.5, hw: 6 } ] },
    { ...base, points: [ { x: 22, y: 18, z: 9.5, hw: 3.5 }, { x: 44, y: 18, z: 11, hw: 3.5 } ] },
    { ...base, points: [ { x: 22, y: 18, z: 9.5, hw: 3.5 }, { x: 6, y: 36, z: 9, hw: 3.5 } ] },
  ];
}

/** the CPU's reading of the records at a frame point: the first record whose half width holds it, its profile */
function onRoad(recs: RoadRecord[], p: [number, number]): number | null {
  for (const r of recs) {
    let best = Infinity;
    let z = 0;
    for (let i = 0; i + 1 < r.points.length; i++) {
      const a = r.points[i];
      const b = r.points[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((p[0] - a.x) * dx + (p[1] - a.y) * dy) / Math.max(dx * dx + dy * dy, 1e-12)));
      const d = Math.hypot(p[0] - a.x - dx * t, p[1] - a.y - dy * t);
      if (d <= a.hw + (b.hw - a.hw) * t && d < best) {
        best = d;
        z = a.z + (b.z - a.z) * t;
      }
    }
    if (best < Infinity) return z;
  }
  return null;
}

interface Rig {
  w: TinyWorld;
  sc: StaticClaims;
  layer: GradeLayer;
  recs: RoadRecord[];
  buf: GPUBuffer;
  place: GradePlace;
  unwritten: [number, number][];
  /** frame columns claimed by another owner: (lx, ly) → its span (frame z) */
  owned: Map<number, { z0: number; z1: number }>;
}

/** a tiny world, its static claims with the town's claim grid (buildings and a crossing street's paving, none on the
 *  graded columns — streets.wgsl claimRoads' rule), the hook laying the records after each claim */
async function rig(place: GradePlace): Promise<Rig> {
  const w = await tinyWorld(g, tinyMap(W, W, 32, land), []);
  const dev = g.device;
  const recs = records();
  const bytes = packRoads(recs);
  const buf = dev.createBuffer({ label: 'test town records', size: bytes.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  dev.queue.writeBuffer(buf, 0, bytes);
  const layer = new GradeLayer(dev, w.core.world);
  const cols = () => w.core.columnsGpu();
  const ap = w.core.columnApply;
  const ext = new ExternalRegistry({
    read: () => {
      throw new Error('read: nothing here reads the columns');
    },
    write: () => {
      throw new Error('write: the claims write through the GPU');
    },
    release: (spans) => ap.run(cols(), [{ cuts: [], release: spans }]),
  });
  const r: Rig = { w, layer, recs, buf, place, unwritten: [], owned: new Map(), sc: null! };
  r.sc = new StaticClaims({ device: dev, apply: () => ap, columns: cols, registry: () => ext, dims: { w: W, h: W }, R, unwritten: () => r.unwritten, held: () => false });
  ext.statics = r.sc;
  // (the claim grid: a building in the east street's way (frame columns 33–35, 17–19), one in its shoulder (30–32,
  // 22–23), the crossing street's paving at its own ground far from the records (row 46))
  const N = GW * GW;
  const words = new Uint32Array(N * 8);
  const iw = new Int32Array(words.buffer);
  const fw = new Float32Array(words.buffer);
  const span = (lx: number, ly: number, h: number, aux: number) => {
    const i = ly * GW + lx;
    // (on the frame's raw ground at its window place, frame z)
    const z0 = ground(lx + place.dx, ly + place.dy) - place.dz;
    words[i * 4 + 3] = 1;
    fw[N * 4 + i * 4] = z0;
    fw[N * 4 + i * 4 + 1] = z0 + h;
    words[N * 4 + i * 4 + 2] = aux;
    if (h > 1) r.owned.set(i, { z0, z1: z0 + h });
  };
  for (let i = 0; i < N; i++) {
    iw[i * 4] = i % GW;
    iw[i * 4 + 1] = Math.floor(i / GW);
    words[i * 4 + 2] = i;
  }
  for (let ly = 17; ly <= 19; ly++) for (let lx = 33; lx <= 35; lx++) span(lx, ly, 4, MAT.Rubble);
  for (let ly = 22; ly <= 23; ly++) for (let lx = 30; lx <= 32; lx++) span(lx, ly, 4, MAT.Rubble);
  for (let lx = 2; lx < 40; lx++) span(lx, 46, 0.27, MAT.Rubble);
  const slot = r.sc.ownedSlot()!;
  dev.queue.writeBuffer(slot.binding.buffer, slot.binding.offset ?? 0, words);
  r.sc.gpuGrid('town', 0x100000, () => r.place, {
    slot,
    w: GW,
    h: GW,
    maxKey: 0,
    claimed: (rects, p) => r.layer.layRects(r.buf, r.recs.length, rects, p, [p.dx, p.dy, p.dx + GW, p.dy + GW]),
  });
  return r;
}

async function slots(r: Rig): Promise<Uint32Array> {
  const s = new Uint32Array((await r.w.core.readBuffer('layers')).buffer);
  expect(g.takeErrors()).toEqual([]);
  return s;
}

/** the land written raw over the window (a region arriving: the streamer's write) and told to the claims */
function arrive(r: Rig, regions: [number, number][]): void {
  g.device.queue.writeBuffer(r.w.core.world.layers, 0, r.w.core.packed.slots);
  for (const [lx, ly] of regions) r.sc.landWritten(lx, ly, R, R);
}

const ALL: [number, number][] = [
  [0, 0],
  [R, 0],
  [0, R],
  [R, R],
];

/** the checks every graded window passes: each road column the road's cobble at its profile (window z) with nothing
 *  over it, unless another owner holds it — then as claimed; returns how many road columns were seen */
function checkRoads(r: Rig, s: Uint32Array): { road: number; owned: number } {
  const p = r.w.core.packed;
  let road = 0;
  let owned = 0;
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      const lx = x - r.place.dx;
      const ly = y - r.place.dy;
      if (lx < 0 || ly < 0 || lx >= GW || ly >= GW) continue;
      const col = readColumn(p, s, x, y);
      const own = r.owned.get(ly * GW + lx);
      if (own) {
        const top = col[col.length - 1];
        expect(top.mat, `owned ${x},${y}`).toBe(MAT.External);
        expect(top.z1, `owned ${x},${y}`).toBeCloseTo(own.z1 + r.place.dz, 4);
        // (its ground under it as it came)
        expect(col.find((iv) => iv.mat === MAT.Soil)?.z1, `owned ${x},${y} ground`).toBeCloseTo(ground(x, y), 4);
        owned++;
        continue;
      }
      const z = onRoad(r.recs, cellPos(lx, ly));
      if (z === null) continue;
      const top = col[col.length - 1];
      expect(top.mat, `road ${x},${y}: ${JSON.stringify(col)}`).toBe(MAT.Cobble);
      expect(top.z1, `road ${x},${y}`).toBeCloseTo(z + r.place.dz, 4);
      expect(top.z1 - top.z0, `road ${x},${y}`).toBeCloseTo(0.3, 4);
      road++;
    }
  return { road, owned };
}

const same = (r: Rig, a: Uint32Array, b: Uint32Array, what: string) => {
  const p = r.w.core.packed;
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) expect(readColumn(p, a, x, y), `${what}: ${x},${y}`).toEqual(readColumn(p, b, x, y));
};

describe('streets as terrain: the town grader on arriving land (loop-streets)', () => {
  it('graded as each region arrives, the same as one lay; again the same when the land comes back raw', async () => {
    const r = await rig({ dx: 6, dy: 4, dz: -0.5 });
    try {
      // (the window's land arrives region by region: each claimed, then graded where it lies)
      r.unwritten = ALL.slice();
      arrive(r, []);
      for (const reg of ALL) {
        r.unwritten = r.unwritten.filter(([x, y]) => x !== reg[0] || y !== reg[1]);
        r.sc.landWritten(reg[0], reg[1], R, R);
      }
      const byRegion = await slots(r);
      const seen = checkRoads(r, byRegion);
      expect(seen.road).toBeGreaterThan(150);
      expect(seen.owned).toBe(15);
      const st = await r.layer.readStats();
      // (the profile cuts the east and fills the west: both)
      expect(st.roadCols).toBeGreaterThan(0);
      expect(st.shoulderCols).toBeGreaterThan(0);
      expect(st.maxMove).toBeGreaterThan(1);
      // (the crossing street's paving claimed on its own ground, untouched)
      const cross = readColumn(r.w.core.packed, byRegion, 20 + r.place.dx, 46 + r.place.dy);
      expect(cross[cross.length - 1].mat).toBe(MAT.External);
      // (laid again over what's there: unchanged)
      r.layer.layRects(r.buf, r.recs.length, [[0, 0, W, W]], r.place, [r.place.dx, r.place.dy, r.place.dx + GW, r.place.dy + GW]);
      same(r, byRegion, await slots(r), 'laid twice');
      // (the land arrives again raw — a pool thaw, a reload — every region: claimed and graded the same)
      arrive(r, ALL);
      same(r, byRegion, await slots(r), 'arrived again');
      // (one lay over the whole window after the claims: the same as region by region)
      g.device.queue.writeBuffer(r.w.core.world.layers, 0, r.w.core.packed.slots);
      r.sc.reclaim(r.sc['grids'][0]);
      same(r, byRegion, await slots(r), 'one claim and lay over all');
    } finally {
      r.layer.dispose();
      r.sc.dispose();
      r.w.destroy();
    }
  }, 120_000);

  it('a slide: the frame placed elsewhere grades where it now lies', async () => {
    const r = await rig({ dx: 6, dy: 4, dz: -0.5 });
    try {
      arrive(r, ALL);
      const before = checkRoads(r, await slots(r));
      // (the window slid 2 columns and 2 rows the other way: the town's frame lies there now, its land raw again)
      r.place = { dx: 4, dy: 2, dz: -0.5 };
      // (the owned spans were placed on the old place's ground: drop that check, keep the road's)
      r.owned.clear();
      g.device.queue.writeBuffer(r.w.core.world.layers, 0, r.w.core.packed.slots);
      r.sc.reclaim(r.sc['grids'][0]);
      const s = await slots(r);
      const p = r.w.core.packed;
      let road = 0;
      for (let y = 0; y < W; y++)
        for (let x = 0; x < W; x++) {
          const lx = x - r.place.dx;
          const ly = y - r.place.dy;
          if (lx < 0 || ly < 0 || lx >= GW || ly >= GW) continue;
          const z = onRoad(r.recs, cellPos(lx, ly));
          const col = readColumn(p, s, x, y);
          const top = col[col.length - 1];
          if (z === null || top.mat === MAT.External) continue;
          expect(top.mat, `slid road ${x},${y}`).toBe(MAT.Cobble);
          expect(top.z1, `slid road ${x},${y}`).toBeCloseTo(z + r.place.dz, 4);
          road++;
        }
      expect(road).toBeGreaterThan(before.road - 20);
    } finally {
      r.layer.dispose();
      r.sc.dispose();
      r.w.destroy();
    }
  }, 120_000);
});
