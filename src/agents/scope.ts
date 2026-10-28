// Where the agents' fields are kept, and where they're relaxed (round 104, simscale — the user: "For the agents we
// already discussed that we should compute paths instead of flow fields for towns then just move agents along the
// paths between destinations. Flow fields can be generated as needed and I suspect only during large combats or
// storms").
//
// Two cuts (agents.ts encodeScoped, agents.wgsl):
//  - the scope: the surfaces, the links, the fields and the occupancy are made only over the chunks round what the
//    agents do — every live unit (their box, read back from the GPU now and then), the fields' seeds, the targets,
//    what's held or in flight — with a margin a path can bend through, each chunk held a while after it was last
//    needed. A chunk come into it starts over (every field unreachable there, nobody there: units.wgsl scopeIn); a
//    neighbour past it is no way.
//  - the front: a sweep relaxes only the chunks where something changed in the last one, and those next to them
//    (agents.wgsl frontBuild, from a per-chunk dirty mark: a distance that moved, a surface or a link peeled
//    differently, a seed placed or moved, a chunk come into the scope). Settled fields mark nothing, so the front
//    empties and the fields cost nothing: a town's legs (homes, jobs, heaps, the well) are its paths, made once and
//    walked down; what moves (a raid's targets, a hunt, the ground dug) is relaxed where it moves. The GPU's
//    equivalent of the user's paths, not a CPU path graph (BACKLOG ST15 stays open).

import { CHUNK } from '../world/layout';

/** columns round what the agents do that the fields reach: room for a path to bend round what's in its way */
export const SCOPE_MARGIN = 48;

export type Box = [number, number, number, number];

/** ticks a chunk stays in the scope after it was last needed */
const HOLD_TICKS = 600;

export class AgentScope {
  /** the scope (columns, [x0, y0, x1, y1), whole chunks) this tick; null: nothing */
  box: Box | null = null;
  /** the chunks needed and the tick each was last needed: kept HOLD_TICKS after (a scope at the edge of a chunk
   *  doesn't flap in and out, starting it over each time) */
  private chunks = new Map<number, number>();
  /** the chunks the last update listed (the box of those held) */
  private inList = new Set<number>();
  /** the live units' box from the GPU (columns, inclusive) at its last read; null: none alive */
  gpuBox: Box | null = null;
  /** units placed since the read that will see them (columns), with the serial they were placed at */
  private placed: { x: number; y: number; serial: number }[] = [];
  serial = 0;
  /** chunks to mark changed this tick (a seed placed or moved: its old and new chunks); `all`: every chunk in scope */
  readonly marks = new Set<number>();
  markAll = false;
  constructor(
    private cx: number,
    private cy: number,
  ) {}

  /** a unit placed at column (x, y) */
  place(x: number, y: number): void {
    this.placed.push({ x, y, serial: this.serial });
  }

  /** column (x, y) changed for the fields (a seed there came or went) */
  mark(x: number, y: number): void {
    const i = Math.floor(x / CHUNK);
    const j = Math.floor(y / CHUNK);
    if (i >= 0 && j >= 0 && i < this.cx && j < this.cy) this.marks.add(j * this.cx + i);
  }

  /** A read issued with spawn serial `serial` came back: the live units' box (null: none). */
  read(serial: number, box: Box | null): void {
    this.gpuBox = box;
    this.placed = this.placed.filter((p) => p.serial > serial);
  }

  /** The window slid (columns, rows): what's on the CPU goes with the land; the chunks that came in are new to it. */
  shift(dx: number, dy: number): void {
    const mv = (b: Box | null): Box | null => (b ? [b[0] - dx, b[1] - dy, b[2] - dx, b[3] - dy] : null);
    this.gpuBox = mv(this.gpuBox);
    for (const p of this.placed) {
      p.x -= dx;
      p.y -= dy;
    }
    const dcx = Math.round(dx / CHUNK);
    const dcy = Math.round(dy / CHUNK);
    const at = (c: number): number => {
      const i = (c % this.cx) - dcx;
      const j = Math.floor(c / this.cx) - dcy;
      return i >= 0 && j >= 0 && i < this.cx && j < this.cy ? j * this.cx + i : -1;
    };
    const moved = new Map<number, number>();
    for (const [c, t] of this.chunks) if (at(c) >= 0) moved.set(at(c), t);
    this.chunks = moved;
    const kept = new Set<number>();
    for (const c of this.inList) if (at(c) >= 0) kept.add(at(c));
    this.inList = kept;
    // (the fields moved with the land; the strips come in are new to the scope: started over and marked)
    this.marks.clear();
  }

  /**
   * This tick's scope from the points the agents' work is at (columns): its chunks (the box of those needed lately),
   * and those new to it.
   */
  update(points: readonly (readonly [number, number])[], tick: number): { list: number[]; enter: number[] } {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const add = (x: number, y: number) => {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    };
    for (const p of points) add(p[0], p[1]);
    for (const p of this.placed) add(p.x, p.y);
    if (this.gpuBox) {
      add(this.gpuBox[0], this.gpuBox[1]);
      add(this.gpuBox[2], this.gpuBox[3]);
    }
    if (x1 >= x0) {
      const i0 = Math.max(0, Math.floor((x0 - SCOPE_MARGIN) / CHUNK));
      const j0 = Math.max(0, Math.floor((y0 - SCOPE_MARGIN) / CHUNK));
      const i1 = Math.min(this.cx - 1, Math.floor((x1 + SCOPE_MARGIN) / CHUNK));
      const j1 = Math.min(this.cy - 1, Math.floor((y1 + SCOPE_MARGIN) / CHUNK));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.chunks.set(j * this.cx + i, tick);
    }
    // (what's held a while after it was last needed, then let go)
    let bi0 = Infinity;
    let bj0 = Infinity;
    let bi1 = -Infinity;
    let bj1 = -Infinity;
    for (const [c, t] of this.chunks) {
      if (tick - t > HOLD_TICKS) {
        this.chunks.delete(c);
        continue;
      }
      const i = c % this.cx;
      const j = Math.floor(c / this.cx);
      bi0 = Math.min(bi0, i);
      bj0 = Math.min(bj0, j);
      bi1 = Math.max(bi1, i);
      bj1 = Math.max(bj1, j);
    }
    // (the box of it all: the fields' edge is a rectangle — agents.wgsl inScope)
    const list: number[] = [];
    const enter: number[] = [];
    const now = new Set<number>();
    if (bi1 >= bi0)
      for (let j = bj0; j <= bj1; j++)
        for (let i = bi0; i <= bi1; i++) {
          const c = j * this.cx + i;
          list.push(c);
          now.add(c);
          if (!this.inList.has(c)) enter.push(c);
        }
    this.inList = now;
    this.box = list.length ? [bi0 * CHUNK, bj0 * CHUNK, (bi1 + 1) * CHUNK, (bj1 + 1) * CHUNK] : null;
    return { list, enter };
  }
}
