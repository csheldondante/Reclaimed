// External intervals (round 99, `?meshinst=1`; docs/ARCHITECTURE.md "External intervals"). The user (DECISIONS round
// 99): "can we more seamlessly mix normal meshes or sprites (instanced maybe) into the existing terrain system so that
// we let a skewed mesh be buried instead of turning back into an ordinary layer. It does mean that the layer needs to
// be skipped and marked as being in an external system so that it can properly support columns over it and interact."
//
// The contract:
//  - An owner (a system that draws something as a mesh: the resting rock, later trees, houses) claims the cells its
//    thing fills as intervals of MAT.External in the columns, aux = the material they become if it lets go (0: stone).
//  - Every sim treats them as solid rock that never gives by itself (materials.ts: strength 1, bear 1): what's put on
//    them stands, water goes round, loose ground piles on them, the rock judge counts them as ground. The terrain's
//    draws (the field mesh: meshregion.wgsl fieldMat; the prisms: renderprep.wgsl; the hybrid's grid: its chunk is
//    made voxels by the owner's host) skip them: the owner draws its thing.
//  - The registry below is the truth of who owns what: by instance, its intervals (window cells, z). Nothing else is
//    read from the GPU's words (the sims may move or join intervals; aux is kept by most of them, not all).
//  - When the ground is read back (the integrity system's CPU copy, after an edit or a meteor), `verify` checks each
//    instance there still holds every cell it claimed. One that lost any — dug, cut, melted, moved — is `cut`: its
//    owner is told and lets go (`release`: what's left of it becomes ordinary ground, its fallback material, in
//    place; the judge then looks at it like any other ground — or `release(id, true)`: to air, the owner taking its
//    cells back, as the resting rock does waking as a body, round 110). An instance the judge finds hanging free is
//    `loose`: its owner is told likewise (its intervals taken out of what the judge frees, round 110). External intervals no instance claims (a slide's thaw, an undo) are orphans: they
//    become their fallback material (`orphans`).
//  - Owners say when the window slides: what leaves it is released first (the streamer freezes ordinary ground).

import { MAT, MATERIALS } from '../world/materials';
import type { Interval } from '../world/layout';

/**
 * (round 99) the experiment's switch: `?meshinst=1` (default off until measured) — now the trees' only (round 110: the
 * resting rock's registry is on wherever the rigid rock is, game/integrity.ts)
 */
export const MESHINST = typeof location !== 'undefined' && new URLSearchParams(location.search).get('meshinst') === '1';

/** Who owns an instance (a small id; ExternalRegistry.owner). */
export type OwnerId = number;
/** the resting rock (game/integrity.ts: a rigid body come to rest stays its mesh) */
export const OWNER_ROCK: OwnerId = 1;
/** (round 117/119) the settlements' buildings (src/settle/view.ts: one instance a building, a wall run, a bridge) */
export const OWNER_STRUCT: OwnerId = 2;

export interface ExternalCol {
  x: number;
  y: number;
  z0: number;
  z1: number;
}

export interface ExternalInstance {
  id: number;
  owner: OwnerId;
  /** the intervals it claimed (window cells; z in cells), at most one a column */
  cols: ExternalCol[];
  /** what its cells become when it lets go */
  fallback: number;
}

export interface ExternalOwner {
  name: string;
  /**
   * The instance lost cells it claimed (`why` 'cut': an edit, a meteor, melting, a slide moving it) or hangs free
   * ('loose': the rock judge found nothing holding it). The owner decides: release it to ground, or take it back
   * (a rock woken into a body). It must do one of the two before it returns.
   */
  onLost(inst: ExternalInstance, why: 'cut' | 'loose'): void;
}

/** What the registry reads and writes the columns through (the integrity system's CPU copy and its writes). */
export interface ColumnAccess {
  read(x: number, y: number): Interval[];
  write(x: number, y: number, col: Interval[]): void;
}

const EPS = 1e-3;

/** The column with [z0, z1) taken out of it (intervals cut at its ends). */
export function cutOut(col: Interval[], z0: number, z1: number): Interval[] {
  const out: Interval[] = [];
  for (const iv of col) {
    if (iv.z1 <= z0 + EPS || iv.z0 >= z1 - EPS) {
      out.push(iv);
      continue;
    }
    if (iv.z0 < z0 - EPS) out.push({ ...iv, z1: z0 });
    if (iv.z1 > z1 + EPS) out.push({ ...iv, z0: z1 });
  }
  return out;
}

/** Is [z0, z1) of the column all External? */
function heldBy(col: Interval[], z0: number, z1: number): boolean {
  let z = z0;
  for (const iv of col) {
    if (iv.mat !== MAT.External) continue;
    if (iv.z0 <= z + EPS && iv.z1 > z + EPS) z = iv.z1;
    if (z >= z1 - EPS) return true;
  }
  return z >= z1 - EPS;
}

