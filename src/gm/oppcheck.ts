// ---- gm/oppcheck.ts -----------------------------------------------------------------------------------------------
// (round 120, `opportunities`; BACKLOG RN2-4) The opportunity validator: a deal is checked before it is shown (the
// level throws on a problem; the tests and scripts/storycheck.mjs run it). Three families, as the brief asked:
//   references    the location's region is on the map, its settlement in the world, a challenge's area in the
//                 situation, an agent kind known;
//   consequences  every outcome and expiry realisable: effect kinds known, a conflict operation the conflict has, an
//                 atlas event's kind and regions real, losses a share, no outcome on a tier the odds can't give;
//   hands         sane deals: the limits kept (a forced one dealt alone), one offer of a template at a place, ids
//                 unique, the dealt tier in range and the largest the holdings meet, affordable as the rules say,
//                 a challenge iff the player is required, odds summing to 1, expiry not in the past.
// A problem is a line; the empty list is a pass. Never patched: a GM-written or template deal with problems is an
// error where it's used (situationcheck's rule).

import { affords, AGENT_KINDS, needsPlayer, TIERS, type Holdings, type OppOutcome } from '../api/contracts/opportunity';
import type { Situation } from '../api/contracts/situation';
import type { AtlasEventKind } from '../api/contracts/world';
import type { DealReport } from '../opps/dealer';
import type { DealerTune } from '../opps/tune';

export interface OppWorld {
  /** the region exists on the map */
  region(id: number): boolean;
  /** the settlement exists in the world */
  settlement(id: string): boolean;
  situation: Situation;
  /** the conflict's operations */
  ops: readonly string[];
  atlasKinds?: readonly AtlasEventKind[];
}

export function checkOpps(r: DealReport, w: OppWorld, h: Holdings, tune: DealerTune): string[] {
  const p: string[] = [];
  const ids = new Set<string>();
  const places = new Set<string>();
  const dealt = r.dealt.map((d) => d.opp);
  for (const o of dealt) {
    const at = `${o.id}`;
    if (ids.has(o.id)) p.push(`${at}: the id is dealt twice`);
    ids.add(o.id);
    // references
    if (!w.region(o.location.region)) p.push(`${at}: region ${o.location.region} isn't on the map`);
    if (o.location.settlement && !w.settlement(o.location.settlement)) p.push(`${at}: settlement ${o.location.settlement} isn't in the world`);
    if (!o.location.at.every(Number.isFinite)) p.push(`${at}: its place isn't a point`);
    for (const q of o.requires) {
      if (!AGENT_KINDS.includes(q.kind)) p.push(`${at}: no agent kind ${q.kind}`);
      if (!(q.count > 0)) p.push(`${at}: requires ${q.count} ${q.kind}`);
    }
    const player = needsPlayer(o);
    if (player !== !!o.challenge) p.push(`${at}: a challenge iff the player is required`);
    // (a detour's area, `d-<template>-<from>`, is made when it's played: run.ts)
    if (o.challenge && !w.situation.areas.some((a) => a.id === o.challenge!.area) && !/^d-(rescue|scout|chase)-/.test(o.challenge.area)) p.push(`${at}: its challenge's area ${o.challenge.area} isn't in the situation`);
    // (round 124: the user — "no enemies or combat no pursuers": every encounter has enemies in it)
    if (o.challenge) {
      const e = o.challenge.encounter;
      if (!e) p.push(`${at}: a player opportunity names its encounter`);
      else if (e.foes + e.pursuers + (e.horde ?? 0) <= 0) p.push(`${at}: its encounter (${e.kind}) has no enemies in it: a ride to a flag`);
    }
    if (player && !('minutes' in o.duration)) p.push(`${at}: a player opportunity's duration is in minutes`);
    if (!player) {
      if (!('turns' in o.duration) || o.duration.turns < 0) p.push(`${at}: a resource opportunity's duration is in turns, not negative`);
      if (!o.odds) p.push(`${at}: a resource opportunity needs its odds`);
      else {
        const sum = Object.values(o.odds).reduce((s, v) => s + (v ?? 0), 0);
        if (Math.abs(sum - 1) > 1e-6) p.push(`${at}: its odds sum to ${sum.toFixed(3)}`);
        for (const [t, v] of Object.entries(o.odds)) if ((v ?? 0) > 0 && !o.outcomes[t as keyof typeof o.outcomes]) p.push(`${at}: odds for ${t} but no outcome for it`);
      }
    }
    // consequences
    for (const [t, oc] of Object.entries(o.outcomes)) {
      if (!TIERS.includes(t as never)) p.push(`${at}: no tier ${t}`);
      p.push(...outcomeProblems(`${at} ${t}`, oc!, w));
    }
    if (o.onExpire) p.push(...outcomeProblems(`${at} on expiry`, o.onExpire, w));
    if (!o.outcomes.success && !o.outcomes.triumph) p.push(`${at}: no outcome for success`);
    // hands
    if (!(o.tier >= 1 && o.tier <= o.tiers)) p.push(`${at}: tier ${o.tier} of ${o.tiers}`);
    const can = affords(o, h);
    if (can.ok !== o.affordable) p.push(`${at}: marked ${o.affordable ? 'affordable' : 'unaffordable'}, the rules say ${can.ok ? 'affordable' : `not (${can.missing.join('; ')})`}`);
    if (o.expires.turn < r.turn) p.push(`${at}: expires in turn ${o.expires.turn}, before this one (${r.turn})`);
    if (o.forced && !player) p.push(`${at}: a forced opportunity is the player's`);
    if (o.affordable) {
      const k = `${o.template}@${o.location.name}`;
      if (places.has(k)) p.push(`${at}: a second offer of ${o.template} at ${o.location.name}`);
      places.add(k);
    }
  }
  const mine = dealt.filter((o) => needsPlayer(o));
  if (mine.some((o) => o.forced) && mine.length > 1) p.push(`a forced opportunity is dealt with ${mine.length - 1} others`);
  if (mine.length > tune.playerMax) p.push(`${mine.length} player opportunities dealt, the limit is ${tune.playerMax}`);
  const res = dealt.filter((o) => !needsPlayer(o));
  if (res.length > tune.resourceMax + (tune.nextTier ? res.length : 0)) p.push(`${res.length} resource opportunities dealt, the limit is ${tune.resourceMax}`);
  if (res.filter((o) => !o.affordable && !o.id.includes(':goal')).length > tune.unaffordable) p.push(`more unaffordable opportunities shown than the ${tune.unaffordable} slots`);
  return p;
}

