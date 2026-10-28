// ---- story/stage-land.ts --------------------------------------------------------
// (round 99, `runstream`; the user after the GameplayGM slice: "The controls are integrated but why is the
// streaming disabled?") A run's stage kept in world cells and stamped into the land as it arrives, as the
// settlements are (settle/settlements.ts, Atlas.landHooks): so the window streams during a run.
// - The stage generator's pieces (story/stage-gen.ts StagePiece: a disc of a material so many cells high) are kept
//   at their world spots (x cells, y world units, on the torus). Each region's land, as the atlas makes it (the
//   first time it comes into the window, and after a warp makes the window again), gets the pieces over it laid on
//   its columns' tops exactly as edit.wgsl's OP_BUILD lays one (full over the inner half, soft at the rim): no
//   edit queued in window coordinates, nothing to land a region off across a slide.
// - A slide keeps everything else: what leaves the window is frozen with whatever play did to it and thawed as it
//   was (streamer.ts). A warp drops the window: what play changed lasting is kept here as a diff, in world cells —
//   an opened lock's plug gone (`open`), a grave or a cairn added (`add`), a wall found broken (`watch`: a piece
//   seen standing whose top has come down is gone) — and the next stamp of that land has it.
//
//   const land = new StageLand(atlas)              // the hook is in from here on
//   land.add(pieces)                               // world spots
//   land.open('lock:bone-door')                    // an opened lock's plug isn't stamped again
//   every second or so: land.watch(at => terrain.heightAt(...), toWin, oz, inWindow)
//   land.dispose()                                 // the hook out

import type { Atlas } from '../atlas/atlas';
import type { RegionLand } from '../world/streamgen';
import { addTop } from '../world/layout';
import { ROW_H } from '../world/lattice';
import { materialId } from '../api/common';
import type { MaterialName } from '../api/common';
import type { StagePiece } from './stage-gen';

type V2 = [number, number];

/** a piece at its world spot, and what's known of it */
export interface WorldPiece extends StagePiece {
  /** world x cells, y world units (on the torus) */
  at: V2;
  /** no longer stamped: an opened lock's plug, a broken wall */
  gone?: boolean;
  /** the column's top (world z) under its middle when it was last stamped */
  base?: number;
  /** seen standing in the window since its last stamp (only a piece seen standing can be found broken) */
  seen?: boolean;
}

interface Cover {
  piece: number;
  /** how much of its layers this column gets (edit.wgsl: smoothstep(1, 0.5, d)) */
  w: number;
  /** the column nearest its middle */
  mid: boolean;
}

export class StageLand {
  readonly pieces: WorldPiece[] = [];
  /** world cell (x + y × cols) → the pieces over it */
  private cover = new Map<number, Cover[]>();
  private cols: number;
  private rows: number;
  private hook: (land: RegionLand, x0: number, y0: number, w: number, h: number) => Promise<void>;
  readonly stats = { regions: 0, stamped: 0, opened: 0, broken: 0, added: 0 };

  constructor(private atlas: Atlas) {
    this.cols = atlas.p.cols;
    this.rows = atlas.p.rows;
    if (this.rows % 2) throw new Error('stage land: the atlas needs an even number of rows (the lattice wraps)');
    this.hook = async (land, x0, y0, w, h) => this.stamp(land, x0, y0, w, h);
    atlas.landHooks.push(this.hook);
  }

  /** Pieces at their world spots (x cells, y world units). */
  add(ps: StagePiece[]): void {
    for (const p of ps) {
      const i = this.pieces.length;
      const wp: WorldPiece = { ...p, at: [this.modX(p.at[0]), this.modY(p.at[1])] };
      this.pieces.push(wp);
      this.index(wp, i);
      this.stats.added++;
    }
  }

  /** A tag's pieces gone for good (an opened lock: `lock:<id>`). → how many */
  open(tag: string): number {
    let n = 0;
    for (const p of this.pieces)
      if (p.tag === tag && !p.gone) {
        p.gone = true;
        n++;
      }
    this.stats.opened += n;
    return n;
  }