export class ExternalRegistry {
  private owners = new Map<OwnerId, ExternalOwner>();
  private list = new Map<number, ExternalInstance>();
  /** column key (y · 65536 + x) → instances with an interval there */
  private byCol = new Map<number, number[]>();
  private nextId = 1;
  stats = { claimed: 0, cut: 0, loose: 0, released: 0, orphans: 0, live: 0, cells: 0, ms: 0 };

  constructor(private cols: ColumnAccess) {}

  /** An owner (a fixed small id). */
  owner(id: OwnerId, o: ExternalOwner): void {
    this.owners.set(id, o);
  }

  get instances(): IterableIterator<ExternalInstance> {
    return this.list.values();
  }
  get size(): number {
    return this.list.size;
  }
  get(id: number): ExternalInstance | undefined {
    return this.list.get(id);
  }

  /**
   * Claim cells: for each column, [z0, z1) wherever it is free (air or a liquid) becomes External — where there's
   * ground already the thing is buried in it, and that part isn't claimed. Returns the instance (null: nothing free).
   */
  claim(owner: OwnerId, want: ExternalCol[], fallback: number = MAT.Stone): ExternalInstance | null {
    const cols: ExternalCol[] = [];
    for (const w of want) {
      const col = this.cols.read(w.x, w.y);
      // (the free spans of [z0, z1): what isn't matter)
      let free: [number, number][] = [[w.z0, w.z1]];
      for (const iv of col) {
        const s = MATERIALS[iv.mat]?.state;
        if (s === undefined || s === 0 || s === 3) continue;
        const next: [number, number][] = [];
        for (const [a, b] of free) {
          if (iv.z1 <= a + EPS || iv.z0 >= b - EPS) next.push([a, b]);
          else {
            if (iv.z0 > a + EPS) next.push([a, iv.z0]);
            if (iv.z1 < b - EPS) next.push([iv.z1, b]);
          }
        }
        free = next;
      }
      let out = col;
      for (const [a, b] of free) {
        if (b - a < 0.05) continue;
        out = cutOut(out, a, b);
        out.push({ z0: a, z1: b, mat: MAT.External, aux: fallback & 0xff });
        cols.push({ x: w.x, y: w.y, z0: a, z1: b });
      }
      if (out !== col) {
        out.sort((p, q) => p.z0 - q.z0);
        this.cols.write(w.x, w.y, join(out));
      }
    }
    if (!cols.length) return null;
    const inst: ExternalInstance = { id: this.nextId++, owner, cols, fallback };
    this.list.set(inst.id, inst);
    for (const c of cols) this.index(c.y * 65536 + c.x, inst.id);
    this.stats.claimed++;
    this.count();
    return inst;
  }

  /**
   * (round 100) An instance back from a region's record (Streamer.things): its cells are External in the columns
   * already (the record's) — registered, the columns untouched.
   */
  adopt(owner: OwnerId, cols: ExternalCol[], fallback: number): ExternalInstance {
    const inst: ExternalInstance = { id: this.nextId++, owner, cols: cols.map((c) => ({ ...c })), fallback };
    this.list.set(inst.id, inst);
    for (const c of inst.cols) this.index(c.y * 65536 + c.x, inst.id);
    this.count();
    return inst;
  }

  /** Let go of an instance: what's left of its cells becomes its fallback material, in place (or air: `toAir`). */
  release(id: number, toAir = false): void {
    const inst = this.list.get(id);
    if (!inst) return;
    this.forget(inst);
    for (const c of inst.cols) {
      const col = this.cols.read(c.x, c.y);
      let changed = false;
      const out: Interval[] = [];
      for (const iv of col) {
        if (iv.mat !== MAT.External || iv.z1 <= c.z0 + EPS || iv.z0 >= c.z1 - EPS) {
          out.push(iv);
          continue;
        }
        changed = true;
        if (iv.z0 < c.z0 - EPS) out.push({ ...iv, z1: c.z0 });
        if (!toAir) out.push({ z0: Math.max(iv.z0, c.z0), z1: Math.min(iv.z1, c.z1), mat: inst.fallback || MAT.Stone });
        if (iv.z1 > c.z1 + EPS) out.push({ ...iv, z0: c.z1 });
      }
      if (changed) this.cols.write(c.x, c.y, join(out));
    }
    this.stats.released++;
    this.count();
  }

  /** Forget an instance without touching the columns (its owner rewrote them itself, or the world under it went). */
  forget(inst: ExternalInstance): void {
    if (!this.list.delete(inst.id)) return;
    for (const c of inst.cols) {
      const k = c.y * 65536 + c.x;
      const l = this.byCol.get(k)?.filter((i) => i !== inst.id);
      if (l?.length) this.byCol.set(k, l);
      else this.byCol.delete(k);
    }
    this.count();
  }

  /** Forget every instance (undo, a warp: the columns under them are someone else's now). */
  clear(): void {
    this.list.clear();
    this.byCol.clear();
    this.count();
  }

