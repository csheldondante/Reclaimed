// ---- runplan/plan.ts --------------------------------------------------------------------------------------------
// (round 117, runplan) The run manager: plans a branching run on the region graph, fitted to the hero.
// The user (round 117): runs of "15-50 minutes with branching"; "the run manager should be able to get. The graph
// and request obstacles or otherwise request a certain number of exits"; "A fast bike need races and chases. A combat
// soldier needs fun fights. A force of nature needs spectacle and power fantasy."
//
// The shape: a start, then a few layers of two stages each (the player picks a leg out of each stage: the branch),
// then a finale against the run's threat. Each stage is the region round it that this hero can reach at a fair
// distance and that best affords what this hero likes (affords.ts × HeroCapabilities.likes), as the world left it —
// so last run's consequences (a region overrun by the dead, a town ruined, a captive held) steer this one.
// Why layers of two: every choice is a real fork (two places, two kinds of play), the run stays 15-50 minutes (a
// path is start + layers + finale stages), and every path reaches the finale — the run can't strand the player.
// Why plain CPU: a few hundred Dijkstra relaxations over a 7772-region graph, once a run (scripts/perf/runplan.mjs).

import type { EncounterKind, HeroCapabilities, RegionGraph, RunPlan, RunPlanner, RunStage, TerrainRequest, TravelLeg } from '../api/contracts/run';
import type { Faction, RegionState, WorldSnapshot } from '../api/contracts/world';
import { freshRegion } from '../api/contracts/world';
import { affordances } from './affords';
import { failureRules, holderOf, spread, stageOutcomes } from './consequences';
import { torusDelta } from './graph';
import { crossCost } from './heroes';
import { reach, routeTo, type Reach } from './route';
import { enRoute } from './travel';
import { hashStr, rng } from './rng';

/** minutes of play a stage of each kind is planned for (a finale half again) */
export const STAGE_MINUTES: Record<EncounterKind, number> = { race: 5, chase: 6, fight: 7, horde: 7, spectacle: 6, destruction: 6, delve: 9, talk: 5, explore: 5, rescue: 8 };
/** how far apart stages are, in effort (world units weighted by the hero's borders): a leg is a real journey, not a hop */
export const LEG_EFFORT: [number, number] = [700, 2600];
/** stages of one layer at least this far apart (world units): the two choices are different places (a first look at
 *  seed 1 had both choices of a layer in neighbouring chasms, their labels on top of each other at 500) */
const APART = 1100;

const ENC_TITLE: Record<EncounterKind, string> = {
  race: 'A race', chase: 'A chase', fight: 'A fight', horde: 'The dead', spectacle: 'A show of power', destruction: 'Breaking',
  delve: 'A delve', talk: 'A parley', explore: 'Uncharted', rescue: 'A rescue',
};
const FINALE_TITLE: Record<EncounterKind, string> = {
  race: 'The last race', chase: 'The last chase', fight: 'The last stand', horde: 'The last host', spectacle: 'The great working', destruction: 'The great breaking',
  delve: 'The deepest vault', talk: 'The council', explore: 'The far place', rescue: 'The last rescue',
};
const ENC_BRIEF: Record<EncounterKind, string> = {
  race: 'open ground for speed: a course with crests to launch off and rivals to beat',
  chase: 'broken ground to chase through: gullies, switchbacks, someone to run down',
  fight: 'a fight worth having: a place to hold or take, foes in waves',
  horde: 'the walking dead in numbers: a host to break',
  spectacle: 'a stage for power: what the hero does here changes the land',
  destruction: 'things to break: walls, pillars, a town that will fall or be spared',
  delve: 'a way down: caves, a vault, locked rooms and their keys',
  talk: 'people with wants: a parley that can turn a faction',
  explore: 'somewhere no one has mapped: a find for the one who looks',
  rescue: 'someone held here: get in, get them out',
};

export interface PlanOptions {
  graph: RegionGraph;
  world: WorldSnapshot;
  hero: HeroCapabilities;
  seed: number;
  /** the region the run starts in (else the hero's, as the world remembers it) */
  from?: number;
  /** the run's length, minutes (default the user's 15-50) */
  minutes?: [number, number];
  /** world units → the level's cells (the precache and section asks are in cells): y / ROW_H */
  toCell?: (x: number, y: number) => [number, number];
}

