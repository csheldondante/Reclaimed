// ---- runplan/travel.ts ------------------------------------------------------------------------------------------
// (round 117, runplan) Travel between a run's stages on the atlas map (B-RC2, RC3). The user (round 115): "have the
// player use the atlas map to travel from location to location. We can precache the locations they go to and animate
// travel on that map while we load in the background. One fun thing we might do is have events enroute and generate
// new poi along their path or fade between pretty views along the road and the map."
// - enRoute: what's on the road (planned with the leg, deterministic): a vista where the land is striking (a pause
//   to fade to a pretty view), a new place found (a poi, kept as a mark if the player stops), an ambush where someone
//   hostile holds the land, weather where a storm sits, a traveller near a town.
// - Journey: one leg as it plays: it asks for the destination's land the moment it starts (Precacher: the streamer's
//   precache), moves the marker along the leg's path, stops at each event until it's answered, and arrives only when
//   the animation is done AND the land is ready — so the travel covers the loading.
// Why pure (no DOM, no GPU): the same Journey drives the viewer's map, the game's travel and a Node test with a
// fake precacher.

import type { EnRouteEvent, RegionGraph, TravelLeg } from '../api/contracts/run';
import type { Faction, RegionState } from '../api/contracts/world';

const SCENIC = new Set(['range', 'glacier', 'spires', 'crystalfield', 'lavafield', 'escarpment', 'cenotes', 'karst', 'rift', 'mesa', 'basalt']);
const POI = ['a wrecked caravan', 'a toppled statue half in the ground', 'a hermit’s tower', 'a ring of standing stones', 'a crashed airship', 'a flooded chapel', 'a bone-white tree', 'a sealed door in a hillside'];

export function enRoute(o: { id: string; route: number[]; path: [number, number][]; graph: RegionGraph; state: (id: number) => RegionState; factions: Map<string, Faction>; rnd: () => number; len: number }): EnRouteEvent[] {
  const out: EnRouteEvent[] = [];
  const N = o.route.length;
  if (N < 3) return out;
  // at most one event per ~900 world units of road, at most 3, none on the first or last region (that's the stages')
  const room = Math.min(3, Math.floor(o.len / 1200));
  const cands: (EnRouteEvent & { w: number })[] = [];
  for (let i = 1; i < N - 1; i++) {
    const id = o.route[i];
    const n = o.graph.node(id)!;
    const s = o.state(id);
    const t = i / (N - 1);
    const at = o.path[i];
    const base = { id: `${o.id}-e${i}`, t, region: id, at };
    let hostile = 0;
    for (const [f, p] of Object.entries(s.presence)) hostile += Math.max(0, -(o.factions.get(f)?.attitude ?? 0)) * (p ?? 0);
    if (SCENIC.has(n.kind) || n.ground.max - n.ground.min > 60) cands.push({ ...base, kind: 'vista', text: `The road opens over ${n.name}`, w: 0.6 + o.rnd() * 0.3 });
    if (hostile > 0.15 || s.undead > 0.2) cands.push({ ...base, kind: 'ambush', text: s.undead > 0.2 ? `The dead rise from the ditches in ${n.name}` : `Riders bar the road through ${n.name}`, w: 0.7 + hostile + o.rnd() * 0.2 });
    if (s.storm.strength > 0.2) cands.push({ ...base, kind: 'weather', text: `A ${s.storm.kind} storm over ${n.name}`, w: 0.5 + s.storm.strength });
    if (n.settlements.length) cands.push({ ...base, kind: 'traveller', text: `A traveller from ${n.name} with news`, w: 0.4 + o.rnd() * 0.3 });
    if (o.rnd() < 0.12) {
      const what = POI[Math.floor(o.rnd() * POI.length)];
      cands.push({ ...base, kind: 'poi', text: `Found ${what} in ${n.name}`, w: 0.5 + o.rnd() * 0.4, effects: { atlas: [{ kind: 'mark', regions: [id], magnitude: 1, detail: { name: what.replace(/^an? /, '').replace(/^./, (c) => c.toUpperCase()), kind: 'found place' }, cause: { by: 'player' } }] } });
    }
  }
  cands.sort((a, b) => b.w - a.w);
  for (const c of cands) {
    if (out.length >= room) break;
    if (out.some((e) => Math.abs(e.t - c.t) < 0.2)) continue;
    const { w: _w, ...e } = c;
    out.push(e);
  }
  return out.sort((a, b) => a.t - b.t);
}

