// Integrity's writes to the world's columns: a falling body's landing and touch, column writes on the CPU copy and
// the GPU, and the staged GPU edit. API: touch, land, touchCols, writeColumn, gpuCols, edit.
import { columnSlots, type Interval } from '../../world/layout';
import { cellPos, nbr, ROW_H } from '../../world/lattice';
import { subtract, type FallingBody, type Landing } from '../colbodies';
import { claimColumn, claimFreeColumn, releaseSpan } from '../../sim/external';
import { cutColumn, type ApplyStage, type GpuColumns } from '../colapply';
import { toLoose } from './loose';
import { IMP, impactRadius, impactReach } from './defs';
import type { Integrity } from '../integrity';

/** (round 86) a piece's columns changed: the chunks over them meshed the next frame (and voxels, in the hybrid), their sim awake */
export function touch(ig: Integrity, b: FallingBody, first: boolean): void {
  const [x0, y0] = cellPos(b.box[0], b.box[1]);
  const [x1, y1] = cellPos(b.box[2], b.box[3]);
  ig.core.renderer.fieldMesh.urgent(x0 - 1, y0 - 1, x1 + 1, y1 + 1);
  if (first) ig.onTouched?.(x0 - 1, y0 - 1, x1 + 1, y1 + 1);
  ig.core.sleep?.wake((x0 + x1) / 2, (y0 + y1) / 2, Math.max(x1 - x0, y1 - y0) / 2 + 8, 4, performance.now() / 1000);
}

/**
 * (round 86) A piece came down: hit hard (IMP.breakSpeed), the rim of its foot crumbles round where it struck
 * first — rubble, chips thrown, dust — a small one all of it; the rest is ground again where it lies, and its
 * columns are judged (what overhangs where it landed hangs).
 */
export function land(ig: Integrity, l: Landing): void {
  const b = l.body;
  const [hx, hy] = cellPos(l.at[0], l.at[1]);
  const hz = l.at[2];
  // (it didn't fall: it was resting on something — ground again, quietly)
  if (b.dz > -0.05) {
    ig.falling.commit(b);
    return;
  }
  ig.stats.impacts++;
  ig.onDust?.(hx, hy, hz, Math.min(40, Math.round(4 + l.speed * 4)), 0.6 + l.speed * 0.2 + Math.sqrt(b.cols.length) * 0.3, b.mat);
  const removed: { p: [number, number, number]; mat: number }[] = [];
  if (l.speed >= IMP.breakSpeed && !b.broke) {
    const small = b.cells <= IMP.crumb;
    const R = small ? Infinity : impactRadius(l.speed) * impactReach(b.mat) + 0.5;
    const inPiece = new Set(b.cols.map((c) => c.y * 65536 + c.x));
    for (const c of b.cols) {
      const [cx, cy] = cellPos(c.x, c.y);
      const dxy = Math.hypot(cx - hx, cy - hy);
      if (dxy > R) continue;
      // (only the rim: a column with all six neighbours in the piece is its core, and holds the rest up)
      let n = 0;
      for (let k = 0; k < 6; k++) {
        const [nx, ny] = nbr(c.x, c.y, k);
        if (inPiece.has(ny * 65536 + nx)) n++;
      }
      if (!small && n === 6) continue;
      const cut: { z0: number; z1: number }[] = [];
      for (const iv of c.ivs) {
        const z0 = iv.z0 + b.dz;
        const z1 = iv.z1 + b.dz;
        for (let z = Math.floor(z0); z < z1; z++) {
          const lo = Math.max(z, z0);
          const hi = Math.min(z + 1, z1);
          if (hi - lo < 1e-3 || Math.hypot(dxy, (lo + hi) / 2 - hz) > R) continue;
          cut.push({ z0: lo - b.dz, z1: hi - b.dz });
          removed.push({ p: [c.x + 0.5, c.y + 0.5, (lo + hi) / 2], mat: iv.mat });
        }
      }
      if (cut.length) c.ivs = subtract(c.ivs, cut);
    }
    if (removed.length) {
      ig.stats.shatters++;
      ig.stats.shattered += removed.length;
      ig.onDust?.(hx, hy, hz, Math.min(60, 10 + removed.length * 3), impactRadius(l.speed) + 0.5, b.mat);
    }
  }
  ig.onCollapse?.(hx, hy, hz, removed.length + b.cells * l.speed * 0.05);
  // (round 96) its foot crumbled: it settles on down onto what's under it, gently, rather than being ground again
  // over the gap the crumbs left — judged hanging, it fell and crumbled again each time it landed (floatsweep's
  // 3-wide, 100-tall tower, a few cells a fall, never settling)
  if (removed.length && b.cells > removed.length) {
    b.broke = true;
    b.vz = 0;
    toLoose(ig, removed, l.speed * 1.5);
    touch(ig, b, false);
    return;
  }
  ig.falling.commit(b);
  // (thrown: chips flying from what broke, faster the harder it hit)
  if (removed.length) {
    toLoose(ig, removed, l.speed * 1.5);
  }
  touch(ig, b, false);
  // what it landed on and what of it overhangs: judged (rock), looked at (structures)
  // (round 96: judged for floating only — weighed, a tall piece landed on uneven ground was judged off its "leg" each
  // time it came to rest, slumping a cell a pass: floatsweep's 3-wide 100-tall tower never settled)
  for (const c of b.cols) ig.rockSeeds.set(c.y * 65536 + c.x, 1);
  ig.urgent = true;
}

