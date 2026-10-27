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
import { NDIR, nbr } from '../world/lattice';

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
  /** (round 86) the rock's pieces as their runs, column by column (fractional ends kept), one per body; the
   *  structures' come as cells only */
  pieces?: { x: number; y: number; ivs: { z0: number; z1: number; mat: number }[] }[][];
}

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
export const fractureOpts = { runs: typeof location !== 'undefined' && new URLSearchParams(location.search).get('fracture') === 'runs' };

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
    if (touchesEdge) continue;
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

/** How far rock hangs over air before it gives, columns for each cell of its thickness (materials.ts `span`; Infinity: never) */
const ROCK_SPAN = 3;
/** rock freed in fewer cells than this stays where it is (a crumb), not a body */
const MIN_BODY = 8;
/** runs in neighbouring columns overlapping by this much (cells) hold each other up */
const OVERLAP = 0.5;
/** a hanging piece reaching this many runs is held (a cave's roof, joined on and on): the flood stops there */
const MAX_PIECE = 4096;

interface Run {
  x: number;
  y: number;
  z0: number;
  z1: number;
  /** its intervals (each its own material) */
  ivs: { z0: number; z1: number; mat: number }[];
  /** resting on something under it (or the bedrock) */
  stands: boolean;
  span: number;
}

/**
 * Rock (round 83, the user: undercut rock left floating — "Islands + weak overhangs", falling as bodies; "If
 * things are breaking just make a material that is stronger so they don't break"; "Make sure to get the
 * boundary correct and assume it is firmly anchored there"; "check columns not cells … overlapping intervals
 * of material for lateral support and vertical material for support from below. If it is supported from
 * below it can stand … if it is just supported laterally that's the only time you need to do any flood";
 * "you don't need to check all of them just the ones that we woke up"). From the columns an edit changed
 * (`seeds`) and the six round each, by the columns' intervals:
 *  - a run of rock resting on anything under it (or the bedrock) stands — nothing to look at;
 *  - a run with air under it hangs: held sideways by what it overlaps in the six columns round it — a run
 *    that stands, anything solid that isn't rock, the map's edge — or through the hanging runs it overlaps
 *    (the only flood, from the hanging runs by the seeds, a piece at a time; a piece of MAX_PIECE runs is held);
 *  - a hanging piece nothing holds falls as a body (tipping and tumbling as it goes);
 *  - a hanging run further than its material's span × its thickness (columns) from what holds it gives: the
 *    first such next to one that doesn't crumbles; what it held falls the next pass.
 * Structures keep their own rules (analyse); rock holds them.
 */