  /** The instances with an interval in column (x, y) overlapping [z0, z1). */
  at(x: number, y: number, z0 = -Infinity, z1 = Infinity): ExternalInstance[] {
    const out: ExternalInstance[] = [];
    for (const id of this.byCol.get(y * 65536 + x) ?? []) {
      const inst = this.list.get(id)!;
      if (inst.cols.some((c) => c.x === x && c.y === y && c.z1 > z0 + EPS && c.z0 < z1 - EPS)) out.push(inst);
    }
    return out;
  }

  /**
   * The columns were read (all of them, or those `known` says): every instance there that lost a cell it claimed is
   * cut — its owner told. Then the External intervals there no one claims are orphans: their fallback material.
   */
  verify(known?: (x: number, y: number) => boolean, cols?: Iterable<number>): void {
    const lost: ExternalInstance[] = [];
    for (const inst of this.list.values()) {
      let ok = true;
      for (const c of inst.cols) {
        if (known && !known(c.x, c.y)) continue;
        if (!heldBy(this.cols.read(c.x, c.y), c.z0, c.z1)) {
          ok = false;
          break;
        }
      }
      if (!ok) lost.push(inst);
    }
    for (const inst of lost) {
      this.stats.cut++;
      this.tell(inst, 'cut');
    }
    if (cols) this.orphans(cols);
  }

  /** These columns' External intervals no instance claims become their fallback material. */
  orphans(cols: Iterable<number>): void {
    for (const k of cols) {
      const x = k % 65536;
      const y = Math.floor(k / 65536);
      const col = this.cols.read(x, y);
      if (!col.some((iv) => iv.mat === MAT.External)) continue;
      const mine = this.at(x, y).flatMap((i) => i.cols.filter((c) => c.x === x && c.y === y));
      let changed = false;
      const out: Interval[] = [];
      for (const iv of col) {
        if (iv.mat !== MAT.External) {
          out.push(iv);
          continue;
        }
        // (the parts of it no instance holds)
        let rest: [number, number][] = [[iv.z0, iv.z1]];
        for (const c of mine) {
          const next: [number, number][] = [];
          for (const [a, b] of rest) {
            if (c.z1 <= a + EPS || c.z0 >= b - EPS) next.push([a, b]);
            else {
              if (c.z0 > a + EPS) next.push([a, c.z0]);
              if (c.z1 < b - EPS) next.push([c.z1, b]);
            }
          }
          rest = next;
        }
        if (!rest.length) {
          out.push(iv);
          continue;
        }
        changed = true;
        this.stats.orphans++;
        let z = iv.z0;
        for (const [a, b] of rest) {
          if (a > z + EPS) out.push({ ...iv, z0: z, z1: a });
          out.push({ z0: a, z1: b, mat: iv.aux || MAT.Stone });
          z = b;
        }
        if (iv.z1 > z + EPS) out.push({ ...iv, z0: z });
      }
      if (changed) this.cols.write(x, y, join(out));
    }
  }

  /** The judge found these intervals hanging free (or giving): their instances are loose — owners told. */
  loose(ivs: { x: number; y: number; z0: number; z1: number }[]): void {
    const hit = new Set<ExternalInstance>();
    for (const iv of ivs) for (const inst of this.at(iv.x, iv.y, iv.z0, iv.z1)) hit.add(inst);
    for (const inst of hit) {
      this.stats.loose++;
      this.tell(inst, 'loose');
    }
  }

  /** The window slid by (dx, dy) cells: instances move with the land (those leaving were released before). */
  shift(dx: number, dy: number): void {
    const moved = [...this.list.values()];
    this.byCol.clear();
    for (const inst of moved) {
      for (const c of inst.cols) {
        c.x -= dx;
        c.y -= dy;
      }
      for (const c of inst.cols) this.index(c.y * 65536 + c.x, inst.id);
    }
  }

  private tell(inst: ExternalInstance, why: 'cut' | 'loose'): void {
    if (!this.list.has(inst.id)) return;
    const o = this.owners.get(inst.owner);
    if (o) o.onLost(inst, why);
    // (an owner that kept it after being told — or no owner: let go here; the contract says it must decide)
    if (this.list.has(inst.id)) this.release(inst.id);
  }

  private index(k: number, id: number): void {
    const l = this.byCol.get(k);
    if (l) {
      if (!l.includes(id)) l.push(id);
    } else this.byCol.set(k, [id]);
  }

  private count(): void {
    this.stats.live = this.list.size;
    let n = 0;
    for (const i of this.list.values()) for (const c of i.cols) n += c.z1 - c.z0;
    this.stats.cells = Math.round(n);
  }
}

/** Touching intervals of one material (and aux) joined. */
function join(col: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const iv of [...col].sort((a, b) => a.z0 - b.z0)) {
    const last = out[out.length - 1];
    if (last && last.mat === iv.mat && Math.abs(last.z1 - iv.z0) < 1e-4 && (last.aux ?? 0) === (iv.aux ?? 0)) last.z1 = iv.z1;
    else out.push({ ...iv });
  }
  return out;
}