/** (round 95) columns changed: the chunks over them meshed again (voxels, in the hybrid), their sim awake */
export function touchCols(ig: Integrity, cols: { x: number; y: number }[], first: boolean): void {
  if (!cols.length) return;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of cols) {
    x0 = Math.min(x0, c.x);
    y0 = Math.min(y0, c.y);
    x1 = Math.max(x1, c.x);
    y1 = Math.max(y1, c.y);
  }
  touch(ig, { box: [x0, y0, x1, y1] } as FallingBody, first);
  // (round 120: the ground there changed — what of the voxel lattice slept on it looks again)
  if (ig.physics) {
    const [ax, ay] = cellPos(x0, y0);
    const [bx, by] = cellPos(x1, y1);
    ig.physics.wakeNear((ax + bx) / 2, (ay + by) / 2, Math.hypot(bx - ax, by - ay) / 2 + 1);
  }
}

/** A column written (to the CPU copy, the GPU's layers or both; round 86: either alone, for the falling pieces). */
export function writeColumn(ig: Integrity, x: number, y: number, col: Interval[], cpu = true, gpu = true): void {
  ig.cols.write(x, y, col, cpu, gpu);
}

/** (round 120, JB6) the GPU's columns as colapply and colquery take them */
export function gpuCols(ig: Integrity): GpuColumns {
  return ig.core.columnsGpu();
}

/**
 * (round 120, JB6) Changes to the columns made by the GPU in place (game/colapply.ts: cuts, crumbs spilled, loose ground
 * laid, External let go) — and, where the CPU keeps its copy, made to the copy too by the CPU's statement of each rule,
 * so it stays the GPU's. The columns changed are woken.
 */
export function edit(ig: Integrity, stages: ApplyStage[]): void {
  if (!stages.some((s) => s.cuts.length || s.spill?.length || s.deposits?.length || s.release?.length || s.claim?.length || s.claimFree?.length)) return;
  if (stages.some((s) => s.take || s.seat)) throw new Error('Integrity.edit: take and seat are WorldCore.stampColumns\' (the copy isn\'t told of them)');
  const ring = ig.core.ring;
  ig.gpuEdit.run(gpuCols(ig), stages, { deposit: ig.core.world.deposit, pages: ring.slots(0, 0, ig.core.dims.w, ig.core.dims.h) });
  const zMax = ig.core.dims.zMax;
  const touched = new Set<number>();
  for (const st of stages) {
    const cuts = new Map<number, { z0: number; z1: number }[]>();
    for (const c of st.cuts) {
      const k = c.y * 65536 + c.x;
      cuts.set(k, [...(cuts.get(k) ?? []), ...c.cuts]);
    }
    for (const [k, cs] of cuts) {
      const x = k % 65536;
      const y = Math.floor(k / 65536);
      touched.add(k);
      if (ig.cols.has(x, y)) ig.cols.mirror(x, y, cutColumn(ig.cols.read(x, y), cs, columnSlots(ig.core.packed, x, y).k, zMax));
    }
    for (const r of st.release ?? []) {
      touched.add(r.y * 65536 + r.x);
      if (!ig.cols.has(r.x, r.y)) continue;
      const out = releaseSpan(ig.cols.read(r.x, r.y), r, r.fallback, r.toAir);
      if (out) ig.cols.mirror(r.x, r.y, out);
    }
    const claims = new Map<number, { z0: number; z1: number; aux: number }[]>();
    for (const c of st.claim ?? []) {
      const k = c.y * 65536 + c.x;
      claims.set(k, [...(claims.get(k) ?? []), c]);
    }
    for (const [k, cs] of claims) {
      const x = k % 65536;
      const y = Math.floor(k / 65536);
      touched.add(k);
      if (ig.cols.has(x, y)) ig.cols.mirror(x, y, claimColumn(ig.cols.read(x, y), cs));
    }
    const frees = new Map<number, { z0: number; z1: number; aux: number }[]>();
    for (const c of st.claimFree ?? []) {
      const k = c.y * 65536 + c.x;
      frees.set(k, [...(frees.get(k) ?? []), c]);
    }
    for (const [k, cs] of frees) {
      const x = k % 65536;
      const y = Math.floor(k / 65536);
      touched.add(k);
      if (ig.cols.has(x, y)) ig.cols.mirror(x, y, claimFreeColumn(ig.cols.read(x, y), cs));
    }
  }
  // (round 80: the chunks under what changed woken — their surface, their water, their slumping. Round 128d: a claim or
  // a release alone — a building raised, a fortress's block standing — only touches them: drowsy, the ground's systems
  // asleep (sim/sleep.ts touch; the user: "keep that frozen outside of collapse, spells, or weather events"). A cut, a
  // spill or a deposit wakes them: something broke or fell)
  const sleep = ig.core.sleep;
  const quiet = stages.every((s) => !s.cuts.length && !s.spill?.length && !s.deposits?.length);
  if (sleep)
    for (const k of touched) {
      const x = (k % 65536) + 0.5;
      const y = (Math.floor(k / 65536) + 0.5) * ROW_H;
      if (quiet) sleep.touch(x, y, 1);
      else sleep.wake(x, y, 16, 8, performance.now() / 1000);
    }
}
