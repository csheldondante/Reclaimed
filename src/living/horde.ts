// ---- living/horde.ts ----------------------------------------------------------------------------------------------
// (merge124) Slice A — the horde comes for the town — as living templates. The user (DECISIONS round 125): "Please
// proceed with getting it ready to merge into our run structure for now." Before this merge the run dealt from its own
// template path (src/opps/horde.ts, proposals made in code); now its cards are templates of the living engine
// (engine.ts) like the inspector's, bound to the atlas world's real entities: the town the dead come for, the hold that
// keeps a levy (the Red Hold on seed 1's GM situation), the factions, the run's locus and the cast of named people who
// present the cards. One engine, one dealer (opps/dealer.ts), one oppcheck (gm/oppcheck.ts checkLiving).
//
// The run's conflict is a Stage (dsl.ts): the situation run (runsit/state.ts SituationRun: the clock, where the hero is,
// the host on its road, the town's fate, the finale) owns it; the stage stages it in the fact layer — the host as an
// army, the situation's areas as sites, its ways on as routes, the hold's fields — and registers the helpers the
// templates name: predicates over the run (atEdge, fordReach …), the conflict's operations as effects (delay, thin,
// rally …), and what a card needs of the run (vars, odds, challenge, expiry, locate). Run scaffolding is removed when
// the run ends (unstage); what it did stays in the history and the world.
// The cards (the user, rounds 120 and 124: every player card an encounter with enemies; travel as opportunities):
//   outriders  the run's start: the threat's riders are on the hero — forced, dealt alone
//   ride / warn / lead-out / muster   the ways on at an area's edge, one per situation choice (muster: carry the word to
//              the hold — its reward the levy, an army agent the world remembers, and supplies)
//   rescue / scout / chase   the detours: a new area off the road that leads on to the same places
//   ford       hold the ford on the host's road: army 1/2/3 (+ supplies), rolled; the survivors come back veterans
//   harvest    bring in the hold's harvest: army 1/2, supplies for the town's defenders; let it go and it rots
//   vanguard   only for veterans: break the host's vanguard

import type { EntityId } from '../api/contracts/facts';
import type { BonusRecord, Encounter, Tier } from '../api/contracts/opportunity';
import type { SituationArea, SituationChoice } from '../api/contracts/situation';
import { along, delta, LEVY_PACE, PLAY_TITLE, type SituationRun, type V2 } from '../runsit/state';
import type { HordeTune } from '../opps/tune';
import type { Ctx, Helper, Stage } from './dsl';
import type { TemplateDef } from './engine';
import type { FactWorld } from './world';
import { capitalise } from './plain';

/** what a levy that has stood in a fight carries (the ford's tag, a saved town): a disaster on a fight lifted */
export const VETERANS: BonusRecord = { why: 'veterans hold', on: 'resolve', themes: ['fight'], effect: { kind: 'negate', tier: 'disaster' } };
/** what the conflict is about (the dealer's "tied to the conflict") */
export const HORDE_HOOKS = ['horde', 'town'];
/** the conflict's own operations (the `conflict` helper's) */
export const CONFLICT_OPS = ['delay', 'hasten', 'thin', 'swell', 'rally', 'intel'] as const;
/** the detours: a new area off the road toward the town, leading on to the same places as where it was taken */
export const DETOURS = ['rescue', 'scout', 'chase'] as const;
export type Detour = (typeof DETOURS)[number];
const DETOUR_AT: Record<Detour, number> = { rescue: 0.3, chase: 0.45, scout: 0.6 };
/** minutes the levy must be at the ford before the host to hold it */
const FORD_LEAD = 0.25;

/** minutes as the player reads them (docs/WRITING.md) */
const fmt = (m: number) => (m < 1 ? `${Math.round(m * 60)} seconds` : `${+m.toFixed(1)} minute${+m.toFixed(1) === 1 ? '' : 's'}`);

/** the template a way on is: what it sets going */
export function wayTemplate(c: SituationChoice, to: SituationArea): string {
  if (c.effects.some((e) => e.kind === 'evacuate')) return 'lead-out';
  if (c.effects.some((e) => e.kind === 'warn')) return 'warn';
  if (to.play.kind === 'deliver') return 'muster';
  return 'ride';
}

/**
 * (round 124) The encounter an area is: its play, with the threat in it (its own foes and pursuers, the area's
 * `threat`, the outriders still on the hero). Every player card shows it; a Node test holds that none is empty.
 */
