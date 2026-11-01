// ---- opps/horde.ts ------------------------------------------------------------------------------------------------
// (round 120, `opportunities`; BACKLOG RN2-3) Slice A's templates: runsit's horde run as opportunities. What each
// proposes this turn, from the run as it stands (the situation, where the hero is, the host on its route, what is
// held); the dealer (dealer.ts) decides what of it is offered. The templates:
//   outriders  the run's start: the threat's riders are on the hero — forced, dealt alone (the user: "Opportunities can
//              trigger player interactions and consequences")
//   ride / warn / lead-out   the ways on at an area's edge, one per situation choice: player opportunities; playing one
//              travels there and plays its area (the GM's travel rule is the situation's: a choice of destinations)
//   ford       hold the ford on the host's road: army 1/2/3 (+ supplies), delays the host by the tier; the survivors
//              come back veterans
//   harvest    bring in the harvest at the hold's fields: army 1/2, supplies for the town's defenders; let it go and
//              the grain rots: the host forages and comes on sooner
//   vanguard   only for veterans (a tag opportunity): break the host's vanguard, fewer of the dead reach the town
//   (round 124: the user on slice A — "there are not multiple to select from and the game mode when I select is just
//   drive to a flag no enemies or combat no pursuers no race". Every player opportunity is an encounter with enemies
//   (encounterOf; a hall or a trader without its own threat gets one: armThreats), and three detours are dealt beside
//   the ways on, each a new area off the road that leads on to the same places:)
//   rescue     free the host's captives (guards, then lead them out): they stand with the town; let them go and they
//              swell the host
//   scout      the lookout over the host's road past its patrols: the host's road known (the ford's odds up)
//   chase      run down the host's herald (it starts close and already running, PL23): fewer of the dead rise; let it
//              go and more do
// The DECISIONS round 120 the user: "travel ... as opportunities that require the player and therefore playing travels
// you to them"; "Having a knight creates opportunities requiring a knight; having an army enables military campaigns".

import type { Encounter, Goods, OppOutcome, Opportunity, Requirement, Tier } from '../api/contracts/opportunity';
import type { SituationArea, SituationChoice } from '../api/contracts/situation';
import type { Made, Proposal, TierOffer } from './dealer';
import type { HordeTune } from './tune';
import { along, delta, LEVY_PACE, PLAY_TITLE, type SituationRun, type V2 } from '../runsit/state';

/** what the conflict is about (the dealer's "tied to the conflict") */
export const HORDE_HOOKS = ['horde', 'town'];
/** the conflict's own operations (an effect `{ kind: 'conflict', op }`; the run applies them: run.ts) */
export const CONFLICT_OPS = ['delay', 'hasten', 'thin', 'swell', 'rally', 'intel'] as const;

/** what the templates read of the run */
export interface HordeView {
  sr: SituationRun;
  turn: number;
  /** where the player is (world units) */
  at: V2;
  tune: HordeTune;
  /** the harvest's fate, once it has one */
  harvest: 'open' | 'rotted' | 'taken';
  /** a template id → committed or resolved already this run (each is offered until taken) */
  taken: Set<string>;
  /** where a free army is (world units), if one is held */
  armyAt?: V2;
  /** (round 124) the turn a template at a place was first offered (an expiry counts from it, not from each deal) */
  firstSeen: (key: string) => { turn: number; minute: number };
  /** what scouting has learned (added to the ford's odds) */
  intel: number;
}

/**
 * (round 124) The encounter an area is: its play, with the threat in it (its own foes and pursuers, the area's
 * `threat`, the outriders still on the hero). Every player opportunity shows it; a Node test holds that none is empty.
 */
