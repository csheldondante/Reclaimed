// Debris and impacts: the bodies' projection on the ground, the body budget, impacts that break bodies, voxels
// turned loose (with chips and dust), batched. API: resetProjection, project, keepBudget, impact, toLoose, chips,
// flushLoose.
import { MAT } from '../../world/materials';
import { type Body } from '../bodies';
import { cellPos, ROW_H } from '../../world/lattice';
import { looseFrom, type ApplyStage } from '../colapply';
import { edit } from './columns';
import { IMP, impactRadius, impactReach, mainMat } from './defs';
import { Integrity } from '../integrity';

export function resetProjection(ig: Integrity): void {
  for (let i = 0; i < ig.proj.length; i += 4) {
    ig.proj[i] = -1;
    ig.proj[i + 1] = 0;
    ig.proj[i + 2] = 0;
  }
}

export function project(ig: Integrity): void {
  const sleeping = ig.bodies.list.some((b) => b.asleep);
  if (!sleeping && !ig.projected) return;
  ig.projected = sleeping;
  resetProjection(ig);
  const { w: W, h: H } = ig.core.dims;
  const P = ig.proj;
  const ring = ig.core.ring;
  for (const b of ig.bodies.list) {
    if (!b.asleep) continue;
    ig.bodies.voxelBounds(b, (lo, hi) => {
      // (the cells whose centres the voxel's box covers: the grid is hex)
      for (let y = Math.max(0, Math.floor((lo[1] + 0.15) / ROW_H - 0.5)); y <= Math.min(H - 1, Math.ceil((hi[1] - 0.15) / ROW_H - 0.5)); y++)
        for (let x = Math.max(0, Math.floor(lo[0] - 1)); x <= Math.min(W - 1, Math.ceil(hi[0])); x++) {
          const [cx, cy] = cellPos(x, y);
          if (cx < lo[0] + 0.15 || cx > hi[0] - 0.15 || cy < lo[1] + 0.15 || cy > hi[1] - 0.15) continue;
          // (round 106: on the window's ring, as the texture: written whole, not rotated)
          const i = ring.t(x, y) * 4;
          if (P[i] < 0) {
            P[i] = hi[2];
            P[i + 1] = lo[2];
            P[i + 2] = b.id;
          } else {
            if (hi[2] > P[i]) P[i + 2] = b.id;
            P[i] = Math.max(P[i], hi[2]);
            P[i + 1] = Math.min(P[i + 1], lo[2]);
          }
        }
    });
  }
  const dev = ig.core.host.gpu.device;
  // (ringwin: in the ring's order — round 106: kept so)
  dev.queue.writeTexture({ texture: ig.core.world.bodyCpu }, P as Float32Array<ArrayBuffer>, { bytesPerRow: W * 16 }, [W, H]);
  // (round 104, simscale: written whole, so projected whole next tick — grids/systems.ts ProjectSystem)
  ig.core.world.projectAll = true;
}

/**
 * Over budget (DECISIONS round 17: about 64 sleeping bodies, 16k voxels):
 * the oldest small sleeping bodies crumble into loose ground where they lie
 * (the oldest of all if none is small).
 */
export function keepBudget(ig: Integrity): void {
  for (;;) {
    const sleeping = ig.bodies.list.filter((b) => b.asleep);
    const voxels = sleeping.reduce((s, b) => s + b.local.length, 0);
    if (sleeping.length <= Integrity.MAX_SLEEPING && voxels <= Integrity.MAX_SLEEP_VOXELS) return;
    const byAge = sleeping.sort((a, b) => a.sleptAt - b.sleptAt);
    const victim = byAge.find((b) => b.local.length < 200) ?? byAge[0];
    ig.crumble(victim);
  }
}

