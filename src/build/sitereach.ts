// One reach for every town (round 128o, B; DESIGN section 13): what any TownSite's plan asks of a reach engine (the
// GPU's, reachgpu.ts — the fortress's or a generated settlement's in play) and how its answer's fixes go into the plan.
// The fortress's edits and a settlement's generation share it: the plan's solid as if built (its cuttable ground floors
// flagged), and the fixes — passages, gates, ramps — made in the plan.
import type { Town } from './town';
import type { QuadGrid } from './quadgrid';
import type { TownPlan } from './plan';
import type { Ways } from './ways';
import { rampRun, solidSpans } from './solid';
import { stairRise } from './ways';
import { cellPos, nbr } from '../world/lattice';
import { packSpan, REACH_BITS, unpackSpan, type ReachAsk, type ReachEngine, type ReachFix, type ReachReply } from './reach';
import type { StructureType } from '../api/contracts/fortress';
import { openCell } from './entrances';

/** what a fix made: a gate in a wall, a passage through a block's ground floor, a ramp up a drop (fortress/words.ts) */
export type FixKind = 'gate' | 'passage' | 'ramp';

/**
 * Whether the reach's fix may cut a cell's ground floor: a block's (not a landmark drawn whole, not a passage already) —
 * an arch through it; a wall's straight cell on the ground, not a gate yet — a gate in it.
 */
export function cuttableCell(plan: TownPlan, c: number): boolean {
  if (c < 0) return false;
  const t = plan.typeAt(c);
  if (!t || !plan.has(c, 0)) return false;
  const def = plan.defs[t];
  if (def.form === 'block') return !def.look.mega && !plan.passage[c];
  if (def.form === 'wall') return !plan.gate[c] && plan.levels.bottom(c) === 0 && plan.wallTile(c, 0) === 'straight';
  return false;
}

export interface SiteSolid {
  plan: TownPlan;
  town: Town;
  grid: QuadGrid;
  box: { w: number; h: number };
  /** the ground's top at a box column (world z) */
  ground(col: number): number;
  ways?: Ways;
  /** window z = world z − oz */
  oz: number;
}

/**
 * The plan's solid as if built (solid.ts: a block its cell, a wall its band, a gate open under its lintel, the stairs,
 * the ramps): two spans a box column, packed for the reach (more than two: the last two merged); a ground floor the fix
 * may cut flagged.
 */
export function siteSpans(s: SiteSolid): Uint32Array {
  const { plan, grid, oz } = s;
  const town: Town = Object.create(s.town);
  Object.defineProperty(town, 'built', { value: { each: (c: number) => plan.levels.each(c) } });
  const { w, h } = s.box;
  const out = new Uint32Array(w * h * 2);
  for (const spans of solidSpans({ plan, town, grid, ground: s.ground, ways: s.ways }).values())
    for (const q of spans) {
      if (q.x < 0 || q.y < 0 || q.x >= w || q.y >= h) continue;
      const b = q.y * w + q.x;
      const i = 2 * b;
      const p = packSpan(q.z0 - oz, q.z1 - oz, q.z0 <= s.ground(b) + 0.5 && cuttableCell(plan, grid.cellOf[b]));
      if (!out[i]) out[i] = p;
      else if (!out[i + 1]) out[i + 1] = p;
      else {
        const o = unpackSpan(out[i + 1]);
        const n = unpackSpan(p);
        out[i + 1] = packSpan(Math.min(o.z0, n.z0), Math.max(o.z1, n.z1), o.cut && n.cut);
      }
    }
  return out;
}

/**
 * (round 128o, DA-A10) Per box column the highest drop a ramp on it would join: a free cell (no structure, no ramp yet)
 * takes a stair across it no steeper than SLOPE (ways.ts stairRise) over its shortest run (solid.ts rampRun, each side's
 * axis) — a short cell, a low stair; a cell with a structure or a ramp, 0 (none goes there).
 */
