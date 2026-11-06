// One reach for every town (round 128o, B; DESIGN section 13): what any TownSite's plan asks of a reach engine (the
// GPU's, reachgpu.ts — the fortress's or a generated settlement's in play) and how its answer's fixes go into the plan.
// The fortress's edits and a settlement's generation share it: the plan's solid as if built (its cuttable ground floors
// flagged), and the fixes — passages, gates, ramps — made in the plan.
import type { Town } from './town';
import type { QuadGrid } from './quadgrid';
import type { TownPlan } from './plan';
import type { Ways } from './ways';
import { rampRun, solidSpans } from './solid';
import { gradeLanes, type GradeLane } from './grade';
import { stairRise } from './ways';
import { cellPos, nbr } from '../world/lattice';
import { packSpan, REACH_BITS, unpackSpan, type ReachAsk, type ReachEngine, type ReachFix, type ReachReply } from './reach';
import type { StructureType } from '../api/contracts/fortress';
import { entrancesOf, needsEntrance, openCell } from './entrances';

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
export interface Joined {
  out: number;
  fixes: number;
  asks: number;
  /** the last answer's places still out (their indexes in `places`, as last asked) */
  outAt: number[];
  places: Places;
}

export async function joinPlaces(j: JoinPlaces): Promise<Joined> {
  const res: Joined = { out: 0, fixes: 0, asks: 0, outAt: [], places: { cols: [], floors: [] } };
  const state = { tried: new Set<string>() };
  for (;;) {
    res.places = j.places();
    const ask = joinAsk(j, res.places);
    const reply = await j.engine.check(ask);
    if (j.live && !j.live()) return res;
    if (!joinStep(j, reply, res, state)) return res;
  }
}

export interface Places {
  cols: [number, number, number, number][];
  floors: [number, number, number, number][];
  open?: number[];
  /** per place the structure it's the way into (-1: another place — a heap, a door spot) */
  ids?: number[];
}

function joinAsk(j: JoinPlaces, p: Places): ReachAsk {
  const solid = j.solid();
  const { w } = solid.box;
  j.engine.setSpans(siteSpans(solid), siteRampRise(solid));
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
function joinStep(j: JoinPlaces, reply: ReachReply, res: Joined, state: { tried: Set<string> }): boolean {
  res.asks++;
  const out = [...reply.bits].map((b, q) => ((b & REACH_BITS.reached) === 0 ? q : -1)).filter((q) => q >= 0);
  res.out = out.length;
  res.outAt = out;
  if (!out.length) return false;
  // (one way at a time — a pocket's one gate reaches every place in it — but every place that must be opened at once:
  // each its own passage. A place's fixes are made once: still out after them, the next place's — each place tried
  // once, so it ends)
  const key = (i: number) => `${res.places.cols[i].join(',')}`;
  const open = res.places.open;
  const fixable = (i: number) => !state.tried.has(key(i)) && reply.fixes.some((f) => f.query === i);
  const pick = new Set(out.filter((i) => open?.[i] && fixable(i)));
  const first = out.find((i) => !open?.[i] && fixable(i));
  if (first !== undefined) pick.add(first);
  if (!pick.size) return false;
  for (const i of pick) state.tried.add(key(i));
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

export interface RealiseTown extends Omit<JoinPlaces, 'places'> {
  /** box column of a window point (the stands' columns), and the floor there (window z) */
  colAt(boxWorld: [number, number]): number;
  floorAt(col: number): number;
  /** the town's other places (a settlement's heaps, its fields, the house going up), as stands */
  extra?: Places;
  /**
   * (DA-A10: graded at generation) its lanes (box world) and how a grade is laid: the town's ground columns and the
   * world's land changed by `dz` (+ fill, - cut), resolved once the world has them — before the reach is asked
   */
  grade?: { lanes(): GradeLane[]; apply(dz: Map<number, number>): Promise<void> };
}

/**
 * (round 128o, DA-A10/DA-A11: generation through the one reach) A town as generated, the first time its land is in the
 * window: every structure's way in (its entrances' cells; none — no side open — the sides a passage would open, which
 * a fix must open) and the town's other places joined to its stores by the GPU's reach and its fixes; a structure
 * nothing reaches is dropped from the plan (TownPlan.drop: "refuse what nothing can fix") and logged why. Then the
 * plan is the town's for good: every structure entered (assertEntered, after this).
 */
export async function realiseTown(r: RealiseTown): Promise<Joined & { dropped: number; graded: number; steep: number }> {
  // (the lanes graded into the land first: the reach then judges the town on the ground it will have)
  let graded = 0;
  let steep = 0;
  if (r.grade) {
    const s = r.solid();
    const g = gradeLanes(r.grade.lanes(), s.ground, s.box, r.colAt);
    graded = g.dz.size;
    steep = g.steep;
    if (g.dz.size) await r.grade.apply(g.dz);
  }
  let unstood: number[] = [];
  const places = (): Places => {
    unstood = [];
    const { plan, grid } = r.solid();
    const out: Places = { cols: [], floors: [], open: [], ids: [] };
    const ways = new Map<number, number[]>();
    for (const e of entrancesOf(plan, grid, [], () => false, plan.defs)) ways.set(e.structure, [...(ways.get(e.structure) ?? []), e.out]);
    for (const s of plan.structures()) {
      if (!needsEntrance(s.type, plan.defs)) continue;
      const doors = (ways.get(s.id) ?? []).map((c) => r.colAt(grid.centre(c))).filter((b) => b >= 0).slice(0, 4);
      const stands = doors.length
        ? doors
        : [...s.cells.keys()]
            .flatMap((c) => standsOfCell(plan, grid, () => false, c, -1, true))
            .map((p) => r.colAt(p))
            .filter((b) => b >= 0)
            .slice(0, 4);
      if (!stands.length) {
        // (no side to stand at, none a passage would open — walled by what can't be cut, or past the box)
        unstood.push(s.id);
        continue;
      }
      const q: [number, number, number, number] = [-1, -1, -1, -1];
      const f: [number, number, number, number] = [0, 0, 0, 0];
      stands.forEach((b, i) => ((q[i] = b), (f[i] = r.floorAt(b))));
      out.cols.push(q);
      out.floors.push(f);
      out.open!.push(doors.length ? 0 : 1);
      out.ids!.push(s.id);
    }
    if (r.extra) {
      out.cols.push(...r.extra.cols);
      out.floors.push(...r.extra.floors);
      out.open!.push(...r.extra.cols.map(() => 0));
      out.ids!.push(...r.extra.cols.map(() => -1));
    }
    return out;
  };
  // (what nothing reaches: dropped, logged — and the rest asked again, a drop opening ground others may now be joined
  // over; until a round drops nothing)
  const { plan } = r.solid();
  let dropped = 0;
  let fixes = 0;
  let asks = 0;
  for (;;) {
    const res = await joinPlaces({ ...r, places });
    fixes += res.fixes;
    asks += res.asks;
    if (r.live && !r.live()) return { ...res, fixes, asks, dropped, graded, steep };
    let now = 0;
    for (const id of unstood) if (plan.drop(id, 'no side to stand at, and none a passage would open: walled in by what cannot be cut')) now++;
    for (const q of res.outAt) {
      const id = res.places.ids?.[q] ?? -1;
      if (id >= 0 && plan.drop(id, 'no gate, passage or stair joins it to the stores: a cliff, deep water or walls past any fix')) now++;
    }
    dropped += now;
    if (now) r.changed?.();
    else return { ...res, fixes, asks, dropped, graded, steep };
  }
}

