// (round 128m, townlab) The placement bench's diagnosis, on the game only: on the Pixel 9a every placement was refused
// ("A cliff or a building is in the way", 0 kept of 270) where the desktop kept 207, and the phone's town wasn't the
// desktop's (the stores at 207,156 against 159,176). What the report needs to tell why, read once at the end of a run:
// where the town and the fortress's box are, the reach's surfaces at the stores' column (the GPU's, 32 bytes), and the
// same ask answered by the CPU reference (fortress/reach.ts CpuReach) over the window's columns read back once — the
// GPU's answers and the CPU's side by side. A bench's reads, never the game's.
import type { Fortress } from '../../fortress/fortress';
import { CpuReach, surfacesOf, type ReachAsk, type ReachColumns, type ReachEngine } from '../../fortress/reach';
import type { FortressReachGpu } from '../../fortress/reachgpu';
import { unpackColumns } from '../../world/mapfile';
import { MATERIALS, MatState } from '../../world/materials';
import type { PackedWorld } from '../../world/layout';
import type { PlacePoint } from './points';

export interface DiagnoseIO {
  fort: Fortress;
  readBuffer(name: 'layers' | 'water'): Promise<Float32Array>;
  packed: PackedWorld;
  dims: { w: number; h: number };
  windowOrigin: [number, number];
  town: { id: string | null; name: string | null };
  heightAt(x: number, y: number): number;
}

export interface Diagnosis {
  town: { id: string | null; name: string | null };
  windowOrigin: [number, number];
  window: { w: number; h: number };
  box: { origin: [number, number]; w: number; h: number; offset: [number, number] };
  stores: [number, number];
  /** the stores' box column, the ground the game reads there (the surface buffer's top) */
  storesCol: number;
  storesGround: number;
  /** the reach's surfaces at the stores' column, the top first ([height, room over it]): the GPU's and the CPU's */
  storesSurfacesGpu: [number, number][];
  storesSurfacesCpu: [number, number][];
  /** per point (its cell's stands): the GPU's answer bits and the CPU reference's, for the same ask */
  points: { name: string; cell: number; gpu: number; cpu: number }[];
  agree: number;
  gpuMs: number;
  cpuMs: number;
}

export async function diagnose(io: DiagnoseIO, points: PlacePoint[]): Promise<Diagnosis> {
  const f = io.fort;
  const fi = f as unknown as { io: { reach?: ReachEngine }; spansNow(): Uint32Array; standCols(c: number): number[]; boxColOf(x: number, y: number): number };
  const gpu = fi.io.reach as FortressReachGpu | undefined;
  if (!gpu) throw new Error('diagnose: no reach engine');
  await f.settled();
  const stores = f.storesAt()!;
  const sc = fi.boxColOf(...f.toBox(stores[0], stores[1]));
  const { w: bw, h: bh } = f.box;
  const cells = points.map((p) => f.cellAt(p.at[0], p.at[1]));
  const queries = new Int32Array(cells.length * 4).fill(-1);
  cells.forEach((c, i) => c >= 0 && fi.standCols(c).forEach((b, k) => (queries[i * 4 + k] = b)));
  const ask: ReachAsk = { stores: sc >= 0 ? [sc % bw, Math.floor(sc / bw)] : null, queries, wet: false, why: true };
  const spans = fi.spansNow();
  gpu.setSpans(spans);
  const g0 = performance.now();
  const g = await gpu.check(ask);
  const gpuMs = Math.round(performance.now() - g0);
  const storesSurfacesGpu = sc >= 0 ? await gpu.surfacesAt(sc) : [];
  // the CPU reference over the window's columns, read back once
  const [layers, water] = await Promise.all([io.readBuffer('layers'), io.readBuffer('water')]);
  const grid = unpackColumns(io.packed, new Uint32Array(layers.buffer));
  const { w, h } = io.dims;
  const solid = (m: number) => {
    const st = MATERIALS[m]?.state;
    return st === MatState.Solid || st === MatState.Granular;
  };
  const cols: ReachColumns = {
    w,
    h,
    runs: (x, y) => grid.col(x, y).filter((iv) => solid(iv.mat)).map((iv) => [iv.z0, iv.z1] as [number, number]),
    water: (x, y) => water[y * w + x],
  };
  const cpu = new CpuReach(cols, bw, bh, () => f.offset());
  cpu.setSpans(spans);
  const c0 = performance.now();
  const c = await cpu.check(ask);
  const cpuMs = Math.round(performance.now() - c0);
  const [ox, oy] = f.offset();
  const sx = sc >= 0 ? (sc % bw) + ox : -1;
  const sy = sc >= 0 ? Math.floor(sc / bw) + oy : -1;
  const storesSurfacesCpu = sx >= 0 && sx < w && sy >= 0 && sy < h ? surfacesOf(cols.runs(sx, sy)).map((s) => [+s.z.toFixed(2), +s.head.toFixed(2)] as [number, number]) : [];
  const pts = points.map((p, i) => ({ name: p.name, cell: cells[i], gpu: g.bits[i], cpu: c.bits[i] }));
  return {
    town: io.town,
    windowOrigin: io.windowOrigin,
    window: { w, h },
    box: { origin: [f.box.origin[0], f.box.origin[1]], w: bw, h: bh, offset: [ox, oy] },
    stores: [+stores[0].toFixed(1), +stores[1].toFixed(1)],
    storesCol: sc,
    storesGround: +io.heightAt(stores[0], stores[1]).toFixed(2),
    storesSurfacesGpu,
    storesSurfacesCpu,
    points: pts,
    agree: pts.filter((p) => (p.gpu & 1) === (p.cpu & 1)).length,
    gpuMs,
    cpuMs,
  };
}

/** the diagnosis in plain lines (the summary's end) */
export function diagnosisLines(d: Diagnosis): string[] {
  const reached = (k: 'gpu' | 'cpu') => d.points.filter((p) => p[k] & 1).length;
  const s = (v: [number, number][]) => (v.length ? v.map(([z, r]) => `${z} m (${r} m over it)`).join(', ') : 'none');
  return [
    `Town ${d.town.name ?? '?'} (${d.town.id ?? '?'}); window at ${d.windowOrigin.join(', ')}, the fortress's land at ${d.box.offset.join(', ')} in it.`,
    `The stores at ${d.stores.join(', ')}: ground ${d.storesGround} m. Walkable levels there, GPU: ${s(d.storesSurfacesGpu)}; CPU: ${s(d.storesSurfacesCpu)}.`,
    `Reached from the stores: GPU ${reached('gpu')} of ${d.points.length} points, CPU ${reached('cpu')}. They agree on ${d.agree}.`,
  ];
}
