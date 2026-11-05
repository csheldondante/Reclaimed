// (round 128m, townlab) The placement bench's run (the user: "build a bench for me to run that places buildings"), on
// the game (perf/placebench.ts: ?bench=place, by the phone) or the lab (lab.placeBench(): the `town` recipe on the
// desktop). Each building type at each point (points.ts): the block placed as a tap places it (Fortress.paint), then
// the frames until the reach judges it — kept (perhaps with a gate, passage or ramp put in) or refused with the line
// the panel shows. Recorded: the tap's CPU, the time until the answer, the frame times round it. Each placement is
// taken out again before the next. Then the arrival check: a house at each point a house was kept on, Build at 16x,
// and which of them have their first block standing within `arriveS` sim seconds.
import type { Fortress } from '../../fortress/fortress';
import { STRUCTURE_TYPES, type StructureType } from '../../api/contracts/fortress';
import { placePoints, type PlacePoint, type V2 } from './points';
import { stat, type Stat } from '../bench/defs';

export interface PlaceBenchIO {
  fort: Fortress;
  /** the next displayed frame's time (ms) */
  frame(): Promise<number>;
  ground(x: number, y: number): number;
  /** the bar's Build */
  build(): void;
  /** sim time on at the game's `speed` (16: the bar's 16x) for `seconds` of sim time; resolves after */
  advance(seconds: number, speed: number): Promise<void>;
  /** sim seconds since the start (the world's clock) */
  simTime(): number;
  /** where the fortress's builders are now (window world) */
  walkers(): V2[];
  log?(line: string): void;
}

export interface PlaceRow {
  point: string;
  group: PlacePoint['group'];
  type: StructureType;
  at: V2;
  /** kept: reached (maybe with a variant); refused: taken out again with a reason; unplaced: the plan wouldn't take
   *  it (a cell taken, off the box); noanswer: no judgement within MAX_WAIT frames */
  outcome: 'kept' | 'refused' | 'unplaced' | 'noanswer';
  /** the panel's line: why it was refused, or what was put in to keep it (a gate, a passage, a ramp) */
  line: string | null;
  tapMs: number;
  answerMs: number | null;
  frames: Stat | null;
  over33: number;
}

export interface ArriveRow {
  point: string;
  /** sim seconds from Build to a builder standing at the site (within ARRIVE_R of its middle; null: none within the limit) */
  arrivedS: number | null;
  /** sim seconds from Build to its first block standing (null: not within the limit) */
  builtS: number | null;
  /** the nearest a builder came to it (m; null: no builders seen) */
  nearestM: number | null;
}

/** a builder this near a site's middle (m) has reached it (a cell's stands are a little out from its sides) */
export const ARRIVE_R = 6;
/** the sites the arrival check builds at once (8 builders at the start: more sites only queue) */
export const ARRIVE_SITES = 8;
/** which points' houses go first into the arrival check: the far and the hard ones */
const ARRIVE_ORDER: PlacePoint['group'][] = ['river', 'hill', 'ring', 'inside'];

export interface PlaceBenchResult {
  points: PlacePoint[];
  stores: V2;
  rows: PlaceRow[];
  arrive: ArriveRow[];
  arriveLimitS: number;
}

/** frames waited for a judgement before it counts as none (the GPU's answer comes in a few) */
const MAX_WAIT = 600;
/** frames measured before a placement (the frame times round it) */
const BEFORE = 3;

