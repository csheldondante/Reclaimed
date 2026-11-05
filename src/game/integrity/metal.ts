// Metal (and what bends) on the node solver: taking a fracture's metal, waking a ruin's metal into deformable
// bodies, and the blows that reach it. API: takeMetal, wakeMetal, wakeMetalNow, metalBlows, wakeMetalNear.
import { type Interval } from '../../world/layout';
import { type Fracture, type Voxel } from '../fracture';
import { ignoreTeardown } from '../../gpu/pipeline';
import { cellAt, cellPos, nbr } from '../../world/lattice';
import type { SolverBody } from '../../api/contracts/solver';
import { type ApplyStage } from '../colapply';
import { withColumns } from './tick';
import { meshFor } from './rigid';
import { edit, touchCols } from './columns';
import { spawnLattice } from './lattice';
import { WOOD, METAL_MAX, WAKE_HIT } from './defs';
import type { Integrity } from '../integrity';

/** (round 96) The metal in what the judges found taken out of it, and woken (wakeMetal) where it was. */
export function takeMetal(ig: Integrity, r: Fracture): void {
  const at: [number, number, number][] = [];
  const strip = (rp: { x: number; y: number; ivs: { z0: number; z1: number; mat: number }[] }[] | undefined) => {
    for (const c of rp ?? []) {
      const keep = c.ivs.filter((iv) => !ig.bends(iv.mat));
      if (keep.length !== c.ivs.length) for (const iv of c.ivs) if (ig.bends(iv.mat)) at.push([c.x, c.y, Math.floor((iv.z0 + iv.z1) / 2)]);
      c.ivs = keep;
    }
  };
  for (const p of r.pieces ?? []) strip(p);
  if (r.pieces) r.pieces = r.pieces.map((p) => p.filter((c) => c.ivs.length));
  strip(r.crumbleRuns);
  if (r.crumbleRuns) r.crumbleRuns = r.crumbleRuns.filter((c) => c.ivs.length);
  const cellsOut = (vs: Voxel[]) => {
    for (const v of vs) if (ig.bends(v.mat)) at.push([v.x, v.y, v.z]);
    return vs.filter((v) => !ig.bends(v.mat));
  };
  r.crumble = cellsOut(r.crumble);
  r.bodies = r.bodies.map(cellsOut).filter((b) => b.length);
  // (round 120, JB6: sparse, when the columns round it have come; meanwhile it's left in them, judged again)
  if (at.length) void wakeMetal(ig, at).catch(ignoreTeardown);
}

/**
 * (round 96) The metal connected to these cells (column x, y, cell z), out of the columns into the node solver
 * (solver step 2; it was the physics voxels) as one deformable body — it bends, dents and snaps — a cell resting on
 * other ground pinned (a foundation: wake.ts), drawn as its cells riding its nodes (or its mesh skinned to them,
 * ?rbskin=1). (Round 120, JB6: the columns round them read where they lie — the copy, or fetched `margin` columns
 * round the seeds, and again twice as far when what the metal connects to reaches past them.)
 */
export async function wakeMetal(ig: Integrity, seeds: [number, number, number][], margin = 24): Promise<void> {
  if (!seeds.length) return;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of seeds) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
  const got = await withColumns(ig, ig.cols.chunksIn(x0 - margin, y0 - margin, x1 + margin, y1 + margin), () => wakeMetalNow(ig, seeds));
  if (got === 'more' && margin < 512) await wakeMetal(ig, seeds, margin * 2);
}

