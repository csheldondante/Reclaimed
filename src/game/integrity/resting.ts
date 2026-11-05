// Resting pieces as External instances: kept with their region, carried by a slide, woken when cut or loosened,
// eroding what's under them, and let go. API: carried, regionThings (Integrity.regionThings), restingMass, bakeDust,
// wakeResting, erodeUnder, unrest, takeExternal, externalCols.
import { SLOT_WORDS, type Interval } from '../../world/layout';
import { MAT, MATERIALS, MatState } from '../../world/materials';
import { type Fracture } from '../fracture';
import { cellAt, cellPos, ROW_H } from '../../world/lattice';
import { RB, type RockBody, type V3 } from '../rockbodies';
import { OWNER_ROCK, type ExternalCol, type ExternalInstance } from '../../sim/external';
import { fieldMeshed } from '../../world/materials';
import { type ApplyStage } from '../colapply';
import { allocRock, fastForward, restingMesh, toIndex } from './rigid';
import { edit, touchCols } from './columns';
import { toLoose } from './loose';
import { REGION_CELLS } from './defs';
import type { Integrity } from '../integrity';

/** (round 100) whether a resting rock is wholly inside one region that a slide of (dx, dy) — (0, 0): a warp — freezes */
export function carried(ig: Integrity, inst: ExternalInstance, dx: number, dy: number): boolean {
  const { w: W, h: H } = ig.core.dims;
  const R = REGION_CELLS;
  const r = ig.resting.get(inst.id);
  if (!r?.cells || !inst.cols.length) return false;
  const rx = Math.floor(inst.cols[0].x / R);
  const ry = Math.floor(inst.cols[0].y / R);
  if (!inst.cols.every((c) => Math.floor(c.x / R) === rx && Math.floor(c.y / R) === ry)) return false;
  const x0 = rx * R;
  const y0 = ry * R;
  if (!dx && !dy) return true;
  return dx > 0 ? x0 < dx : dx < 0 ? x0 >= W + dx : dy > 0 ? y0 < dy : y0 >= H + dy;
}

/** Integrity.regionThings (the class keeps the method, documented there) */
export function regionThings(ig: Integrity): { name: string; take(x0: number, y0: number, x1: number, y1: number, keep?: boolean): import('../../world/region-record').ThingRecord[]; give(things: import('../../world/region-record').ThingRecord[], x0: number, y0: number): void } {
  return {
    name: 'rock',
    take: (x0, y0, x1, y1, keep = false) => {
      const ext = ig.external;
      if (!ext) return [];
      const out: import('../../world/region-record').ThingRecord[] = [];
      for (const inst of [...ext.instances]) {
        if (inst.owner !== OWNER_ROCK) continue;
        if (!inst.cols.every((c) => c.x >= x0 && c.x < x1 && c.y >= y0 && c.y < y1)) continue;
        const r = ig.resting.get(inst.id);
        if (!r?.cells) continue;
        const m = [...r.m];
        m[3] -= x0;
        m[7] -= y0 * ROW_H;
        out.push({ owner: OWNER_ROCK, kind: 'rock', m, state: { cells: r.cells, mat: r.mat }, cols: inst.cols.map((c) => ({ x: c.x - x0, y: c.y - y0, z0: c.z0, z1: c.z1 })), fallback: inst.fallback, id: r.history ?? inst.id });
        if (keep) continue;
        ext.forget(inst);
        if (r.slot !== undefined) ig.rockMesh?.release(r.slot);
        ig.resting.delete(inst.id);
      }
      return out;
    },
    give: (things, x0, y0) => {
      const ext = ig.external;
      if (!ext) return;
      for (const t of things) {
        if (t.owner !== OWNER_ROCK) continue;
        const st = t.state as { cells: { x: number; y: number; z: number; mat: number }[]; mat: number };
        // (round 112: a mesh for what the field mesh draws of it; all built, none)
        const meshed = st.cells.filter((c) => fieldMeshed(c.mat));
        const slot = meshed.length ? ig.rockMesh?.alloc(meshed)?.id : undefined;
        const inst = ext.adopt(OWNER_ROCK, t.cols.map((c) => ({ x: c.x + x0, y: c.y + y0, z0: c.z0, z1: c.z1 })), t.fallback);
        if (slot === undefined && meshed.length) {
          // (no room for its mesh: ground again)
          unrest(ig, inst, 'room');
          continue;
        }
        const m = [...t.m];
        m[3] += x0;
        m[7] += y0 * ROW_H;
        ig.resting.set(inst.id, { slot, m, mat: st.mat, cells: st.cells, history: t.id, mesh: restingMesh(ig, st.cells, m, slot) });
      }
    },
  };
}