/** the streamer's precache, as the journey needs it (api/atlas-world.ts precacheWarp; a fake in tests) */
export interface Precacher {
  /** ask for the land round a world cell; returns how many regions were asked for */
  precache(cx: number, cy: number): number;
  /** is the land there resident yet (the streamer: nothing of it still under way) */
  ready(cx: number, cy: number): boolean;
}

export type JourneyState =
  | { phase: 'moving'; t: number; at: [number, number] }
  | { phase: 'event'; t: number; at: [number, number]; event: EnRouteEvent }
  | { phase: 'waiting'; t: 1; at: [number, number] }
  | { phase: 'arrived'; t: 1; at: [number, number] };

/** a point along a polyline at 0..1 of its length */
export function along(path: [number, number][], t: number): [number, number] {
  if (path.length === 1) return [...path[0]];
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const d = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
    seg.push(d);
    total += d;
  }
  let want = Math.max(0, Math.min(1, t)) * total;
  for (let i = 0; i < seg.length; i++) {
    if (want <= seg[i] || i === seg.length - 1) {
      const k = seg[i] > 0 ? Math.min(1, want / seg[i]) : 1;
      return [path[i][0] + (path[i + 1][0] - path[i][0]) * k, path[i][1] + (path[i + 1][1] - path[i][1]) * k];
    }
    want -= seg[i];
  }
  return [...path[path.length - 1]];
}

export class Journey {
  private t = 0;
  private next = 0;
  private holding: EnRouteEvent | null = null;
  /** seconds spent waiting for the land after the animation (the loading the travel didn't cover) */
  waited = 0;
  /** the events met and how each was answered */
  readonly met: { event: EnRouteEvent; stopped: boolean }[] = [];
  private dest: [number, number];

  constructor(
    readonly leg: TravelLeg,
    /** the destination's section middle (world units) */
    dest: [number, number],
    private pre: Precacher | null,
    /** world units → the level's cells */
    private toCell: (x: number, y: number) => [number, number] = (x, y) => [x, y],
    /** a time scale for tests and the viewer's fast-forward */
    private speed = 1,
  ) {
    this.dest = dest;
    // the land is asked for the moment travel starts: the animation is the loading screen
    if (pre) pre.precache(...toCell(...dest));
  }

  /** answer the event the journey is held at: stop (its effects are the player's), or pass by */
  answer(stop: boolean): void {
    if (!this.holding) return;
    this.met.push({ event: this.holding, stopped: stop });
    this.holding = null;
  }

  update(dt: number): JourneyState {
    const at = along(this.leg.path, this.t);
    if (this.holding) return { phase: 'event', t: this.t, at, event: this.holding };
    if (this.t >= 1) {
      if (this.pre && !this.pre.ready(...this.toCell(...this.dest))) {
        this.waited += dt;
        return { phase: 'waiting', t: 1, at };
      }
      return { phase: 'arrived', t: 1, at };
    }
    const nt = Math.min(1, this.t + (dt * this.speed) / Math.max(0.1, this.leg.animSeconds));
    const ev = this.leg.events[this.next];
    if (ev && nt >= ev.t) {
      this.t = ev.t;
      this.next++;
      this.holding = ev;
      return { phase: 'event', t: this.t, at: along(this.leg.path, this.t), event: ev };
    }
    this.t = nt;
    return { phase: 'moving', t: this.t, at: along(this.leg.path, this.t) };
  }
}