function outcomeProblems(at: string, oc: OppOutcome, w: OppWorld): string[] {
  const p: string[] = [];
  if (!oc.text) p.push(`${at}: an outcome without its line`);
  if (oc.losses !== undefined && !(oc.losses >= 0 && oc.losses <= 1)) p.push(`${at}: losses ${oc.losses} aren't a share`);
  for (const e of oc.effects) {
    if (e.kind === 'conflict' && !w.ops.includes(e.op)) p.push(`${at}: the conflict has no operation ${e.op}`);
    else if (e.kind === 'conflict' && !Number.isFinite(e.amount)) p.push(`${at}: ${e.op} by ${e.amount}`);
    else if (e.kind === 'agent' && !AGENT_KINDS.includes(e.agent.kind)) p.push(`${at}: gains an agent of no kind ${e.agent.kind}`);
    else if (e.kind === 'goods' && Object.values(e.goods).some((n) => !Number.isFinite(n))) p.push(`${at}: goods that aren't numbers`);
    else if (e.kind === 'atlas') {
      if (w.atlasKinds && !w.atlasKinds.includes(e.event.kind)) p.push(`${at}: no atlas event ${e.event.kind}`);
      for (const r of e.event.regions) if (!w.region(r)) p.push(`${at}: atlas event on region ${r}, not on the map`);
    } else if (!['conflict', 'agent', 'goods', 'atlas', 'tag'].includes(e.kind)) p.push(`${at}: no effect kind ${(e as { kind: string }).kind}`);
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
    for (const r of t.requires.agents) if (!AGENT_KINDS.includes(r.kind)) p.push(`template ${t.id}: no agent kind ${r.kind}`);
    if (t.setup) walk(`template ${t.id}`, t.setup);
  }
  return p;
}

export function checkLiving(e: LivingEngine, r: EngineReport): string[] {
  const p: string[] = [];
  const w = e.w;
  const places = new Set<string>();
  const keys = new Set<string>();
  const regions = new Set(w.ws.snapshot().regions.map((x) => x.id));
  for (const o of [...r.dealt, ...r.kept]) {
    const at = `${o.opp.title}`;
    for (const [k, id] of Object.entries(o.bind)) if (!w.facts.entity(id)) p.push(`${at}: ${k} = ${id} isn't in the fact layer`);
    if (!regions.has(o.opp.location.region)) p.push(`${at}: region ${o.opp.location.region} isn't in the world`);
    if (o.opp.location.settlement && !w.settlement(o.opp.location.settlement)) p.push(`${at}: settlement ${o.opp.location.settlement} isn't in the world`);
    for (const q of o.opp.requires) if (!AGENT_KINDS.includes(q.kind)) p.push(`${at}: no agent kind ${q.kind}`);
    const t = e.template(o.template);
    for (const s of t.requires.stores ?? []) {
      const sid = s.at.startsWith('$') ? o.bind[s.at.slice(1)] : s.at;
      const st = w.settlementOf(sid);
      if (!st) p.push(`${at}: its stores are at ${sid}, not a settlement`);
      else if (!(s.good in st.stores)) p.push(`${at}: ${st.name} keeps no ${s.good}`);
    }
    if (places.has(o.place)) p.push(`${at}: a second card at ${o.place}`);
    places.add(o.place);
    if (keys.has(o.key)) p.push(`${at}: its binding is dealt twice`);
    keys.add(o.key);
    if (o.expires < r.turn) p.push(`${at}: expired (turn ${o.expires}) but on the board at ${r.turn}`);
    try {
      e.dryRun(t, o.bind);
    } catch (err) {
      p.push(`${at}: its outcome can't be realised: ${(err as Error).message}`);
    }
  }
  return p;
}