export function encounterOf(sr: SituationRun, a: SituationArea, evacuate = false): Encounter {
  const p = a.play;
  const x = a.threat ?? { foes: 0, pursuers: 0 };
  const behind = (sr.pursuers?.count ?? 0) + x.pursuers;
  const th = sr.sit.threat;
  const tail = behind ? `, ${behind} ${th.role} behind you` : '';
  switch (p.kind) {
    case 'flee':
      return { kind: 'flee', foes: 0, pursuers: (th.outriders?.count ?? 0) + x.pursuers, text: `${(th.outriders?.count ?? 0) + x.pursuers} outriders on your heels: get away, or cut them down` };
    case 'ambush':
      return { kind: 'ambush', foes: p.foes + x.foes, pursuers: behind, text: `${p.foes + x.foes} ${p.role} in the road${tail}` };
    case 'deliver':
      return { kind: 'gauntlet', foes: x.foes, pursuers: behind, text: `${x.foes} ${th.role} between you and the hall${tail}; ${Math.round(p.limit)} s to get the word in` };
    case 'trader':
      return { kind: 'skirmish', foes: x.foes, pursuers: behind, text: `${x.foes} ${th.role} round the trader: drive them off, then it trades${tail}` };
    case 'chase':
      return { kind: 'chase', foes: p.quarry, pursuers: behind, text: `${p.quarry} ${p.role} already running, a few seconds ahead: cut them all down before they get away${tail}` };
    case 'rescue':
      return { kind: 'rescue', foes: p.guards, pursuers: behind, text: `${p.guards} ${p.role} guard ${p.captives} captives: cut them down, then lead the captives out${tail}` };
    case 'scout':
      return { kind: 'patrol', foes: p.patrols * 2, pursuers: behind, text: `${p.patrols * 2} ${p.role} patrol the way to the lookout${tail}` };
    case 'town': {
      const n = Math.max(1, th.count - sr.thinned);
      return evacuate
        ? { kind: 'evacuate', foes: 0, pursuers: behind, horde: n, text: `${n} of ${th.name} come for the town: lead its people out to ${sr.sit.refuge.name} before they're caught` }
        : { kind: 'defend', foes: 0, pursuers: behind, horde: n, text: `${n} of ${th.name} come for the town: hold it, or it burns` };
    }
  }
}

/** (round 124) a hall or a trader with no threat of its own gets one: nothing the player plays is a ride to a flag */
export function armThreats(sr: SituationRun, t: HordeTune): void {
  for (const a of sr.sit.areas) {
    if (a.threat) continue;
    if (a.play.kind === 'deliver') a.threat = { foes: t.gauntletFoes, pursuers: t.gauntletPursuers };
    else if (a.play.kind === 'trader') a.threat = { foes: t.skirmishFoes, pursuers: 0 };
  }
}

/** the detours: a new area off the road toward the town, leading on to the same places as where it was taken */
export const DETOURS = ['rescue', 'scout', 'chase'] as const;
export type Detour = (typeof DETOURS)[number];
const DETOUR_AT: Record<Detour, number> = { rescue: 0.3, chase: 0.45, scout: 0.6 };

export function detourArea(v: HordeView, d: Detour): SituationArea {
  const sr = v.sr;
  const from = sr.area();
  const a = sr.map.areaAt(from);
  const [dx, dy] = delta(a, sr.map.areaAt(sr.finaleArea), sr.map.world);
  const f = DETOUR_AT[d];
  const at: [number, number] = [a[0] + dx * f, a[1] + dy * f];
  const th = sr.sit.threat;
  const T = v.tune;
  const play: SituationArea['play'] =
    d === 'rescue' ? { kind: 'rescue', captives: T.rescueCaptives, guards: T.rescueGuards, role: th.role, faction: th.faction }
    : d === 'chase' ? { kind: 'chase', quarry: T.chaseQuarry, role: th.role, faction: th.faction, escape: 0 }
    : { kind: 'scout', patrols: T.patrols, role: th.role, faction: th.faction };
  const name = d === 'rescue' ? `the dead's camp by ${from.name}` : d === 'chase' ? `the herald's road from ${from.name}` : `the lookout over ${th.name}`;
  const brief = d === 'rescue' ? `Outriders of ${th.name} hold people taken off the roads. Free them and they stand with ${sr.sit.target.name}.` : d === 'chase' ? `${th.name}'s herald rides for the barrows to wake more dead. It is a few seconds ahead of you.` : `A ridge looks over ${th.name}'s road. Patrols watch the way up.`;
  return { id: `d-${d}-${from.id}`, name, region: from.region, at, brief, minutes: T.detourMinutes, play, threat: { foes: 0, pursuers: d === 'scout' ? 1 : 0 } };
}

const army = (n: number, tags?: string[]): Requirement => ({ kind: 'army', count: n, ...(tags ? { tags } : {}) });
const PLAYER: Requirement = { kind: 'player', count: 1 };
const fmt = (m: number) => (m < 1 ? `${Math.round(m * 60)} s` : `${m.toFixed(1)} min`);