export class GraphRunPlanner implements RunPlanner {
  plan(o: PlanOptions): RunPlan {
    return planRun(o);
  }
}

export function planRun(o: PlanOptions): RunPlan {
  const { graph: g, world: snap, hero: H } = o;
  const [lo, hi] = o.minutes ?? [15, 50];
  const rnd = rng(hashStr(`${o.seed}:${snap.run}:${H.role}:${snap.version}`));
  const notes: string[] = [];
  const states = new Map<number, RegionState>(snap.regions.map((r) => [r.id, r.state]));
  const state = (id: number) => states.get(id) ?? freshRegion();
  const factions = new Map(snap.factions.map((f) => [f.id, f]));
  const chars = snap.characters ?? [];
  const me = chars.find((c) => c.id === H.role);
  if (me && !me.alive) throw new Error(`runplan: ${me.name} is dead (${me.history.at(-1)?.text ?? ''}); plan another hero`);
  const from = o.from ?? me?.region ?? null;
  if (from === null || !g.node(from)) throw new Error(`runplan: no start region (give opts.from, or the hero's region)`);
  if (me?.statuses.some((s) => s.startsWith('captive'))) notes.push(`${me.name} starts a captive at ${g.node(from)!.name}: the first leg is an escape`);
  // other heroes held captive: a rescue is offered where they're held
  const captives = new Map<number, string>();
  for (const c of chars) if (c.hero && c.alive && c.id !== H.role && c.region !== null && c.statuses.some((s) => s.startsWith('captive'))) captives.set(c.region, c.id);

  // the run's threat: the faction most hostile round here, weighted by how much it holds near the start
  const near = reach(g, H, from, LEG_EFFORT[1] * 3);
  const threatScore = new Map<string, number>();
  let deadOnMap = 0;
  for (const [id] of near.cost) {
    const s = state(id);
    deadOnMap = Math.max(deadOnMap, s.undead);
    for (const [f, p] of Object.entries(s.presence)) {
      const F = factions.get(f);
      if (!F) continue;
      const hostility = -F.attitude + (f === 'f-hollow-court' ? 0.6 : 0) + (F.power ?? 0.5) * 0.3;
      if (hostility > 0) threatScore.set(f, (threatScore.get(f) ?? 0) + (p ?? 0) * hostility);
    }
  }
  let threat: Faction | null = null;
  let ts = 0.2;
  for (const [f, v] of threatScore) if (v > ts) ((threat = factions.get(f)!), (ts = v));
  notes.push(threat ? `threat: ${threat.name} (${threat.ethos.split(';')[0]})` : 'no faction threat near: the land itself is the challenge');

  // how many layers: the path's stages × their minutes, plus travel, inside the run's length
  const target = lo + (0.35 + 0.3 * rnd()) * (hi - lo);
  const perStage = 7.5;
  const layers = Math.max(1, Math.min(4, Math.round(target / perStage) - 2));
  notes.push(`aiming at ${target.toFixed(0)} min: start + ${layers} layer${layers > 1 ? 's' : ''} of two + a finale`);

  const used = new Set<number>([from]);
  const stages: RunStage[] = [];
  const reaches = new Map<number, Reach>();
  const reachOf = (id: number) => {
    let r = reaches.get(id);
    if (!r) reaches.set(id, (r = reach(g, H, id, LEG_EFFORT[1] * 1.6)));
    return r;
  };
  const fit = (id: number, prev: EncounterKind | null, forced?: EncounterKind): { enc: EncounterKind; score: number } => {
    const n = g.node(id)!;
    const a = affordances(n, state(id), factions, captives.has(id) ? 1 : 0);
    let best: EncounterKind = 'explore';
    let bs = -1;
    for (const k of Object.keys(a) as EncounterKind[]) {
      if (forced && k !== forced) continue;
      const like = k === 'rescue' ? (a.rescue ? 1.2 : 0) : (H.likes[k] ?? 0);
      const s = like * a[k] * (k === prev ? 0.6 : 1);
      if (s > bs) ((bs = s), (best = k));
    }
    return { enc: best, score: bs };
  };
  const centreDist = (a: number, b: number) => Math.hypot(...torusDelta(g.node(a)!.centre, g.node(b)!.centre, g.world.w, g.world.h));

  const makeStage = (id: number, region: number, enc: EncounterKind, finale: boolean): RunStage => {
    const n = g.node(region)!;
    const s = state(region);
    const holder = holderOf(n, s, snap);
    const around = g.edges(region).map((e) => e.b).filter((b) => g.node(b)?.land);
    const settlement = snap.settlements.find((x) => n.settlements.includes(x.id));
    const place = settlement ? `${settlement.name}, ${n.name}` : n.name;
    const minutes = STAGE_MINUTES[enc] * (finale ? 1.5 : 1);
    const radius = Math.min(640, Math.max(192, Math.sqrt(n.area / Math.PI) * (g.world.w / 2048)));
    const sid = `st${id}`;
    return {
      id: sid,
      name: `${finale ? FINALE_TITLE[enc] : ENC_TITLE[enc]} at ${place}`,
      region,
      at: n.centre,
      encounter: enc,
      brief: `${ENC_BRIEF[enc]}${finale && threat ? `; against ${threat.name}` : ''} (${n.kind}${s.undead > 0.1 ? ', the dead walk here' : ''}${s.ruin > 0.2 ? ', in ruins' : ''}${s.sunk > 0 ? ', half drowned' : ''})`,
      minutes,
      section: { at: n.centre, radius },
      outcomes: stageOutcomes({ stage: sid, node: n, state: s, encounter: enc, hero: H.role, threat, holder, finale, rnd, around, captive: captives.get(region) }),
      next: [],
    };
  };

  // the start
  const startFit = me?.statuses.some((s) => s.startsWith('captive')) ? { enc: 'chase' as EncounterKind } : fit(from, null);
  stages.push(makeStage(0, from, startFit.enc, false));
  let prevLayer: RunStage[] = [stages[0]];
  let sid = 1;
  const pickLayer = (parents: RunStage[], width: number, finale: boolean): RunStage[] => {
    // candidates: reachable from some parent inside the leg band (finale: from every parent)
    const cand = new Map<number, number>();
    for (const p of parents) {
      const r = reachOf(p.region);
      for (const [id, c] of r.cost) {
        if (used.has(id) || !g.node(id)!.land) continue;
        if (c < LEG_EFFORT[0] || c > LEG_EFFORT[1] * (finale ? 1.4 : 1)) continue;
        cand.set(id, (cand.get(id) ?? 0) + 1);
      }
    }
    const top = (Object.entries(H.likes) as [EncounterKind, number][]).sort((a, b) => b[1] - a[1])[0][0];
    const scored: { id: number; enc: EncounterKind; score: number }[] = [];
    for (const [id, k] of cand) {
      if (finale && k < parents.length) continue;
      const prevEnc = parents[0].encounter;
      const f = finale ? fit(id, null, threat ? undefined : top) : fit(id, prevEnc);
      // a rescue where a hero is held comes first; then fit, a little noise so ties break by the seed
      // (reachable from every parent: every choice before it can lead here — a real fork, not two corridors)
      const bonus = (captives.has(id) ? 2 : 0) + (k === parents.length ? 0.3 : 0);
      scored.push({ id, enc: f.enc, score: f.score + bonus + 0.08 * rnd() });
    }
    scored.sort((a, b) => b.score - a.score);
    const out: RunStage[] = [];
    // greedy: the best, then the best of what's left far enough from it, a kind already in the layer worth less (the
    // two choices should be two kinds of play where the hero likes more than one: a race or a chase)
    const pool = scored.slice();
    while (out.length < width && pool.length) {
      let bi = -1;
      let bs = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const c = pool[i];
        if (out.some((s) => centreDist(s.region, c.id) < APART)) continue;
        const s = c.score * (out.some((x) => x.encounter === c.enc) ? 0.75 : 1);
        if (s > bs) ((bs = s), (bi = i));
      }
      if (bi < 0) break;
      const c = pool.splice(bi, 1)[0];
      used.add(c.id);
      out.push(makeStage(sid++, c.id, c.enc, finale));
    }
    return out;
  };
  for (let L = 0; L < layers; L++) {
    const layer = pickLayer(prevLayer, 2, false);
    if (!layer.length) {
      notes.push(`layer ${L + 1}: nowhere this hero can reach at a fair distance — the run is shorter`);
      break;
    }
    // each parent leads to the children it can reach at a fair distance; a child no parent reaches is dropped
    const fair = (p: RunStage, c: RunStage) => (reachOf(p.region).cost.get(c.region) ?? Infinity) <= LEG_EFFORT[1] * 1.4;
    const kept = layer.filter((c) => prevLayer.some((p) => fair(p, c)));
    for (const p of prevLayer) p.next = kept.filter((c) => fair(p, c)).map((c) => c.id);
    // a parent that reaches none of them goes to the nearest it reaches at all (a longer leg, never a dead end)
    for (const p of prevLayer)
      if (!p.next.length) {
        const r = reachOf(p.region);
        const best = kept.filter((c) => r.cost.has(c.region)).sort((x, y) => r.cost.get(x.region)! - r.cost.get(y.region)!)[0];
        if (!best) throw new Error(`runplan: ${p.name} reaches none of layer ${L + 1}`);
        p.next = [best.id];
      }
    stages.push(...kept);
    prevLayer = kept;
  }
  const fin = pickLayer(prevLayer, 1, true);
  if (!fin.length) throw new Error(`runplan: no finale reachable by ${H.role} from every last stage (from region ${from})`);
  stages.push(fin[0]);
  for (const p of prevLayer) p.next = [fin[0].id];

  // the legs: the hero's route between stages, its crossings, the fun obstacle asked of terrain, what's on the road
  const legs: TravelLeg[] = [];
  const requests: TerrainRequest[] = [];
  const byId = new Map(stages.map((s) => [s.id, s]));
  for (const s of stages) {
    const nextIds = s.next;
    s.next = [];
    for (const t of nextIds) {
      const to = byId.get(t)!;
      const route = routeTo(reachOf(s.region), to.region);
      if (!route) throw new Error(`runplan: ${to.name} not reachable from ${s.name}`);
      const id = `${s.id}-${to.id}`;
      const path: [number, number][] = [];
      for (const r of route) {
        const c = g.node(r)!.centre;
        if (!path.length) path.push([c[0], c[1]]);
        else {
          const p = path[path.length - 1];
          const [dx, dy] = torusDelta(p, c, g.world.w, g.world.h);
          path.push([p[0] + dx, p[1] + dy]);
        }
      }
      const crossings: TravelLeg['crossings'] = [];
      let effort = 0;
      let len = 0;
      for (let i = 1; i < route.length; i++) {
        const e = g.edges(route[i - 1]).find((x) => x.b === route[i])!;
        const k = crossCost(H, e.barrier, e.crossing);
        effort += e.length * k;
        len += e.length;
        if (e.barrier && !e.crossing && (k !== 1 || H.funCrossings?.[e.barrier])) crossings.push({ a: e.a, b: e.b, barrier: e.barrier, how: H.funCrossings?.[e.barrier] ?? (k === 1 ? 'easily' : 'the hard way') });
      }
      // one fun obstacle a leg (the user: "make not only obstacles but fun ones"): a border already of a kind that's
      // fun for this hero, else an open border made one — never a border the hero couldn't cross
      const fun = Object.keys(H.funCrossings ?? {}) as (keyof NonNullable<HeroCapabilities['funCrossings']>)[];
      if (fun.length && route.length > 1) {
        let pick = crossings.find((c) => fun.includes(c.barrier));
        if (!pick) {
          const open: { a: number; b: number }[] = [];
          for (let i = 1; i < route.length; i++) {
            const e = g.edges(route[i - 1]).find((x) => x.b === route[i])!;
            if (!e.barrier) open.push({ a: e.a, b: e.b });
          }
          const kind = fun[Math.floor(rnd() * fun.length)];
          // (a fun crossing is built with its passage for this hero — a ramp for the bike — so it's crossable even
          // where the bare barrier wouldn't be)
          if (open.length) {
            const at = open[Math.floor(rnd() * open.length)];
            pick = { a: at.a, b: at.b, barrier: kind, how: H.funCrossings![kind]! };
            crossings.push(pick);
          }
        }
        if (pick && !requests.some((q) => q.kind === 'obstacle' && ((q.a === pick!.a && q.b === pick!.b) || (q.a === pick!.b && q.b === pick!.a)))) requests.push({ kind: 'obstacle', a: pick.a, b: pick.b, barrier: pick.barrier, passage: H.funCrossings![pick.barrier]!, why: `${H.role}: ${pick.how} on the way to ${to.name}` });
      }
      const animSeconds = Math.min(14, 4 + route.length * 0.6);
      const events = enRoute({ id, route, path, graph: g, state, factions, rnd, len });
      legs.push({ id, from: s.id, to: to.id, route, path, minutes: +(animSeconds / 60 + events.length * 1.5 + (effort / Math.max(1, H.speed)) / 600).toFixed(2), animSeconds, crossings, events });
      s.next.push(id);
    }
  }
  // the exits each stage needs: the borders toward its legs (in and out) passable, the rest closed — the player is
  // kept in a section (B-RC1) whose ways out are the run's choices
  for (const s of stages) {
    const toward = new Set<number>();
    for (const l of legs) {
      if (l.from === s.id && l.route.length > 1) toward.add(l.route[1]);
      if (l.to === s.id && l.route.length > 1) toward.add(l.route[l.route.length - 2]);
    }
    requests.push({ kind: 'exits', region: s.region, toward: [...toward], closeOthers: s.id !== stages[0].id });
  }

  // the length of every path, start to finale
  const legOf = new Map(legs.map((l) => [l.id, l]));
  const span = (s: RunStage): { min: number; max: number } => {
    if (!s.next.length) return { min: s.minutes, max: s.minutes };
    let mn = Infinity;
    let mx = 0;
    for (const lid of s.next) {
      const l = legOf.get(lid)!;
      const r = span(byId.get(l.to)!);
      mn = Math.min(mn, s.minutes + l.minutes + r.min);
      mx = Math.max(mx, s.minutes + l.minutes + r.max);
    }
    return { min: mn, max: mx };
  };
  let minutes = span(stages[0]);
  // the stages' minutes are budgets (the region generator sizes a stage to its minutes): fitted so every path is in
  // the run's length — the travel stays what it is
  if (minutes.max > hi * 0.95 || minutes.min < lo * 1.05) {
    const k = minutes.max > hi * 0.95 ? (hi * 0.95) / minutes.max : (lo * 1.05) / minutes.min;
    for (const s of stages) s.minutes = +(s.minutes * k).toFixed(1);
    notes.push(`stage budgets scaled ×${k.toFixed(2)} to fit ${lo}-${hi} min`);
    minutes = span(stages[0]);
  }
  const finale = stages[stages.length - 1];
  const spreadTo = spread(g, stages.map((s) => s.region), 3);
  const seatSett = threat ? snap.settlements.find((x) => x.faction === threat!.id) : undefined;
  const failures = failureRules({ plan: { stages }, hero: H.role, threat, spread: spreadTo, deadOnMap, finaleRegion: finale.region, finaleName: g.node(finale.region)!.name, seat: seatSett?.region ?? null });
  notes.push(`${stages.length} stages, ${legs.length} legs; a path takes ${minutes.min.toFixed(0)}-${minutes.max.toFixed(0)} min`);
  return {
    id: `plan-${o.seed}-${snap.run}-${H.role}`,
    from: { seed: o.seed, worldVersion: snap.version, run: snap.run },
    hero: H.role,
    start: stages[0].id,
    stages,
    legs,
    deadline: Math.ceil(minutes.max * 1.15),
    minutes: { min: +minutes.min.toFixed(1), max: +minutes.max.toFixed(1) },
    failures,
    requests,
    notes,
  };
}
