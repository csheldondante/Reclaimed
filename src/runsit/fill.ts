// ---- runsit/fill.ts ---------------------------------------------------------------------------------------------
// (round 120, `runsit`; BACKLOG RS20) The situation template, filled from the world as it is: "the horde comes for the
// town". Deterministic from the seed and the world (tests and a run with no GM-written file use it); the GM writes the
// same contract by hand from the wiki (docs/GM.md "Situations"), and storycheck's situation half validates both.
// The user (round 120): "This is what we want the gm to do possibly with templates. Look at world state and tell a
// story with meaningful decisions for the player run."
//
// What it reads of the world: the settlements standing (a ruined or abandoned town isn't a target again — last run's
// fire is remembered), who's hostile and present near the town (the threat's faction), the region graph (the horde's
// route: a real march over borders a walker crosses, from beyond the town), the town's highest neighbour (the hills
// its people can be led to), the realm's strongest other town or city (the hold that can send a levy).
// The shape (five areas; a path plays three or four): the start (outriders on the hero) → the hold (carry the message:
// its levy marches, late but in force) or the road (an ambush) → the town; from the road, a turn aside to a trader
// (a find, time lost). The clock is set so the straight road gets there first and the hold's way doesn't — the fork
// is real: in time with less, or late with more.

import type { RegionGraph } from '../api/contracts/run';
import type { ItemDef } from '../api/contracts/items';
import type { Situation, SituationArea, SituationChoice } from '../api/contracts/situation';
import type { Settlement } from '../api/contracts/settlement';
import type { AtlasEvent, FactionId, RegionId, WorldSnapshot } from '../api/contracts/world';
import { freshRegion } from '../api/contracts/world';
import { hashStr, rng } from '../runplan/rng';
import { heroCaps } from '../runplan/heroes';
import { reach, routeTo } from '../runplan/route';
import { ITEMS } from './items';
import { delta, pathEstimates, type SituationMap, type V2 } from './state';

/** the town the dead come for: this far from the start (world units) */
const TARGET_RANGE: [number, number] = [380, 1500];
/** the hold: this far from the town */
const HOLD_RANGE: [number, number] = [350, 1700];
/** the horde's route: this many regions long (it rises a few borders beyond the town) */
const ROUTE_LEN: [number, number] = [4, 8];
/** minutes the straight road is ahead of the dead */
const MARGIN = 2.5;

export interface FillOptions {
  graph: RegionGraph;
  world: WorldSnapshot;
  seed: number;
  /** the region the hero starts in */
  from: RegionId;
  /** the spot it starts at (world units; default the region's centre) */
  at?: V2;
  hero?: string;
}

/** where things are on this graph and world (the run's SituationMap) */
export function situationMap(graph: RegionGraph, world: WorldSnapshot): SituationMap {
  const sett = new Map(world.settlements.map((s) => [s.id, s]));
  return {
    world: graph.world,
    regionCentre: (r) => {
      const n = graph.node(r);
      if (!n) throw new Error(`situation: region ${r} isn't on the graph`);
      return [n.centre[0], n.centre[1]];
    },
    areaAt: (a) => {
      if (a.at) return [a.at[0], a.at[1]];
      if (a.settlement) {
        const s = sett.get(a.settlement);
        if (!s) throw new Error(`situation: settlement ${a.settlement} isn't in the world`);
        return [s.at[0], s.at[1]];
      }
      const n = graph.node(a.region);
      if (!n) throw new Error(`situation: region ${a.region} isn't on the graph`);
      return [n.centre[0], n.centre[1]];
    },
  };
}

const SIZE_W: Record<Settlement['size'], number> = { camp: 0, hamlet: 0.3, village: 0.7, town: 1, city: 0.9 };