/** the template a way on is: what it sets going */
export function wayTemplate(c: SituationChoice): string {
  if (c.effects.some((e) => e.kind === 'evacuate')) return 'lead-out';
  if (c.effects.some((e) => e.kind === 'warn')) return 'warn';
  return 'ride';
}

/** can the town be reached from this area along the ways on */
function leadsTo(sr: SituationRun, from: string, to: string, seen = new Set<string>()): boolean {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return sr.sit.choices.some((c) => c.from === from && leadsTo(sr, c.to, to, seen));
}

/** the levy's pace on the march (world units a run minute: runsit's) */
const MARCH = LEVY_PACE;
/** minutes the levy must be at the ford before the host to hold it */
const FORD_LEAD = 0.25;

/**
 * Where the levy can meet the host's road before the host: the first point along the route ahead of the host that the
 * levy (from where it is, at its pace) reaches FORD_LEAD minutes before the host does. null: nowhere.
 */
export function fordAt(sr: SituationRun, from: V2 | undefined): { at: V2; region: number; lead: number; hostIn: number } | null {
  if (!from) return null;
  const route = sr.sit.threat.route;
  const pts = route.map((r) => sr.map.regionCentre(r));
  const prog = sr.hordeProgress();
  const T = sr.hordeArrives();
  for (let t = Math.ceil(prog * 50) / 50; t <= 0.981; t += 0.02) {
    const p = along(pts, t, sr.map.world);
    const hostIn = (t - prog) * T;
    const levyIn = Math.hypot(...delta(from, p, sr.map.world)) / MARCH;
    if (levyIn + FORD_LEAD <= hostIn) return { at: p, region: route[Math.min(route.length - 1, Math.round(t * (route.length - 1)))], lead: hostIn - levyIn, hostIn };
  }
  return null;
}

/** minutes of march from here to the nearest point of the host's road ahead of it */
function nearestMarch(sr: SituationRun, from: V2): number {
  const pts = sr.sit.threat.route.map((r) => sr.map.regionCentre(r));
  let best = Infinity;
  for (let t = sr.hordeProgress(); t <= 1; t += 0.02) best = Math.min(best, Math.hypot(...delta(from, along(pts, t, sr.map.world), sr.map.world)) / MARCH);
  return best;
}

export function holdArea(sr: SituationRun): SituationArea | undefined {
  return sr.sit.areas.find((a) => a.play.kind === 'deliver');
}

