// Structural integrity for structures (round 13/14, BACKLOG F7). Pure CPU,
// on a read-back copy of the layers, around places that just changed.
//
// What breaks free (DECISIONS round 13: "more physicsy will make things feel
// better"; terrain keeps its column rule):
//  - islands: a structural piece no longer touching terrain falls;
//  - tipping: a structure whose centre of mass lies outside the footprint it
//    stands on topples as one piece;
//  - snapping: each voxel's load (mass and first moment of everything it
//    holds up) is passed down every shortest path toward the ground, so the
//    bending moment at a voxel = carried mass × horizontal lever. Where the
//    moment beats strength × thickness³ (thickness from a distance field
//    inside the piece — the cheap stand-in for a medial axis), that cross-
//    section crumbles and what it held falls.
// Structural = solid and weaker than bedrock (strength < 1); everything else
// that isn't air (stone, soil, sand, trash, rubble…) is terrain and anchors.

import { CHUNK as CHUNK_V, SLOT_WORDS, cellRange, columnSlots, readSlot, type PackedWorld } from '../world/layout';
import { MATERIALS, MatState } from '../world/materials';
import { NDIR, cellPos, nbr } from '../world/lattice';

export interface Voxel {
  x: number;
  y: number;
  z: number;
  mat: number;
}

/** What the analysis found: pieces that break free, voxels that crumble. */
export interface Fracture {
  bodies: Voxel[][];
  crumble: Voxel[];
  /** (round 86) the rock's pieces as their runs, column by column (fractional ends kept) — the structures' come
   *  as cells (`bodies`) only */
  pieces?: RunPiece[];
  /** (round 87) the rock's runs that give (crumble to rubble), whole runs — the structures' come as cells (`crumble`) */
  crumbleRuns?: RunPiece;
  /** (round 87) a structure went on past the box: not judged (look again over a bigger box) */
  beyond?: boolean;
  /** (round 88, analyseRock) columns a piece reached that the CPU's copy doesn't hold as they are now: read them */
  need?: [number, number][];
  /** (round 88, analyseRock) the seeds of the pieces left for that: judged again once they're read */
  undecided?: [number, number][];
  /** (round 92, analyseRock) why what fell fell: held nowhere, a joint's load, crushed under it, tipped (counts) */
  why?: { free: number; load: number; crush: number; tip: number };
  /** (round 95, RockOpts.rotate) pieces that tip: the index in `pieces`, the edge they tip over (world x, y at
   *  height z, its direction a horizontal unit vector, turned the way it tips: right-handed about it) */
  tips?: { piece: number; pivot: [number, number, number]; axis: [number, number, number] }[];
}

/** (round 86) a piece of rock by its columns: each one's runs (window z, fractional ends kept) */
export type RunPiece = { x: number; y: number; ivs: { z0: number; z1: number; mat: number }[] }[];

/** Read-only voxel view of packed column slots (allocation-free lookups). */
export class WorldVox {
  /**
   * (perfopt, round 83 audit) The slots read in place — a slot's z0, z1 as floats, its material the low byte of its
   * third word — not through readSlot, which made a view and an object a slot: matAt walks a column a call, and the
   * bodies call it for every point of every substep.
   */
  private f32: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private slotsAt: Uint32Array | null = null;
  constructor(
    readonly packed: PackedWorld,
    public slots: Uint32Array,
  ) {}

  get w(): number {
    return this.packed.dims.w;
  }
  get h(): number {
    return this.packed.dims.h;
  }

  /** the float view of the slots (made again when they're replaced) */
  private floats(): Float32Array<ArrayBufferLike> {
    if (this.slotsAt !== this.slots) {
      this.slotsAt = this.slots;
      this.f32 = new Float32Array(this.slots.buffer, this.slots.byteOffset, this.slots.length);
    }
    return this.f32;
  }

  /** the slots of column (x, y): its first word and how many slots it has */
  private col(x: number, y: number): [number, number] {
    const p = this.packed;
    const ci = Math.floor(y / CHUNK_V) * p.chunksX + Math.floor(x / CHUNK_V);
    const k = p.chunkTable[ci * 2 + 1];
    return [(p.chunkTable[ci * 2] + ((y % CHUNK_V) * CHUNK_V + (x % CHUNK_V)) * k) * SLOT_WORDS, k];
  }

  /** Material at cell (x, y, z) (its centre z + 0.5), 0 for air or off the map. */
  matAt(x: number, y: number, z: number): number {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || z < 0) return 0;
    const f = this.floats();
    const u = this.slots;
    const [o, k] = this.col(x, y);
    const c = z + 0.5;
    for (let s = 0; s < k; s++) {
      const w = o + s * SLOT_WORDS;
      if (u[w + 1] === 0) return 0;
      if (c < f[w]) return 0;
      if (c < f[w + 1]) return u[w + 2] & 0xff;
    }
    return 0;
  }

  /** Top of the column's highest run (0 if empty or off the map). */
  colTop(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    const f = this.floats();
    const u = this.slots;
    const [o, k] = this.col(x, y);
    let top = 0;
    for (let s = 0; s < k; s++) {
      const w = o + s * SLOT_WORDS;
      if (u[w + 1] === 0) break;
      top = f[w + 1];
    }
    return top;
  }

  /** Base of the loose ground on top of the column (its top if there is none): granular intervals touching from the top. */
  baseTop(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    const f = this.floats();
    const u = this.slots;
    const [o, k] = this.col(x, y);
    let n = 0;
    while (n < k && u[o + n * SLOT_WORDS + 1] !== 0) n++;
    let z = n ? f[o + (n - 1) * SLOT_WORDS + 1] : 0;
    for (let s = n - 1; s >= 0; s--) {
      const w = o + s * SLOT_WORDS;
      if (MATERIALS[u[w + 2] & 0xff]?.state !== MatState.Granular || Math.abs(f[w + 1] - z) > 1e-3) break;
      z = f[w];
    }
    return z;
  }

  /** Top of the run containing cell (x, y, z) (z itself must be inside one). */
  runTop(x: number, y: number, z: number): number {
    const f = this.floats();
    const u = this.slots;
    const [o, k] = this.col(x, y);
    const c = z + 0.5;
    for (let s = 0; s < k; s++) {
      const w = o + s * SLOT_WORDS;
      if (u[w + 1] === 0) break;
      if (c >= f[w] && c < f[w + 1]) return f[w + 1];
    }
    return z + 1;
  }
}

