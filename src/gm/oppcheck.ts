// ---- gm/oppcheck.ts -----------------------------------------------------------------------------------------------
// (round 120, `opportunities`; BACKLOG RN2-4; merge124: one oppcheck) The opportunity validator: a deal is checked before
// it is shown (the run throws on a problem; the tests and the inspector run it). One validator for every deal of the
// living engine, the inspector's world and a run's alike (merge124: the run's old DealReport check is folded in here):
//   references    every bound entity exists in the fact layer; the card's place is a region of the world and its
//                 settlement real; a played card's area is in the situation; agent kinds known; the stores asked for
//                 are goods the settlement keeps;
//   consequences  every outcome realisable: effect kinds known, losses a share, no odds for a tier with no outcome; the
//                 outcome dry-runs on a copy of the world without error and every invariant holds after it;
//   hands         sane deals: the limits kept (a forced one dealt alone), one card a place (or one offer of a template a
//                 place), a binding dealt once, the tier in range, affordable as the rules say, a challenge only when
//                 the player is required (and every challenge an encounter with enemies: the user, round 124), odds
//                 summing to 1, expiry not in the past;
//   setup         an incident never fabricates a prerequisite (checkTemplates, statically, over the setup's data).
// A problem is a line; the empty list is a pass. Never patched: a deal with problems is an error where it's used.

import { affords, AGENT_KINDS, needsPlayer, TIERS, type Holdings, type OppOutcome, type Opportunity } from '../api/contracts/opportunity';
import type { Situation } from '../api/contracts/situation';
import type { AtlasEventKind } from '../api/contracts/world';
import type { DealerTune } from '../opps/tune';

/** what a card is checked against beyond the fact world: the map's regions, the run's situation */
export interface OppWorld {
  /** the region exists on the map (default: a region of the world state) */
  region?(id: number): boolean;
  /** the run's situation: a played card's area must be in it (a detour's, `d-<kind>-<from>`, is made when played) */
  situation?: Situation;
  atlasKinds?: readonly AtlasEventKind[];
}

/** one opportunity, as the contract has it (references, consequences, its own hand rules) */
export function checkOpportunity(o: Opportunity, h: Holdings, turn: number, w: OppWorld & { region(id: number): boolean }, committed = false): string[] {
  const p: string[] = [];
  const at = `${o.title} (${o.id})`;
  if (!w.region(o.location.region)) p.push(`${at}: region ${o.location.region} isn't on the map`);
  if (!o.location.at.every(Number.isFinite)) p.push(`${at}: its place isn't a point`);
  for (const q of o.requires) {
    if (!AGENT_KINDS.includes(q.kind)) p.push(`${at}: no agent kind ${q.kind}`);
    if (!(q.count > 0)) p.push(`${at}: requires ${q.count} ${q.kind}`);
  }
  const player = needsPlayer(o);
  if (o.challenge && !player) p.push(`${at}: a challenge only when the player is required`);
  if (o.challenge) {
    if (w.situation && !w.situation.areas.some((a) => a.id === o.challenge!.area) && !/^d-(rescue|scout|chase)-/.test(o.challenge.area)) p.push(`${at}: its challenge's area ${o.challenge.area} isn't in the situation`);
    const e = o.challenge.encounter;
    if (!e) p.push(`${at}: a played card names its encounter`);
    else if (e.foes + e.pursuers + (e.horde ?? 0) <= 0) p.push(`${at}: its encounter (${e.kind}) has no enemies in it: a ride to a flag`);
    // (round 126: the game it plays, read off its EncounterSpec; a race only with an arena — none exists)
    if (e && !e.plays) p.push(`${at}: its encounter (${e.kind}) names no game it plays (encounters/spec.ts)`);
    else if (e?.plays === 'race' || e?.kind === 'race') p.push(`${at}: a race, and no arena (the user: "Don't have races unless you have arenas with jumps and crowds")`);
    if (!('minutes' in o.duration)) p.push(`${at}: a played card's duration is in minutes`);
  } else if (!('turns' in o.duration) || o.duration.turns < 0) p.push(`${at}: a crew's card's duration is in turns, not negative`);
  if (o.odds) {
    const sum = Object.values(o.odds).reduce((s, v) => s + (v ?? 0), 0);
    if (Math.abs(sum - 1) > 1e-6) p.push(`${at}: its odds sum to ${sum.toFixed(3)}`);
    for (const [t, v] of Object.entries(o.odds)) if ((v ?? 0) > 0 && !o.outcomes[t as keyof typeof o.outcomes]) p.push(`${at}: odds for ${t} but no outcome for it`);
  }
  for (const [t, oc] of Object.entries(o.outcomes)) {
    if (!TIERS.includes(t as never)) p.push(`${at}: no tier ${t}`);
    p.push(...outcomeProblems(`${at} ${t}`, oc!, w));
  }
  if (o.onExpire) p.push(...outcomeProblems(`${at} on expiry`, o.onExpire, w));
  if (!o.outcomes.success && !o.outcomes.triumph) p.push(`${at}: no outcome for success`);
  if (!(o.tier >= 1 && o.tier <= o.tiers)) p.push(`${at}: tier ${o.tier} of ${o.tiers}`);
  const can = affords(o, h);
  if (!committed && can.ok !== o.affordable) p.push(`${at}: marked ${o.affordable ? 'affordable' : 'unaffordable'}, the rules say ${can.ok ? 'affordable' : `not (${can.missing.join('; ')})`}`);
  if (o.expires.turn < turn) p.push(`${at}: expires in turn ${o.expires.turn}, before this one (${turn})`);
  if (o.forced && !player) p.push(`${at}: a forced card is the player's`);
  return p;
}