/** Every proposal of slice A's templates this turn. */
export function hordeProposals(v: HordeView): Proposal[] {
  const out: Proposal[] = [];
  const { sr } = v;
  const atEdge = sr.phase === 'edge';
  const edge = { ok: atEdge, why: atEdge ? `at ${sr.area().name}'s edge` : 'opportunities are taken at an area\'s edge' };
  const town = sr.finaleArea;

  // the outriders (forced, the start)
  const start = sr.sit.areas[0];
  const o = sr.sit.threat.outriders;
  if (start.play.kind === 'flee') {
    const fresh = sr.phase === 'area' && sr.at === start.id && sr.path.length === 0;
    out.push({
      template: 'outriders', offer: 'flee', place: start.id, title: PLAY_TITLE.flee,
      tiers: [{ requires: [PLAYER], costs: {} }],
      sense: [{ ok: fresh, why: fresh ? `the threat's ${o?.count ?? 0} outriders are on you` : 'the outriders are behind you now' }],
      parts: { theme: 1, foreshadow: 1, difficulty: 0.6, hero: 0.8 },
      at: sr.map.areaAt(start), forced: true, hooks: ['horde'],
      make: () => ({
        template: 'outriders', offer: 'flee', title: `${PLAY_TITLE.flee}`,
        pitch: start.brief, location: loc(sr, start),
        duration: { minutes: start.minutes },
        challenge: { system: 'character', play: 'flee', area: start.id, minutes: start.minutes, encounter: encounterOf(sr, start) },
        outcomes: {
          triumph: { text: 'You lost them on the road.', effects: [] },
          success: { text: 'You got clear, with riders still behind.', effects: [] },
          failure: { text: 'They ran you ragged.', effects: [] },
          disaster: { text: 'They rode you down.', effects: [] },
        },
        visibility: 'known', expires: { turn: v.turn }, forced: true,
        themes: ['flee', 'pursuit'], hooks: ['horde'],
      }),
    });
  }

  // the ways on (one per choice of the situation; the travel rule: a way on from where the hero is)
  for (const c of sr.sit.choices) {
    const to = sr.area(c.to);
    const from = sr.area(c.from);
    const here = c.from === sr.at;
    const opt = here && atEdge ? sr.options().find((x) => x.choice.id === c.id) : undefined;
    const tpl = wayTemplate(c);
    const minutes = opt ? opt.legMinutes + to.minutes : to.minutes;
    const lead = opt ? opt.hordeAt - (opt.arriveAt + (to.id === town.id ? 0 : 0)) : 0;
    out.push({
      template: tpl, offer: c.id, place: to.id, title: c.text,
      tiers: [{ requires: [PLAYER], costs: {} }],
      sense: [edge, { ok: here, why: here ? `a way on from ${from.name} (the GM's travel rule: a choice of destinations)` : `not a way on from here (from ${from.name})` }],
      parts: {
        theme: to.play.kind === 'town' ? 1 : 0.6,
        foreshadow: to.play.kind === 'town' || to.play.kind === 'deliver' ? 1 : 0.4,
        synergy: to.play.kind === 'town' && sr.reinforce ? 0.8 : 0.3,
        difficulty: opt ? (lead > 0 ? 0.8 : 0.3) : 0.5,
        hero: 0.6,
      },
      at: sr.map.areaAt(to), towardClimax: leadsTo(sr, to.id, town.id), hooks: to.play.kind === 'town' ? ['horde', 'town'] : to.play.kind === 'deliver' ? ['horde'] : [],
      make: () => wayOpp(v, c, to, minutes, opt?.note),
    });
  }

  // the detours (round 124): off the road toward the town, each once a run, leading on to where it was taken
  const T0 = v.tune;
  const here0 = sr.area();
  const passed0 = sr.at === town.id || sr.phase === 'ended';
  const fromTown = sr.sit.choices.filter((c) => c.from === sr.at).length;
  for (const d of DETOURS) {
    const area = detourArea(v, d);
    const used = v.taken.has(d) || sr.sit.areas.some((a) => a.id.startsWith(`d-${d}-`));
    const isDetour = here0.id.startsWith('d-');
    const ok = !used && !passed0 && !isDetour && fromTown > 0;
    const key = `${d}@${here0.id}`;
    const first = v.firstSeen(key);
    const minuteLeft = Math.max(0, T0.rescueMinutes - (sr.clock - first.minute));
    const legMin = 0.25 + Math.hypot(...delta(sr.map.areaAt(here0), area.at!, sr.map.world)) / 500;
    const enc = encounterOf(sr, area);
    out.push({
      template: d, offer: d, place: area.id, title: d === 'rescue' ? 'Free the captives' : d === 'chase' ? 'Run down the herald' : 'Scout the host from the ridge',
      tiers: [{ requires: [PLAYER], costs: {} }],
      sense: [edge, { ok, why: used ? `${d}: done this run` : isDetour ? 'a detour leads on, not to another' : passed0 ? 'the host is at the town' : `off the road toward ${town.name}` }],
      parts: { theme: d === 'rescue' ? 0.4 : 0.3, foreshadow: d === 'scout' ? 0.6 : 0.5, synergy: d === 'scout' && v.armyAt ? 0.9 : 0.4, difficulty: 0.6, hero: d === 'chase' ? 0.9 : 0.6 },
      at: area.at!, towardClimax: true, hooks: ['horde'],
      make: (): Made => ({
        template: d, offer: d, title: d === 'rescue' ? 'Free the captives' : d === 'chase' ? 'Run down the herald' : 'Scout the host from the ridge',
        pitch: area.brief, location: { region: area.region, at: area.at!, name: area.name },
        duration: { minutes: +(legMin + area.minutes).toFixed(2) },
        challenge: { system: 'character', play: area.play.kind, area: area.id, minutes: area.minutes, encounter: enc },
        outcomes:
          d === 'rescue'
            ? { success: { text: `${T0.rescueCaptives} freed: they stand with ${town.name}'s defenders (+${T0.rescueCaptives}).`, effects: [{ kind: 'conflict', op: 'rally', amount: T0.rescueCaptives }, { kind: 'goods', goods: { renown: 1 } }] }, failure: { text: `The captives are dragged to the host: ${T0.rescueCaptives} more dead.`, effects: [{ kind: 'conflict', op: 'swell', amount: T0.rescueCaptives }] }, disaster: { text: 'The hero fell.', effects: [] } }
            : d === 'chase'
              ? { success: { text: `The herald is down: ${T0.heraldDead} fewer of the dead rise.`, effects: [{ kind: 'conflict', op: 'thin', amount: T0.heraldDead }] }, failure: { text: `The herald got away: ${T0.heraldDead} more dead rise.`, effects: [{ kind: 'conflict', op: 'swell', amount: T0.heraldDead }] }, disaster: { text: 'The hero fell.', effects: [] } }
              : { success: { text: `The host's road is known: the ford's odds +${Math.round(T0.intel * 100)}%, its time to ${town.name} certain.`, effects: [{ kind: 'conflict', op: 'intel', amount: T0.intel }] }, failure: { text: 'The patrols drove you off the ridge: nothing learned.', effects: [] }, disaster: { text: 'The hero fell.', effects: [] } },
        visibility: 'known',
        expires: d === 'rescue' ? { turn: v.turn + 9, minute: +(sr.clock + minuteLeft).toFixed(2) } : { turn: v.turn },
        ...(d === 'rescue' ? { onExpire: { text: `The captives are taken to the host: ${T0.rescueCaptives} more dead.`, effects: [{ kind: 'conflict' as const, op: 'swell', amount: T0.rescueCaptives }] } } : d === 'chase' ? { onExpire: { text: `The herald reaches the barrows: ${T0.heraldDead} more dead rise.`, effects: [{ kind: 'conflict' as const, op: 'swell', amount: T0.heraldDead }] } } : {}),
        themes: ['travel', d], hooks: ['horde'],
      }),
    });
  }

  // the levy's opportunities (they need an army: the dealer finds none before the hold's levy is won)
  const T = v.tune;
  const passed = sr.phase === 'ended' || sr.at === town.id;
  const ford = fordAt(sr, v.armyAt);
  const fordName = ford ? regionName(sr, ford.region) : "the host's road";
  const fordOk = !passed && !!ford;
  const fordWhy = passed ? 'the host is at the town' : ford ? `the levy reaches ${fordName} ${fmt(ford.lead)} before the host (the host there in ${fmt(ford.hostIn)})` : v.armyAt ? `the levy can't reach the host's road before it passes (${fmt(nearestMarch(sr, v.armyAt))} to the nearest of it; the host at the town in ${fmt(Math.max(0, sr.hordeArrives() - sr.clock))})` : 'no army to send';
  const fordTiers: TierOffer[] = [1, 2, 3].map((n) => ({ requires: [army(n)], costs: { supplies: n } }));
  out.push({
    template: 'ford', offer: 'hold', place: ford ? `r${ford.region}` : 'road', title: `Hold the ford at ${fordName}`,
    tiers: fordTiers,
    sense: [edge, { ok: !v.taken.has('ford'), why: v.taken.has('ford') ? 'the ford is held already' : 'the ford is open' }, { ok: fordOk || !v.armyAt, why: fordWhy }],
    parts: { theme: 0.6, foreshadow: 0.9, synergy: sr.taken.length ? 0.6 : 0.3, difficulty: 0.5 },
    at: ford?.at ?? v.at, hooks: ['horde', 'route'],
    make: (tier) => {
      const base = Math.min(0.95, T.fordOdds + 0.1 * (tier - 1) + v.intel);
      const d = T.fordDelay * tier;
      const odds: Partial<Record<Tier, number>> = { triumph: base * 0.2, success: base * 0.8, cost: (1 - base) * 0.6, failure: (1 - base) * 0.4 };
      const vet = { kind: 'tag' as const, add: ['veteran'], bonuses: [{ kind: 'negate' as const, themes: ['fight'], tier: 'disaster' as Tier, why: 'veterans hold' }] };
      return {
        template: 'ford', offer: 'hold', title: `Hold the ford at ${fordName}`,
        pitch: `The host must cross at ${fordName}. Put the levy in the water and hold them there while you ride on.`,
        location: { region: ford?.region ?? sr.sit.threat.route[0], at: ford?.at ?? v.at, name: fordName },
        duration: { turns: T.fordTurns },
        odds,
        outcomes: {
          triumph: { text: `The ford ran red; the host waited ${fmt(d * 1.5)} to cross.`, effects: [{ kind: 'conflict', op: 'delay', amount: +(d * 1.5).toFixed(2) }, vet], losses: T.fordLoss * 0.4 },
          success: { text: `The ford held: the host is ${fmt(d)} late.`, effects: [{ kind: 'conflict', op: 'delay', amount: d }, vet], losses: T.fordLoss },
          cost: { text: `The ford held a while, dearly: the host ${fmt(d * 0.75)} late.`, effects: [{ kind: 'conflict', op: 'delay', amount: +(d * 0.75).toFixed(2) }, vet], losses: Math.min(1, T.fordLoss * 2) },
          failure: { text: 'The ford broke at the first rush.', effects: [], losses: Math.min(1, T.fordLoss * 3) },
        },
        visibility: 'known', expires: { turn: v.turn, ...(ford ? { minute: +(sr.clock + ford.hostIn).toFixed(2) } : {}) },
        themes: ['fight', 'delay'], hooks: ['horde', 'route'],
      } satisfies Made;
    },
  });

  // the harvest (at the hold's fields; the hold is where the levy is won, so it's offered there)
  const hold = holdArea(sr);
  if (hold) {
    const hAt = sr.map.areaAt(hold);
    const fieldsAt: V2 = [hAt[0] + 60, hAt[1] + 60];
    const ok = v.harvest === 'open' && !passed;
    out.push({
      template: 'harvest', offer: 'bring-in', place: `r${hold.region}`, title: `Bring in the harvest at ${hold.name}`,
      tiers: [1, 2].map((n) => ({ requires: [army(n)], costs: {} })),
      sense: [edge, { ok, why: v.harvest === 'rotted' ? 'the harvest rotted in the fields' : v.harvest === 'taken' ? 'the harvest is in' : ok ? `${hold.name}'s fields stand ripe` : 'the host is at the town' }],
      parts: { theme: 0.8, foreshadow: 0.5, synergy: 0.5, difficulty: 0.9 },
      at: fieldsAt, hooks: ['town'],
      make: (tier): Made => ({
        template: 'harvest', offer: 'bring-in', title: `Bring in the harvest at ${hold.name}`,
        pitch: `${hold.name}'s fields are ripe and the host will forage them. Bring the grain in and ${town.name}'s defenders eat; leave it and it rots.`,
        location: { region: hold.region, settlement: hold.settlement, at: fieldsAt, name: `${hold.name}'s fields` },
        duration: { turns: T.harvestTurns },
        odds: { success: 0.85, cost: 0.15 },
        outcomes: {
          success: { text: `The grain is in: ${T.harvestSupplies * tier} supplies.`, effects: [{ kind: 'goods', goods: { supplies: T.harvestSupplies * tier } }] },
          cost: { text: `Half the grain is in before the rain: ${Math.floor((T.harvestSupplies * tier) / 2)} supplies.`, effects: [{ kind: 'goods', goods: { supplies: Math.floor((T.harvestSupplies * tier) / 2) } }], losses: 0.1 },
        },
        visibility: 'known', expires: { turn: Math.max(v.turn, v.firstSeen(`harvest@${hold.id}`).turn + T.harvestExpiry - 1) },
        onExpire: { text: `The grain rots in ${hold.name}'s fields; the host forages and comes on ${fmt(T.rot)} sooner.`, effects: [{ kind: 'conflict', op: 'hasten', amount: T.rot }] },
        themes: ['harvest', 'labour'], hooks: ['town'],
      }),
    });
  }

  // the vanguard (a tag opportunity: only veterans are offered it)
  const hostAt = sr.hordeAt();
  const vOk = !passed && (!!ford || !v.armyAt) && !v.taken.has('vanguard');
  out.push({
    template: 'vanguard', offer: 'break', place: 'host', title: 'Break the host\'s vanguard',
    tiers: [{ requires: [army(1, ['veteran'])], costs: {} }],
    sense: [edge, { ok: vOk, why: vOk ? (ford ? `the levy can meet the host's head at ${fordName}` : 'no army to send') : v.taken.has('vanguard') ? 'the vanguard is broken already' : "the levy can't reach the host before it is at the town" }],
    parts: { theme: 0.7, foreshadow: 1, synergy: 0.5, difficulty: 0.4 },
    at: hostAt, hooks: ['horde'],
    make: (): Made => ({
      template: 'vanguard', offer: 'break', title: 'Break the host\'s vanguard',
      pitch: `Veterans know how the dead march. Strike the head of the host and fewer of them reach ${town.name}.`,
      location: { region: ford?.region ?? sr.sit.threat.route[0], at: ford?.at ?? hostAt, name: `${sr.sit.threat.name}'s vanguard` },
      duration: { turns: 1 },
      odds: { success: 0.6, cost: 0.3, failure: 0.1 },
      outcomes: {
        success: { text: `The vanguard is broken: ${T.vanguardThin} fewer of the dead.`, effects: [{ kind: 'conflict', op: 'thin', amount: T.vanguardThin }], losses: 0.2 },
        cost: { text: `The vanguard bled them: ${Math.ceil(T.vanguardThin / 2)} fewer of the dead.`, effects: [{ kind: 'conflict', op: 'thin', amount: Math.ceil(T.vanguardThin / 2) }], losses: 0.4 },
        failure: { text: 'The dead closed round them.', effects: [], losses: 0.6 },
      },
      visibility: 'known', expires: { turn: v.turn },
      themes: ['fight'], hooks: ['horde'],
    }),
  });
  return out;
}