export function analyseRock(world: WorldVox, seeds: Iterable<[number, number]>): Fracture {
  const result: Fracture = { bodies: [], crumble: [], pieces: [] };
  const cache = new Map<number, Run[]>();
  const ivCache = new Map<number, { z0: number; z1: number; mat: number }[]>();
  const inMap = (x: number, y: number) => x >= 0 && y >= 0 && x < world.w && y < world.h;
  const colIvs = (x: number, y: number) => {
    const key = y * 65536 + x;
    let out = ivCache.get(key);
    if (out) return out;
    out = [];
    const { base, k } = columnSlots(world.packed, x, y);
    for (let s = 0; s < k; s++) {
      const iv = readSlot(world.slots, base + s);
      if (!iv) break;
      out.push({ z0: iv.z0, z1: iv.z1, mat: iv.mat });
    }
    ivCache.set(key, out);
    return out;
  };
  /** the column's runs of rock (touching intervals of rock are one) */
  const runsAt = (x: number, y: number): Run[] => {
    const key = y * 65536 + x;
    let rs = cache.get(key);
    if (rs) return rs;
    rs = [];
    let below: { z1: number } | null = null;
    for (const iv of colIvs(x, y)) {
      if (!isRock(iv.mat)) {
        below = iv;
        continue;
      }
      const last = rs[rs.length - 1];
      const span = MATERIALS[iv.mat].span ?? ROCK_SPAN;
      if (last && Math.abs(iv.z0 - last.z1) < 1e-3) {
        last.z1 = iv.z1;
        last.ivs.push(iv);
        last.span = Math.min(last.span, span);
      } else rs.push({ x, y, z0: iv.z0, z1: iv.z1, ivs: [iv], stands: iv.z0 < 1e-3 || (!!below && Math.abs(iv.z0 - below.z1) < 1e-3), span });
      below = iv;
    }
    cache.set(key, rs);
    return rs;
  };
  const overlaps = (a: { z0: number; z1: number }, b: { z0: number; z1: number }) => Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0) >= OVERLAP;
  const solid = (m: number) => MATERIALS[m]?.state === MatState.Solid;
  /** the hanging runs beside r (overlapping it), and whether anything that holds is beside it */
  const besides = (r: Run): { held: boolean; next: Run[] } => {
    let held = false;
    const next: Run[] = [];
    for (let k = 0; k < NDIR; k++) {
      const [nx, ny] = nbr(r.x, r.y, k);
      if (!inMap(nx, ny)) {
        held = true;
        continue;
      }
      for (const o of runsAt(nx, ny)) {
        if (!overlaps(o, r)) continue;
        if (o.stands) held = true;
        else next.push(o);
      }
      if (!held) for (const iv of colIvs(nx, ny)) if (!isRock(iv.mat) && solid(iv.mat) && overlaps(iv, r)) held = true;
    }
    return { held, next };
  };
  const cells = (r: Run) => {
    const out: Voxel[] = [];
    for (const iv of r.ivs) {
      const [c0, c1] = cellRange(iv.z0, iv.z1);
      for (let z = Math.max(0, c0); z < c1; z++) out.push({ x: r.x, y: r.y, z, mat: iv.mat });
    }
    return out;
  };
  // the hanging runs by the seeds
  const start: Run[] = [];
  const seen = new Set<Run>();
  for (const [sx, sy] of seeds) {
    const cols: [number, number][] = [[sx, sy]];
    for (let k = 0; k < NDIR; k++) cols.push(nbr(sx, sy, k));
    for (const [x, y] of cols) if (inMap(x, y)) for (const r of runsAt(x, y)) if (!r.stands) start.push(r);
  }
  for (const s of start) {
    if (seen.has(s)) continue;
    // its piece: the hanging runs joined to it; what of it is held beside, and how far each is from that
    const piece: Run[] = [s];
    seen.add(s);
    const next = new Map<Run, Run[]>();
    const held: Run[] = [];
    let big = false;
    for (let h = 0; h < piece.length; h++) {
      const r = piece[h];
      const b = besides(r);
      next.set(r, b.next);
      if (b.held) held.push(r);
      for (const o of b.next)
        if (!seen.has(o)) {
          seen.add(o);
          piece.push(o);
        }
      if (piece.length >= MAX_PIECE) {
        big = true;
        break;
      }
    }
    if (big) continue;
    if (!held.length) {
      const vox = piece.flatMap(cells);
      if (vox.length >= MIN_BODY) {
        result.bodies.push(vox);
        result.pieces!.push(piece.map((r) => ({ x: r.x, y: r.y, ivs: r.ivs.map((iv) => ({ ...iv })) })));
      }
      continue;
    }
    const dist = new Map<Run, number>();
    let frontier = held;
    for (const r of held) dist.set(r, 1);
    while (frontier.length) {
      const nf: Run[] = [];
      for (const r of frontier)
        for (const o of next.get(r)!) {
          if (dist.has(o)) continue;
          dist.set(o, dist.get(r)! + 1);
          nf.push(o);
        }
      frontier = nf;
    }
    // past its reach: the first such next to one that isn't (or to what holds it)
    const over = (r: Run) => dist.get(r)! > r.span * (r.z1 - r.z0);
    for (const r of piece) {
      if (!over(r)) continue;
      const d = dist.get(r)!;
      if (d === 1 || next.get(r)!.some((o) => dist.get(o)! < d && !over(o))) result.crumble.push(...cells(r));
    }
  }
  return result;
}
