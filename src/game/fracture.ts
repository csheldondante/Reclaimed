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

import { cellRange, columnSlots, readSlot, type PackedWorld } from '../world/layout';
import { MATERIALS, MatState } from '../world/materials';

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
}

/** Read-only voxel view of packed column slots (allocation-free lookups). */
export class WorldVox {
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

  /** Material at cell (x, y, z) (its centre z + 0.5), 0 for air or off the map. */
  matAt(x: number, y: number, z: number): number {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || z < 0) return 0;
    const { base, k } = columnSlots(this.packed, x, y);
    const c = z + 0.5;
    for (let s = 0; s < k; s++) {
      const iv = readSlot(this.slots, base + s);
      if (!iv) return 0;
      if (c < iv.z0) return 0;
      if (c < iv.z1) return iv.mat;
    }
    return 0;
  }

  /** Top of the column's highest run (0 if empty or off the map). */
  colTop(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    const { base, k } = columnSlots(this.packed, x, y);
    let top = 0;
    for (let s = 0; s < k; s++) {
      const iv = readSlot(this.slots, base + s);
      if (!iv) break;
      top = iv.z1;
    }
    return top;
  }

  /** Base of the loose ground on top of the column (its top if there is none): granular intervals touching from the top. */
  baseTop(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    const { base, k } = columnSlots(this.packed, x, y);
    const col: { z0: number; z1: number; mat: number }[] = [];
    for (let s = 0; s < k; s++) {
      const iv = readSlot(this.slots, base + s);
      if (!iv) break;
      col.push(iv);
    }
    let z = col.length ? col[col.length - 1].z1 : 0;
    for (let s = col.length - 1; s >= 0; s--) {
      if (MATERIALS[col[s].mat]?.state !== MatState.Granular || Math.abs(col[s].z1 - z) > 1e-3) break;
      z = col[s].z0;
    }
    return z;
  }

  /** Top of the run containing cell (x, y, z) (z itself must be inside one). */
  runTop(x: number, y: number, z: number): number {
    const { base, k } = columnSlots(this.packed, x, y);
    const c = z + 0.5;
    for (let s = 0; s < k; s++) {
      const iv = readSlot(this.slots, base + s);
      if (!iv) break;
      if (c >= iv.z0 && c < iv.z1) return iv.z1;
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
  const mat = new Uint8Array(N);
  const idx = (x: number, y: number, z: number) => (z * D + (y - y0)) * W + (x - x0);
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const { base, k } = columnSlots(world.packed, x, y);
      for (let s = 0; s < k; s++) {
        const iv = readSlot(world.slots, base + s);
        if (!iv) break;
        const [c0, c1] = cellRange(iv.z0, iv.z1);
        for (let z = Math.max(c0, 0); z < c1 && z < H; z++) mat[idx(x, y, z)] = iv.mat;
      }
    }
  const structural = new Uint8Array(256);
  for (let m = 0; m < MATERIALS.length; m++) structural[m] = isStructural(m) ? 1 : 0;
  // what holds a structure: terrain under it, or solid terrain beside it —
  // loose ground banked against it doesn't (round 24: a tower with sand
  // drifted round its foot was "keyed in" and never tipped)
  const loose = new Uint8Array(256);
  for (let m = 0; m < MATERIALS.length; m++) loose[m] = MATERIALS[m].state === MatState.Granular ? 1 : 0;
  const holds = (m: number, dz: number) => m !== 0 && !structural[m] && (dz < 0 || !loose[m]);
  const comp = new Int32Array(N).fill(-1);
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
  for (let start = 0; start < N; start++) {
    if (!structural[mat[start]] || comp[start] >= 0) continue;
    // flood the piece
    const cells: number[] = [start];
    comp[start] = nComp;
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
        const m = mat[j];
        if (!m) continue;
        if (!structural[m]) {
          if (holds(m, dz)) anchored = true;
          continue;
        }
        if (comp[j] < 0) {
          comp[j] = nComp;
          cells.push(j);
        }
      }
    }
    nComp++;
    if (touchesEdge) continue;
    const vox = (i: number): Voxel => {
      const [x, y, z] = coord(i);
      return { x, y, z, mat: mat[i] };
    };
    if (!anchored) {
      result.bodies.push(cells.map(vox));
      continue;
    }
    const piece = solve(cells);
    if (piece === 'tip') result.bodies.push(cells.map(vox));
    else if (piece) {
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
      const below = z > 0 ? mat[idx(x, y, z - 1)] : 1;
      if (z === 0 || (below && !structural[below])) foot.push([x, y]);
      for (const [dx, dy] of NB.slice(0, 4)) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < x0 || ny < y0 || nx >= x1 || ny >= y1) continue;
        const m = mat[idx(nx, ny, z)];
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
      if (z === 0 || (mat[below] && !structural[mat[below]]) || grounded.has(below)) grounded.add(i);
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
        const m = mat[idx(nx, ny, nz)];
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
        const ratio = moment / (CAPACITY * MATERIALS[mat[i]].strength * t * t * t);
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