export function fillSituation(o: FillOptions): Situation {
  const { graph: g, world: snap } = o;
  const rnd = rng(hashStr(`${o.seed}:${snap.run}:${snap.version}:situation`));
  const W = g.world;
  const state = (r: RegionId) => snap.regions.find((x) => x.id === r)?.state ?? freshRegion();
  const start = g.node(o.from);
  if (!start) throw new Error(`situation: the start region ${o.from} isn't on the graph`);
  const startAt: V2 = o.at ?? [start.centre[0], start.centre[1]];
  const dist = (a: V2, b: V2) => Math.hypot(...delta(a, b, W));
  const standing = (s: Settlement) => s.condition !== 'ruined' && s.condition !== 'abandoned' && state(s.region).ruin < 0.3 && !!g.node(s.region)?.land;

  // the town: standing, a fair ride off, the bigger the better
  const towns = snap.settlements
    .filter((s) => standing(s) && SIZE_W[s.size] > 0.5)
    .map((s) => ({ s, d: dist(startAt, s.at as V2) }))
    .filter((x) => x.d >= TARGET_RANGE[0] && x.d <= TARGET_RANGE[1])
    .map((x) => ({ ...x, w: SIZE_W[x.s.size] * (1 - Math.abs(x.d - 800) / 1400) + rnd() * 0.3 }))
    .sort((a, b) => b.w - a.w);
  if (!towns.length) throw new Error(`situation: no standing town ${TARGET_RANGE.join('-')} world units from region ${o.from}`);
  const town = towns[0].s;
  const townAt = town.at as V2;

  // the threat: the dead (the Hollow Court) — the slice is "the horde comes for the town"; a world without the Court
  // sends the most hostile faction present round the town, else the most hostile there is
  const facs = new Map(snap.factions.map((f) => [f.id, f]));
  let threatFaction: FactionId | null = facs.has('f-hollow-court') ? 'f-hollow-court' : null;
  if (!threatFaction) {
    let worst = 0;
    for (const r of [town.region, ...g.edges(town.region).map((e) => e.b)])
      for (const [f, p] of Object.entries(state(r).presence)) {
        const a = (facs.get(f)?.attitude ?? 0) * (0.5 + (p ?? 0));
        if (a < worst) (worst = a), (threatFaction = f);
      }
  }
  threatFaction ??= [...facs.values()].sort((a, b) => a.attitude - b.attitude)[0]?.id ?? null;
  if (!threatFaction) throw new Error('situation: the world has no factions');
  const dead = threatFaction === 'f-hollow-court';
  const role = dead ? 'walking dead' : 'raider';

  // its route: a walker's march over the region graph from a few borders beyond the town (away from the hero)
  const walker = heroCaps('wanderer');
  const fromTown = reach(g, walker, town.region);
  const cands: { r: RegionId; route: RegionId[]; w: number }[] = [];
  for (const [r] of fromTown.cost) {
    const route = routeTo(fromTown, r);
    if (!route || route.length < ROUTE_LEN[0] || route.length > ROUTE_LEN[1]) continue;
    const n = g.node(r)!;
    if (!n.land) continue;
    // (beyond the town from the hero: the far side scores; dead land — undead, the court's ground — scores)
    const away = dist(startAt, n.centre as V2) - dist(startAt, townAt);
    const grim = state(r).undead + (state(r).presence[threatFaction] ?? 0);
    cands.push({ r, route: route.reverse(), w: away / 400 + grim + rnd() * 0.4 });
  }
  if (!cands.length) throw new Error(`situation: no route of ${ROUTE_LEN.join('-')} regions to ${town.name}`);
  cands.sort((a, b) => b.w - a.w);
  const route = cands[0].route;
  const origin = g.node(route[0])!;

  // the refuge: the town's highest land neighbour (the hills)
  const hills = g
    .edges(town.region)
    .map((e) => g.node(e.b)!)
    .filter((n) => n.land && n.id !== route[route.length - 2])
    .sort((a, b) => b.ground.mean - a.ground.mean)[0] ?? g.node(town.region)!;

  // the hold: the realm's strongest other standing town or city, not past the town on the dead's road
  const holds = snap.settlements
    .filter((s) => s.id !== town.id && standing(s) && (s.size === 'city' || s.size === 'town') && (!town.faction || s.faction === town.faction))
    .map((s) => ({ s, d: dist(townAt, s.at as V2), h: dist(startAt, s.at as V2) }))
    .filter((x) => x.d >= HOLD_RANGE[0] && x.d <= HOLD_RANGE[1] && x.h >= 250)
    .sort((a, b) => (b.s.size === 'city' ? 1 : 0) - (a.s.size === 'city' ? 1 : 0) || a.d + a.h - (b.d + b.h));
  if (!holds.length) throw new Error(`situation: no hold within ${HOLD_RANGE.join('-')} of ${town.name}`);
  const hold = holds[0].s;
  const allyFaction = (hold.faction ?? town.faction ?? threatFaction) as FactionId;

  // the road: a region about halfway from the start to the town (not the town's own)
  const [mx, my] = delta(startAt, townAt, W);
  const mid: V2 = [startAt[0] + mx * 0.5, startAt[1] + my * 0.5];
  const fromStart = reach(g, walker, o.from);
  let road = o.from;
  let rd = Infinity;
  for (const [r] of fromStart.cost) {
    const n = g.node(r)!;
    if (!n.land || r === town.region || r === o.from) continue;
    const d = dist(mid, n.centre as V2);
    if (d < rd) (rd = d), (road = r);
  }
  const roadNode = g.node(road)!;
  // the crossroads: a region off the road, a little out of the way (toward the hills side)
  let cross = road;
  let cd = Infinity;
  for (const e of g.edges(road)) {
    const n = g.node(e.b)!;
    if (!n.land || e.b === town.region || e.b === o.from) continue;
    const d = Math.abs(dist(n.centre as V2, townAt) - dist(roadNode.centre as V2, townAt) * 0.9) + rnd() * 60;
    if (d < cd) (cd = d), (cross = e.b);
  }
  const crossNode = g.node(cross)!;

  const T = town.name;
  const H = hold.name;
  const items = (ids: string[]): ItemDef[] => ids.map((id) => ITEMS[id]);
  const areas: SituationArea[] = [
    {
      id: 'a-start', name: start.name, region: o.from, at: startAt, brief: `Word comes running: ${dead ? 'the dead walk' : 'raiders ride'} out of ${origin.name}, bound for ${T}. Their outriders have seen you.`, minutes: 2.5,
      play: { kind: 'flee' },
      say: [{ line: `${dead ? 'The dead' : 'Raiders'} out of ${origin.name}, making for ${T}! Their riders have your scent.` }],
    },
    {
      id: 'a-hold', name: H, region: hold.region, settlement: hold.id, brief: `${H} keeps a levy. Carry the word to its hall and it marches for ${T} — slower than you.`, minutes: 3,
      play: { kind: 'deliver', settlement: hold.id, sends: { faction: allyFaction, role: 'guard', count: 8 }, gives: ['war-horn', 'fresh-mount'], limit: 150 },
      say: [{ line: `${H}'s gate. The hall is up the hill — ride!` }],
    },
    {
      id: 'a-road', name: roadNode.name, region: road, brief: `The road to ${T} runs through ${roadNode.name}; something waits in the ditches.`, minutes: 2.5,
      play: { kind: 'ambush', foes: 5, role, faction: threatFaction },
      say: [{ line: dead ? 'The ditches stir. They were waiting.' : 'Riders bar the road.' }],
    },
    {
      id: 'a-cross', name: crossNode.name, region: cross, brief: `A trader camps at the crossroads in ${crossNode.name}: a find for the one who stops, time lost to the one who does.`, minutes: 2,
      play: { kind: 'trader', offers: ['lure-bell', 'ash-cloak'] },
      say: [{ line: 'A trader waves from the crossroads: "Something for the road? Quick, then."' }],
    },
    {
      id: 'a-town', name: T, region: town.region, settlement: town.id, brief: `${T}, with ${dead ? 'the dead' : 'the raiders'} on the road behind.`, minutes: 5,
      play: { kind: 'town' },
      say: [{ line: `${T}. Ring the bell!` }],
    },
  ];
  const choices: SituationChoice[] = [
    { id: 'c-hold', from: 'a-start', to: 'a-hold', text: `Ride to ${H} for its levy`, effects: [] },
    { id: 'c-road', from: 'a-start', to: 'a-road', text: `Ride for ${T} by the straight road`, effects: [] },
    { id: 'c-levy', from: 'a-hold', to: 'a-town', text: `Ride ahead of the levy to ${T}`, effects: [{ kind: 'warn' }] },
    { id: 'c-stand', from: 'a-road', to: 'a-town', text: `Warn ${T} and hold its walls`, effects: [{ kind: 'warn' }] },
    { id: 'c-flee', from: 'a-road', to: 'a-town', text: `Warn ${T} and lead its people into ${hills.name}`, effects: [{ kind: 'warn' }, { kind: 'evacuate' }] },
    { id: 'c-cross', from: 'a-road', to: 'a-cross', text: `Turn aside to the trader in ${crossNode.name}`, effects: [] },
    { id: 'c-on', from: 'a-cross', to: 'a-town', text: `On to ${T}, to warn them`, effects: [{ kind: 'warn' }] },
  ];
  const sit: Situation = {
    id: `horde-${o.seed}-${snap.run}`,
    title: `${dead ? 'The Dead Come' : 'Raiders Ride'} for ${T}`,
    premise: `${dead ? 'A host of the walking dead' : 'A raiding host'} has risen in ${origin.name} and marches on ${T}. Ride to ${H} for its levy and come late but in force, or warn ${T} yourself and hold it — or lead its people into ${hills.name} and let the town go.`,
    from: { worldVersion: snap.version, run: snap.run, seed: o.seed },
    hero: o.hero ?? 'any',
    threat: { kind: 'horde', name: dead ? 'the Hollow Host' : 'the Raiding Host', faction: threatFaction, role, count: 16, route, arrives: 0, outriders: { count: 3, role, behind: 0.6 } },
    target: { settlement: town.id, region: town.region, name: T },
    refuge: { region: hills.id, name: hills.name },
    areas,
    choices,
    items: items(['war-horn', 'fresh-mount', 'lure-bell', 'ash-cloak']),
    endings: endings({ town, hold, hills: hills.id, route, threat: threatFaction, dead, ref: `horde-${o.seed}-${snap.run}` }),
  };
  // the clock: the straight road there first (by MARGIN), the hold's way not
  const est = pathEstimates(sit, situationMap(g, snap));
  const straight = Math.min(...est.filter((p) => !p.areas.includes('a-hold') && !p.areas.includes('a-cross')).map((p) => p.minutes));
  sit.threat.arrives = +(straight + MARGIN).toFixed(1);
  const viaHold = est.find((p) => p.areas.includes('a-hold'));
  if (viaHold && viaHold.minutes > sit.threat.arrives) sit.choices[0].text += ' (late, but in force)';
  return sit;
}