/** (round 110) the mass (cells) of the resting rock owning column (x, y) at height z; undefined: none (the ground) */
export function restingMass(ig: Integrity, x: number, y: number, z: number): number | undefined {
  const inst = ig.external?.at(x, y, z, z + 0.5).find((o) => o.owner === OWNER_ROCK);
  return inst ? ig.resting.get(inst.id)?.cells?.length : undefined;
}

/** (round 110) the burst a bake (or a re-mesh) hides behind: dust over the body's size, a puff of chips */
export function bakeDust(ig: Integrity, x: number, y: number, z: number, r: number, cells: number, mat: number): void {
  ig.onDust?.(x, y, z, Math.min(60, 12 + Math.round(Math.sqrt(cells) * 3)), Math.max(1, r * 0.8), mat);
}

/**
 * (round 110, BACKLOG MI5) A resting rock whose instance was lost wakes as a body where it lies — its own mesh, at
 * its transform, still — rather than becoming ground the judge then frees as a new body (meshed again: the user's
 * "they turn to dust"). Cut (dug, smashed): the cells it lost are gone from it, its mesh made again behind dust;
 * hanging free: as it was. Its cells in the columns go to air (the body has them).
 */
export function wakeResting(ig: Integrity, inst: ExternalInstance, why: 'cut' | 'loose'): void {
  const rigid = ig.rigid;
  const ext = ig.external!;
  const r = ig.resting.get(inst.id);
  if (!rigid || !r?.cells) return unrest(ig, inst, 'lost');
  let keep = r.cells;
  if (why === 'cut') {
    // (each cell where it lies now: still claimed, and still External in the copy — or dug out of it)
    const m = r.m;
    keep = r.cells.filter((c) => {
      const [px, py] = cellPos(c.x, c.y);
      const pz = c.z + 0.5;
      const wx = m[0] * px + m[1] * py + m[2] * pz + m[3];
      const wy = m[4] * px + m[5] * py + m[6] * pz + m[7];
      const wz = m[8] * px + m[9] * py + m[10] * pz + m[11];
      const [cx, cy] = cellAt(wx, wy);
      if (!ext.at(cx, cy, wz - 0.5, wz + 0.5).includes(inst)) return true;
      return ig.cols.read(cx, cy).some((iv) => iv.mat === MAT.External && iv.z1 > wz - 0.25 && iv.z0 < wz + 0.25);
    });
  }
  ig.resting.delete(inst.id);
  ext.release(inst.id, true);
  const cols = inst.cols.map((c) => ({ x: c.x, y: c.y, ivs: [] }));
  touchCols(ig, cols, true);
  for (const c of inst.cols) {
    ig.rockSeeds.set(c.y * 65536 + c.x, 2);
    ig.cutSeeds.set(c.y * 65536 + c.x, 2);
  }
  ig.urgent = true;
  const lost = r.cells.length - keep.length;
  const b = keep.length >= 8 ? rigid.revive(keep, r.m) : null;
  if (!b) {
    // (what's left of it too small to be a body: rubble, behind dust)
    if (r.slot !== undefined) ig.afterglow.push({ slot: r.slot, m: r.m, frames: 2 });
    if (keep.length) {
      const m = r.m;
      const pts = keep.map((c) => {
        const [px, py] = cellPos(c.x, c.y);
        const pz = c.z + 0.5;
        return { p: [m[0] * px + m[1] * py + m[2] * pz + m[3], m[4] * px + m[5] * py + m[6] * pz + m[7], m[8] * px + m[9] * py + m[10] * pz + m[11]] as V3, mat: c.mat };
      });
      toLoose(ig, toIndex(ig, pts), 2);
      bakeDust(ig, pts[0].p[0], pts[0].p[1], pts[0].p[2], 2, keep.length, r.mat);
    }
    return;
  }
  if (!lost) b.slot = r.slot;
  else {
    // (its mesh made again without what it lost: the swap behind a burst of dust)
    if (r.slot !== undefined) ig.afterglow.push({ slot: r.slot, m: r.m, frames: 2 });
    b.slot = allocRock(ig, rigid.latCells(b));
    const [x0, y0, x1, y1] = rigid.box(b);
    bakeDust(ig, (x0 + x1) / 2, (y0 + y1) / 2, b.pos[2], Math.max(x1 - x0, y1 - y0) / 2, lost, b.mat);
  }
  ig.stats.bodies++;
  // (the phone's cap: the oldest other comes to rest first)
  while (rigid.list.length > Math.max(1, RB.maxBodies)) {
    const old = rigid.list.find((o) => o !== b);
    if (!old) break;
    rigid.stats.capped++;
    fastForward(ig, old);
  }
}