/** How far rock hangs over air before it gives, a cell of its thickness (materials.ts `span`; Infinity: never) */
const ROCK_SPAN = 3;
/** the rock pass looks this far under the box's lowest ground (what's deeper stands on what's under it) */
const ROCK_DEPTH = 32;
/** a neck: rock this many cells or more standing on a section under NECK_SHARE of its own mean section */
const NECK_MASS = 24;
/** rock freed in fewer cells than this stays where it is (a crumb), not a body */
const MIN_BODY = 8;
const NECK_SHARE = 0.5;

/**
 * Rock (round 83, the user: undercut rock left floating; "Islands + weak overhangs", falling as bodies; "If
 * things are breaking just make a material that is stronger so they don't break"; "Make sure to get the
 * boundary correct and assume it is firmly anchored there"; "I want to topple spires of stone"). In the box,
 * from ROCK_DEPTH under its lowest ground up; what reaches past the box's sides or the map's edge, and the
 * box's floor, hold firmly:
 *  - islands: rock no longer joined to what holds it, nor resting on or keyed into anything else, falls (a
 *    body: it tips and tumbles as it goes);
 *  - overhangs: rock over air reaches at most its material's span (cells) × its thickness (its run up the
 *    column) from rock standing on what holds it; past that, the line where it gives crumbles;
 *  - necks: rock standing on a section much narrower than its own (a spire undercut) snaps there.
 * What's cut loose is an island the next pass drops. Structures keep their own rules (analyse); rock holds them.
 */