  /**
   * Which built pieces have come down in play: a piece seen standing (its middle's top at 70% of its height or more)
   * whose top is under 30% of it is broken, and gone from the next stamp. `heightAt` the window's top (window z,
   * null outside it), `toWin` a world spot into the window, `oz` the window's floor (world z).
   */
  watch(heightAt: (x: number, y: number) => number | null, toWin: (p: V2) => V2, oz: number): number {
    let n = 0;
    for (const p of this.pieces) {
      if (p.gone || p.base === undefined || p.layers <= 0 || p.grow) continue;
      const [x, y] = toWin(p.at);
      const z = heightAt(x, y);
      if (z === null) continue;
      const top = z + oz;
      if (top >= p.base + p.layers * 0.7) p.seen = true;
      else if (p.seen && top < p.base + p.layers * 0.3) {
        p.gone = true;
        n++;
      }
    }
    this.stats.broken += n;
    return n;
  }

  dispose(): void {
    const k = this.atlas.landHooks.indexOf(this.hook);
    if (k >= 0) this.atlas.landHooks.splice(k, 1);
  }

  // ---- inside ----

  private modX = (x: number) => ((x % this.cols) + this.cols) % this.cols;
  private modY = (y: number) => ((y % (this.rows * ROW_H)) + this.rows * ROW_H) % (this.rows * ROW_H);
  private key = (cx: number, cy: number) => (((cx % this.cols) + this.cols) % this.cols) + (((cy % this.rows) + this.rows) % this.rows) * this.cols;

  /** the columns a piece covers (their centres within its radius), as edit.wgsl weighs them */
  private index(p: WorldPiece, i: number): void {
    const r = p.radius;
    const [x, y] = p.at;
    const cy0 = Math.floor((y - r) / ROW_H - 0.5);
    const cy1 = Math.ceil((y + r) / ROW_H - 0.5);
    let best: Cover | null = null;
    let bd = Infinity;
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = Math.floor(x - r - 1); cx <= Math.ceil(x + r); cx++) {
        const px = cx + 0.5 + 0.5 * (cy & 1);
        const py = (cy + 0.5) * ROW_H;
        const dist = Math.hypot(px - x, py - y);
        const d = dist / r;
        if (d >= 1) continue;
        const w = d <= 0.5 ? 1 : 1 - smooth((d - 0.5) / 0.5);
        const c: Cover = { piece: i, w, mid: false };
        const k = this.key(cx, cy);
        (this.cover.get(k) ?? this.cover.set(k, []).get(k)!).push(c);
        if (dist < bd) {
          bd = dist;
          best = c;
        }
      }
    if (best) best.mid = true;
  }

  /** the pieces over a region's columns, laid on their tops (world z) */
  private stamp(land: RegionLand, x0: number, y0: number, w: number, h: number): void {
    if (!this.cover.size) return;
    let any = false;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const cs = this.cover.get(this.key(x0 + x, y0 + y));
        if (!cs) continue;
        const i = y * w + x;
        const col = land.cols[i];
        let done = false;
        for (const pass of [0, 1] as const) {
          // (as the same pieces queued as edits build: the world's queue takes four a tick, and one tick's edits share
          // a column (edit.wgsl's `given`: the tallest of them), the next tick's go on top — so the pieces in fours,
          // in the order they were made, the tallest of each four, the fours stacked. Taking the tallest of all left
          // the walls 6 high with their soft rims as steps a hero climbed onto the top: round 99's first runtest)
          let hgt = 0;
          let mat = 0;
          let most = 0;
          let tick = -1;
          let inTick = 0;
          for (const c of cs) {
            const p = this.pieces[c.piece];
            if (p.gone || p.pass !== pass) continue;
            if (p.grow) {
              land.vegetation[i] = Math.max(land.vegetation[i], 3.2 * c.w);
              continue;
            }
            const v = p.layers * c.w;
            const k = Math.floor(c.piece / 4);
            if (k !== tick) {
              hgt += inTick;
              inTick = 0;
              tick = k;
            }
            inTick = Math.max(inTick, v);
            if (v > most) {
              most = v;
              mat = materialId(p.material as MaterialName);
            }
          }
          hgt += inTick;
          if (hgt < 0.02) continue;
          const top = col.length ? col[col.length - 1].z1 : 0;
          for (const c of cs) {
            const p = this.pieces[c.piece];
            if (c.mid && p.pass === pass && !p.gone) {
              p.base = top;
              p.seen = false;
            }
          }
          addTop(col, hgt, mat);
          done = true;
        }
        if (!done) continue;
        land.surface[i] = col[col.length - 1].z1;
        land.vegetation[i] = 0;
        this.stats.stamped++;
        any = true;
      }
    if (any) this.stats.regions++;
  }
}

const smooth = (t: number) => t * t * (3 - 2 * t);
