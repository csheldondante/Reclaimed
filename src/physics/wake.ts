// Waking the map into physics bodies (round 49: moved out of the level so a
// game can do it too; docs/PHYSICS.md "The map's own structures", "For games").
// The map's ruins are terrain (intervals in the layers) until something
// touches them; waking takes the structure cells near a point and everything
// they connect to (a whole wall, up to WAKE_MAX cells) out of the layers and
// makes them bodies, their foundations pinned. Or, `flood: false`, only the
// cells within the radius (a chunk torn out of rock), none pinned.

import { ignoreTeardown } from '../gpu/pipeline';
import { cellRange, columnSlots, packColumn, readColumn, SLOT_WORDS, type Interval } from '../world/layout';
import { cellAt, cellPos } from '../world/lattice';
import { MAT } from '../world/materials';
import type { WorldCore } from '../scenes/world-core';
import type { Physics, PhysBody } from './physics';

/** What the structure system holds up: not stone (the bedrock), not asphalt (the roads). */
export const STRUCTURAL: ReadonlySet<number> = new Set<number>([MAT.Concrete, MAT.Brick, MAT.Rust, MAT.Steel, MAT.Canvas]);
const WAKE_MAX = 6000;

export interface WakeOptions {
  /** the materials taken (default STRUCTURAL) */
  materials?: ReadonlySet<number>;
  /** take everything connected to what's within the radius (default), or only that */
  flood?: boolean;
}