/** A body hit something at `speed` (cells/s) at world point `at`. */
export function impact(ig: Integrity, b: Body, speed: number, at: [number, number, number]): void {
  ig.stats.impacts++;
  const mat = mainMat(b.local);
  ig.onDust?.(at[0], at[1], at[2], Math.min(40, Math.round(4 + speed * 4)), 0.6 + speed * 0.2, mat);
  if (speed < IMP.breakSpeed) {
    ig.onCollapse?.(at[0], at[1], at[2], b.local.length * speed * 0.05);
    return;
  }
  const weak = b.local.reduce((s, v) => s + impactReach(v.mat), 0) / b.local.length;
  const k = Math.min(8, Math.floor((weak * speed * speed * b.local.length) / IMP.shatter));
  const shards = ig.bodies.shatter(b, at, k, IMP.crumb);
  const { removed, crumbs } = ig.bodies.breakAt(at, impactRadius(speed), IMP.crumb, impactReach);
  crumbs.push(...shards);
  if (k >= 2) ig.stats.shatters++;
  ig.onCollapse?.(at[0], at[1], at[2], removed.length + crumbs.length + b.local.length * speed * 0.05);
  if (!removed.length && !crumbs.length) return;
  ig.stats.shattered += removed.length + crumbs.length;
  ig.onDust?.(at[0], at[1], at[2], Math.min(60, 10 + removed.length * 3), impactRadius(speed) + 0.5, mat);
  toLoose(ig, [...removed, ...crumbs]);
  project(ig);
}

/** Voxels (world centres) into loose ground at the columns under them. */
export function toLoose(ig: Integrity, vox: { p: [number, number, number]; mat: number }[], chipSpeed?: number): void {
  const { w: W, h: H } = ig.core.dims;
  const add = ig.pendingLoose;
  for (const v of vox) {
    const x = Math.floor(v.p[0]);
    const y = Math.floor(v.p[1]);
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const i = y * W + x;
    const m = looseFrom(v.mat);
    const e = add.get(i) ?? { amount: 0, mats: new Map() };
    e.amount += 1;
    e.mats.set(m, (e.mats.get(m) ?? 0) + 1);
    add.set(i, e);
  }
  chips(ig, vox.map((v) => v.p), 1, chipSpeed);
}

/**
 * Chips at some points, `each` per point, as one burst per column (the
 * particle queue holds 64 bursts a tick; one per voxel crowded out the
 * dust clouds).
 */
export function chips(ig: Integrity, pts: [number, number, number][], each: number, speed?: number): void {
  const cols = new Map<string, { p: [number, number, number]; n: number }>();
  for (const p of pts) {
    const k = `${Math.floor(p[0])},${Math.floor(p[1])}`;
    const e = cols.get(k);
    if (e) {
      e.n += each;
      e.p[2] = Math.max(e.p[2], p[2]);
    } else cols.set(k, { p: [...p], n: each });
  }
  // (round 86: the points are column indices + 0.5 — the particles want the world's: the hex lattice's)
  for (const { p, n } of cols.values()) {
    const [wx, wy] = cellPos(Math.floor(p[0]), Math.floor(p[1]));
    ig.onChips?.(wx, wy, p[2], Math.min(12, n), speed);
  }
}

/**
 * The loose ground gathered this frame laid through the deposit (sediment.wgsl folds it into the layers). Round 120,
 * JB6: added to it on the GPU (colapply depositAdd) — the edit pass's blows and the verdicts' spills add to it too, so
 * no write overwrites another's (it was written over from the CPU, at most once every two ticks).
 */
export function flushLoose(ig: Integrity): void {
  if (!ig.pendingLoose.size) return;
  const W = ig.core.dims.w;
  const deposits: NonNullable<ApplyStage['deposits']> = [];
  for (const [i, e] of ig.pendingLoose) {
    let best: number = MAT.Rubble;
    let n = -1;
    for (const [m, c] of e.mats) if (c > n) [best, n] = [m, c];
    deposits.push({ x: i % W, y: Math.floor(i / W), amount: e.amount, mat: best });
  }
  ig.pendingLoose.clear();
  edit(ig, [{ cuts: [], deposits }]);
}