export function isStructural(m: number): boolean {
  const d = MATERIALS[m];
  return !!d && d.state === MatState.Solid && d.strength < 1;
}

/**
 * Bending capacity per unit of strength × thickness³ (cells, unit masses): a
 * one-cell-thick steel beam holds a cantilever of about √(2·40·0.85) ≈ 8
 * cells, brick about 7, canvas about 5.
 */
const CAPACITY = 40;

/**
 * Analyse the structures in the box [x0, x1) × [y0, y1) (all heights).
 * Pieces reaching the box's side are left alone (they continue outside it).
 */
/**
 * (perfopt, round 83 audit: ?fracture=runs) The box's structural cells only, from the columns' runs — a sparse map
 * (the box is mostly ground and air: a 64² region came in as a W × D × zMax grid, a million cells unpacked and
 * scanned, 12–27 ms a pass on the desktop while riding); any other cell is looked up in its column when asked.
 */
/** (round 86: the runs by default — the same bodies and crumbs, round 83's audit; ?fracture=dense the whole box unpacked) */
export const fractureOpts = { runs: typeof location === 'undefined' || new URLSearchParams(location.search).get('fracture') !== 'dense' };

export function analyse(world: WorldVox, x0: number, y0: number, x1: number, y1: number): Fracture {
  x0 = Math.max(0, Math.floor(x0));
  y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(world.w, Math.ceil(x1));
  y1 = Math.min(world.h, Math.ceil(y1));
  const W = x1 - x0;
  const D = y1 - y0;
  const H = world.packed.dims.zMax;
  if (W <= 0 || D <= 0) return { bodies: [], crumble: [] };
  const N = W * D * H;
  const idx = (x: number, y: number, z: number) => (z * D + (y - y0)) * W + (x - x0);
  const structural = new Uint8Array(256);
  for (let m = 0; m < MATERIALS.length; m++) structural[m] = isStructural(m) ? 1 : 0;
  // the cells: dense (every cell of the box, all heights), or (fracture=runs) the structural ones only
  const dense = fractureOpts.runs ? null : new Uint8Array(N);
  const sparse = fractureOpts.runs ? new Map<number, number>() : null;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const { base, k } = columnSlots(world.packed, x, y);
      for (let s = 0; s < k; s++) {
        const iv = readSlot(world.slots, base + s);
        if (!iv) break;
        if (sparse && !structural[iv.mat]) continue;
        const [c0, c1] = cellRange(iv.z0, iv.z1);
        for (let z = Math.max(c0, 0); z < c1 && z < H; z++) {
          if (dense) dense[idx(x, y, z)] = iv.mat;
          else sparse!.set(idx(x, y, z), iv.mat);
        }
      }
    }
  if (sparse && !sparse.size) return { bodies: [], crumble: [] };
  const coordOf = (i: number): [number, number, number] => {
    const x = i % W;
    const r = (i - x) / W;
    const y = r % D;
    return [x + x0, y + y0, (r - y) / D];
  };
  // (a cell's material: the box's own, or — sparse, not structural — its column's)
  const mat = {
    at: (i: number): number => {
      if (dense) return dense[i];
      const m = sparse!.get(i);
      if (m !== undefined) return m;
      const [x, y, z] = coordOf(i);
      return world.matAt(x, y, z);
    },
  };
  // what holds a structure: terrain under it, or solid terrain beside it —
  // loose ground banked against it doesn't (round 24: a tower with sand
  // drifted round its foot was "keyed in" and never tipped)
  const loose = new Uint8Array(256);
  for (let m = 0; m < MATERIALS.length; m++) loose[m] = MATERIALS[m].state === MatState.Granular ? 1 : 0;
  const holds = (m: number, dz: number) => m !== 0 && !structural[m] && (dz < 0 || !loose[m]);
  const comp = dense ? new Int32Array(N).fill(-1) : null;
  const compS = dense ? null : new Map<number, number>();
  const compAt = (i: number) => (comp ? comp[i] : (compS!.get(i) ?? -1));
  const compSet = (i: number, c: number) => (comp ? (comp[i] = c) : compS!.set(i, c));
  const result: Fracture = { bodies: [], crumble: [] };
  const NB = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  const coord = (i: number): [number, number, number] => {
    const x = i % W;
    const r = (i - x) / W;
    const y = r % D;
    return [x + x0, y + y0, (r - y) / D];
  };
  let nComp = 0;
  // (in index order either way: z-major, as the dense scan went)
  const starts: Iterable<number> = dense ? dense.keys() : [...sparse!.keys()].sort((a, b) => a - b);
  for (const start of starts) {
    if (!structural[mat.at(start)] || compAt(start) >= 0) continue;
    // flood the piece
    const cells: number[] = [start];
    compSet(start, nComp);
    let touchesEdge = false;
    let anchored = false;
    for (let h = 0; h < cells.length; h++) {
      const [x, y, z] = coord(cells[h]);
      if (z === 0) anchored = true;
      for (const [dx, dy, dz] of NB) {
        const nx = x + dx;
        const ny = y + dy;
        const nz = z + dz;
        if (nz < 0 || nz >= H) continue;
        if (nx < x0 || ny < y0 || nx >= x1 || ny >= y1) {
          // the piece continues beyond the box (or the map edge holds it)
          if (world.matAt(nx, ny, nz)) touchesEdge = true;
          continue;
        }
        const j = idx(nx, ny, nz);
        const m = mat.at(j);
        if (!m) continue;
        if (!structural[m]) {
          if (holds(m, dz)) anchored = true;
          continue;
        }
        if (compAt(j) < 0) {
          compSet(j, nComp);
          cells.push(j);
        }
      }
    }
    nComp++;
    // (round 87: not judged here — it goes on past the box; the caller looks again over a bigger one)
    if (touchesEdge) {
      result.beyond = true;
      continue;
    }
    const vox = (i: number): Voxel => {
      const [x, y, z] = coord(i);
      return { x, y, z, mat: mat.at(i) };
    };
    if (!anchored) {
      result.bodies.push(cells.map(vox));
      continue;
    }
    const piece = solve(cells);
    // (round 86: a piece that would tip stands — pieces fall straight down in the columns (colbodies.ts), so one
    // resting on its foot came down where it was every pass; toppling is BACKLOG C4)
    if (piece === 'tip') continue;
    if (piece) {
      result.crumble.push(...piece.crumble.map(vox));
      // what the cut held up is now an island: the next pass drops it
    }
  }
  return result;

  /** Tipping and snapping for one anchored piece. */
  function solve(cells: number[]): 'tip' | { crumble: number[] } | null {
    const inPiece = new Set(cells);
    // footprint: the cells resting on terrain; centre of mass of the piece
    let cx = 0;
    let cy = 0;
    const foot: [number, number][] = [];
    let sideAnchored = false;
    for (const i of cells) {
      const [x, y, z] = coord(i);
      cx += x + 0.5;
      cy += y + 0.5;
      const below = z > 0 ? mat.at(idx(x, y, z - 1)) : 1;
      if (z === 0 || (below && !structural[below])) foot.push([x, y]);
      for (const [dx, dy] of NB.slice(0, 4)) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < x0 || ny < y0 || nx >= x1 || ny >= y1) continue;
        const m = mat.at(idx(nx, ny, z));
        if (holds(m, 0)) sideAnchored = true;
      }
    }
    cx /= cells.length;
    cy /= cells.length;
    // tipping: only pieces standing on the ground (not keyed into a wall)
    if (!sideAnchored && foot.length && !insideFootprint(foot, cx, cy)) return 'tip';
    // snapping: distance (in voxels) from the anchors along the piece. A voxel
    // standing on an unbroken stack of the piece down to the ground carries
    // its load straight down (no bending): it counts as an anchor too, so
    // only what hangs over air routes load sideways
    const grounded = new Set<number>();
    for (const i of [...cells].sort((a, b) => a - b)) {
      // (index order is z-major: every voxel's support below comes first)
      const [x, y, z] = coord(i);
      const below = z > 0 ? idx(x, y, z - 1) : -1;
      const mb = below >= 0 ? mat.at(below) : 0;
      if (z === 0 || (mb && !structural[mb]) || grounded.has(below)) grounded.add(i);
    }
    const dist = new Map<number, number>();
    let frontier: number[] = [];
    for (const i of cells) {
      const [x, y, z] = coord(i);
      let anchor = z === 0 || grounded.has(i);
      for (const [dx, dy, dz] of NB) {
        const nx = x + dx;
        const ny = y + dy;
        const nz = z + dz;
        if (nx < x0 || ny < y0 || nx >= x1 || ny >= y1 || nz < 0 || nz >= H) continue;
        const m = mat.at(idx(nx, ny, nz));
        if (holds(m, dz)) anchor = true;
      }
      if (anchor) {
        dist.set(i, 0);
        frontier.push(i);
      }
    }
    const order: number[] = [...frontier];
    for (let d = 1; frontier.length; d++) {
      const next: number[] = [];
      for (const i of frontier) {
        const [x, y, z] = coord(i);
        for (const [dx, dy, dz] of NB) {
          const nx = x + dx;
          const ny = y + dy;
          const nz = z + dz;
          if (nx < x0 || ny < y0 || nx >= x1 || ny >= y1 || nz < 0 || nz >= H) continue;
          const j = idx(nx, ny, nz);
          if (!inPiece.has(j) || dist.has(j)) continue;
          dist.set(j, d);
          next.push(j);
          order.push(j);
        }
      }
      frontier = next;
    }
    // thickness: distance from the piece's surface (1 on the skin)
    const thick = new Map<number, number>();
    let skin: number[] = [];
    for (const i of cells) {
      const [x, y, z] = coord(i);
      for (const [dx, dy, dz] of NB) {
        const nx = x + dx;
        const ny = y + dy;
        const nz = z + dz;
        const inside = nx >= x0 && ny >= y0 && nx < x1 && ny < y1 && nz >= 0 && nz < H && inPiece.has(idx(nx, ny, nz));
        if (!inside) {
          thick.set(i, 1);
          skin.push(i);
          break;
        }
      }
    }
    for (let t = 2; skin.length; t++) {
      const next: number[] = [];
      for (const i of skin) {
        const [x, y, z] = coord(i);
        for (const [dx, dy, dz] of NB) {
          const j = idx(x + dx, y + dy, z + dz);
          if (z + dz < 0 || z + dz >= H || !inPiece.has(j) || thick.has(j)) continue;
          thick.set(j, t);
          next.push(j);
        }
      }
      skin = next;
    }
    // carried load: far voxels first, each passes (mass, Σx, Σy) on, split
    // evenly over its neighbours one step nearer the ground
    const M = new Map<number, number>();
    const SX = new Map<number, number>();
    const SY = new Map<number, number>();
    for (const i of cells) {
      const [x, y] = coord(i);
      M.set(i, 1);
      SX.set(i, x + 0.5);
      SY.set(i, y + 0.5);
    }
    let worst = -1;
    let worstRatio = 1;
    for (let k = order.length - 1; k >= 0; k--) {
      const i = order[k];
      const d = dist.get(i)!;
      const [x, y, z] = coord(i);
      const m = M.get(i)!;
      const sx = SX.get(i)!;
      const sy = SY.get(i)!;
      if (d > 0) {
        const moment = Math.hypot(sx - m * (x + 0.5), sy - m * (y + 0.5));
        const t = 2 * thick.get(i)! - 1;
        const ratio = moment / (CAPACITY * MATERIALS[mat.at(i)].strength * t * t * t);
        if (ratio > worstRatio) {
          worstRatio = ratio;
          worst = i;
        }
      }
      const down: number[] = [];
      for (const [dx, dy, dz] of NB) {
        const j = idx(x + dx, y + dy, z + dz);
        if (z + dz < 0 || z + dz >= H || !inPiece.has(j)) continue;
        if (dist.get(j) === d - 1) down.push(j);
      }
      for (const j of down) {
        M.set(j, M.get(j)! + m / down.length);
        SX.set(j, SX.get(j)! + sx / down.length);
        SY.set(j, SY.get(j)! + sy / down.length);
      }
    }
    if (worst < 0) return null;
    // crumble the cross-section there: the worst voxel and its neighbours at
    // the same distance from the ground
    const dw = dist.get(worst)!;
    const cut = [worst];
    const [wx, wy, wz] = coord(worst);
    for (const [dx, dy, dz] of NB) {
      const j = idx(wx + dx, wy + dy, wz + dz);
      if (wz + dz < 0 || wz + dz >= H || !inPiece.has(j)) continue;
      if (dist.get(j) === dw) cut.push(j);
    }
    return { crumble: cut };
  }
}