/**
 * (round 110) Ground a body cut deep into (RockBodies: past its slop by RB.erodeDepth) crumbles where they meet —
 * rubble and dust — rather than the body being pushed out (DECISIONS round 106). Solid ground only (loose ground
 * it just sinks into), not bedrock, not what other systems own (External: a resting rock).
 */
export function erodeUnder(ig: Integrity, pts: { body: RockBody; at: V3 }[]): void {
  const { w: W, h: H } = ig.core.dims;
  const removed: { p: [number, number, number]; mat: number }[] = [];
  const cols: { x: number; y: number; ivs: [] }[] = [];
  const cuts: ApplyStage['cuts'] = [];
  const done = new Set<number>();
  let mat = 0;
  for (const { body, at } of pts) {
    const [cx, cy] = cellAt(at[0], at[1]);
    if (cx < 0 || cy < 0 || cx >= W || cy >= H) continue;
    const z = Math.floor(at[2]);
    const key = (z * 8192 + cy) * 8192 + cx;
    if (z < 1 || done.has(key)) continue;
    done.add(key);
    const col = ig.cols.read(cx, cy);
    const cut: { z0: number; z1: number }[] = [];
    for (const iv of col) {
      const d = MATERIALS[iv.mat];
      if (!d || d.state !== MatState.Solid || d.span === Infinity) continue;
      const lo = Math.max(iv.z0, z);
      const hi = Math.min(iv.z1, z + 1);
      if (hi - lo < 0.05) continue;
      cut.push({ z0: lo, z1: hi });
      removed.push({ p: [cx + 0.5, cy + 0.5, (lo + hi) / 2], mat: iv.mat });
      mat = iv.mat;
    }
    if (!cut.length) continue;
    cuts.push({ x: cx, y: cy, cuts: cut });
    cols.push({ x: cx, y: cy, ivs: [] });
    ig.rockSeeds.set(cy * 65536 + cx, 2);
    ig.cutSeeds.set(cy * 65536 + cx, 2);
    void body;
  }
  if (!removed.length) return;
  // (round 120, JB6: cut on the GPU, and in the copy)
  edit(ig, [{ cuts }]);
  ig.rigid!.stats.eroded += removed.length;
  touchCols(ig, cols, true);
  toLoose(ig, removed, 1.5);
  const p = pts[0].at;
  ig.onDust?.(p[0], p[1], p[2], Math.min(30, 6 + removed.length * 3), 0.8 + removed.length * 0.2, mat);
  ig.urgent = true;
}

/**
 * (round 99) A resting rock baked into the ground (round 110: only out of room, leaving the window, or asked —
 * `bakeResting`; one cut or hanging free wakes instead): its cells ground again, its mesh gone, behind a burst of dust.
 */
