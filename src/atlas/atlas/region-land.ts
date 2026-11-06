// A region's land for the streamer: its stamps (craters, vents, ways), its land as intervals (regionLand) or made
// straight into a pool slot (regionInto), the raw ground, paced by the tile gate. API: stampsFor, regionLand,
// regionInto, rawGround (Atlas's), ventsIn, waysOf, traceOf, tileGate.
import { addTop, lowerTop } from '../../world/layout';
import { ROW_H } from '../../world/lattice';
import type { RegionLand } from '../../world/streamgen';
import { regionWays, stampWays, type RegionWays } from '../ways';
import { applyStamps, StampOps } from '../stamps';
import { type FinishMeta, type FinishTarget, type RawGround } from '../finish';
import { timed } from '../../gpu/cpustat';
import { MAX_INST, paceTile, TILE_OLD, MakeHow, WINDOW_MAKE, FINISH_TILE, MAT_SINTER, GEYSER_STENCIL, landFrom } from './defs';
import type { Atlas } from '../atlas';

/** Atlas.stampsFor (the class keeps the method, documented there) */
export async function stampsFor(atl: Atlas, x0: number, y0: number, w: number, h: number, spread: boolean, plan = true): Promise<StampOps> {
  const ops = new StampOps(w, h);
  for (const f of atl.stampHooks) await f(ops, x0, y0, w, h, spread, plan);
  return ops;
}

/** (round 102) the geysers' vents in a region (region cells) */
export function ventsIn(atl: Atlas, x0: number, y0: number, w: number, h: number): [number, number][] {
  return atl.geysersIn(x0, y0, w, h).map((g) => [g.x - x0, g.y - y0]);
}

/** (round 102) a region's ways as both paths stamp them (ways.ts regionWays) */
export function waysOf(atl: Atlas, x0: number, y0: number, w: number, h: number): RegionWays | null {
  return timed('ways', () => regionWays(atl.ways, x0, y0, w, h, (cx, cy) => [cx + 0.5 + 0.5 * (cy & 1), (cy + 0.5) * ROW_H], atl.worldW, atl.worldH));
}

/** Atlas.regionLand (the class keeps the method, documented there) */
export async function regionLand(atl: Atlas, x0: number, y0: number, w: number, h: number, K = Infinity, spread = false, raw = false): Promise<RegionLand> {
  if (y0 & 1) throw new Error('a region starts on an even row');
  const c = await atl.columns(x0, y0, w, h, spread);
  const land = timed('land', () => landFrom(c, x0, y0, K));
  atl.gapsFilled += land.gapsFilled;
  // the geysers' sinter: a low mound round each vent, its pit at the middle (round 102: GEYSER_STENCIL, as
  // finish.wgsl lays it)
  for (const [gx, gy] of ventsIn(atl, x0, y0, w, h))
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const x = gx + dx;
        const y = gy + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const st = GEYSER_STENCIL[(dy + 4) * 9 + dx + 4];
        if (!(st & 3)) continue;
        const col = land.cols[y * w + x];
        if (!col.length) continue;
        if ((st & 3) === 1) lowerTop(col, (st >>> 2) / 256);
        else addTop(col, (st >>> 2) / 256, MAT_SINTER);
        land.vegetation[y * w + x] = 0;
        land.surface[y * w + x] = col[col.length - 1].z1;
      }
  // the roads, their crossings and the sites' plazas (round 79, ways.ts)
  const rw = waysOf(atl, x0, y0, w, h);
  atl.waysStamped += timed('ways', () => stampWays(atl.ways, land, x0, y0, w, h, (cx, cy) => [cx + 0.5 + 0.5 * (cy & 1), (cy + 0.5) * ROW_H], atl.worldW, atl.worldH, rw));
  const bt = spread && !raw ? atl.builds.get(`${x0},${y0}`) : undefined;
  if (bt) bt.ways = performance.now();
  if (!raw) {
    const o = await atl.stampsFor(x0, y0, w, h, spread);
    const marks = new Float32Array(o.marks);
    timed('stamp', () => applyStamps(o, land, marks));
    o.tell(marks);
    for (const f of atl.landHooks) await f(land, x0, y0, w, h, spread);
  }
  if (bt) bt.hooks = performance.now();
  return land;
}

