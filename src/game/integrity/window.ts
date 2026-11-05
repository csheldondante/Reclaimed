// Integrity across the streamed window's moves: settling after a slide, shifting what it keeps in window coordinates
// (slid), and forgetting what left (forget). API: settle, slid, forget (Integrity's public methods' bodies).
import { cellPos, ROW_H } from '../../world/lattice';
import { type FallingBody } from '../colbodies';
import { type RockBody } from '../rockbodies';
import { OWNER_ROCK } from '../../sim/external';
import { fastForward } from './rigid';
import { carried, unrest } from './resting';
import { land } from './columns';
import { project } from './loose';
import type { Integrity } from '../integrity';

/** Integrity.settle (the class keeps the method, documented there) */
export function settle(ig: Integrity, dx = 0, dy = 0, dz = 0): void {
  // (a slide along x or y: only what's in the strip leaving — the rest moves with the land, slid)
  const { w: W, h: H } = ig.core.dims;
  const leaving = (b: FallingBody) => {
    if (dz || (!dx && !dy)) return true;
    const [x0, y0, x1, y1] = b.box;
    return dx > 0 ? x0 < dx : dx < 0 ? x1 >= W + dx : dy > 0 ? y0 < dy : y1 >= H + dy;
  };
  const t0 = performance.now();
  let n = 0;
  // (round 95) the rigid rock in the strip leaving (all of it, for a slide in z or a warp) comes to rest first,
  // written into the columns as they are before the slide
  if (ig.rigid) {
    const wl = (b: RockBody) => {
      if (dz || (!dx && !dy)) return true;
      const [x0, y0, x1, y1] = ig.rigid!.box(b);
      return dx > 0 ? x0 < dx + 1 : dx < 0 ? x1 >= W + dx - 1 : dy > 0 ? y0 / ROW_H < dy + 1 : y1 / ROW_H >= H + dy - 1;
    };
    for (const b of ig.rigid.list.filter(wl)) {
      fastForward(ig, b);
      n++;
    }
  }
  // (round 99) the resting rock leaving the window (all of it, in z or a warp) becomes ground first: the streamer
  // freezes the columns as they are, and no one owns them over there
  if (ig.external) {
    for (const inst of [...ig.external.instances]) {
      if (inst.owner !== OWNER_ROCK) continue;
      const out = dz || (!dx && !dy) || inst.cols.some((c) => (dx > 0 ? c.x < dx + 1 : dx < 0 ? c.x >= W + dx - 1 : dy > 0 ? c.y < dy + 1 : c.y >= H + dy - 1));
      // (round 100: one wholly inside a region leaving — or any of the window's, a warp — goes with it, its mesh
      // and transform in the region's record: Streamer.things, regionThings below)
      if (out && !dz && carried(ig, inst, dx, dy)) continue;
      if (out) unrest(ig, inst, 'leaving');
    }
  }
  for (let k = 0; k < 2000; k++) {
    const go = ig.falling.list.filter(leaving);
    if (!go.length) break;
    n += go.length;
    for (const l of ig.falling.update(0.05, false, go)) land(ig, l);
  }
  if (n) ig.stats.settledFalls = (ig.stats.settledFalls ?? 0) + 1;
  ig.stats.settleMs = Math.max(ig.stats.settleMs ?? 0, performance.now() - t0);
}