function endings(o: { town: Settlement; hold: Settlement; hills: RegionId; route: RegionId[]; threat: FactionId; dead: boolean; ref: string }): Situation['endings'] {
  const T = o.town.name;
  const r = o.town.region;
  const ev = (e: Omit<AtlasEvent, 'id' | 'run' | 'cause'>): Omit<AtlasEvent, 'id' | 'run'> => ({ ...e, cause: { by: 'story', ref: o.ref } });
  const burnt = [ev({ kind: 'burn', regions: [r], magnitude: 0.8 }), ev({ kind: 'ruin', regions: [r], magnitude: 0.6 }), ev({ kind: 'mark', regions: [r], magnitude: 1, detail: { name: `the burned town of ${T}`, kind: 'ruin' } })];
  const fac = o.town.faction;
  return {
    saved: {
      text: `${T} stands. The host is broken on its walls.`,
      outcome: {
        atlas: [ev({ kind: o.dead ? 'lay-dead' : 'faction-presence', regions: o.route, magnitude: o.dead ? 0.2 : -0.2, ...(o.dead ? {} : { detail: { faction: o.threat } }) }), ev({ kind: 'mark', regions: [r], magnitude: 1, detail: { name: `the Stand at ${T}`, kind: 'battlefield' } })],
        attitude: fac ? [{ faction: fac, delta: 0.3 }] : [],
      },
      settlement: 'thriving',
    },
    burned: {
      text: `${T} burned. ${o.dead ? 'The dead walk its ashes.' : 'The raiders took what the fire left.'}`,
      outcome: { atlas: [...burnt, ...(o.dead ? [ev({ kind: 'raise-dead', regions: [r], magnitude: 0.3 })] : [])], attitude: fac ? [{ faction: fac, delta: -0.2 }] : [] },
      settlement: 'ruined',
    },
    evacuated: {
      text: `${T}'s people live, in the hills; the town is ash behind them.`,
      outcome: {
        atlas: [...burnt, ev({ kind: 'mark', regions: [o.hills], magnitude: 1, detail: { name: `the refuge of ${T}`, kind: 'camp' } }), ...(fac ? [ev({ kind: 'faction-presence', regions: [o.hills], magnitude: 0.2, detail: { faction: fac } })] : [])],
        attitude: fac ? [{ faction: fac, delta: 0.2 }] : [],
      },
      settlement: 'abandoned',
    },
    fell: {
      text: `The hero fell on the road, and ${T} with them.`,
      outcome: { atlas: [...burnt, ...(o.dead ? [ev({ kind: 'raise-dead', regions: [r, ...o.route.slice(-3)], magnitude: 0.3 })] : [])] },
      settlement: 'ruined',
    },
  };
}