/** Atlas.regionInto (the class keeps the method, documented there) */
export async function regionInto(atl: Atlas, x0: number, y0: number, w: number, h: number, target: FinishTarget, how: MakeHow = WINDOW_MAKE): Promise<FinishMeta | null> {
  if (y0 & 1) throw new Error('a region starts on an even row');
  const spread = how.pace !== 'none';
  // (the pacer's lanes: the tiles' first — a render-only tile is the latency the screen waits on — or the streamer's)
  const gate = how.pace === 'tile' ? () => atl.pacer.next(true, how.order ?? 0) : spread ? () => tileGate(atl) : undefined;
  // (the stamps asked for first: a settlement's plan runs while the columns are made)
  const ops = atl.stampsFor(x0, y0, w, h, spread, how.stamps === 'plan');
  const c = await atl.columnsGpu(x0, y0, w, h, spread, gate);
  try {
    const rw = waysOf(atl, x0, y0, w, h);
    const o = await ops;
    const bt = how.pace === 'stream' ? atl.builds.get(`${x0},${y0}`) : undefined;
    if (bt) bt.ways = performance.now();
    const { meta } = await atl.finisher.run(c, x0, y0, rw, ventsIn(atl, x0, y0, w, h), GEYSER_STENCIL, o, target, atl.profiler, gate, paceTile(Math.max(w, h), FINISH_TILE), how.summary);
    atl.gpuMade++;
    if (how.summary) return null;
    if (bt) bt.mapped = bt.hooks = performance.now();
    if (meta!.forms > MAX_INST) throw new Error(`atlas: ${meta!.forms} forms around the batch at ${x0},${y0} (room for ${MAX_INST})`);
    o.tell(meta!.marks);
    return meta!;
  } finally {
    c.done();
  }
}

/** Atlas.rawGround (the class keeps the method, documented there) */
export async function rawGround(atl: Atlas, x0: number, y0: number, w: number, h: number, spread = false): Promise<RawGround> {
  const T = 64;
  if (y0 & 1) throw new Error('a raw box starts on an even row');
  if (w % T || h % T) throw new Error(`a raw box is whole tiles of ${T}`);
  const N = w * h;
  const out: RawGround = { ground: new Float32Array(N), water: new Float32Array(N), top: new Uint8Array(N), veg: new Float32Array(N) };
  const tiles: [number, number][] = [];
  for (let ty = 0; ty < h; ty += T) for (let tx = 0; tx < w; tx += T) tiles.push([tx, ty]);
  await Promise.all(
    tiles.map(async ([tx, ty]) => {
      const c = await atl.columnsGpu(x0 + tx, y0 + ty, T, T, spread);
      let raw: RawGround;
      try {
        const r = await atl.finisher.run(c, x0 + tx, y0 + ty, waysOf(atl, x0 + tx, y0 + ty, T, T), ventsIn(atl, x0 + tx, y0 + ty, T, T), GEYSER_STENCIL, null, null, atl.profiler, spread ? () => tileGate(atl) : undefined, FINISH_TILE);
        raw = r.raw!;
      } finally {
        c.done();
      }
      atl.gpuRaw++;
      for (let y = 0; y < T; y++) {
        const j = (ty + y) * w + tx;
        out.ground.set(raw.ground.subarray(y * T, (y + 1) * T), j);
        out.water.set(raw.water.subarray(y * T, (y + 1) * T), j);
        out.top.set(raw.top.subarray(y * T, (y + 1) * T), j);
        out.veg.set(raw.veg.subarray(y * T, (y + 1) * T), j);
      }
    }),
  );
  return out;
}

export function traceOf(atl: Atlas, x0: number, y0: number) {
  const b = { t0: performance.now(), tiles: [] as number[], mapped: 0, ways: 0, hooks: 0 };
  atl.builds.set(`${x0},${y0}`, b);
  if (atl.builds.size > 400) atl.builds.delete(atl.builds.keys().next().value!);
  return b;
}

export function tileGate(atl: Atlas): Promise<void> {
  if (!TILE_OLD) return atl.pacer.next();
  const p = atl.gate.then(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  atl.gate = p;
  return p;
}