/** Integrity.slid (the class keeps the method, documented there) */
export function slid(ig: Integrity, dx: number, dy: number, dz: number): void {
  const { w: W, h: H } = ig.core.dims;
  const move = (m: Map<number, number>) => {
    const out = new Map<number, number>();
    for (const [k, v] of m) {
      const x = (k % 65536) - dx;
      const y = Math.floor(k / 65536) - dy;
      if (x >= 0 && y >= 0 && x < W && y < H) out.set(y * 65536 + x, v);
    }
    return out;
  };
  ig.rockSeeds = move(ig.rockSeeds);
  ig.cutSeeds = move(ig.cutSeeds);
  const wx = dx;
  const wy = dy * ROW_H;
  for (const w of ig.watches) {
    w.x -= wx;
    w.y -= wy;
  }
  ig.dirty = ig.dirty.map(([x0, y0, x1, y1, n]) => [x0 - wx, y0 - wy, x1 - wx, y1 - wy, n]);
  // (what's falling where the land left or was cut again landed before the slide; the rest moves with it. The
  // physics bodies are in window coordinates: they go, as before)
  if (dz) ig.falling.clear();
  else ig.falling.shift(dx, dy);
  // (round 95) the rigid rock moves with the land, still until the copy is read again (it's of the old window)
  if (ig.rigid) {
    ig.rigid.shift(wx, wy, dz);
    ig.rigid.frozen = true;
  }
  ig.solver?.shift(wx, wy, dz);
  // (round 99) the resting rock with the land (what left was let go in settle)
  if (ig.external) {
    ig.external.shift(dx, dy);
    for (const r of ig.resting.values()) {
      r.m[3] -= wx;
      r.m[7] -= wy;
      r.m[11] -= dz;
    }
  }
  ig.bodies.list = [];
  ig.pendingLoose.clear();
  ig.needChunks.clear();
  // (round 120, JB6: the copy is of the window before: dropped — kept, read whole next pass; and what came in with the
  // land checked for orphaned External cells)
  ig.cols.drop();
  ig.orphanCheck = true;
  if (ig.rockSeeds.size) ig.urgent = true;
  project(ig);
}

/** Integrity.forget (the class keeps the method, documented there) */
export function forget(ig: Integrity, x0: number, y0: number, x1: number, y1: number): void {
  const [wx0, wy0] = cellPos(x0, y0);
  const [wx1, wy1] = cellPos(x1, y1);
  const over = (x: number, y: number) => x >= wx0 - 1 && x < wx1 + 1 && y >= wy0 - 1 && y < wy1 + 1;
  if (ig.rigid) {
    const go = new Set(ig.rigid.list.filter((b) => over(b.pos[0], b.pos[1])));
    for (const b of go) if (b.slot !== undefined) ig.rockMesh?.release(b.slot);
    ig.rigid.list = ig.rigid.list.filter((b) => !go.has(b));
  }
  if (ig.external) {
    for (const inst of [...ig.external.instances]) {
      if (inst.owner !== OWNER_ROCK || !inst.cols.some((c) => c.x >= x0 && c.x < x1 && c.y >= y0 && c.y < y1)) continue;
      const r = ig.resting.get(inst.id);
      ig.external.forget(inst);
      if (r) {
        if (r.slot !== undefined) ig.rockMesh?.release(r.slot);
        ig.resting.delete(inst.id);
      }
    }
  }
  const through = (b: FallingBody) => b.box[0] < x1 && b.box[2] >= x0 && b.box[1] < y1 && b.box[3] >= y0;
  for (let k = 0; k < 2000; k++) {
    const go = ig.falling.list.filter(through);
    if (!go.length) break;
    for (const l of ig.falling.update(0.05, false, go)) land(ig, l);
  }
  ig.bodies.list = ig.bodies.list.filter((b) => !over(b.pos[0], b.pos[1]));
  ig.dirty = ig.dirty.filter(([a, b, c, d]) => !(a >= wx0 && c <= wx1 && b >= wy0 && d <= wy1));
  // (solver step 2) the metal there let go too
  if (ig.solver)
    for (const mb of [...ig.metal]) {
      const r = ig.solver.read(mb.body);
      const at = r?.pos ?? mb.body.restCom;
      if (!over(at[0], at[1])) continue;
      ig.solver.remove(mb.body);
      ig.bodyMeshes?.remove(mb.mesh);
      ig.metal = ig.metal.filter((m) => m !== mb);
    }
}