/** Is (cx, cy) over the convex hull of the footprint cells (with a little give)? */
function insideFootprint(foot: [number, number][], cx: number, cy: number): boolean {
  const pts: [number, number][] = [];
  for (const [x, y] of foot) pts.push([x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]);
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  if (hull.length < 3) return false;
  // inside, or within 0.25 cells of an edge
  let inside = true;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (cross(a, b, [cx, cy]) / len < -0.25) inside = false;
  }
  return inside;
}

/** Rock (round 83): solid ground as strong as bedrock (stone, sandstone, basalt…), judged by analyseRock. */
export function isRock(m: number): boolean {
  const d = MATERIALS[m];
  return !!d && d.state === MatState.Solid && d.strength >= 1;
}

/**
 * (round 92) What holds rock up (the user: "connected components of solid intervals then look at total solid
 * support under an interval and see if it is sufficient for the volume of the connected section and if not
 * collapse it … supports can be vertical or horizontal"). Masses are cells × density (rock 1), strengths the
 * material table's (rock 1, concrete 0.8, steel 0.85, brick 0.6, wood 0.4 …).
 *  - BEND, SHEAR: a joint between runs in neighbouring columns (their side-holding intervals overlapping by h cells)
 *    holds strength × min(BEND h², SHEAR h) of load through it: a slab a cell thick reaches BEND (3) columns out
 *    from what holds it (round 83's span), one three thick or more SHEAR (10), whatever its thickness;
 *  - CRUSH: a column holding a piece up from below holds CRUSH × its bear (the least down its run: rock 1, soil
 *    0.3, sand 0.15 …) — a top of 300 cells of rock on one column of rock, 45 on one of sand;
 *  - NECK_R: the piece above a cut is followed this many columns from what hangs; past it it's keyed into the land
 *    (a cliff, a ridge), held; TIP_GIVE: how far (cells) a piece's centre of mass may lie past what it stands on.
 */