export function analyseRock(world: WorldVox, x0: number, y0: number, x1: number, y1: number): Fracture {
  x0 = Math.max(0, Math.floor(x0));
  y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(world.w, Math.ceil(x1));
  y1 = Math.min(world.h, Math.ceil(y1));
  const W = x1 - x0;
  const D = y1 - y0;
  const result: Fracture = { bodies: [], crumble: [] };
  if (W <= 0 || D <= 0) return result;
  const zMax = world.packed.dims.zMax;
  let low = Infinity;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) low = Math.min(low, world.baseTop(x, y));
  const zLo = Math.max(0, Math.floor(low) - ROCK_DEPTH);
  const Z = zMax - zLo;
  if (Z <= 0) return result;
  const N = W * D * Z;
  const mat = new Uint8Array(N);
  const idx = (x: number, y: number, z: number) => ((z - zLo) * D + (y - y0)) * W + (x - x0);
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const { base, k } = columnSlots(world.packed, x, y);
      for (let s = 0; s < k; s++) {
        const iv = readSlot(world.slots, base + s);
        if (!iv) break;
        const [c0, c1] = cellRange(iv.z0, iv.z1);
        for (let z = Math.max(c0, zLo); z < c1 && z < zMax; z++) mat[idx(x, y, z)] = iv.mat;
      }
    }
  const rock = new Uint8Array(256);
  const loose = new Uint8Array(256);
  const span = new Float32Array(256);
  for (let m = 0; m < MATERIALS.length; m++) {
    rock[m] = isRock(m) ? 1 : 0;
    loose[m] = MATERIALS[m].state === MatState.Granular ? 1 : 0;
    span[m] = MATERIALS[m].span ?? ROCK_SPAN;
  }
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
    return [x + x0, y + y0, (r - y) / D + zLo];
  };
  const inBox = (x: number, y: number, z: number) => x >= x0 && y >= y0 && x < x1 && y < y1 && z >= zLo && z < zMax;
  // held firmly: the box's floor; what goes on past its sides; the map's edge; anything solid beside or
  // under it that isn't rock (loose ground only under it)
  const held = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (!rock[mat[i]]) continue;
    const [x, y, z] = coord(i);
    if (z === zLo) {
      held[i] = 1;
      continue;
    }
    for (const [dx, dy, dz] of NB) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (nz >= zMax) continue;
      if (nx < 0 || ny < 0 || nx >= world.w || ny >= world.h) {
        held[i] = 1;
        break;
      }
      if (!inBox(nx, ny, nz)) {
        if (world.matAt(nx, ny, nz) !== 0) {
          held[i] = 1;
          break;
        }
        continue;
      }
      const m = mat[idx(nx, ny, nz)];
      if (m !== 0 && !rock[m] && (dz < 0 || !loose[m])) {
        held[i] = 1;
        break;
      }
    }
  }
  const vox = (i: number): Voxel => {
    const [x, y, z] = coord(i);
    return { x, y, z, mat: mat[i] };
  };
  const crumble = new Set<number>();
  const comp = new Int32Array(N).fill(-1);
  let nComp = 0;
  for (let start = 0; start < N; start++) {
    if (!rock[mat[start]] || comp[start] >= 0) continue;
    const cells: number[] = [start];
    comp[start] = nComp;
    let anyHeld = false;
    for (let h = 0; h < cells.length; h++) {
      const i = cells[h];
      if (held[i]) anyHeld = true;
      const [x, y, z] = coord(i);
      for (const [dx, dy, dz] of NB) {
        if (!inBox(x + dx, y + dy, z + dz)) continue;
        const j = idx(x + dx, y + dy, z + dz);
        if (rock[mat[j]] && comp[j] < 0) {
          comp[j] = nComp;
          cells.push(j);
        }
      }
    }
    const c = nComp++;
    if (!anyHeld) {
      // (a crumb stays: a body that small, settled on another, was written back over air and found free
      // again pass after pass; crumbled, its rubble set off more)
      if (cells.length >= MIN_BODY) result.bodies.push(cells.map(vox));
      continue;
    }
    // standing: held, or on an unbroken stack of the piece down to what is (index order is z-major)
    cells.sort((a, b) => a - b);
    const at = new Map<number, number>();
    cells.forEach((i, k) => at.set(i, k));
    const stand = new Uint8Array(cells.length);
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k];
      const [x, y, z] = coord(i);
      const below = z > zLo ? idx(x, y, z - 1) : -1;
      if (held[i] || (below >= 0 && comp[below] === c && stand[at.get(below)!])) stand[k] = 1;
    }
    // hanging: how far through the piece from what stands, against its reach (span × its run up the column)
    const dist = new Int32Array(cells.length).fill(-1);
    let frontier: number[] = [];
    for (let k = 0; k < cells.length; k++)
      if (stand[k]) {
        dist[k] = 0;
        frontier.push(k);
      }
    if (frontier.length === cells.length) continue;
    for (let d = 1; frontier.length; d++) {
      const next: number[] = [];
      for (const k of frontier) {
        const [x, y, z] = coord(cells[k]);
        for (const [dx, dy, dz] of NB) {
          if (!inBox(x + dx, y + dy, z + dz)) continue;
          const j = idx(x + dx, y + dy, z + dz);
          if (comp[j] !== c) continue;
          const kj = at.get(j)!;
          if (dist[kj] >= 0) continue;
          dist[kj] = d;
          next.push(kj);
        }
      }
      frontier = next;
    }
    const runOf = (x: number, y: number, z: number) => {
      let a = z;
      while (a + 1 < zMax && comp[idx(x, y, a + 1)] === c) a++;
      let b = z;
      while (b - 1 >= zLo && comp[idx(x, y, b - 1)] === c) b--;
      return a - b + 1;
    };
    const over = (k: number) => {
      if (dist[k] <= 0) return false;
      const [x, y, z] = coord(cells[k]);
      return dist[k] > span[mat[cells[k]]] * runOf(x, y, z);
    };
    // the line where it gives: past its reach, next to what isn't
    for (let k = 0; k < cells.length; k++) {
      if (!over(k)) continue;
      const [x, y, z] = coord(cells[k]);
      for (const [dx, dy, dz] of NB) {
        if (!inBox(x + dx, y + dy, z + dz)) continue;
        const j = idx(x + dx, y + dy, z + dz);
        if (comp[j] !== c) continue;
        const kj = at.get(j)!;
        if (dist[kj] < dist[k] && !over(kj)) {
          crumble.add(cells[k]);
          break;
        }
      }
    }
  }
  // necks: the rock built up from the top down a layer at a time (union–find); a piece over layer z that
  // nothing holds but its foot, standing on far less than its own mean section, snaps at its foot
  const parent = new Int32Array(N).fill(-1);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const mass = new Int32Array(N);
  const top = new Int32Array(N);
  const heldR = new Uint8Array(N);
  const cut = new Uint8Array(N);
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    parent[rb] = ra;
    mass[ra] += mass[rb];
    top[ra] = Math.max(top[ra], top[rb]);
    heldR[ra] |= heldR[rb];
    cut[ra] |= cut[rb];
  };
  const layer = W * D;
  for (let z = zMax - 1; z >= zLo; z--) {
    const o = (z - zLo) * layer;
    // the feet of the pieces over this layer: their cells with rock under them
    const feet = new Map<number, number[]>();
    if (z < zMax - 1)
      for (let q = 0; q < layer; q++) {
        const up = o + layer + q;
        if (parent[up] < 0 || !rock[mat[o + q]]) continue;
        const r = find(up);
        let f = feet.get(r);
        if (!f) feet.set(r, (f = []));
        f.push(up);
      }
    for (const [r, f] of feet) {
      if (heldR[r] || cut[r] || mass[r] < NECK_MASS) continue;
      const mean = mass[r] / (top[r] - z);
      if (f.length < NECK_SHARE * mean) {
        for (const i of f) crumble.add(i);
        cut[r] = 1;
      }
    }
    // this layer joins: its cells, with each other and with what's over them
    for (let q = 0; q < layer; q++) {
      const i = o + q;
      if (!rock[mat[i]]) continue;
      parent[i] = i;
      mass[i] = 1;
      top[i] = z;
      heldR[i] = held[i] && z > zLo ? 1 : 0;
      cut[i] = 0;
    }
    for (let q = 0; q < layer; q++) {
      const i = o + q;
      if (parent[i] < 0) continue;
      const x = q % W;
      if (x + 1 < W && parent[i + 1] >= 0) union(i, i + 1);
      if (q + W < layer && parent[i + W] >= 0) union(i, i + W);
      // (a piece cut at its foot isn't joined to what's under it: it hangs free, the next pass drops it)
      if (z < zMax - 1 && parent[i + layer] >= 0 && !cut[find(i + layer)]) union(i, i + layer);
    }
  }
  for (const i of crumble) result.crumble.push(vox(i));
  return result;
}
