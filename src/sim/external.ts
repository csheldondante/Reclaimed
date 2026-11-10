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
//  - Owners say when the window slides: what leaves it is released first (the streamer freezes ordinary ground) —
//    but for the static ones (round 128j, below).
//  - (round 128j, claims at load; the user: "If we compute the town and intersect grids can't it load the terrain with
//    the intervals for town already stored?") Things that don't move (a town's buildings, the fortress's blocks) are
//    *static*: their claims are written with the land by the kernel that writes an arriving region (sim/static-claims.ts),
//    kept in it when it leaves, never released on a slide nor claimed again after one. The registry sees them through a
//    StaticSet (`statics`): in its lookups, verify, orphans and release alike, anchored to their grid (not shifted).

import { MAT, MATERIALS } from '../world/materials';
import type { Interval } from '../world/layout';
import { urlFlags } from '../flags';

/**
 * (round 99) the experiment's switch: `?meshinst=1` (default off until measured) — now the trees' only (round 110: the
 * resting rock's registry is on wherever the rigid rock is, game/integrity.ts)
 */
export const MESHINST = typeof location !== 'undefined' && urlFlags().get('meshinst') === '1';

/** Who owns an instance (a small id; ExternalRegistry.owner). */
export type OwnerId = number;
/** the resting rock (game/integrity.ts: a rigid body come to rest stays its mesh) */
export const OWNER_ROCK: OwnerId = 1;
// (round 128m, onetown) a town's claims are owned by its grid's id (build/site.ts gridIdOf: 256 and up), one owner
// for the generated buildings and the player's alike — the settlements' and the fortress's owner ids are gone
// (citygen M4b) A town made by the field generator owns its claims on the GPU: a GPU-owned static grid
// (sim/static-claims.ts gpuGrid) — its spans built, claimed, held by the orphan pass and checked after an edit there,
// keyed by lot record (a span's owner word); the CPU knows only its box. The old towns' grids (CPU spans) stay as they
// are until the old planner goes (M4e), behind the same StaticSet.

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
  /**
   * (round 128g) claimed where free (claimFree): `cols` are the spans it asked for, made External on the GPU only where
   * they were air or liquid — where there was ground the thing is buried in it. Nothing is read back to know which.
   */
  free?: boolean;
  /** (round 128g) the registry's epoch when it was claimed: a read of the columns asked for before it doesn't judge it */
  epoch?: number;
}

/** (round 128g) materials a claim takes (where free): air, liquids, and any id past the table */
export function freeMat(m: number): boolean {
  const s = MATERIALS[m]?.state;
  return s === undefined || s === 0 || s === 3;
}