export const ROCK = { BEND: 3, SHEAR: 10, CRUSH: 300, NECK_R: 16, TIP_GIVE: 0.25 };
/** (round 87) rock freed in less than this (cells of volume) crumbles to rubble rather than falling as a body —
 *  it used to stay where it was, floating */
const MIN_BODY = 8;
/** runs in neighbouring columns overlapping by this much (cells) hold each other up */
const OVERLAP = 0.5;
/**
 * A hanging piece reaching this many runs that is held somewhere (a cave's roof, joined on and on) is held: the
 * flood stops there, its reach not judged. (Round 88: one held nowhere floods on to its end, however far — it
 * falls whole or not at all; round 87 stopped at 65536 runs and dropped what it had followed, leaving the rest
 * floating. Runs, not cells: a tower 8 columns across and 70 tall is 64 runs.)
 */
const MAX_PIECE = 4096;

/** (round 88) what holds a neighbour's run up sideways: solid ground of any strength, a plant's wood — not loose ground or a liquid */
const sideHolds = (m: number) => {
  const s = MATERIALS[m]?.state;
  return s === MatState.Solid || s === MatState.Vegetation;
};
/** (round 88) what a column's runs are made of: anything but air and a liquid (loose ground lying on rock is part of its run) */
const isMatter = (m: number) => {
  const s = MATERIALS[m]?.state;
  return s !== undefined && s !== MatState.Empty && s !== MatState.Liquid;
};
/** (round 92) the table's bear, density (materials.ts) with their defaults */
const bearOf = (m: number) => {
  const d = MATERIALS[m];
  if (!d) return 0;
  if (d.bear !== undefined) return d.bear;
  return d.state === MatState.Solid ? Math.min(1, d.strength) : d.state === MatState.Vegetation ? d.strength : 0.2;
};
const densityOf = (m: number) => MATERIALS[m]?.density ?? (MATERIALS[m]?.state === MatState.Vegetation ? 0.4 : 1);

/**
 * (round 88) A column's runs: its intervals touching one another, whatever they're made of (rock, a structure on
 * it, the loose ground on that) — a run either reaches the window's floor (it stands: what's under the window holds
 * it) or it hangs over air. Round 87's runs were the rock's alone, standing on whatever was under them — a run of
 * stone on a block of concrete that itself hung free stood, and the soil on a falling run of rock stayed in the air.
 */
interface Run {
  x: number;
  y: number;
  z0: number;
  z1: number;
  /** its intervals (each its own material) */
  ivs: { z0: number; z1: number; mat: number }[];
  /** it reaches the window's floor */
  stands: boolean;
  /** something solid in it (only such runs are judged: a plant's leaves hanging from it go with it) */
  solid: boolean;
}