function loc(sr: SituationRun, a: SituationArea): Opportunity['location'] {
  return { region: a.region, settlement: a.settlement, at: sr.map.areaAt(a), name: a.name };
}

function regionName(sr: SituationRun, r: number): string {
  const a = sr.sit.areas.find((x) => x.region === r);
  if (a) return a.name;
  return r === sr.sit.refuge.region ? sr.sit.refuge.name : `region ${r}`;
}

/** a way on as a player opportunity: travel there and play its area */
function wayOpp(v: HordeView, c: SituationChoice, to: SituationArea, minutes: number, note?: string): Made {
  const sr = v.sr;
  const sets = c.effects.map((e) => (e.kind === 'warn' ? `${sr.sit.target.name} warned` : e.kind === 'evacuate' ? `its people led into ${sr.sit.refuge.name}` : `the host slowed ${fmt(e.minutes)}`));
  const p = to.play;
  const outcomes: Partial<Record<Tier, OppOutcome>> = {
    success: { text: `${to.name}: ${PLAY_TITLE[p.kind].toLowerCase()} — done.${sets.length ? ` ${sets.join('; ')}.` : ''}`, effects: [] },
    failure: { text: `${to.name}: it went badly.`, effects: [] },
    disaster: { text: 'The hero fell.', effects: [] },
  };
  if (p.kind === 'deliver') {
    const holdId = p.settlement;
    const supplies: Goods = { supplies: v.tune.holdSupplies };
    outcomes.success = {
      text: `The word is carried: ${to.name}'s levy (${p.sends.count} ${p.sends.role}s) is yours to command, and ${v.tune.holdSupplies} supplies.${sets.length ? ` ${sets.join('; ')}.` : ''}`,
      effects: [
        { kind: 'agent', agent: { id: 'levy', kind: 'army', name: `the levy of ${to.name}`, character: `levy:${holdId}`, count: p.sends.count, tags: [], statuses: [], at: { with: 'player' } } },
        { kind: 'goods', goods: supplies },
      ],
    };
    outcomes.failure = { text: `${to.name}'s hall didn't hear you in time: no levy.`, effects: [] };
  }
  if (p.kind === 'town') outcomes.success = { text: `${to.name}: the climax.${sets.length ? ` ${sets.join('; ')}.` : ''}`, effects: [] };
  return {
    template: wayTemplate(c), offer: c.id, title: c.text,
    pitch: `${to.brief}${note ? ` (${note})` : ''}`,
    location: loc(sr, to),
    duration: { minutes: +minutes.toFixed(2) },
    challenge: { system: 'character', play: p.kind, area: to.id, minutes: to.minutes, encounter: encounterOf(sr, to, c.effects.some((e) => e.kind === 'evacuate')) },
    outcomes,
    visibility: 'known', expires: { turn: v.turn },
    ...(p.kind === 'town' ? { climax: true } : {}),
    themes: ['travel', p.kind], hooks: p.kind === 'town' ? ['horde', 'town'] : p.kind === 'deliver' ? ['horde'] : [],
  };
}

/** the world distance (the torus's) */
export function distOn(sr: SituationRun): (a: V2, b: V2) => number {
  return (a, b) => Math.hypot(...delta(a, b, sr.map.world));
}