/** the hand as a whole: the limits */
function checkHand(opps: Opportunity[], tune: DealerTune): string[] {
  const p: string[] = [];
  const mine = opps.filter((o) => needsPlayer(o));
  if (mine.some((o) => o.forced) && mine.length > 1) p.push(`a forced card is dealt with ${mine.length - 1} others`);
  if (mine.length > tune.playerMax) p.push(`${mine.length} player cards dealt, the limit is ${tune.playerMax}`);
  const res = opps.filter((o) => !needsPlayer(o));
  if (res.length > tune.resourceMax + (tune.nextTier ? res.length : 0)) p.push(`${res.length} crews' cards dealt, the limit is ${tune.resourceMax}`);
  if (res.filter((o) => !o.affordable && !o.id.includes(':goal')).length > tune.unaffordable) p.push(`more unaffordable cards shown than the ${tune.unaffordable} slots`);
  return p;
}

function outcomeProblems(at: string, oc: OppOutcome, w: OppWorld): string[] {
  const p: string[] = [];
  if (!oc.text) p.push(`${at}: an outcome without its line`);
  if (oc.losses !== undefined && !(oc.losses >= 0 && oc.losses <= 1)) p.push(`${at}: losses ${oc.losses} aren't a share`);
  for (const e of oc.effects) {
    if (e.kind === 'agent' && !AGENT_KINDS.includes(e.agent.kind)) p.push(`${at}: gains an agent of no kind ${e.agent.kind}`);
    else if (e.kind === 'goods' && Object.values(e.goods).some((n) => !Number.isFinite(n))) p.push(`${at}: goods that aren't numbers`);
    else if (e.kind === 'atlas') {
      if (w.atlasKinds && !w.atlasKinds.includes(e.event.kind)) p.push(`${at}: no atlas event ${e.event.kind}`);
      for (const r of e.event.regions) if (w.region && !w.region(r)) p.push(`${at}: atlas event on region ${r}, not on the map`);
    } else if (e.kind === 'conflict') p.push(`${at}: a conflict's operation is the stage's (an effect helper), not an outcome's`);
    else if (!['agent', 'goods', 'atlas', 'tag'].includes(e.kind)) p.push(`${at}: no effect kind ${(e as { kind: string }).kind}`);
  }
  return p;
}

// ---- (round 125, `facts`; BACKLOG LW-F6) the living world's family -------------------------------------------------
// The template engine's cards (src/living/engine.ts), checked as the user's guardrails ask (OPPORTUNITY_CATALOG.md E):
//   references    every bound entity exists in the fact layer; the card's place is a region of the world and its
//                 settlement real; the pawns asked for are agent kinds; the stores asked for are goods the settlement keeps;
//   consequences  the outcome dry-runs on a copy of the world without error and every invariant holds after it;
//   hands         one card a place; not expired; a binding dealt once;
//   setup         an incident never fabricates a prerequisite: no capability, law or government tag, no alliance, trade,
//                 vassalage, membership, control or rights (checkTemplates, statically, over the setup's data) —
//                 "The generator may create incidents, but it should not fabricate the prerequisite capabilities or
//                 relationships (e.g., allied reinforcements require an ally)".
import type { EngineReport, LivingEngine, TemplateDef } from '../living/engine';
import type { Effect } from '../living/dsl';