/** (round 128g) the parts of [z0, z1) of the column that are free (claimFree's rule), each at least 0.05 */
export function freeSpans(col: Interval[], z0: number, z1: number): [number, number][] {
  let free: [number, number][] = [[z0, z1]];
  for (const iv of col) {
    if (freeMat(iv.mat)) continue;
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
  return free.filter(([a, b]) => b - a >= 0.05);
}

/**
 * (round 128g) The column with each span, in turn, made External where it's free (air or a liquid; freeSpans) — where
 * there's ground the thing is buried in it, untouched. The rule ExternalRegistry.claimFree has the GPU apply
 * (colapply.wgsl `claim` with P.free) and a CPU world apply (test/gpu/colapply.test.ts holds them equal).
 */
export function claimFreeColumn(col: Interval[], spans: { z0: number; z1: number; aux: number }[]): Interval[] {
  let out = col;
  for (const s of spans) {
    // (joined even when nothing was free: as the GPU's, which writes the column back joined)
    out = claimColumn(out, freeSpans(out, s.z0, s.z1).map(([a, b]) => ({ z0: a, z1: b, aux: s.aux })));
  }
  return out;
}

/** (round 128g) Is every part of [z0, z1) of the column External or ground (not free)? — a free claim still holds */
function heldOrBuried(col: Interval[], z0: number, z1: number): boolean {
  return freeSpans(col, z0, z1).length === 0;
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
  /**
   * (round 120, JB6) Let these spans go in the columns themselves (releaseSpan's rule; the integrity system's on the
   * GPU, colapply.wgsl `release`) — no column read. Absent: the registry reads and writes each column (a CPU world).
   */
  release?(spans: (ExternalCol & { fallback: number; toAir: boolean })[]): void;
  /**
   * (round 128, INT16) Make these spans External in the columns themselves (claimColumn's rule; the GPU's, colapply.wgsl
   * `claim`). Absent: the registry writes each column (a CPU world).
   */
  claim?(spans: (ExternalCol & { aux: number })[]): void;
  /**
   * (round 128g) Make these spans External where they're free (claimFreeColumn's rule; the GPU's, colapply.wgsl `claim`
   * with P.free) — nothing read: the claim needs no copy of the columns. Absent: the registry reads and writes each
   * column (a CPU world).
   */
  claimFree?(spans: (ExternalCol & { aux: number })[]): void;
}

const EPS = 1e-3;

/**
 * (round 128j) The static things' claims as the registry sees them (sim/static-claims.ts StaticClaims): instances whose
 * cells are written with the land, anchored to their grids — `cols` in the window's frame now, some maybe out of it.
 */
export interface StaticSet {
  instances(): Iterable<ExternalInstance>;
  get(id: number): ExternalInstance | undefined;
  /** the static instances with an interval in window column (x, y) */
  at(x: number, y: number): ExternalInstance[];
  /** whether window column (x, y) holds its static claims in a read of the columns asked at registry epoch `asOf`: its
   *  land written (with the claims) by then — not coming in, not written after the read was asked */
  judged(x: number, y: number, asOf: number): boolean;
  /** whether window column (x, y) is in the window */
  inWindow(x: number, y: number): boolean;
  /** an instance let go (its owner's release or forget): out of its grid, never claimed with the land again */
  drop(inst: ExternalInstance): void;
  /** the columns an instance's claim can be let go in now (in the window, its land written): window frame */
  releasable(inst: ExternalInstance): ExternalCol[];
  /** (citygen M4b) whether window column (x, y) lies in a GPU-owned grid's box — its claims are its own, held and
   *  checked on the GPU (the orphan pass reads its spans: ownedJob), never judged on the CPU */
  gpuOwns(x: number, y: number): boolean;
  /** (M4b) the GPU-owned grid as the orphan pass reads it (null: none) */
  ownedJob?(): import('../game/colapply').OwnedGridJob | null;
  /** (M4b) an edit's boxes (world units, window frame): the GPU-owned grids' claims there checked on the GPU */
  damage?(boxes: [number, number, number, number][]): void;
}

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

/**
 * (round 128, INT16) The column with each span [z0, z1) cut out and made External, its aux the span's (the thing's
 * fallback), its touching runs joined. The rule ExternalRegistry.claim applies on the CPU and colapply.wgsl `claim` on
 * the GPU (test/gpu/colapply.test.ts holds them equal).
 */
export function claimColumn(col: Interval[], spans: { z0: number; z1: number; aux: number }[]): Interval[] {
  let out = col;
  for (const c of spans) {
    out = cutOut(out, c.z0, c.z1);
    out.push({ z0: c.z0, z1: c.z1, mat: MAT.External, aux: c.aux & 0xff });
  }
  return join(out);
}

/**
 * (round 120, JB6) The column with the External intervals within [c.z0, c.z1) let go — to `fallback` (0: stone), or air
 * (`toAir`) — its touching runs joined; null when nothing there was External. The rule ExternalRegistry.release applies
 * on the CPU and colapply.wgsl `release` on the GPU (test/gpu/colapply.test.ts holds them equal).
 */
export function releaseSpan(col: Interval[], c: { z0: number; z1: number }, fallback: number, toAir: boolean): Interval[] | null {
  let changed = false;
  const out: Interval[] = [];
  for (const iv of col) {
    if (iv.mat !== MAT.External || iv.z1 <= c.z0 + EPS || iv.z0 >= c.z1 - EPS) {
      out.push(iv);
      continue;
    }
    changed = true;
    if (iv.z0 < c.z0 - EPS) out.push({ ...iv, z1: c.z0 });
    if (!toAir) out.push({ z0: Math.max(iv.z0, c.z0), z1: Math.min(iv.z1, c.z1), mat: fallback || MAT.Stone });
    if (iv.z1 > c.z1 + EPS) out.push({ ...iv, z0: c.z1 });
  }
  return changed ? join(out) : null;
}

/**
 * (round 120, JB6) The column with the parts of its External intervals that none of `mine` (the claimed spans there, in
 * the registry's order) holds made their fallback material (aux; 0: stone), joined; null when every part is held. The
 * rule ExternalRegistry.orphans applies on the CPU and colapply.wgsl `orphans` on the GPU.
 */
export function orphanColumn(col: Interval[], mine: { z0: number; z1: number }[]): Interval[] | null {
  if (!col.some((iv) => iv.mat === MAT.External)) return null;
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
    let z = iv.z0;
    for (const [a, b] of rest) {
      if (a > z + EPS) out.push({ ...iv, z0: z, z1: a });
      out.push({ z0: a, z1: b, mat: iv.aux || MAT.Stone });
      z = b;
    }
    if (iv.z1 > z + EPS) out.push({ ...iv, z0: z });
  }
  return changed ? join(out) : null;
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
  /** (round 128g) bumped by every claim: a read of the columns asked for at epoch e judges only instances claimed by then */
  epoch = 0;
  /** (round 128j) the static things' claims (sim/static-claims.ts; null: none) */
  statics: StaticSet | null = null;
  stats ={ claimed: 0, cut: 0, loose: 0, released: 0, orphans: 0, live: 0, cells: 0, ms: 0 };

  constructor(private cols: ColumnAccess) {
    // (round 128i, FT-67: the cells counted when they're read, not at every claim and release — that walk over every
    // instance's every column was most of a town's claim, and ran once a building let go on a slide)
    Object.defineProperty(this.stats, 'cells', { enumerable: true, get: () => this.cells() });
  }

  /** An owner (a fixed small id). */
  owner(id: OwnerId, o: ExternalOwner): void {
    this.owners.set(id, o);
  }

  /** every instance: the moving ones', then the static ones' (round 128j: their cols may lie out of the window) */
  get instances(): IterableIterator<ExternalInstance> {
    const st = this.statics;
    const list = this.list;
    return (function* () {
      yield* list.values();
      if (st) yield* st.instances();
    })();
  }
  get size(): number {
    return this.list.size;
  }
  get(id: number): ExternalInstance | undefined {
    return this.list.get(id) ?? this.statics?.get(id);
  }

  /**
   * Claim cells: for each column, [z0, z1) wherever it is free (air or a liquid) becomes External — where there's
   * ground already the thing is buried in it, and that part isn't claimed. Returns the instance (null: nothing free).
   */
  claim(owner: OwnerId, want: ExternalCol[], fallback: number = MAT.Stone): ExternalInstance | null {
    const cols: ExternalCol[] = [];
    // (round 128: the GPU's stamp, given — what this claim takes in a column read before it's stamped is matter here)
    const stamp = this.cols.claim ? new Map<number, Interval[]>() : null;
    for (const w of want) {
      const k = w.y * 65536 + w.x;
      const col = stamp?.has(k) ? [...this.cols.read(w.x, w.y), ...stamp.get(k)!] : this.cols.read(w.x, w.y);
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
      const spans: { z0: number; z1: number; aux: number }[] = [];
      for (const [a, b] of free) {
        if (b - a < 0.05) continue;
        spans.push({ z0: a, z1: b, aux: fallback & 0xff });
        cols.push({ x: w.x, y: w.y, z0: a, z1: b });
      }
      if (!spans.length) continue;
      if (stamp) stamp.set(k, [...(stamp.get(k) ?? []), ...spans.map((c) => ({ z0: c.z0, z1: c.z1, mat: MAT.External, aux: c.aux }))]);
      else this.cols.write(w.x, w.y, claimColumn(col, spans));
    }
    if (stamp && cols.length) this.cols.claim!(cols.map((c) => ({ ...c, aux: fallback & 0xff })));
    if (!cols.length) return null;
    const inst: ExternalInstance = { id: this.nextId++, owner, cols, fallback, epoch: ++this.epoch };
    this.list.set(inst.id, inst);
    for (const c of cols) this.index(c.y * 65536 + c.x, inst.id);
    this.stats.claimed++;
    this.count();
    return inst;
  }

  /**
   * (round 128g) Claim cells without reading the columns: each span made External where it's free (air or a liquid) —
   * where there's ground the thing is buried in it — by the columns' own claimFree (the GPU's stamp), or, a CPU world, by
   * reading and writing each column. The instance holds the spans asked for (`free`); verify holds it whole while every
   * part of them is External or ground. Spans of one column go in order (a later one over an earlier is buried in it).
   */
  claimFree(owner: OwnerId, want: ExternalCol[], fallback: number = MAT.Stone): ExternalInstance | null {
    return this.claimFreeEach(owner, [want], fallback)[0];
  }

  /** (round 128g) claimFree for several things at once, in order: one stamp for all of them (one GPU dispatch, not one each) */
  claimFreeEach(owner: OwnerId, wants: ExternalCol[][], fallback: number = MAT.Stone): (ExternalInstance | null)[] {
    const all: (ExternalCol & { aux: number })[] = [];
    const out = wants.map((want) => {
      const cols = want.filter((w) => w.z1 - w.z0 >= 0.05).map((w) => ({ ...w }));
      if (!cols.length) return null;
      for (const c of cols) all.push({ ...c, aux: fallback & 0xff });
      const inst: ExternalInstance = { id: this.nextId++, owner, cols, fallback, free: true, epoch: ++this.epoch };
      this.list.set(inst.id, inst);
      for (const c of cols) this.index(c.y * 65536 + c.x, inst.id);
      this.stats.claimed++;
      return inst;
    });
    if (!all.length) return out;
    if (this.cols.claimFree) this.cols.claimFree(all);
    else {
      const byCol = new Map<number, typeof all>();
      for (const s of all) byCol.set(s.y * 65536 + s.x, [...(byCol.get(s.y * 65536 + s.x) ?? []), s]);
      for (const ss of byCol.values()) this.cols.write(ss[0].x, ss[0].y, claimFreeColumn(this.cols.read(ss[0].x, ss[0].y), ss));
    }
    this.count();
    return out;
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
    const st = this.statics?.get(id);
    if (st) {
      // (round 128j: a static thing — let go where it lies in the window now; out of its grid, so the land written
      // later doesn't claim it again: what was frozen with its cells claimed comes back orphaned, its fallback)
      const cols = this.statics!.releasable(st);
      this.statics!.drop(st);
      if (cols.length) {
        if (this.cols.release) this.cols.release(cols.map((c) => ({ ...c, fallback: st.fallback, toAir })));
        else
          for (const c of cols) {
            const out = releaseSpan(this.cols.read(c.x, c.y), c, st.fallback, toAir);
            if (out) this.cols.write(c.x, c.y, out);
          }
      }
      this.stats.released++;
      return;
    }
    const inst = this.list.get(id);
    if (!inst) return;
    this.forget(inst);
    // (round 120, JB6: given the columns' own release — the GPU's, no column read — it's theirs to do)
    if (this.cols.release) this.cols.release(inst.cols.map((c) => ({ ...c, fallback: inst.fallback, toAir })));
    else
      for (const c of inst.cols) {
        const out = releaseSpan(this.cols.read(c.x, c.y), c, inst.fallback, toAir);
        if (out) this.cols.write(c.x, c.y, out);
      }
    this.stats.released++;
    this.count();
  }

  /** Forget an instance without touching the columns (its owner rewrote them itself, or the world under it went). */
  forget(inst: ExternalInstance): void {
    if (this.statics?.get(inst.id)) {
      this.statics.drop(inst);
      return;
    }
    if (!this.list.delete(inst.id)) return;
    for (const c of inst.cols) {
      const k = c.y * 65536 + c.x;
      const l = this.byCol.get(k)?.filter((i) => i !== inst.id);
      if (l?.length) this.byCol.set(k, l);
      else this.byCol.delete(k);
    }
    this.count();
  }

  /** Forget every instance (undo, a warp: the columns under them are someone else's now). Not the static ones (round
   *  128j): they're their grids', written again with the land wherever it comes. */
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
    if (this.statics)
      for (const inst of this.statics.at(x, y)) if (inst.cols.some((c) => c.x === x && c.y === y && c.z1 > z0 + EPS && c.z0 < z1 - EPS)) out.push(inst);
    return out;
  }

  /**
   * The columns were read (all of them, or those `known` says): every instance there that lost a cell it claimed is
   * cut — its owner told. Then the External intervals there no one claims are orphans: their fallback material.
   */
  verify(known?: (x: number, y: number) => boolean, cols?: Iterable<number>, asOf = Infinity): void {
    const lost: ExternalInstance[] = [];
    const st = this.statics;
    for (const inst of this.instances) {
      // (round 128g: claimed after the read was asked for — the read can't show it yet; the next one judges it)
      if ((inst.epoch ?? 0) > asOf) continue;
      const isStatic = !!st && !this.list.has(inst.id);
      let ok = true;
      for (const c of inst.cols) {
        // (round 128j: a static thing judged only in the window, where its land — and so its claim — was written before
        // the read was asked)
        if (isStatic && !(st.inWindow(c.x, c.y) && st.judged(c.x, c.y, asOf))) continue;
        if (known && !known(c.x, c.y)) continue;
        const col = this.cols.read(c.x, c.y);
        if (!(inst.free ? heldOrBuried(col, c.z0, c.z1) : heldBy(col, c.z0, c.z1))) {
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
      // (M4b: a GPU-owned grid's columns are its own — the GPU's orphan pass holds its spans)
      if (this.statics?.gpuOwns(x, y)) continue;
      const mine = this.claimedAt(x, y);
      if (this.statics) for (const inst of this.statics.at(x, y)) for (const c of inst.cols) if (c.x === x && c.y === y) mine.push(c);
      const out = orphanColumn(this.cols.read(x, y), mine);
      if (!out) continue;
      this.stats.orphans++;
      this.cols.write(x, y, out);
    }
  }

  /** (round 120, JB6) every column's claimed spans (column key y · 65536 + x → spans in the registry's order) */
  claimedSpans(): Map<number, { z0: number; z1: number }[]> {
    const out = new Map<number, { z0: number; z1: number }[]>();
    for (const k of this.byCol.keys()) out.set(k, this.claimedAt(k % 65536, Math.floor(k / 65536)));
    // (round 128j: the static things' spans in the window, written with their land or still to be — never orphans)
    if (this.statics)
      for (const inst of this.statics.instances())
        for (const c of inst.cols) {
          if (!this.statics.inWindow(c.x, c.y)) continue;
          const k = c.y * 65536 + c.x;
          const l = out.get(k);
          if (l) l.push({ z0: c.z0, z1: c.z1 });
          else out.set(k, [{ z0: c.z0, z1: c.z1 }]);
        }
    return out;
  }

  /** the spans claimed in column (x, y), in the registry's order (orphans' `mine`) — the moving things' only */
  private claimedAt(x: number, y: number): { z0: number; z1: number }[] {
    return (this.byCol.get(y * 65536 + x) ?? []).flatMap((id) => this.list.get(id)!.cols.filter((c) => c.x === x && c.y === y));
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

  /** The window slid by (dx, dy) cells: instances move with the land (those leaving were released before). The static
   *  ones aren't moved here: their cols follow their grid's place in the window (round 128j). */
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
  }

  /** the cells every instance holds */
  private cells(): number {
    let n = 0;
    for (const i of this.list.values()) for (const c of i.cols) n += c.z1 - c.z0;
    return Math.round(n);
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