export function unrest(ig: Integrity, inst: ExternalInstance, why: 'room' | 'leaving' | 'asked' | 'lost'): void {
  const r = ig.resting.get(inst.id);
  ig.resting.delete(inst.id);
  if (r) {
    // (round 120: made room for, its slot given back at once; else its mesh stays a few frames while the ground's is made)
    if (r.slot !== undefined) {
      if (why === 'room') ig.rockMesh?.release(r.slot);
      else ig.afterglow.push({ slot: r.slot, m: r.m, frames: 6 });
    }
    if (ig.rigid) {
      ig.rigid.stats.baked++;
      ig.rigid.bakedWhy[why] = (ig.rigid.bakedWhy[why] ?? 0) + 1;
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let z = 0;
    for (const c of inst.cols) {
      x0 = Math.min(x0, c.x);
      y0 = Math.min(y0, c.y);
      x1 = Math.max(x1, c.x);
      y1 = Math.max(y1, c.y);
      z = Math.max(z, c.z1);
    }
    const [wx0, wy0] = cellPos(x0, y0);
    const [wx1, wy1] = cellPos(x1, y1);
    bakeDust(ig, (wx0 + wx1) / 2, (wy0 + wy1) / 2, z - 1, Math.max(wx1 - wx0, wy1 - wy0) / 2, r.cells?.length ?? 8, r.mat);
  }
  ig.external?.release(inst.id);
  const cols = inst.cols.map((c) => ({ x: c.x, y: c.y, ivs: [] }));
  touchCols(ig, cols, true);
  for (const c of inst.cols) {
    ig.rockSeeds.set(c.y * 65536 + c.x, 2);
    ig.cutSeeds.set(c.y * 65536 + c.x, 2);
  }
  ig.urgent = true;
}

/** (round 99) An analysis's runs that are External: made their fallback material in it, their owners told. */
export function takeExternal(ig: Integrity, r: Fracture): void {
  const ext = ig.external!;
  const hit: ExternalCol[] = [];
  // (round 110: taken out of what falls or crumbles — the owner wakes its thing, which takes them back as itself;
  // round 99 made them their fallback material in the piece, and the rock was freed again as a new body, meshed
  // again. One no instance owns stays in, as its fallback)
  const scan = (rp: { x: number; y: number; ivs: Interval[] }[] | undefined) => {
    for (const c of rp ?? []) {
      const keep: Interval[] = [];
      for (const iv of c.ivs) {
        if (iv.mat !== MAT.External) {
          keep.push(iv);
          continue;
        }
        const owned = ext.at(c.x, c.y, iv.z0, iv.z1);
        if (owned.length) {
          hit.push({ x: c.x, y: c.y, z0: iv.z0, z1: iv.z1 });
          continue;
        }
        iv.mat = iv.aux || MAT.Stone;
        iv.aux = 0;
        keep.push(iv);
      }
      c.ivs = keep;
    }
  };
  for (const p of r.pieces ?? []) scan(p);
  scan(r.crumbleRuns);
  if (r.pieces) r.pieces = r.pieces.map((p) => p.filter((c) => c.ivs.length));
  if (r.crumbleRuns) r.crumbleRuns = r.crumbleRuns.filter((c) => c.ivs.length);
  if (hit.length) ext.loose(hit);
}

/** (round 99) The columns (y · 65536 + x) with an External interval in the CPU copy (a scan of its words). */
export function externalCols(ig: Integrity): number[] {
  const p = ig.core.packed;
  const u = ig.world.slots;
  const out: number[] = [];
  const C = 16;
  for (let cy = 0; cy < p.chunksY; cy++)
    for (let cx = 0; cx < p.chunksX; cx++) {
      const ci = cy * p.chunksX + cx;
      const base = p.chunkTable[ci * 2];
      const k = p.chunkTable[ci * 2 + 1];
      for (let i = 0; i < C * C; i++) {
        const o = (base + i * k) * SLOT_WORDS;
        for (let s = 0; s < k; s++) {
          const w = o + s * SLOT_WORDS;
          if (u[w + 1] === 0) break;
          if ((u[w + 2] & 0xff) === MAT.External) {
            out.push((cy * C + Math.floor(i / C)) * 65536 + cx * C + (i % C));
            break;
          }
        }
      }
    }
  return out;
}