/** (round 88) the runs of a column from its intervals */
function columnRuns(x: number, y: number, ivs: { z0: number; z1: number; mat: number }[]): Run[] {
  const rs: Run[] = [];
  let last: Run | null = null;
  for (const iv of ivs) {
    if (!isMatter(iv.mat)) {
      last = null;
      continue;
    }
    const solid = MATERIALS[iv.mat].state === MatState.Solid;
    // (round 92: or overlapping it — the sim's loose ground and basalt laid a hundredth into what's under them read
    // as a run of their own, hanging: the meteor's ejecta on its rim counted floating)
    if (last && iv.z0 <= last.z1 + 1e-3) {
      last.z1 = Math.max(last.z1, iv.z1);
      last.ivs.push(iv);
      last.solid ||= solid;
    } else {
      last = { x, y, z0: iv.z0, z1: iv.z1, ivs: [iv], stands: iv.z0 < 1e-3, solid };
      rs.push(last);
    }
  }
  return rs;
}

/**
 * (round 92) do intervals [p0, p1) and [q0, q1) in neighbouring columns touch face to face: they overlap by OVERLAP,
 * or by half the thinner one's thickness (round 88 asked OVERLAP of all: a stratum under a cell thick, tilted, its
 * runs a column apart overlapping by 0.47, read as floating — 383 of the highlands' 401 "floating" runs)
 */
function touch(p0: number, p1: number, q0: number, q1: number): boolean {
  const o = Math.min(p1, q1) - Math.max(p0, q0);
  return o > 1e-3 && o >= Math.min(OVERLAP, 0.5 * Math.min(p1 - p0, q1 - q0));
}

/** (round 88) do runs a and b (neighbouring columns) hold each other: intervals that hold sideways touching (`touch`) */
function joined(a: Run, b: Run): boolean {
  if (Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0) <= 1e-3) return false;
  for (const p of a.ivs) {
    if (!sideHolds(p.mat)) continue;
    for (const q of b.ivs) if (sideHolds(q.mat) && touch(p.z0, p.z1, q.z0, q.z1)) return true;
  }
  return false;
}

/**
 * (round 92) The joint between runs a and b (neighbouring columns), each from its own height up (a0, b0): how much
 * their side-holding intervals overlap (h, cells) and what that holds (ROCK.BEND, SHEAR; Infinity: bedrock in it).
 */
function joint(a: Run, b: Run, a0 = -Infinity, b0 = -Infinity): { h: number; cap: number } {
  let h = 0;
  let s = 1;
  let never = false;
  let touches = false;
  for (const p of a.ivs) {
    if (!sideHolds(p.mat)) continue;
    const p0 = Math.max(p.z0, a0);
    for (const q of b.ivs) {
      if (!sideHolds(q.mat)) continue;
      const q0 = Math.max(q.z0, b0);
      const o = Math.min(p.z1, q.z1) - Math.max(p0, q0);
      if (o <= 0) continue;
      if (touch(p0, p.z1, q0, q.z1)) touches = true;
      h += o;
      s = Math.min(s, MATERIALS[p.mat].strength, MATERIALS[q.mat].strength);
      if (MATERIALS[p.mat].span === Infinity || MATERIALS[q.mat].span === Infinity) never = true;
    }
  }
  if (!touches) return { h: 0, cap: 0 };
  return { h, cap: never ? Infinity : s * Math.min(ROCK.BEND * h * h, ROCK.SHEAR * h) };
}

/** (round 92) a run's mass from height z0 up */
function massOf(r: Run, z0 = -Infinity): number {
  let m = 0;
  for (const iv of r.ivs) m += Math.max(0, iv.z1 - Math.max(iv.z0, z0)) * densityOf(iv.mat);
  return m;
}

/** (round 92) a run's intervals from height z0 up (cut there) */
function clipIvs(r: Run, z0: number): { z0: number; z1: number; mat: number }[] {
  const out: { z0: number; z1: number; mat: number }[] = [];
  for (const iv of r.ivs) if (iv.z1 > z0 + 1e-3) out.push({ z0: Math.max(iv.z0, z0), z1: iv.z1, mat: iv.mat });
  return out;
}

/** What one judging of the rock may do (Integrity: seams of land come in only fall what floats) */
export interface RockOpts {
  /**
   * (round 92) weigh what's held: the joints' load, the piece above a cut on its columns, tipping (default true). A
   * test of columns: only a piece with a run in one, or held by a run in one (what an edit cut), is weighed — the
   * land as it was made stands, what an edit weakened is judged (a meteor's seeds reach its ejecta's 30 cells: a
   * leaning spire there stood untouched and fell)
   */
  weigh?: boolean | ((x: number, y: number) => boolean);
  /**
   * (round 95, `?rockbody=1`) what tips turns: a piece whose centre of mass is off what it stands on isn't dropped
   * through crushed columns — it's cut free above them (they stand) and its edge reported (`tips`), to topple about
   */
  rotate?: boolean;
}

/**
 * Rock (round 83, the user: undercut rock left floating — "Islands + weak overhangs", falling as bodies; "check
 * columns not cells … overlapping intervals of material for lateral support and vertical material for support
 * from below"; "you don't need to check all of them just the ones that we woke up"). From the columns an edit
 * changed (`seeds`) and the six round each, by the columns' runs (round 88: every material's, columnRuns):
 *  - a run reaching the window's floor stands — nothing to look at;
 *  - a run with air under it hangs: held sideways by a run it's joined to (`joined`) that stands, or the map's
 *    edge — or through the hanging runs it's joined to (the only flood, from the hanging runs by the seeds, a
 *    piece at a time; a held piece of MAX_PIECE runs is held; one held nowhere is followed to its end);
 *  - a hanging piece nothing holds falls, whole.
 * (Round 92, the user's: "look at total solid support under an interval and see if it is sufficient for the volume
 * of the connected section and if not collapse it … flood fill in from the edges by distance so that you sum
 * column mass and support from neighbors. If the mass ever exceeds the support then drop the column"; "where it
 * breaks"; tipping "now and we can add rotation later") A held piece is then weighed (opts.weigh):
 *  - its load, from the far end in (the reverse of its distance from what holds it): each run carries its own mass
 *    and what's handed to it, and hands it on to the runs a step nearer (and what holds it) in proportion to what
 *    each joint holds (`joint`). Where that's more than its joints hold, they give: it and what hangs beyond it
 *    fall (pieces, as what broke free); one whose every held run gives falls whole;
 *  - else the piece above the cut (`neck`): from its lowest point zc up — it and the standing runs it's joined to
 *    above zc, followed NECK_R columns (past that it's keyed into the land: held) — on the standing columns under
 *    it: if it weighs more than they bear (CRUSH × their bear), or its centre of mass lies off them (tipping: it
 *    falls straight; rotation later), those columns crush from where it would land to zc and it all falls.
 * A piece is complete if an edit could have cut it free: whatever lost its way to the ground lost it through
 * what the edit took, so it holds a run in a cut column or beside one. `known` (round 88): the columns the CPU's
 * copy holds as they are now — a piece reaching any other is left (`need`: those columns; `undecided`: its seeds),
 * to be read and judged again.
 * Structures keep their own rules (analyse: snapping, tipping); what hangs free here falls whatever it's made of.
 */