export function siteRampRise(s: Pick<SiteSolid, 'plan' | 'grid' | 'box'>): Float32Array {
  const { plan, grid } = s;
  const { w, h } = s.box;
  const out = new Float32Array(w * h);
  const byCell = new Map<number, number>();
  for (let b = 0; b < w * h; b++) {
    const c = grid.cellOf[b];
    if (c < 0 || plan.owner[c] >= 0 || plan.ramp[c] >= 0) continue;
    let r = byCell.get(c);
    if (r === undefined) {
      r = Math.min(...[0, 1, 2, 3].map((e) => stairRise(rampRun(grid, c, e))));
      byCell.set(c, r);
    }
    out[b] = r;
  }
  return out;
}

/**
 * An answer's fixes into the plan, each once: a cut column's cell gets a passage (a block) or a gate (a wall); a ramp
 * goes on the lower column's cell, up the drop (inside the cell: its side facing up it). `noted` hears each made. How
 * many went in. `origin`: the box's first window column (the fixes' columns are box columns).
 */
export function applyReachFixes(plan: TownPlan, grid: QuadGrid, box: { w: number; h: number }, origin: [number, number], fixes: readonly ReachFix[], noted?: (kind: FixKind, type: StructureType, cell: number) => void): number {
  const { w, h } = box;
  const [ox, oy] = origin;
  let n = 0;
  const seen = new Set<string>();
  for (const f of fixes) {
    const key = `${f.kind}:${f.col}:${f.dir}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const c = grid.cellOf[f.col];
    if (c < 0) continue;
    if (f.kind === 'cut') {
      const t = plan.typeAt(c);
      if (!t || !cuttableCell(plan, c)) continue;
      const kind: FixKind = plan.defs[t].form === 'wall' ? 'gate' : 'passage';
      if (!(kind === 'gate' ? plan.setGate(c, true) : plan.setPassage(c, true))) continue;
      noted?.(kind, t, c);
      n++;
      continue;
    }
    const x = (f.col % w) + ox;
    const y = Math.floor(f.col / w) + oy;
    const [qx, qy] = nbr(x, y, f.dir);
    const inBox = qx - ox >= 0 && qx - ox < w && qy - oy >= 0 && qy - oy < h;
    const m = inBox ? grid.cellOf[(qy - oy) * w + (qx - ox)] : -1;
    if (m < 0 || plan.owner[c] >= 0 || plan.ramp[c] >= 0) continue;
    let side = [0, 1, 2, 3].find((e) => grid.nbr[c * 4 + e] === m);
    if (m === c) {
      const [lx, ly] = cellPos(x - ox, y - oy);
      const [ux, uy] = cellPos(qx - ox, qy - oy);
      const [cx, cy] = grid.centre(c);
      let best = -Infinity;
      for (let e = 0; e < 4; e++) {
        const nb = grid.nbr[c * 4 + e];
        if (nb < 0) continue;
        const [nx, ny] = grid.centre(nb);
        const dot = (nx - cx) * (ux - lx) + (ny - cy) * (uy - ly);
        if (dot > best) {
          best = dot;
          side = e;
        }
      }
    }
    if (side === undefined || !plan.setRamp(c, side)) continue;
    noted?.('ramp', 'house', c);
    n++;
  }
  return n;
}

export interface JoinPlaces {
  engine: ReachEngine;
  /** the town's solid (its plan as if built) — asked again after each fix */
  solid(): SiteSolid;
  /** the box's first window column now */
  origin(): [number, number];
  /** the places now (asked again after each fix: a passage opens a side): each up to four stands (box columns, -1 none)
   *  and their floors (window z), and whether its stands are ones a fix would open (no side of it open) */
  places(): Places;
  stores: number;
  storesZ: number;
  /** each fix made (its kind, the structure type it's in, its cell) */
  noted?(kind: FixKind, type: StructureType, cell: number): void;
  /** a fix made: the plan changed (the caller takes its changes: drawn and claimed again) */
  changed?(): void;
  /** still wanted (the town still live, the window not moved): else it stops */
  live?(): boolean;
}

/**
 * (round 128o, B; DESIGN section 13: generation keeps reach an invariant by changing the world) A town's places joined to
 * its stores by the one reach: a place out of reach gets the cheapest fix the reach finds (a passage, a gate, a ramp)
 * made in its plan, one way at a time while each answer reaches more (a pocket's one gate reaches every place in it).
 * What can't be fixed stays out. The places still out, the fixes made, the asks.
 */
export async function joinPlaces(j: JoinPlaces): Promise<{ out: number; fixes: number; asks: number }> {
  const res = { out: 0, fixes: 0, asks: 0 };
  const state = { left: Infinity };
  for (;;) {
    const ask = joinAsk(j);
    const reply = await j.engine.check(ask);
    if (j.live && !j.live()) return res;
    if (!joinStep(j, reply, res, state)) return res;
  }
}

export interface Places {
  cols: [number, number, number, number][];
  floors: [number, number, number, number][];
  open?: number[];
}

function joinAsk(j: JoinPlaces): ReachAsk {
  const solid = j.solid();
  const { w } = solid.box;
  j.engine.setSpans(siteSpans(solid), siteRampRise(solid));
  const p = j.places();
  return {
    stores: [j.stores % w, Math.floor(j.stores / w)],
    storesZ: j.storesZ,
    queries: new Int32Array(p.cols.flat()),
    floors: new Float32Array(p.floors.flat()),
    wet: false,
    fix: true,
    open: p.open ? Uint8Array.from(p.open) : undefined,
  };
}

/** an answer taken: done (false), or one way more opened (true: ask again) */
function joinStep(j: JoinPlaces, reply: ReachReply, res: { out: number; fixes: number; asks: number }, state: { left: number }): boolean {
  res.asks++;
  const out = [...reply.bits].map((b, q) => ((b & REACH_BITS.reached) === 0 ? q : -1)).filter((q) => q >= 0);
  res.out = out.length;
  if (!out.length || out.length >= state.left) return false;
  state.left = out.length;
  // (one way at a time — a pocket's one gate reaches every place in it — but every place that must be opened at once:
  // each its own passage)
  const open = j.places().open;
  const pick = new Set(out.filter((i) => open?.[i]));
  const first = out.find((i) => !open?.[i] && reply.fixes.some((f) => f.query === i));
  if (first !== undefined) pick.add(first);
  if (!pick.size) return false;
  const solid = j.solid();
  const made = applyReachFixes(solid.plan, solid.grid, solid.box, j.origin(), reply.fixes.filter((f) => pick.has(f.query)), j.noted);
  if (!made) return false;
  res.fixes += made;
  j.changed?.();
  return true;
}

/**
 * Where a builder stands to work on a cell (box world): a little out from the middle of each side that no planned or
 * built block's ground level covers (a yard's is open ground; a passage's arch) — the reach asks the same stands.
 * `cut`: also the sides whose neighbour the reach's fix may cut (a passage there would open it). `also`: a cell about
 * to be planned.
 */
export function standsOfCell(plan: TownPlan, grid: QuadGrid, built: (c: number) => boolean, cell: number, also = -1, cut = false): [number, number][] {
  const [cx, cy] = grid.centre(cell);
  const out: [number, number][] = [];
  for (let e = 0; e < 4; e++) {
    const n = grid.nbr[cell * 4 + e];
    if (n < 0 || n === also) continue;
    const t = plan.typeAt(n);
    if ((plan.has(n, 0) || built(n)) && !(t && plan.defs[t].form === 'yard') && !openCell(plan, n) && !(cut && cuttableCell(plan, n))) continue;
    const [ax, ay] = grid.corner(cell, e);
    const [bx, by] = grid.corner(cell, e + 1);
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const d = Math.hypot(mx - cx, my - cy) || 1;
    out.push([mx + ((mx - cx) / d) * 1.4, my + ((my - cy) / d) * 1.4]);
  }
  return out;
}

/** places of one stand each (box columns, floors) */
export function singleStands(cols: readonly number[], floors: readonly number[]): Places {
  return { cols: cols.map((c) => [c, -1, -1, -1]), floors: floors.map((z) => [z, 0, 0, 0]) };
}