export function encounterOf(sr: SituationRun, a: SituationArea, evacuate = false): Encounter {
  const p = a.play;
  const x = a.threat ?? { foes: 0, pursuers: 0 };
  const behind = (sr.pursuers?.count ?? 0) + x.pursuers;
  const th = sr.sit.threat;
  // (dialog2: whole sentences in plain words — the petition's Takes row shows them as they are)
  const tail = behind === 1 ? ' One more is behind you.' : behind ? ` ${behind} more are behind you.` : '';
  switch (p.kind) {
    case 'flee':
      return { kind: 'flee', foes: 0, pursuers: (th.outriders?.count ?? 0) + x.pursuers, text: `${(th.outriders?.count ?? 0) + x.pursuers} riders are on your trail. Get away, or cut them down.` };
    case 'ambush':
      return { kind: 'ambush', foes: p.foes + x.foes, pursuers: behind, text: `${p.foes + x.foes} ${p.role} wait in the road.${tail}` };
    case 'deliver':
      return { kind: 'gauntlet', foes: x.foes, pursuers: behind, text: `${x.foes} ${th.role} stand between you and the hall. You have ${Math.round(p.limit)} seconds to get the word in.${tail}` };
    case 'trader':
      return { kind: 'skirmish', foes: x.foes, pursuers: behind, text: `${x.foes} ${th.role} surround the trader. Drive them off, and the trader will deal.${tail}` };
    case 'chase':
      return { kind: 'chase', foes: p.quarry, pursuers: behind, text: `${p.quarry} ${p.role} are running, a few seconds ahead. Catch them all before they get away.${tail}` };
    case 'rescue':
      return { kind: 'rescue', foes: p.guards, pursuers: behind, text: `${p.guards} ${p.role} guard ${p.captives} captives. Beat the guards, then lead the captives out.${tail}` };
    case 'scout':
      return { kind: 'patrol', foes: p.patrols * 2, pursuers: behind, text: `${p.patrols * 2} ${p.role} patrol the way to the lookout.${tail}` };
    case 'town': {
      const n = Math.max(1, th.count - sr.thinned);
      return evacuate
        ? { kind: 'evacuate', foes: 0, pursuers: behind, horde: n, text: `${n} of ${th.name} are coming for the town. Lead its people out to ${sr.sit.refuge.name} before they are caught.` }
        : { kind: 'defend', foes: 0, pursuers: behind, horde: n, text: `${n} of ${th.name} are coming for the town. Hold it, or it burns.` };
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

/** a detour's area from where the hero is: on land the situation already knows (the refuge's hills for the captives'
 *  camp, the host's own road for the herald and the lookout) */
export function detourArea(sr: SituationRun, T: HordeTune, d: Detour): SituationArea {
  const from = sr.area();
  const a = sr.map.areaAt(from);
  const th = sr.sit.threat;
  const route = th.route.map((r) => ({ r, at: sr.map.regionCentre(r) }));
  const nearest = route.reduce((b, x) => (Math.hypot(...delta(a, x.at, sr.map.world)) < Math.hypot(...delta(a, b.at, sr.map.world)) ? x : b), route[0]);
  const mid = route[Math.min(route.length - 1, Math.floor(route.length * DETOUR_AT[d]))];
  const pick = d === 'rescue' ? { r: sr.sit.refuge.region, at: sr.map.regionCentre(sr.sit.refuge.region) } : d === 'chase' ? nearest : mid;
  const at: [number, number] = [pick.at[0], pick.at[1]];
  const play: SituationArea['play'] =
    d === 'rescue' ? { kind: 'rescue', captives: T.rescueCaptives, guards: T.rescueGuards, role: th.role, faction: th.faction }
    : d === 'chase' ? { kind: 'chase', quarry: T.chaseQuarry, role: th.role, faction: th.faction, escape: 0 }
    : { kind: 'scout', patrols: T.patrols, role: th.role, faction: th.faction };
  const name = d === 'rescue' ? `the camp in ${sr.sit.refuge.name}` : d === 'chase' ? `the herald's road` : `the ridge over ${th.name}`;
  const brief = d === 'rescue' ? `Riders of ${th.name} hold people taken from the roads. Free them, and they will fight for ${sr.sit.target.name}.` : d === 'chase' ? `${capitalise(th.name)}'s herald rides to the barrows to wake more dead. It is a few seconds ahead of you.` : `A ridge looks over the road of ${th.name}. Patrols watch the way up.`;
  return { id: `d-${d}-${from.id}`, name, region: pick.r, at, brief, minutes: T.detourMinutes, play, threat: { foes: 0, pursuers: d === 'scout' ? 1 : 0 } };
}

export function holdArea(sr: SituationRun): SituationArea | undefined {
  return sr.sit.areas.find((a) => a.play.kind === 'deliver');
}

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
    const levyIn = Math.hypot(...delta(from, p, sr.map.world)) / LEVY_PACE;
    if (levyIn + FORD_LEAD <= hostIn) return { at: p, region: route[Math.min(route.length - 1, Math.round(t * (route.length - 1)))], lead: hostIn - levyIn, hostIn };
  }
  return null;
}

/** minutes of march from here to the nearest point of the host's road ahead of it */
function nearestMarch(sr: SituationRun, from: V2): number {
  const pts = sr.sit.threat.route.map((r) => sr.map.regionCentre(r));
  let best = Infinity;
  for (let t = sr.hordeProgress(); t <= 1; t += 0.02) best = Math.min(best, Math.hypot(...delta(from, along(pts, t, sr.map.world), sr.map.world)) / LEVY_PACE);
  return best;
}

/** where an army is now: marching for the town from where it was freed (its `march`, kept on the agent), else with the
 *  player */
export function armyNow(sr: SituationRun, a: { march?: { from: [number, number]; since: number } }, here: V2): V2 {
  const m = a.march;
  if (!m) return here;
  const town = sr.map.areaAt(sr.finaleArea);
  const [dx, dy] = delta(m.from, town, sr.map.world);
  const l = Math.hypot(dx, dy);
  const k = l > 0 ? Math.min(1, ((sr.clock - m.since) * LEVY_PACE) / l) : 0;
  return [m.from[0] + dx * k, m.from[1] + dy * k];
}

// ---- the stage ------------------------------------------------------------------------------------------------------

/**
 * The horde's stage: the situation run's conflict as the templates see it. It stages the run in the fact layer (ids
 * under `run:<situation>:`), keeps the conflict's own numbers (what the lookout taught, the freed who stand with the
 * town), and answers the templates' helpers.
 */
export class HordeStage implements Stage {
  readonly helpers: Record<string, Helper>;
  /** what scouting has learned (added to the ford's odds), and the freed who stand with the town */
  intel = 0;
  rallied = 0;
  /** the turn a card at a place was first shown (its expiry counts from there): set by its setup, once */
  readonly seen = new Map<string, { turn: number; minute: number }>();
  /** detours let go (their consequence happened: not offered again) */
  readonly lapsed = new Set<Detour>();
  readonly log: string[] = [];
  readonly prefix: string;
  /** the run's locus and who speaks for it (seed.ts) */
  voice: EntityId = '';

  constructor(
    readonly sr: SituationRun,
    readonly tune: () => HordeTune,
  ) {
    this.prefix = `run:${sr.sit.id}`;
    this.helpers = this.makeHelpers();
  }

  get sit() {
    return this.sr.sit;
  }
  id(x: string): EntityId {
    return `${this.prefix}:${x}`;
  }
  /** the area a staged site is */
  areaOf(w: FactWorld, site: EntityId): SituationArea | undefined {
    const a = w.facts.entity(site)?.attrs.area;
    return typeof a === 'string' ? (this.sr.sit.areas.find((x) => x.id === a) ?? this.detours.get(a)) : undefined;
  }
  /** the detours made from the area the hero is at (their areas, before one is played) */
  readonly detours = new Map<string, SituationArea>();

  /** the run in the fact layer: the host, the areas, the ways on, the hold's fields */
  stage(w: FactWorld): void {
    const f = w.facts;
    const sr = this.sr;
    const sit = sr.sit;
    const th = sit.threat;
    const host = this.id('host');
    // (who speaks for the run's locus, the town the host comes for and the hold, marked so a card binds them by their
    // tag: an index, not a search of every faction and settlement)
    const mark = (id: string | undefined, key: string) => {
      if (id && f.entity(id) && f.tag(id, 'condition', key)?.value !== sit.id) f.setTag(id, 'condition', key, sit.id, sit.id);
    };
    mark(this.voice, 'voice_of');
    mark(sit.target.settlement, 'target_of');
    mark(holdArea(sr)?.settlement, 'hold_of');
    if (!f.entity(host)) {
      f.add({ id: host, kind: 'army', name: th.name, at: { region: th.route[0] }, attrs: { role: th.role, count: th.count }, tags: [{ scope: 'condition', key: 'host_of', value: sit.id, since: f.turn }], cause: sit.id });
      // (the host belongs to its faction: an entity of it made if the save has none — WorldState holds its record)
      if (!f.entity(th.faction)) f.add({ id: th.faction, kind: 'faction', name: w.ws.faction(th.faction)?.name ?? th.name, ...(w.ws.faction(th.faction) ? { ref: { faction: th.faction } } : {}), cause: sit.id });
      f.relate({ type: 'member_of', from: host, to: th.faction, cause: sit.id });
      f.record({ kind: 'host-rises', by: [host], to: [sit.target.settlement].filter((x) => f.entity(x)), where: { region: th.route[0] }, note: `${th.name} rises and marches for ${sit.target.name}` });
    }
    for (const a of sit.areas) this.stageArea(w, a);
    for (const c of sit.choices) {
      const id = this.id(`way:${c.id}`);
      if (f.entity(id)) continue;
      const to = sr.area(c.to);
      f.add({ id, kind: 'route', name: c.text, at: { region: to.region }, tags: [{ scope: 'economy', key: 'way', value: wayTemplate(c, to), since: f.turn }], attrs: { choice: c.id, from: c.from, to: c.to }, cause: sit.id });
    }
    const hold = holdArea(sr);
    const fields = this.id('fields');
    if (hold && !f.entity(fields)) {
      const hAt = sr.map.areaAt(hold);
      f.add({ id: fields, kind: 'site', name: `${hold.name}'s fields`, at: { region: hold.region, ...(hold.settlement && f.entity(hold.settlement) ? { settlement: hold.settlement } : {}), at: [hAt[0] + 60, hAt[1] + 60] }, tags: [{ scope: 'economy', key: 'harvest', value: 'ripe', since: f.turn }, { scope: 'economy', key: 'farm', value: true, since: f.turn }], attrs: { of: hold.id }, cause: sit.id });
    }
  }

  private stageArea(w: FactWorld, a: SituationArea): EntityId {
    const f = w.facts;
    const id = this.id(a.id);
    if (!f.entity(id)) {
      const at = this.sr.map.areaAt(a);
      const tags = a.id.startsWith('d-') ? [{ scope: 'economy' as const, key: 'detour', value: a.id.split('-')[1], since: f.turn }] : a.id === this.sit.areas[0].id ? [{ scope: 'condition' as const, key: 'start_of', value: this.sit.id, since: f.turn }] : [];
      f.add({ id, kind: 'site', name: a.name, at: { region: a.region, ...(a.settlement && f.entity(a.settlement) ? { settlement: a.settlement } : {}), at: [at[0], at[1]] }, attrs: { area: a.id, play: a.play.kind }, tags, cause: this.sit.id });
    }
    return id;
  }

  /** at an area's edge: the detours from here staged (each its site, before one is played) */
  refresh(w: FactWorld): void {
    if (this.sr.phase !== 'edge') return;
    for (const d of DETOURS) {
      const a = detourArea(this.sr, this.tune(), d);
      this.detours.set(a.id, a);
      this.stageArea(w, a);
    }
  }

  /** a run's scaffolding left by a run that never ended (a hero chosen again, a run abandoned): cleared before a new
   *  one stages — a run's entities never outlive it */
  static clear(w: FactWorld): void {
    for (const e of w.facts.find({})) if (e.id.startsWith('run:')) w.facts.remove(e.id, 'a new run');
    for (const key of ['voice_of', 'target_of', 'hold_of'])
      for (const e of w.facts.find({ tag: { scope: 'condition', key } })) w.facts.dropTag(e.id, 'condition', key);
  }

  /** the run is over: its scaffolding (the host, the areas, the ways, the fields) leaves the fact layer — what it did
   *  stays in the history and the world */
  unstage(w: FactWorld): void {
    for (const e of w.facts.find({})) if (e.id.startsWith(`${this.prefix}:`)) w.facts.remove(e.id, `${this.sit.id}: over`);
    for (const [id, key] of [[this.voice, 'voice_of'], [this.sit.target.settlement, 'target_of'], [holdArea(this.sr)?.settlement, 'hold_of']] as const)
      if (id && w.facts.entity(id) && w.facts.tag(id, 'condition', key)) w.facts.dropTag(id, 'condition', key);
  }

  /** the conflict's operations on the situation */
  conflict(op: string, amount: number): void {
    const sr = this.sr;
    if (op === 'delay') sr.delay += amount;
    else if (op === 'hasten') sr.delay -= amount;
    else if (op === 'thin') sr.thinned += amount;
    else if (op === 'swell') sr.thinned -= amount;
    else if (op === 'rally') this.rallied += amount;
    else if (op === 'intel') this.intel += amount;
    else throw new Error(`the horde: no conflict operation ${op}`);
    this.log.push(`the host: ${op} ${+amount.toFixed(2)}`);
  }

  /** where the player is (world units) */
  at(): V2 {
    return this.sr.map.areaAt(this.sr.area());
  }

  /** a free army's place now (from its own march), if one is held */
  armyAt(w: FactWorld): V2 | undefined {
    const a = w.holdings.agents.find((x) => x.kind === 'army' && !x.committed && !x.statuses.includes('wounded'));
    return a ? armyNow(this.sr, a, this.at()) : undefined;
  }

  private passed(): boolean {
    return this.sr.phase === 'ended' || this.sr.at === this.sr.finaleArea.id;
  }

  private makeHelpers(): Record<string, Helper> {
    const sr = this.sr;
    const T = () => this.tune();
    const site = (c: Ctx, r: unknown) => {
      const id = String(r).startsWith('$') ? c.b[String(r).slice(1)] : String(r);
      const a = this.areaOf(c.w, id);
      if (!a) throw new Error(`the horde: ${id} is no area of the run`);
      return a;
    };
    const wayOf = (c: Ctx, r: unknown) => {
      const id = String(r).startsWith('$') ? c.b[String(r).slice(1)] : String(r);
      const ch = String(c.w.facts.entity(id)?.attrs.choice ?? '');
      const way = sr.sit.choices.find((x) => x.id === ch);
      if (!way) throw new Error(`the horde: ${id} is no way on of the run`);
      return way;
    };
    const idOf = (c: Ctx, r: unknown) => (String(r).startsWith('$') ? c.b[String(r).slice(1)] : String(r));
    return {
      // ---- predicates over the run ----
      atEdge: { pred: () => sr.phase === 'edge', text: () => (sr.phase === 'edge' ? `at ${sr.area().name}'s edge` : "cards are taken at an area's edge") },
      freshStart: { pred: () => sr.phase === 'area' && sr.at === sr.sit.areas[0].id && sr.path.length === 0, text: () => `the threat's ${sr.sit.threat.outriders?.count ?? 0} outriders are on you, at the start` },
      isStart: { pred: (c, [s]) => this.areaOf(c.w, idOf(c, s))?.id === sr.sit.areas[0].id, text: () => 'where the run starts' },
      isHost: { pred: (c, [h]) => idOf(c, h) === this.id('host'), text: () => "the threat's host" },
      isVoice: { pred: (c, [v]) => idOf(c, v) === this.voice, text: (c) => `who speaks for the run's locus (${c.w.name(this.voice)})` },
      notPassed: { pred: () => !this.passed(), text: () => 'the host is not at the town yet' },
      worldFaction: { pred: (c, [x]) => !!c.w.ws.faction(idOf(c, x)), text: (c, [x]) => `${c.w.name(idOf(c, x))} is a faction of the world` },
      fromHere: { pred: (c, [x]) => wayOf(c, x).from === sr.at, text: (c, [x]) => `a way on from here (the GM's travel rule: a choice of destinations; ${c.w.name(idOf(c, x))})` },
      leadsTo: { pred: (c, [x, s]) => wayOf(c, x).to === this.areaOf(c.w, idOf(c, s))?.id, text: () => 'where the way leads' },
      offHere: {
        pred: (c, [s]) => this.areaOf(c.w, idOf(c, s))?.id.endsWith(`-${sr.at}`) ?? false,
        text: () => `a detour off the road from ${sr.area().name}`,
      },
      detourOpen: {
        pred: (c, [k]) => {
          const d = String(k) as Detour;
          const used = sr.sit.areas.some((a) => a.id.startsWith(`d-${d}-`)) || this.lapsed.has(d);
          return !used && !this.passed() && !sr.at.startsWith('d-') && sr.sit.choices.some((x) => x.from === sr.at);
        },
        text: (c, [k]) => `the ${String(k)} is open (not done this run, not from a detour, the host not at the town)`,
      },
      fordReach: {
        pred: (c) => !!fordAt(sr, this.armyAt(c.w)),
        text: (c) => {
          const from = this.armyAt(c.w);
          const ford = fordAt(sr, from);
          return ford
            ? `the levy can meet the host's road (${fmt(ford.lead)} before the host; the host there in ${fmt(ford.hostIn)})`
            : from
              ? `the levy can meet the host's road before it passes (it can't reach the host's road before it passes: ${fmt(nearestMarch(sr, from))} to the nearest of it; the host at the town in ${fmt(Math.max(0, sr.hordeArrives() - sr.clock))})`
              : 'an army to send';
        },
      },
      vanguardReach: {
        pred: (c) => !this.armyAt(c.w) || !!fordAt(sr, this.armyAt(c.w)),
        text: () => "the levy can meet the host's head before it is at the town",
      },
      // ---- the conflict's operations (the run's, never a dry run's) ----
      conflict: {
        effect: (c, [op, by, mult, perTier]) => {
          if (c.dry) return;
          const base = typeof by === 'number' ? by : ((T() as Record<string, number>)[String(by)] ?? c.vars?.[String(by)]);
          if (typeof base !== 'number') throw new Error(`the horde: no number ${String(by)}`);
          this.conflict(String(op), +(base * Number(mult ?? 1) * (Number(perTier ?? 0) ? (c.tier ?? 1) : 1)).toFixed(2));
        },
        text: (c, [op, by]) => `the host: ${String(op)} (${String(by)})`,
      },
      closeDetour: {
        effect: (c, [k]) => {
          if (!c.dry) this.lapsed.add(String(k) as Detour);
        },
      },
      /** a card first shown (its setup, once): its expiry counts from now — markSeen(template, its place's binding) */
      markSeen: {
        effect: (c, [k, b]) => {
          if (c.dry) return;
          const key = `${String(k)}@${c.b[String(b)]}`;
          if (!this.seen.has(key)) this.seen.set(key, { turn: c.w.turn, minute: sr.clock });
        },
      },
      // ---- what a card needs of the run ----
      horde: {
        vars: (c) => {
          const t = T();
          const tier = c.tier ?? 1;
          const th = sr.sit.threat;
          const town = sr.finaleArea;
          const hold = holdArea(sr);
          const v: Record<string, string | number> = {
            host: th.name,
            role: th.role,
            outriders: th.outriders?.count ?? 0,
            townName: town.name,
            refuge: sr.sit.refuge.name,
            holdName: hold?.name ?? 'the hold',
            holdId: hold?.settlement ?? 'hold',
            holdSupplies: t.holdSupplies,
            levyCount: hold?.play.kind === 'deliver' ? hold.play.sends.count : 0,
            levyRole: hold?.play.kind === 'deliver' ? hold.play.sends.role : 'soldier',
            rescueCaptives: t.rescueCaptives,
            heraldDead: t.heraldDead,
            intelPct: Math.round(t.intel * 100),
            harvestYield: t.harvestSupplies * tier,
            harvestHalf: Math.floor((t.harvestSupplies * tier) / 2),
            rot: fmt(t.rot),
            fordDelay: fmt(t.fordDelay * tier),
            fordDelayHi: fmt(t.fordDelay * tier * 1.5),
            fordDelayLo: fmt(t.fordDelay * tier * 0.75),
            fordLossHi: +(t.fordLoss * 0.4).toFixed(3),
            fordLoss: t.fordLoss,
            fordLossCost: Math.min(1, t.fordLoss * 2),
            fordLossFail: Math.min(1, t.fordLoss * 3),
            vanguardThin: t.vanguardThin,
            vanguardHalf: Math.ceil(t.vanguardThin / 2),
            harvestTurns: t.harvestTurns,
            fordTurns: t.fordTurns,
            towerDefenders: t.towerDefenders,
            weirFactor: t.weirFactor,
            weirPct: Math.round(t.weirFactor * 100),
            weirDelay: fmt(t.weirDelay),
            shelterShare: t.shelterShare,
            shelterPct: Math.round(t.shelterShare * 100),
          };
          const ford = fordAt(sr, this.armyAt(c.w));
          v.fordName = ford ? this.regionName(ford.region) : 'the road';
          const wayId = c.b.way;
          if (wayId) {
            const way = wayOf(c, '$way');
            v.choice = way.id;
            v.wayText = way.text;
            // (dialog2: what the way sets going, as whole sentences)
            const sets = way.effects.map((e) => (e.kind === 'warn' ? `${sr.sit.target.name} is warned.` : e.kind === 'evacuate' ? `Its people will go to ${sr.sit.refuge.name}.` : `The dead are slowed by ${fmt(e.minutes)}.`));
            v.sets = sets.length ? ` ${sets.join(' ')}` : '';
            const opt = sr.phase === 'edge' && way.from === sr.at ? sr.options().find((x) => x.choice.id === way.id) : undefined;
            v.note = opt ? ` ${opt.note}` : '';
          }
          return v;
        },
      },
      fordOdds: {
        odds: (c): Partial<Record<Tier, number>> => {
          const base = Math.min(0.95, T().fordOdds + 0.1 * ((c.tier ?? 1) - 1) + this.intel);
          return { triumph: base * 0.2, success: base * 0.8, cost: (1 - base) * 0.6, failure: (1 - base) * 0.4 };
        },
      },
      challenge: {
        challenge: (c, [r]) => {
          const a = site(c, r);
          const way = c.b.way ? wayOf(c, '$way') : undefined;
          let minutes = a.minutes;
          if (way && way.from === sr.at && sr.phase === 'edge') {
            const opt = sr.options().find((x) => x.choice.id === way.id);
            if (opt) minutes = opt.legMinutes + a.minutes;
          } else if (a.id.startsWith('d-')) minutes = 0.25 + Math.hypot(...delta(this.at(), a.at!, sr.map.world)) / 500 + a.minutes;
          const evac = !!way?.effects.some((e) => e.kind === 'evacuate');
          return { challenge: { system: 'character', play: a.play.kind, area: a.id, minutes: a.minutes, encounter: encounterOf(sr, a, evac) }, minutes };
        },
      },
      thisTurn: { expiry: (c) => ({ turn: c.w.turn }) },
      rescueExpiry: {
        expiry: (c) => {
          const key = `rescue@${c.b.detour}`;
          const first = this.seen.get(key) ?? { turn: c.w.turn, minute: sr.clock };
          const left = Math.max(0, T().rescueMinutes - (sr.clock - first.minute));
          return { turn: c.w.turn + 9, minute: +(sr.clock + left).toFixed(2) };
        },
      },
      harvestExpiry: {
        expiry: (c) => {
          const first = this.seen.get(`harvest@${c.b.fields}`) ?? { turn: c.w.turn, minute: sr.clock };
          return { turn: Math.max(c.w.turn, first.turn + T().harvestExpiry - 1) };
        },
      },
      fordExpiry: {
        expiry: (c) => {
          const ford = fordAt(sr, this.armyAt(c.w));
          return { turn: c.w.turn, ...(ford ? { minute: +(sr.clock + ford.hostIn).toFixed(2) } : {}) };
        },
      },
      fordLocate: {
        locate: (c) => {
          const ford = fordAt(sr, this.armyAt(c.w));
          const at = ford?.at ?? this.at();
          return { region: ford?.region ?? sr.sit.threat.route[0], at: [at[0], at[1]], name: ford ? this.regionName(ford.region) : 'the road' };
        },
      },
      vanguardLocate: {
        locate: (c) => {
          const ford = fordAt(sr, this.armyAt(c.w));
          const at = ford?.at ?? sr.hordeAt();
          return { region: ford?.region ?? sr.sit.threat.route[0], at: [at[0], at[1]], name: `the front of ${sr.sit.threat.name}` };
        },
      },
    };
  }

  regionName(r: number): string {
    const a = this.sit.areas.find((x) => x.region === r);
    if (a) return a.name;
    if (r === this.sit.refuge.region) return this.sit.refuge.name;
    // (dialog2: the region's own name — never "region 2141" on a card)
    return this.sr.map.regionName?.(r) || 'the road';
  }
}

// ---- the templates (data) -------------------------------------------------------------------------------------------
// (dialog2) Every line a player reads is plain words: docs/WRITING.md, checked by test/unit/writing.test.ts. A
// presenter's `line` is the ask, `gain` their answer to "What's in it for me?", `refuse` to "What if I say no?"; their
// voice wraps them (living/cast.ts). The reward is concrete things.

const PLAYER = { kind: 'player' as const, count: 1 };
const army = (n: number, tags?: string[]) => ({ kind: 'army' as const, count: n, ...(tags ? { tags } : {}) });
// (the run's own entities are found by their marks — an index — never by searching every faction or settlement)
const voice = { as: 'voice', kind: ['faction', 'cohort', 'settlement'] as ('faction' | 'cohort' | 'settlement')[], shared: true, tag: { scope: 'condition' as const, key: 'voice_of' } };
const host = { as: 'host', kind: 'army' as const, shared: true, tag: { scope: 'condition' as const, key: 'host_of' } };
const fell = { text: 'You fell.' };
const town = { as: 'town', kind: 'settlement' as const, shared: true, tag: { scope: 'condition' as const, key: 'target_of' } };
const hold = { as: 'hold', kind: 'settlement' as const, shared: true, tag: { scope: 'condition' as const, key: 'hold_of' } };
const foe = { as: 'foe', kind: 'faction' as const, shared: true, via: ['$host', 'member_of', '$'] as [string, 'member_of', string] };
const RUN = { live: true, offerTurns: 1, cooldown: 0, turns: 1, work: 'travel' as const, vars: 'horde' };

/** a way on as a template: the travel rule (a way on from where the hero is), its play at the far end */
function way(id: 'ride' | 'warn' | 'lead-out' | 'muster', o: Pick<TemplateDef, 'title' | 'pitch' | 'presenter' | 'reward' | 'outcomes' | 'parts'> & { climax?: boolean; hooks: string[]; bind?: TemplateDef['bind'] }): TemplateDef {
  return {
    id,
    ...RUN,
    title: o.title,
    pitch: o.pitch,
    themes: ['travel', id],
    hooks: o.hooks,
    bind: [
      { as: 'way', kind: 'route', tag: { scope: 'economy', key: 'way', value: id }, where: [{ helper: 'fromHere', args: ['$way'] }] },
      { as: 'to', kind: 'site', shared: true, where: [{ helper: 'leadsTo', args: ['$way', '$to'] }] },
      voice,
      ...(o.bind ?? []),
    ],
    eligible: [{ helper: 'atEdge' }],
    at: 'to',
    offer: '{choice}',
    requires: { agents: [PLAYER] },
    play: { area: '$to', towardClimax: true, ...(o.climax ? { climax: true } : {}) },
    outcomes: o.outcomes,
    presenter: o.presenter,
    reward: o.reward,
    parts: o.parts,
    expiry: 'thisTurn',
    passable: true,
  };
}

export const HORDE_TEMPLATES: TemplateDef[] = [
  {
    id: 'outriders',
    ...RUN,
    title: PLAY_TITLE.flee,
    pitch: '{outriders} riders from {host} have seen you. Outrun them, or cut them down.',
    themes: ['flee', 'pursuit'],
    hooks: ['horde'],
    bind: [{ as: 'start', kind: 'site', shared: true, tag: { scope: 'condition', key: 'start_of' } }, host, voice],
    eligible: [{ helper: 'freshStart' }],
    at: 'start',
    requires: { agents: [PLAYER] },
    play: { area: '$start', forced: true },
    outcomes: {
      triumph: { text: 'You lost them on the road.' },
      success: { text: 'You got away. Some riders are still behind you.' },
      failure: { text: 'They ran you ragged.' },
      disaster: fell,
    },
    presenter: { of: '$voice', role: 'herder', verb: 'shouts', line: 'Riders on the ridge! The dead ride with them. They have seen you. Go!', gain: 'You get to live. And someone has to warn the others.' },
    reward: { text: 'You get away alive, with news of the army.' },
    parts: { theme: 1, foreshadow: 1, difficulty: 0.6, hero: 0.8 },
    expiry: 'thisTurn',
    passable: true,
  },
  way('ride', {
    title: '{wayText}',
    pitch: 'Take the road to {to}.{note}',
    hooks: [],
    outcomes: { success: { text: 'You made it through {to}.{sets}' }, failure: { text: 'It went badly at {to}.' }, disaster: fell },
    presenter: { of: '$voice', role: 'scout', verb: 'points', line: 'The quick way is through {to}. Something waits in the ditches there, mind.', gain: 'Time. The quick road saves you time, and time is what {townName} needs.' },
    reward: { text: 'You save time.' },
    parts: { theme: 0.6, foreshadow: 0.4, synergy: 0.3, difficulty: 0.5, hero: 0.6 },
  }),
  way('muster', {
    title: '{wayText}',
    pitch: '{holdName} has {levyCount} soldiers. Tell its lord, and they march for {townName}. They are slower than you.{note}',
    hooks: ['horde'],
    outcomes: {
      success: { text: "{holdName}'s lord sends his soldiers. {levyCount} soldiers march with you. +{holdSupplies} supplies.{sets}" },
      failure: { text: "{holdName}'s hall did not hear you in time. No soldiers come." },
      disaster: fell,
    },
    presenter: {
      of: '$voice', role: 'reeve', verb: 'urges',
      line: '{holdName} owes us. Ride to its hall. Its lord keeps soldiers, and they keep their oaths.',
      gain: 'Its lord will send {levyCount} soldiers with you. And {holdSupplies} supplies, if I know him.',
      haggle: { goods: { supplies: 2 } },
    },
    reward: { text: '{levyCount} soldiers from {holdName} join you. +{holdSupplies} supplies.', goods: { supplies: 'holdSupplies' }, agents: [{ id: 'levy', kind: 'army', name: "{holdName}'s soldiers", character: 'levy:{holdId}', count: 'levyCount', tags: [] }] },
    parts: { theme: 0.6, foreshadow: 1, synergy: 0.3, difficulty: 0.5, hero: 0.6 },
  }),
  way('warn', {
    title: '{wayText}',
    pitch: '{townName} has walls but no warning. Get there before the dead.{note}',
    climax: true,
    hooks: ['horde', 'town'],
    bind: [host, town, foe],
    // (the finale is this card's play: lost, the town is the dead's — its holder changes in the world: settlement-owner)
    outcomes: { success: { text: 'You reached {townName}. Now hold it.{sets}' }, failure: { text: '{townName} falls. The dead hold its ruins.', effects: [{ when: { helper: 'worldFaction', args: ['$foe'] }, do: [{ control: ['$foe', '$town'] }] }] }, disaster: fell },
    presenter: { of: '$voice', role: 'reeve', verb: 'begs', line: '{townName} has walls and no warning. Get there before the dead, and they will hold.', gain: '{townName} will thank you. People will say your name in the taverns.' },
    reward: { text: '+1 renown. {townName} will be grateful.', goods: { renown: 1 } },
    parts: { theme: 1, foreshadow: 1, synergy: 0.3, difficulty: 0.5, hero: 0.6 },
  }),
  way('lead-out', {
    title: '{wayText}',
    pitch: 'Warn {townName} and lead its people to {refuge}. The town itself may burn.{note}',
    climax: true,
    hooks: ['horde', 'town'],
    bind: [host, town, foe, hold],
    // (led out, its people go on to the hold — they move there in the world: migrate; lost, the town is the dead's)
    outcomes: {
      success: { text: 'You reached {townName}. Now lead them out.{sets} {shelterPct}% of its people will shelter at {holdName}.', effects: [{ migrate: ['$town', '$hold', 'shelterShare'], note: "{townName}'s people led out to shelter at {holdName}" }] },
      failure: { text: '{townName} falls. The dead hold its ruins.', effects: [{ when: { helper: 'worldFaction', args: ['$foe'] }, do: [{ control: ['$foe', '$town'] }] }] },
      disaster: fell,
    },
    presenter: { of: '$voice', role: 'elder', verb: 'pleads', line: 'Walls burn. People walk. Lead them to {refuge}, and let the dead have the stones.', gain: 'The people you save will remember you. So will I.' },
    reward: { text: '+1 renown. The people you save will remember you.', goods: { renown: 1 } },
    parts: { theme: 1, foreshadow: 1, synergy: 0.3, difficulty: 0.5, hero: 0.6 },
  }),
  ...(['rescue', 'scout', 'chase'] as const).map(
    (d): TemplateDef => ({
      id: d,
      ...RUN,
      title: d === 'rescue' ? 'Free the captives' : d === 'chase' ? 'Run down the herald' : 'Scout the army from the ridge',
      pitch: d === 'rescue' ? 'The dead hold {rescueCaptives} people taken from the roads. Free them, and they will fight for {townName}.' : d === 'chase' ? "{host}'s herald rides to the barrows to wake more dead. It is a few seconds ahead of you." : "A ridge looks over {host}'s road. Patrols watch the way up.",
      themes: ['travel', d],
      hooks: ['horde'],
      bind: [{ as: 'detour', kind: 'site', tag: { scope: 'economy', key: 'detour', value: d }, where: [{ helper: 'offHere', args: ['$detour'] }] }, voice],
      eligible: [{ helper: 'atEdge' }, { helper: 'detourOpen', args: [d] }],
      at: 'detour',
      requires: { agents: [PLAYER] },
      play: { area: '$detour', towardClimax: true },
      once: true,
      ...(d === 'rescue' ? { setup: [{ helper: 'markSeen', args: ['rescue', 'detour'] }] } : {}),
      outcomes:
        d === 'rescue'
          ? { success: { text: 'You freed {rescueCaptives} people. They will fight for {townName}.', effects: [{ helper: 'conflict', args: ['rally', 'rescueCaptives'] }] }, failure: { text: 'The captives were dragged to the army. That is {rescueCaptives} more dead.', effects: [{ helper: 'conflict', args: ['swell', 'rescueCaptives'] }] }, disaster: fell }
          : d === 'chase'
            ? { success: { text: 'The herald is down. {heraldDead} fewer dead rise.', effects: [{ helper: 'conflict', args: ['thin', 'heraldDead'] }] }, failure: { text: 'The herald got away. {heraldDead} more dead rise.', effects: [{ helper: 'conflict', args: ['swell', 'heraldDead'] }] }, disaster: fell }
            : { success: { text: 'You counted them from the ridge. Holding the ford is {intelPct}% more likely.', effects: [{ helper: 'conflict', args: ['intel', 'intel'] }] }, failure: { text: 'The patrols drove you off the ridge. You learned nothing.' }, disaster: fell },
      ...(d === 'rescue'
        ? { onExpire: [{ helper: 'conflict', args: ['swell', 'rescueCaptives'] }, { helper: 'closeDetour', args: ['rescue'] }], expireText: 'The captives are taken to the army. That is {rescueCaptives} more dead.', expiry: 'rescueExpiry', passable: false }
        : d === 'chase'
          ? { onExpire: [{ helper: 'conflict', args: ['swell', 'heraldDead'] }, { helper: 'closeDetour', args: ['chase'] }], expireText: 'The herald reaches the barrows. {heraldDead} more dead rise.', expiry: 'thisTurn', passable: true }
          : { expiry: 'thisTurn', passable: true }),
      presenter:
        d === 'rescue'
          ? { of: '$voice', role: 'herbalist', verb: 'pleads', line: 'They took my brother off the Fen road. They keep them penned like sheep. Please.', gain: 'Everyone you free will fight for {townName}. My brother most of all.', refuse: 'Then they are dragged to the army. And they get up again as the dead.' }
          : d === 'chase'
            ? { of: '$voice', role: 'scout', verb: 'warns', line: 'Their herald rides for the barrows. Every grave it passes gets up and follows. Run it down.', gain: 'That is {heraldDead} fewer dead at the walls.', refuse: 'Then {heraldDead} more of the dead get up and follow it.' }
            : { of: '$voice', role: 'scout', verb: 'offers', line: 'From the ridge you can count them and time them. Our soldiers will want to know where to stand.', gain: 'Holding the ford gets {intelPct}% more likely. And you learn when they reach {townName}.' },
      reward: d === 'rescue' ? { text: '{rescueCaptives} people fight for {townName}. +1 renown.', goods: { renown: 1 } } : d === 'chase' ? { text: '{heraldDead} fewer dead reach {townName}.' } : { text: 'Holding the ford is {intelPct}% more likely.' },
      parts: { theme: d === 'rescue' ? 0.4 : 0.3, foreshadow: d === 'scout' ? 0.6 : 0.5, synergy: 0.4, difficulty: 0.6, hero: d === 'chase' ? 0.9 : 0.6 },
    }),
  ),
  {
    id: 'ford',
    ...RUN,
    title: 'Hold the ford at {fordName}',
    pitch: 'The dead must cross at {fordName}. Send soldiers to hold them in the water while you ride on.',
    themes: ['fight', 'delay'],
    hooks: ['horde', 'route'],
    bind: [host, voice],
    eligible: [{ helper: 'atEdge' }, { helper: 'notPassed' }, { helper: 'fordReach' }],
    at: 'host',
    requires: { agents: [army(1)], goods: { supplies: 1 } },
    tiers: [1, 2, 3].map((n) => ({ agents: [army(n)], goods: { supplies: n } })),
    odds: 'fordOdds',
    turnsVar: 'fordTurns',
    outcomes: {
      triumph: { text: 'The ford ran red. The dead are {fordDelayHi} late.', effects: [{ helper: 'conflict', args: ['delay', 'fordDelay', 1.5, 1] }], losses: 'fordLossHi', tag: { add: ['veteran'], bonuses: [VETERANS] } },
      success: { text: 'The ford held. The dead are {fordDelay} late.', effects: [{ helper: 'conflict', args: ['delay', 'fordDelay', 1, 1] }], losses: 'fordLoss', tag: { add: ['veteran'], bonuses: [VETERANS] } },
      cost: { text: 'The ford held for a while, at a high price. The dead are {fordDelayLo} late.', effects: [{ helper: 'conflict', args: ['delay', 'fordDelay', 0.75, 1] }], losses: 'fordLossCost', tag: { add: ['veteran'], bonuses: [VETERANS] } },
      failure: { text: 'The ford broke at the first rush.', losses: 'fordLossFail' },
    },
    presenter: { of: '$voice', role: 'captain', verb: 'reports', line: 'There is one ford they must take. Give me soldiers, and I will make them pay for every step.', gain: 'Every minute we hold them is a minute for {townName}. And the soldiers who come back will be veterans.', refuse: 'Then the dead cross the ford whenever they like.' },
    reward: { text: 'Time for {townName}. The soldiers who come back become veterans.' },
    parts: { theme: 0.6, foreshadow: 0.9, synergy: 0.6, difficulty: 0.5 },
    expiry: 'fordExpiry',
    locate: 'fordLocate',
    once: true,
  },
  {
    id: 'harvest',
    ...RUN,
    work: 'labour',
    title: 'Bring in the harvest at {holdName}',
    pitch: "{holdName}'s fields are ripe, and the dead will trample them. Bring the grain in, and {townName}'s defenders eat.",
    themes: ['harvest', 'labour'],
    hooks: ['town'],
    bind: [{ as: 'fields', kind: 'site', tag: { scope: 'economy', key: 'harvest', value: 'ripe' } }, voice],
    eligible: [{ helper: 'atEdge' }, { helper: 'notPassed' }],
    at: 'fields',
    setup: [{ helper: 'markSeen', args: ['harvest', 'fields'] }],
    turnsVar: 'harvestTurns',
    requires: { agents: [army(1)] },
    tiers: [1, 2].map((n) => ({ agents: [army(n)] })),
    odds: { success: 0.85, cost: 0.15 },
    outcomes: {
      success: { text: 'The grain is in. +{harvestYield} supplies.', effects: [{ setTag: ['$fields', 'economy', 'harvest', 'in'] }], goods: { supplies: 'harvestYield' } },
      cost: { text: 'Half the grain is in before the rain. +{harvestHalf} supplies.', effects: [{ setTag: ['$fields', 'economy', 'harvest', 'in'] }], goods: { supplies: 'harvestHalf' }, losses: 0.1 },
    },
    onExpire: [{ setTag: ['$fields', 'economy', 'harvest', 'rotted'] }, { helper: 'conflict', args: ['hasten', 'rot'] }],
    expireText: "The grain rots in {holdName}'s fields. The dead come {rot} sooner.",
    presenter: { of: '$voice', role: 'trader', verb: 'asks', line: 'Grain in a barn feeds the walls. Grain in a field feeds nobody. Lend us your soldiers for a day.', gain: "{harvestYield} supplies for {townName}'s defenders. Fed soldiers fight longer.", refuse: 'Then the grain rots, and the dead come on faster.' },
    reward: { text: '+{harvestYield} supplies.' },
    parts: { theme: 0.8, foreshadow: 0.5, synergy: 0.5, difficulty: 0.9 },
    expiry: 'harvestExpiry',
    once: true,
  },
  {
    id: 'watchtower',
    ...RUN,
    work: 'labour',
    title: 'Raise a watchtower at {townName}',
    pitch: "Timber and some strong backs. A tower over {townName}'s gate sees the dead coming.",
    themes: ['build', 'defence'],
    hooks: ['town'],
    bind: [town, voice],
    eligible: [{ helper: 'atEdge' }, { helper: 'notPassed' }, { helper: 'noBuilding', args: ['$town', 'watch'] }],
    at: 'town',
    requires: { agents: [army(1)] },
    odds: { success: 0.9, cost: 0.1 },
    // (a structure placed directly — no builders simulated: the town's plan raises it when the player next looks)
    outcomes: {
      success: { text: 'A watchtower stands over {townName}. {towerDefenders} more defenders hold together.', effects: [{ place: { at: '$town', id: 'watchtower', name: 'the watchtower of {townName}', use: ['defence', 'watch'] } }, { helper: 'conflict', args: ['rally', 'towerDefenders'] }] },
      cost: { text: 'The tower is up, but it was rushed. Some soldiers were hurt building it.', effects: [{ place: { at: '$town', id: 'watchtower', name: 'the watchtower of {townName}', use: ['defence', 'watch'] } }], losses: 0.2 },
    },
    presenter: { of: '$voice', role: 'smith', verb: 'offers', line: 'Lend me soldiers for a day, and {townName} gets a tower that will outlast all of us.', gain: '{towerDefenders} more defenders hold together at {townName}. And the tower stays after this fight.' },
    reward: { text: 'A watchtower at {townName}. It stays after this run. You can build watchtowers in the city builder.', unlocks: [{ mode: 'city', what: 'watchtower' }] },
    parts: { theme: 0.7, foreshadow: 0.8, synergy: 0.5, difficulty: 0.6 },
    expiry: 'thisTurn',
    once: true,
  },
  {
    id: 'weir',
    ...RUN,
    work: 'labour',
    title: 'Close the weir at {holdName}',
    pitch: "The dead drink from {holdName}'s river on their way. Close the weir, and the river below runs dry. Thirsty dead march slowly.",
    themes: ['water', 'delay'],
    hooks: ['horde'],
    bind: [{ as: 'fields', kind: 'site', shared: true, tag: { scope: 'economy', key: 'farm' } }, voice],
    eligible: [{ helper: 'atEdge' }, { helper: 'notPassed' }],
    at: 'fields',
    requires: { agents: [army(1)] },
    odds: { success: 0.8, cost: 0.2 },
    // (the rivers' inflow factor of the hold's region: the held rivers' discharge scales by it — dry where the player looks)
    outcomes: {
      success: { text: "The weir is shut. {holdName}'s river runs at {weirPct}%. The dead are {weirDelay} slower.", effects: [{ inflow: '$fields', factor: 'weirFactor', note: "{holdName}'s weir closed: the river below runs dry" }, { helper: 'conflict', args: ['delay', 'weirDelay'] }] },
      cost: { text: 'The weir is shut, but the water found an old channel. The dead barely slowed.', effects: [{ inflow: '$fields', factor: 'weirFactor', note: "{holdName}'s weir closed: the river below runs dry" }], losses: 0.1 },
    },
    presenter: { of: '$voice', role: 'trader', verb: 'suggests', line: "The dead still drink. Shut {holdName}'s weir, and let them find the river dry.", gain: "The dead are {weirDelay} slower. But {holdName}'s river stays low after this." },
    reward: { text: "The dead are slowed. {holdName}'s river runs dry after this run." },
    parts: { theme: 0.5, foreshadow: 0.7, synergy: 0.4, difficulty: 0.5 },
    expiry: 'thisTurn',
    once: true,
  },
  {
    id: 'vanguard',
    ...RUN,
    title: "Break the army's vanguard",
    pitch: 'Veterans know how the dead fight. Strike the front of the army, and fewer of them reach {townName}.',
    themes: ['fight'],
    hooks: ['horde'],
    bind: [host, voice],
    eligible: [{ helper: 'atEdge' }, { helper: 'notPassed' }, { helper: 'vanguardReach' }],
    at: 'host',
    requires: { agents: [army(1, ['veteran'])] },
    odds: { success: 0.6, cost: 0.3, failure: 0.1 },
    outcomes: {
      success: { text: 'The vanguard is broken. {vanguardThin} fewer dead.', effects: [{ helper: 'conflict', args: ['thin', 'vanguardThin'] }], losses: 0.2 },
      cost: { text: 'The vanguard bled them. {vanguardHalf} fewer dead.', effects: [{ helper: 'conflict', args: ['thin', 'vanguardHalf'] }], losses: 0.4 },
      failure: { text: 'The dead closed around them.', losses: 0.6 },
    },
    presenter: { of: '$voice', role: 'captain', verb: 'proposes', line: 'Your veterans have seen the dead fight. Let them find the head of the thing and cut it off.', gain: '{vanguardThin} fewer dead reach {townName}.' },
    reward: { text: 'Fewer dead at the walls.' },
    parts: { theme: 0.7, foreshadow: 1, synergy: 0.5, difficulty: 0.4 },
    locate: 'vanguardLocate',
    expiry: 'thisTurn',
    once: true,
  },
];