export function analyseRock(world: WorldVox, seeds: Iterable<[number, number]>, known?: (x: number, y: number) => boolean, opts: RockOpts = {}): Fracture {
  const weighAll = opts.weigh ?? true;
  const cutAt = typeof weighAll === 'function' ? weighAll : null;
  const weigh = weighAll !== false;
  /** (round 92) runs a neck's flood found keyed into the land above a height: any flood from that height or lower is */
  const keyedAt = new Map<Run, number>();
  const result: Fracture = { bodies: [], crumble: [], pieces: [], crumbleRuns: [], need: [], undecided: [], why: { free: 0, load: 0, crush: 0, tip: 0 }, tips: [] };
  const cache = new Map<number, Run[]>();
  const inMap = (x: number, y: number) => x >= 0 && y >= 0 && x < world.w && y < world.h;
  const unknown = new Set<number>();
  const runsAt = (x: number, y: number): Run[] => {
    const key = y * 65536 + x;
    let rs = cache.get(key);
    if (rs) return rs;
    const ivs: { z0: number; z1: number; mat: number }[] = [];
    const { base, k } = columnSlots(world.packed, x, y);
    for (let s = 0; s < k; s++) {
      const iv = readSlot(world.slots, base + s);
      if (!iv) break;
      ivs.push({ z0: iv.z0, z1: iv.z1, mat: iv.mat });
    }
    rs = columnRuns(x, y, ivs);
    cache.set(key, rs);
    return rs;
  };
  /** the hanging runs joined to r, the standing ones (what holds it), the map's edge by it */
  const besides = (r: Run): { held: boolean; next: Run[]; stand: Run[]; edge: boolean; stale: boolean } => {
    let edge = false;
    let stale = false;
    const next: Run[] = [];
    const stand: Run[] = [];
    for (let k = 0; k < NDIR; k++) {
      const [nx, ny] = nbr(r.x, r.y, k);
      if (!inMap(nx, ny)) {
        edge = true;
        continue;
      }
      if (known && !known(nx, ny)) {
        stale = true;
        unknown.add(ny * 65536 + nx);
      }
      for (const o of runsAt(nx, ny)) {
        if (!joined(o, r)) continue;
        if (o.stands) stand.push(o);
        else next.push(o);
      }
    }
    return { held: edge || stand.length > 0, next, stand, edge, stale };
  };
  const runsOf = (rs: Run[]): RunPiece => rs.map((r) => ({ x: r.x, y: r.y, ivs: r.ivs.map((iv) => ({ ...iv })) }));
  /** what's left free (no way to what holds it): a piece if big enough, else it crumbles */
  const free = (rs: Run[]) => {
    const volume = rs.reduce((s, r) => s + r.z1 - r.z0, 0);
    if (volume >= MIN_BODY) result.pieces!.push(runsOf(rs));
    else result.crumbleRuns!.push(...runsOf(rs));
  };
  // the hanging runs by the seeds
  const start: { r: Run; seed: [number, number] }[] = [];
  /** the runs followed so far, by the piece (its first run) they were found in */
  const seen = new Map<Run, Run>();
  for (const [sx, sy] of seeds) {
    const cols: [number, number][] = [[sx, sy]];
    for (let k = 0; k < NDIR; k++) cols.push(nbr(sx, sy, k));
    for (const [x, y] of cols) if (inMap(x, y)) for (const r of runsAt(x, y)) if (!r.stands && r.solid) start.push({ r, seed: [sx, sy] });
  }
  for (const { r: s, seed } of start) {
    if (seen.has(s)) continue;
    // its piece: the hanging runs joined to it; what of it is held beside, and how far each is from that
    const piece: Run[] = [s];
    seen.set(s, s);
    const near = new Map<Run, ReturnType<typeof besides>>();
    const held: Run[] = [];
    let big = false;
    let stale = !!known && !known(s.x, s.y);
    for (let h = 0; h < piece.length; h++) {
      const r = piece[h];
      const b = besides(r);
      near.set(r, b);
      if (b.held) held.push(r);
      for (const o of b.next) {
        const of = seen.get(o);
        if (of === undefined) {
          seen.set(o, s);
          piece.push(o);
        } else if (of !== s) big = true;
      }
      if (b.stale) stale = true;
      // (round 88) joined to a piece judged held before (followed to MAX_PIECE, not to its end): held with it.
      // Round 87 took the runs short of it as a piece of their own — falling from what holds them, or a pass that
      // threw (next.get of a run not in the piece) and judged nothing after it
      if (big || (piece.length >= MAX_PIECE && held.length)) {
        big = true;
        break;
      }
    }
    if (big) continue;
    // (round 88) it reaches columns the copy doesn't hold as they are: read them, judge it again
    if (stale && (!held.length || weigh)) {
      for (const k of unknown) result.need!.push([k % 65536, Math.floor(k / 65536)]);
      unknown.clear();
      result.undecided!.push(seed);
      continue;
    }
    if (!held.length) {
      free(piece);
      result.why!.free++;
      continue;
    }
    if (!weigh) continue;
    if (cutAt && !piece.some((r) => cutAt(r.x, r.y) || near.get(r)!.stand.some((o) => cutAt(o.x, o.y)))) continue;
    // (round 92) its load, from the far end in: what gives, and what hangs beyond it
    const dist = new Map<Run, number>();
    let frontier = held;
    for (const r of held) dist.set(r, 1);
    while (frontier.length) {
      const nf: Run[] = [];
      for (const r of frontier)
        for (const o of near.get(r)!.next) {
          if (dist.has(o)) continue;
          dist.set(o, dist.get(r)! + 1);
          nf.push(o);
        }
      frontier = nf;
    }
    // the cross-sections from the far end in: at each step k, every part of the piece k or more steps out (joined
    // within that) weighs what it weighs and is held by the joints from its runs k out to those k - 1 out (and to
    // what holds it); the part whose weight is the most over what its joints hold gives there — it falls (one break a
    // pass: what's left is judged again). Summed across the part, not run by run: load spreads across a slab's
    // width (round 92's first try, each run handing its load on alone, broke a slab's edge row for its own length)
    let maxD = 0;
    for (const d of dist.values()) maxD = Math.max(maxD, d);
    const byD: Run[][] = Array.from({ length: maxD + 1 }, () => []);
    for (const r of piece) byD[dist.get(r)!].push(r);
    const up = new Map<Run, Run>();
    const mass = new Map<Run, number>();
    const find = (r: Run): Run => {
      let p = up.get(r)!;
      while (p !== up.get(p)) p = up.get(p)!;
      let q = r;
      while (q !== p) {
        const n = up.get(q)!;
        up.set(q, p);
        q = n;
      }
      return p;
    };
    let worst = 1;
    let breakAt: [Run, number] | null = null;
    for (let k = maxD; k >= 1; k--) {
      for (const r of byD[k]) {
        up.set(r, r);
        mass.set(r, massOf(r));
      }
      for (const r of byD[k])
        for (const o of near.get(r)!.next) {
          if (!up.has(o)) continue;
          const a = find(r);
          const b = find(o);
          if (a === b) continue;
          up.set(b, a);
          mass.set(a, mass.get(a)! + mass.get(b)!);
        }
      const cap = new Map<Run, number>();
      for (const r of byD[k]) {
        const b = near.get(r)!;
        let c = b.edge ? Infinity : 0;
        for (const o of b.next) if (dist.get(o) === k - 1) c += joint(r, o).cap;
        for (const o of b.stand) c += joint(r, o).cap;
        const root = find(r);
        cap.set(root, (cap.get(root) ?? 0) + c);
      }
      for (const [root, c] of cap) {
        const ratio = mass.get(root)! / c;
        if (ratio > worst) {
          worst = ratio;
          breakAt = [root, k];
        }
      }
    }
    if (breakAt) {
      // what's k or more out, joined to it within that: falls
      const [r0, k] = breakAt;
      const part = [r0];
      const done = new Set<Run>(part);
      for (let h = 0; h < part.length; h++)
        for (const o of near.get(part[h])!.next)
          if (!done.has(o) && dist.get(o)! >= k) {
            done.add(o);
            part.push(o);
          }
      free(part);
      result.why!.load++;
      continue;
    }
    neck(piece, seed);
  }
  return result;

  /**
   * (round 92) The piece above its lowest point: on what it stands on, or it falls (the user's "total solid
   * support under an interval … sufficient for the volume of the connected section"; "supports can be vertical or
   * horizontal").
   */
  function neck(piece: Run[], seed: [number, number]): void {
    let zc = Infinity;
    for (const r of piece) zc = Math.min(zc, r.z0);
    /** the piece above zc: each run from its height up (the standing ones cut at zc) and its hops from the hanging piece */
    const B = new Map<Run, { z0: number; hop: number }>();
    const list: Run[] = [];
    for (const r of piece) {
      B.set(r, { z0: r.z0, hop: 0 });
      list.push(r);
    }
    /** keyed into the land: what it reached is, from zc up */
    const keyed = () => {
      for (const r of list) keyedAt.set(r, Math.min(keyedAt.get(r) ?? Infinity, zc));
    };
    for (let h = 0; h < list.length; h++) {
      const r = list[h];
      const e = B.get(r)!;
      for (let k = 0; k < NDIR; k++) {
        const [nx, ny] = nbr(r.x, r.y, k);
        // (the map's edge holds it; a column not read as it is now: not judged on it)
        if (!inMap(nx, ny)) return keyed();
        if (known && !known(nx, ny)) {
          result.need!.push([nx, ny]);
          result.undecided!.push(seed);
          return;
        }
        for (const o of runsAt(nx, ny)) {
          if (B.has(o)) continue;
          const oz0 = o.stands ? zc : o.z0;
          if (o.z1 - oz0 < OVERLAP || joint(r, o, e.z0, oz0).h <= 0) continue;
          // (on past NECK_R columns, or past MAX_PIECE runs, or to what a flood before found so: keyed into the land, held)
          if (e.hop + 1 > ROCK.NECK_R || list.length >= MAX_PIECE || (keyedAt.get(o) ?? -Infinity) >= zc) return keyed();
          B.set(o, { z0: oz0, hop: e.hop + 1 });
          list.push(o);
        }
      }
    }
    // what it weighs and where; what it stands on and what that bears
    let M = 0;
    let mx = 0;
    let my = 0;
    let bear = 0;
    const foot: [number, number][] = [];
    for (const r of list) {
      const z0 = B.get(r)!.z0;
      const m = massOf(r, z0);
      const [px, py] = cellPos(r.x, r.y);
      M += m;
      mx += m * px;
      my += m * py;
      if (r.stands) {
        let b = Infinity;
        for (const iv of r.ivs) if (iv.z0 < zc) b = Math.min(b, bearOf(iv.mat));
        if (r.ivs.some((iv) => iv.z0 < zc && MATERIALS[iv.mat].span === Infinity)) b = Infinity;
        bear += ROCK.CRUSH * b;
        foot.push([px, py]);
      }
    }
    if (!foot.length || M <= 0) return;
    const tips = !insideHull(foot, mx / M, my / M, ROCK.TIP_GIVE);
    if (M <= bear && !tips) return;
    if (tips) result.why!.tip++;
    else result.why!.crush++;
    // (round 95) it turns over the edge of what it stands on: cut free above it, nothing crushed
    if (tips && opts.rotate) {
      const fall: RunPiece = [];
      for (const r of list) {
        const up = clipIvs(r, B.get(r)!.z0);
        if (up.length) fall.push({ x: r.x, y: r.y, ivs: up });
      }
      const e = hullEdge(foot, mx / M, my / M);
      result.tips!.push({ piece: result.pieces!.length, pivot: [e.at[0], e.at[1], zc], axis: [e.axis[0], e.axis[1], 0] });
      result.pieces!.push(fall);
      for (const r of list) seen.set(r, piece[0]);
      return;
    }
    // it gives: the standing columns under it crush from where it would land to zc; it all falls from there
    let land = 0;
    for (const r of piece) {
      for (const o of runsAt(r.x, r.y)) if (o.z1 <= r.z0 + 1e-3) land = Math.max(land, o.z1);
    }
    const zs = Math.max(0, Math.min(land, zc - 1));
    const fall: RunPiece = [];
    for (const r of list) {
      const z0 = B.get(r)!.z0;
      if (r.stands) {
        const ivs: { z0: number; z1: number; mat: number }[] = [];
        for (const iv of r.ivs) if (iv.z1 > zs + 1e-3 && iv.z0 < zc - 1e-3) ivs.push({ z0: Math.max(iv.z0, zs), z1: Math.min(iv.z1, zc), mat: iv.mat });
        if (ivs.length) result.crumbleRuns!.push({ x: r.x, y: r.y, ivs });
        const up = clipIvs(r, zc);
        if (up.length) fall.push({ x: r.x, y: r.y, ivs: up });
      } else fall.push({ x: r.x, y: r.y, ivs: clipIvs(r, z0) });
    }
    result.pieces!.push(fall);
    // (what's in it isn't judged again this pass)
    for (const r of list) seen.set(r, piece[0]);
  }
}