/** relations a setup may never make: they are prerequisites, earned through play */
export const PREREQ_RELATIONS = ['allied_with', 'trades_with', 'vassal_of', 'member_of', 'governs', 'part_of_polity', 'controls', 'owns', 'has_rights', 'has_access_to', 'at_peace_with', 'friend_of', 'owes_favor_to', 'employs', 'supplies', 'loyal_to'];
const PREREQ_SCOPES = ['capability', 'law', 'government'];

export function checkTemplates(ts: TemplateDef[]): string[] {
  const p: string[] = [];
  const ids = new Set<string>();
  const walk = (at: string, es: Effect[]) => {
    for (const e of es) {
      if ('relate' in e && PREREQ_RELATIONS.includes(e.relate[1])) p.push(`${at}: its setup fabricates ${e.relate[1]} (a prerequisite relationship)`);
      if ('setTag' in e && PREREQ_SCOPES.includes(e.setTag[1])) p.push(`${at}: its setup fabricates ${e.setTag[1]} ${e.setTag[2]} (a prerequisite)`);
      if ('agree' in e || 'control' in e || 'place' in e) p.push(`${at}: its setup makes ${Object.keys(e)[0]} — a setup only makes incidents (claims, events, conditions)`);
      if ('forEach' in e) walk(at, e.do);
      if ('when' in e) walk(at, [...e.do, ...(e.else ?? [])]);
    }
  };
  for (const t of ts) {
    if (ids.has(t.id)) p.push(`template ${t.id}: the id is used twice`);
    ids.add(t.id);
    if (!t.bind.some((b) => b.as === t.at)) p.push(`template ${t.id}: its place (${t.at}) isn't one of its bindings`);
    if (!(t.turns >= 1)) p.push(`template ${t.id}: turns ${t.turns}`);
    if (!t.outcomes && !t.outcome) p.push(`template ${t.id}: no outcome`);
    if (t.play && !t.requires.agents.some((r) => r.kind === 'player')) p.push(`template ${t.id}: a played card requires the player`);
    for (const r of t.requires.agents) if (!AGENT_KINDS.includes(r.kind)) p.push(`template ${t.id}: no agent kind ${r.kind}`);
    if (t.setup) walk(`template ${t.id}`, t.setup);
  }
  return p;
}

export function checkLiving(e: LivingEngine, r: EngineReport, ow: OppWorld = {}): string[] {
  const p: string[] = [];
  const w = e.w;
  const places = new Set<string>();
  const keys = new Set<string>();
  const regions = new Set(w.ws.snapshot().regions.map((x) => x.id));
  const cw = { ...ow, region: ow.region ?? ((id: number) => regions.has(id)) };
  const onePerPlace = e.opts.onePerPlace ?? true;
  for (const o of [...r.dealt, ...r.kept]) {
    const at = `${o.opp.title}`;
    for (const [k, id] of Object.entries(o.bind)) if (!w.facts.entity(id)) p.push(`${at}: ${k} = ${id} isn't in the fact layer`);
    if (o.opp.location.settlement && !w.settlement(o.opp.location.settlement)) p.push(`${at}: settlement ${o.opp.location.settlement} isn't in the world`);
    // (a card kept from an earlier deal was affordable or not as the holdings were then: only this deal's are held to it)
    p.push(...checkOpportunity(o.opp, w.holdings, r.turn, cw, o.status !== 'offered' || !r.dealt.includes(o)));
    const t = e.template(o.template);
    for (const s of t.requires.stores ?? []) {
      const sid = s.at.startsWith('$') ? o.bind[s.at.slice(1)] : s.at;
      const st = w.settlementOf(sid);
      if (!st) p.push(`${at}: its stores are at ${sid}, not a settlement`);
      else if (!(s.good in st.stores)) p.push(`${at}: ${st.name} keeps no ${s.good}`);
    }
    const pk = onePerPlace ? o.place : `${o.template}@${o.place}`;
    if (places.has(pk)) p.push(`${at}: a second card at ${o.place}${onePerPlace ? '' : ` of ${o.template}`}`);
    places.add(pk);
    if (keys.has(o.key)) p.push(`${at}: its binding is dealt twice`);
    keys.add(o.key);
    if (o.expires < r.turn) p.push(`${at}: expired (turn ${o.expires}) but on the board at ${r.turn}`);
    try {
      e.dryRun(t, o.bind);
    } catch (err) {
      p.push(`${at}: its outcome can't be realised: ${(err as Error).message}`);
    }
  }
  p.push(...checkHand(r.dealt.map((o) => o.opp), e.dealerTune()));
  return p;
}