/** wakeMetal with the columns readable: 'more' (nothing done) when the metal reaches columns not held */
export function wakeMetalNow(ig: Integrity, seeds: [number, number, number][]): 'done' | 'more' {
  const solver = ig.solver;
  const { w: W, h: H } = ig.core.dims;
  const cols = new Map<number, Interval[]>();
  let short = false;
  const colAt = (x: number, y: number) => {
    const k = y * 65536 + x;
    let c = cols.get(k);
    if (!c) {
      if (!ig.cols.has(x, y)) {
        short = true;
        c = [];
      } else c = ig.cols.read(x, y);
      cols.set(k, c);
    }
    return c;
  };
  const key = (x: number, y: number, z: number) => (z * 8192 + y) * 8192 + x;
  /** the metal cell at (x, y, z): its material, and whether it rests on other ground */
  const metalAt = (x: number, y: number, z: number): { mat: number; pin: boolean } | null => {
    if (x < 0 || y < 0 || x >= W || y >= H || z < 0) return null;
    const col = colAt(x, y);
    for (let k = 0; k < col.length; k++) {
      const iv = col[k];
      // (any metal in the cell, a sliver too: what a meteor's melt left of a member is taken with it, not left floating)
      if (!ig.bends(iv.mat) || iv.z1 <= z + 0.01 || iv.z0 >= z + 0.99) continue;
      const below = k > 0 ? col[k - 1] : null;
      const pin = z === Math.floor(iv.z0 + 0.01) && (iv.z0 < 1e-3 || (!!below && Math.abs(below.z1 - iv.z0) < 1e-3 && !ig.bends(below.mat)));
      return { mat: iv.mat, pin };
    }
    return null;
  };
  const cells = new Map<number, { x: number; y: number; z: number; mat: number; pin: boolean }>();
  const queue: number[] = [];
  for (const [x, y, z] of seeds) {
    for (let dz = -1; dz <= 1; dz++) {
      const c = metalAt(x, y, z + dz);
      const k = key(x, y, z + dz);
      if (c && !cells.has(k)) {
        cells.set(k, { x, y, z: z + dz, ...c });
        queue.push(k);
      }
    }
  }
  for (let q = 0; q < queue.length && cells.size < METAL_MAX; q++) {
    const c = cells.get(queue[q])!;
    const around: [number, number][] = [[c.x, c.y]];
    for (let d = 0; d < 6; d++) around.push(nbr(c.x, c.y, d));
    for (const [nx, ny] of around)
      for (let dz = -1; dz <= 1; dz++) {
        const k = key(nx, ny, c.z + dz);
        if (cells.has(k)) continue;
        const n = metalAt(nx, ny, c.z + dz);
        if (!n) continue;
        cells.set(k, { x: nx, y: ny, z: c.z + dz, ...n });
        queue.push(k);
      }
  }
  if (short) return 'more';
  if (!cells.size) return 'done';
  let lo: [number, number, number] = [Infinity, Infinity, Infinity];
  let hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const c of cells.values()) {
    lo = [Math.min(lo[0], c.x), Math.min(lo[1], c.y), Math.min(lo[2], c.z)];
    hi = [Math.max(hi[0], c.x), Math.max(hi[1], c.y), Math.max(hi[2], c.z)];
  }
  const list = [...cells.values()];
  const mats = new Map<number, number>();
  for (const c of list) mats.set(c.mat, (mats.get(c.mat) ?? 0) + 1);
  const mat = [...mats].sort((a, b) => b[1] - a[1])[0][0];
  const pins = new Set(list.filter((c) => c.pin).map((c) => key(c.x, c.y, c.z)));
  const plain = list.map((c) => ({ x: c.x, y: c.y, z: c.z, mat: c.mat }));
  // (the variant's: the voxel lattice — the physics voxels, drawn as their own voxels — or the node solver)
  let body: SolverBody | null = null;
  if (ig.route.metal === 'lattice') {
    if (!spawnLattice(ig, plain, (c) => pins.has(key(c.x, c.y, c.z)))) return 'done';
  } else {
    body = solver!.add({ cells: plain, pinned: (c) => pins.has(key(c.x, c.y, c.z)), kind: 'deformable' });
    if (!body) return 'done';
  }
  // out of the columns (round 120, JB6: on the GPU, and the copy where it's kept) — only the metal goes: what else
  // shares those heights stays, so each cell's cut is the metal's own part of it
  const byCol = new Map<number, { z0: number; z1: number }[]>();
  for (const c of cells.values()) {
    const k = c.y * 65536 + c.x;
    const l = byCol.get(k) ?? [];
    for (const iv of colAt(c.x, c.y)) {
      if (!ig.bends(iv.mat)) continue;
      const a = Math.max(iv.z0, c.z);
      const b = Math.min(iv.z1, c.z + 1);
      if (b > a) l.push({ z0: a, z1: b });
    }
    byCol.set(k, l);
  }
  const touched: { x: number; y: number }[] = [];
  const cuts: ApplyStage['cuts'] = [];
  for (const [k, cut] of byCol) {
    const x = k % 65536;
    const y = Math.floor(k / 65536);
    cuts.push({ x, y, cuts: cut });
    touched.push({ x, y });
    ig.rockSeeds.set(k, 2);
  }
  edit(ig, [{ cuts }]);
  touchCols(ig, touched, true);
  ig.urgent = true;
  if (body) ig.metal.push({ body, mesh: meshFor(ig, body, plain), mat });
  ig.stats.bodies++;
  ig.stats.metal = (ig.stats.metal ?? 0) + list.length;
  const [fx, fy] = cellPos(Math.round((lo[0] + hi[0]) / 2), Math.round((lo[1] + hi[1]) / 2));
  ig.onCollapse?.(fx, fy, lo[2] + 0.5, list.length * 0.1);
  return 'done';
}