/**
 * (round 95) The edge of these columns' hull (world centres, a cell across) that (cx, cy) lies furthest outside: the
 * point on it nearest (cx, cy) and its direction, signed so that turning right-handed about it carries (cx, cy) out
 * and down.
 */
function hullEdge(cols: [number, number][], cx: number, cy: number): { at: [number, number]; axis: [number, number] } {
  const hull = hullOf(cols);
  let best = { at: [cx, cy] as [number, number], axis: [1, 0] as [number, number] };
  let worst = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const ux = (b[0] - a[0]) / L;
    const uy = (b[1] - a[1]) / L;
    // (counter-clockwise hull: inside is to the left, the signed distance negative outside)
    const s = (ux * (cy - a[1]) - uy * (cx - a[0]));
    if (s < worst) {
      worst = s;
      const t = Math.max(0, Math.min(L, (cx - a[0]) * ux + (cy - a[1]) * uy));
      // (about u, right-handed, up turns toward u × up = (uy, -ux): to the right of a→b, outside)
      best = { at: [a[0] + ux * t, a[1] + uy * t], axis: [ux, uy] };
    }
  }
  return best;
}

/** (round 95) the convex hull (counter-clockwise) of columns (world centres, each a cell across) */
function hullOf(cols: [number, number][]): [number, number][] {
  const pts: [number, number][] = [];
  for (const [x, y] of cols) pts.push([x - 0.5, y - 0.5], [x + 0.5, y - 0.5], [x - 0.5, y + 0.5], [x + 0.5, y + 0.5]);
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** (round 92) Is (cx, cy) over the convex hull of these columns (world centres, each a cell across), within `give`? */
function insideHull(cols: [number, number][], cx: number, cy: number, give: number): boolean {
  const pts: [number, number][] = [];
  for (const [x, y] of cols) pts.push([x - 0.5, y - 0.5], [x + 0.5, y - 0.5], [x - 0.5, y + 0.5], [x + 0.5, y + 0.5]);
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    if (cross(a, b, [cx, cy]) / Math.hypot(b[0] - a[0], b[1] - a[1]) < -give) return false;
  }
  return true;
}