export class Waker {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private core: WorldCore,
    private phys: Physics,
  ) {}

  /**
   * Wake what's within r of world (x, y, z) (z < 0: at any height) into
   * bodies, one a connected piece. Wakes run one after another (each reads
   * the layers the last one left). The bodies made; when the solver has no
   * room for them all, nothing is taken and `full` says how many pieces.
   */
  wake(x: number, y: number, z: number, r: number, opts: WakeOptions = {}): Promise<{ bodies: PhysBody[]; full: number }> {
    const next = this.chain.then(() => this.wakeNow(x, y, z, r, opts));
    this.chain = next.catch(ignoreTeardown);
    return next;
  }

  private async wakeNow(wx: number, wy: number, wz: number, r: number, opts: WakeOptions): Promise<{ bodies: PhysBody[]; full: number }> {
    const { core, phys } = this;
    const { dims, packed } = core;
    const take = opts.materials ?? STRUCTURAL;
    const flood = opts.flood ?? true;
    // (a chunk needs a height: at any height it would be the whole column, down to the map's floor)
    if (!flood && wz < 0) throw new Error('wake: flood: false needs a height (z >= 0)');
    const slots = new Uint32Array((await core.readBuffer('layers')).buffer);
    const key = (x: number, y: number, z: number) => (z * dims.h + y) * dims.w + x;
    const cols = new Map<number, Interval[]>();
    const colAt = (x: number, y: number) => {
      const k = y * dims.w + x;
      let c = cols.get(k);
      if (!c) cols.set(k, (c = readColumn(packed, slots, x, y)));
      return c;
    };
    /** the cell at (x, y, z) if it's of a material taken: its material, and whether it rests on the ground */
    const structAt = (x: number, y: number, z: number): { mat: number; ground: boolean } | null => {
      if (x < 0 || y < 0 || x >= dims.w || y >= dims.h || z < 0) return null;
      const col = colAt(x, y);
      for (let k = 0; k < col.length; k++) {
        const iv = col[k];
        if (!take.has(iv.mat)) continue;
        const [c0, c1] = cellRange(iv.z0, iv.z1);
        if (z < c0 || z >= c1) continue;
        const below = k > 0 ? col[k - 1] : null;
        // (on the ground, rock or loose: a foundation)
        const ground = z === c0 && (!below || (Math.abs(below.z1 - iv.z0) < 1e-3 && !take.has(below.mat)));
        return { mat: iv.mat, ground };
      }
      return null;
    };
    type Cell = { x: number; y: number; z: number; mat: number; pin: boolean };
    const piece = new Map<number, Cell>();
    const queue: number[] = [];
    // seeds: the cells near the point
    const [cx, cy] = cellAt(wx, wy);
    const R = Math.ceil(r) + 1;
    for (let y = cy - R; y <= cy + R; y++)
      for (let x = cx - R; x <= cx + R; x++) {
        if (x < 0 || y < 0 || x >= dims.w || y >= dims.h) continue;
        const [px, py] = cellPos(x, y);
        const dxy = Math.hypot(px - wx, py - wy);
        if (dxy > r + 0.5) continue;
        for (const iv of colAt(x, y)) {
          if (!take.has(iv.mat)) continue;
          const [c0, c1] = cellRange(iv.z0, iv.z1);
          for (let z = c0; z < c1; z++) {
            if (wz >= 0 && (flood ? Math.abs(z + 0.5 - wz) : Math.hypot(dxy, z + 0.5 - wz)) > r + 0.5) continue;
            const k = key(x, y, z);
            if (piece.has(k)) continue;
            const c = structAt(x, y, z);
            if (!c) continue;
            // (a chunk torn out isn't held by its foundation)
            piece.set(k, { x, y, z, mat: c.mat, pin: flood && c.ground });
            queue.push(k);
          }
        }
      }
    if (!piece.size) return { bodies: [], full: 0 };
    // the flood: everything they touch, up to WAKE_MAX
    for (let q = 0; flood && q < queue.length; q++) {
      const c = piece.get(queue[q])!;
      for (let dz = -1; dz <= 1; dz++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nk = key(c.x + dx, c.y + dy, c.z + dz);
            if (piece.has(nk)) continue;
            const n = structAt(c.x + dx, c.y + dy, c.z + dz);
            if (!n) continue;
            // (too big: this edge holds on to what stays behind)
            if (piece.size >= WAKE_MAX) {
              c.pin = true;
              continue;
            }
            piece.set(nk, { x: c.x + dx, y: c.y + dy, z: c.z + dz, mat: n.mat, pin: n.ground });
            queue.push(nk);
          }
    }
    // one body per connected piece (the seeds may have found several)
    const parts: { part: Cell[]; lo: number[]; hi: number[] }[] = [];
    const seen = new Set<number>();
    for (const [sk, start] of piece) {
      if (seen.has(sk)) continue;
      seen.add(sk);
      const part = [start];
      for (let q = 0; q < part.length; q++) {
        const c = part[q];
        for (let dz = -1; dz <= 1; dz++)
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const nk = key(c.x + dx, c.y + dy, c.z + dz);
              const n = piece.get(nk);
              if (n && !seen.has(nk)) {
                seen.add(nk);
                part.push(n);
              }
            }
      }
      let lo = [Infinity, Infinity, Infinity];
      let hi = [-Infinity, -Infinity, -Infinity];
      for (const c of part) {
        lo = [Math.min(lo[0], c.x), Math.min(lo[1], c.y), Math.min(lo[2], c.z)];
        hi = [Math.max(hi[0], c.x), Math.max(hi[1], c.y), Math.max(hi[2], c.z)];
      }
      parts.push({ part, lo, hi });
    }
    // (no room for them all in the solver: nothing is taken)
    const need = parts.reduce((a, p) => a + (p.hi[0] - p.lo[0] + 1) * (p.hi[1] - p.lo[1] + 1) * (p.hi[2] - p.lo[2] + 1), 0);
    if (!phys.hasRoom(need, parts.length)) return { bodies: [], full: parts.length };
    // out of the layers: each touched column keeps the parts of its intervals not taken
    const dev = core.host.gpu.device;
    const byCol = new Map<number, Set<number>>();
    for (const c of piece.values()) {
      const k = c.y * dims.w + c.x;
      if (!byCol.has(k)) byCol.set(k, new Set());
      byCol.get(k)!.add(c.z);
    }
    for (const [k, zs] of byCol) {
      const x = k % dims.w;
      const y = (k - x) / dims.w;
      const out: Interval[] = [];
      for (const iv of colAt(x, y)) {
        if (!take.has(iv.mat)) {
          out.push(iv);
          continue;
        }
        const [c0, c1] = cellRange(iv.z0, iv.z1);
        let run = -1;
        for (let z = c0; z <= c1; z++) {
          const keep = z < c1 && !zs.has(z);
          if (keep && run < 0) run = z;
          if (!keep && run >= 0) {
            out.push({ ...iv, z0: run === c0 ? iv.z0 : run, z1: z === c1 ? iv.z1 : z });
            run = -1;
          }
        }
      }
      const { base, k: K } = columnSlots(packed, x, y);
      dev.queue.writeBuffer(core.world.layers, base * SLOT_WORDS * 4, packColumn(out, K));
    }
    const bodies: PhysBody[] = [];
    let full = 0;
    for (const { part, lo, hi } of parts) {
      const at = (x: number, y: number, z: number) => piece.get(key(lo[0] + x, lo[1] + y, lo[2] + z));
      const mine = new Set(part);
      const body = phys.spawnLattice(
        [hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1],
        (x, y, z) => {
          const c = at(x, y, z);
          return c && mine.has(c) ? c.mat : 0;
        },
        (x, y, z) => {
          const [px, py] = cellPos(lo[0] + x, lo[1] + y);
          return [px, py, lo[2] + z + 0.5];
        },
        { pinned: (x, y, z) => !!at(x, y, z)?.pin },
      );
      if (body) bodies.push(body);
      else full++;
    }
    return { bodies, full };
  }
}