export function metalBlows(ig: Integrity): void {
  if (!ig.solver) return;
  for (const mb of ig.metal) {
    const r = ig.solver.read(mb.body);
    if (!r?.impact || r.impact.speed < 2.5 || ig.metalTick.get(mb.body) === r.tick) continue;
    ig.metalTick.set(mb.body, r.tick);
    const e = 0.5 * r.mass * r.impact.speed * r.impact.speed;
    const [x, y, z] = r.impact.at;
    // (round 120) the map's metal it struck wakes too (a girder dropped on a parked car: both bend)
    if (r.impact.speed > WAKE_HIT) ig.wakeMetalNear(x, y, z, 1.5);
    // (round 120) and hard ground struck hard gives
    ig.groundBlow(x, y, z, e, 0.6 * Math.cbrt(mb.body.cells));
    const n = Math.min(40, Math.round(Math.sqrt(e) / 12));
    if (n < 1) continue;
    // (metal sparks; wood splinters and dusts)
    if (WOOD.has(mb.mat)) ig.onDust?.(x, y, z + 0.2, n, 0.8 + r.impact.speed * 0.1, mb.mat);
    else ig.onSparks?.(x, y, z + 0.2, Math.min(24, n), 1.5 + r.impact.speed * 0.4);
    ig.onChips?.(x, y, z + 0.2, Math.ceil(n / 2), 2 + r.impact.speed * 0.3);
    ig.onCollapse?.(x, y, z, Math.min(400, e / 400));
  }
}

/** Integrity.wakeMetalNear (the class keeps the method, documented there) */
export async function wakeMetalNear(ig: Integrity, x: number, y: number, z: number, r: number): Promise<boolean> {
  if (!ig.rigid || !ig.metalSolver) return false;
  const { w: W, h: H } = ig.core.dims;
  const [cx, cy] = cellAt(x, y);
  const R = Math.ceil(r) + 1;
  const seeds = await withColumns(ig, ig.cols.chunksIn(cx - R, cy - R * 2, cx + R, cy + R * 2), () => {
    const out: [number, number, number][] = [];
    for (let j = cy - R * 2; j <= cy + R * 2; j++)
      for (let i = cx - R; i <= cx + R; i++) {
        if (i < 0 || j < 0 || i >= W || j >= H) continue;
        const [px, py] = cellPos(i, j);
        if (Math.hypot(px - x, py - y) > r + 0.5) continue;
        for (const iv of ig.cols.read(i, j)) {
          if (!ig.bends(iv.mat)) continue;
          if (z >= 0 && (iv.z1 < z - r || iv.z0 > z + r)) continue;
          const lo = z >= 0 ? Math.max(iv.z0, z - r) : iv.z0;
          out.push([i, j, Math.floor(Math.min(lo + 0.01, iv.z1 - 0.01))]);
        }
      }
    // (kept: woken now, as it was found)
    if (out.length && ig.cols.mode === 'kept') wakeMetalNow(ig, out);
    return out;
  });
  if (!seeds?.length) return false;
  if (ig.cols.mode === 'sparse') await wakeMetal(ig, seeds);
  return true;
}