export async function runPlaceBench(io: PlaceBenchIO, o: { types?: StructureType[]; arriveS?: number; arrive?: boolean } = {}): Promise<PlaceBenchResult> {
  const f = io.fort;
  const types = o.types ?? [...STRUCTURE_TYPES];
  const arriveS = o.arriveS ?? 300;
  await f.settled();
  const stores = f.storesAt();
  if (!stores) throw new Error('place bench: the fortress has no stores');
  if (f.mode !== 'plan') throw new Error('place bench: start while planning');
  if (f.plan.structures().length) throw new Error('place bench: start on an empty plan (?fresh=1)');
  // (the reach's own wet bits: asked for once, as planning starts)
  f.requestReach(true);
  await f.settled();
  const gates = (f as unknown as { io: { townGates?: () => V2[] } }).io.townGates?.() ?? [];
  const points = placePoints({
    stores,
    gates,
    inBox: (x, y) => f.cellAt(x, y) >= 0,
    wet: (x, y) => f.wetAt(x, y) === true,
    ground: io.ground,
  });
  const clear = async () => {
    for (let pass = 0; pass < 4 && f.plan.structures().length; pass++)
      for (const s of f.plan.structures())
        for (const c of [...s.cells.keys()]) for (const l of [...f.plan.levels.each(c)].reverse()) f.erase(c, l);
    if (f.plan.structures().length) throw new Error('place bench: the plan would not erase');
    f.refusal = null;
    f.note = null;
    await f.settled();
  };
  const rows: PlaceRow[] = [];
  for (const pt of points)
    for (const type of types) {
      const dt: number[] = [];
      let last = await io.frame();
      for (let i = 0; i < BEFORE; i++) {
        const t = await io.frame();
        dt.push(t - last);
        last = t;
      }
      const cell = f.cellAt(pt.at[0], pt.at[1]);
      const row: PlaceRow = { point: pt.name, group: pt.group, type, at: [+pt.at[0].toFixed(1), +pt.at[1].toFixed(1)], outcome: 'unplaced', line: null, tapMs: 0, answerMs: null, frames: null, over33: 0 };
      f.refusal = null;
      f.note = null;
      const t0 = performance.now();
      const ok = cell >= 0 && f.paint(cell, 0, type);
      row.tapMs = +(performance.now() - t0).toFixed(2);
      if (!ok) row.line = cell < 0 ? "outside the fortress's land" : f.refusal;
      else {
        let n = 0;
        while (f.isPending(cell) && n++ < MAX_WAIT) {
          const t = await io.frame();
          dt.push(t - last);
          last = t;
        }
        if (f.isPending(cell)) row.outcome = 'noanswer';
        else {
          row.answerMs = Math.round(performance.now() - t0);
          await f.settled();
          row.outcome = f.plan.has(cell, 0) ? 'kept' : 'refused';
          row.line = row.outcome === 'kept' ? f.note : f.refusal;
        }
        for (let i = 0; i < BEFORE; i++) {
          const t = await io.frame();
          dt.push(t - last);
          last = t;
        }
      }
      row.frames = stat(dt, 'ms');
      row.over33 = dt.filter((v) => v > 33.4).length;
      rows.push(row);
      io.log?.(`${pt.name} ${type}: ${row.outcome}${row.line ? ` (${row.line})` : ''} tap ${row.tapMs} ms, answer ${row.answerMs ?? '-'} ms`);
      await clear();
    }
  // the arrival check: houses at the points a house was kept on (the far and hard ones first, ARRIVE_SITES of them),
  // planned together, Build at 16x: when a builder stands at each, and when its first block stands
  const arrive: ArriveRow[] = [];
  if (o.arrive !== false) {
    const kept = rows.filter((r) => r.type === 'house' && r.outcome === 'kept');
    const rank = (r: PlaceRow) => ARRIVE_ORDER.indexOf(r.group) * 1000 - Math.hypot(r.at[0] - stores[0], r.at[1] - stores[1]);
    const sites = new Map<string, { cell: number }>();
    for (const r of kept.sort((a, b) => rank(a) - rank(b)).slice(0, ARRIVE_SITES)) sites.set(r.point, { cell: f.cellAt(r.at[0], r.at[1]) });
    for (const [, s] of sites) f.paint(s.cell, 0, 'house');
    await f.settled();
    const got = new Map<string, number>();
    const built = new Map<string, number>();
    const near = new Map<string, number>();
    // (refused when placed together: no site for the builders)
    for (const [p, s] of [...sites])
      if (!f.plan.has(s.cell, 0)) {
        sites.delete(p);
        arrive.push({ point: p, arrivedS: null, builtS: null, nearestM: null });
      }
    const t0 = io.simTime();
    io.build();
    while (io.simTime() - t0 < arriveS && built.size < sites.size) {
      await io.advance(5, 16);
      const t = +(io.simTime() - t0).toFixed(1);
      const ws = io.walkers();
      for (const [p, s] of sites) {
        // (its middle now: a slide moves the window's frame under the box)
        const [cx, cy] = f.centre(s.cell);
        const d = Math.min(...ws.map((w) => Math.hypot(w[0] - cx, w[1] - cy)));
        if (Number.isFinite(d)) near.set(p, Math.min(near.get(p) ?? Infinity, d));
        if (!got.has(p) && d <= ARRIVE_R) got.set(p, t);
        if (!built.has(p) && f.town.has(s.cell, 0)) built.set(p, t);
      }
    }
    for (const [p] of sites) arrive.push({ point: p, arrivedS: got.get(p) ?? null, builtS: built.get(p) ?? null, nearestM: near.has(p) ? +near.get(p)!.toFixed(1) : null });
    io.log?.(`arrival: ${io.walkers().length} builders seen at the end`);
  }
  return { points, stores, rows, arrive, arriveLimitS: arriveS };
}