/**
 * (round 88) The ground truth the tests hold the game to: every run of the window (columnRuns) that holds something
 * solid and has no way to the ground — a flood from every run reaching the window's floor (and every run of the
 * map's edge columns: held there, as analyseRock takes it) through the runs joined to them. What's left over floats.
 */
export function floatingRuns(world: WorldVox): { runs: number; floating: { x: number; y: number; z0: number; z1: number; mat: number }[] } {
  const W = world.w;
  const H = world.h;
  const cols: Run[][] = new Array(W * H);
  let runs = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const ivs: { z0: number; z1: number; mat: number }[] = [];
      const { base, k } = columnSlots(world.packed, x, y);
      for (let s = 0; s < k; s++) {
        const iv = readSlot(world.slots, base + s);
        if (!iv) break;
        ivs.push({ z0: iv.z0, z1: iv.z1, mat: iv.mat });
      }
      cols[y * W + x] = columnRuns(x, y, ivs);
      runs += cols[y * W + x].length;
    }
  const reached = new Set<Run>();
  const queue: Run[] = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1;
      for (const r of cols[y * W + x])
        if (r.stands || edge) {
          reached.add(r);
          queue.push(r);
        }
    }
  for (let h = 0; h < queue.length; h++) {
    const r = queue[h];
    for (let k = 0; k < NDIR; k++) {
      const [nx, ny] = nbr(r.x, r.y, k);
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      for (const o of cols[ny * W + nx])
        if (!reached.has(o) && joined(o, r)) {
          reached.add(o);
          queue.push(o);
        }
    }
  }
  const floating: { x: number; y: number; z0: number; z1: number; mat: number }[] = [];
  for (const c of cols)
    for (const r of c) if (!reached.has(r) && r.solid) floating.push({ x: r.x, y: r.y, z0: r.z0, z1: r.z1, mat: r.ivs.find((iv) => MATERIALS[iv.mat].state === MatState.Solid)!.mat });
  return { runs, floating };
}
