// The situation's validator (round 120, `runsit`; docs/GM.md "Situations"): checks a Situation (src/api/contracts/
// situation.ts) against its types and the world it was written from (a world wiki: its snapshot, its regions'
// neighbours and centres). Returns every problem; none means the run can be played. No fixing, no defaults.
//
// What it checks:
//  - shapes: every field's type, no missing fields, no fields situation.ts doesn't have; ids lowercase-with-dashes,
//    unique across the situation;
//  - the world: regions, settlements (in their region), factions; the threat's route over neighbouring regions ending
//    at the target's; the refuge at or next to the target; the finale at the target settlement;
//  - the run: areas[0] starts it; every area reached from it by the choices; every area but the finale has a way on,
//    the finale none; somewhere the player has a real fork (two ways on); no way back round (no cycles); every path
//    plays 3-5 areas; 'evacuate' only with 'warn'; every offered item defined, every defined item offered;
//  - the clock (from the areas' spots, the planned minutes and the road pace, runsit/state.ts): some path reaches the
//    town before the threat does — a run that can't be won in time isn't a choice;
//  - the endings: all four; each changes the world (an AtlasEvent, through the stories' own check); 'burned' burns the
//    target's region — the user: "Let it burn down if the player fails".
// (Node runs it too — scripts/storycheck.mjs — so it imports only types and pure code.)

import type { WorldSnapshot } from '../api/contracts/world';
import { ITEM_SLOTS } from '../api/contracts/items.ts';
import { SITUATION_ENDS, type Situation } from '../api/contracts/situation.ts';
import { atlasEventProblems, type CheckWorld } from './storycheck.ts';
import { pathEstimates, type SituationMap } from '../runsit/state.ts';

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => typeof v === 'object' && v !== null && !Array.isArray(v);
const ID = /^[a-z0-9][a-z0-9-]*$/;
const PLAYS = ['flee', 'ambush', 'deliver', 'trader', 'town'];
const EFFECTS = ['warn', 'evacuate', 'delay'];
const ITEM_EFFECTS = ['call-allies', 'lure', 'fire-ward', 'pace', 'guard'];
const CONDITIONS = ['thriving', 'struggling', 'besieged', 'abandoned', 'ruined'];

export interface SituationWorld extends CheckWorld {
  /** each region's neighbours and centre (world units), from the wiki's regions */
  neighbours: (region: number) => number[] | undefined;
  centre: (region: number) => [number, number] | undefined;
  world: { w: number; h: number };
}

/** The world a situation is checked against: a world wiki (data/wiki/*.json — it has the regions' geography). */
export function situationWorldFrom(json: unknown): SituationWorld {
  if (!isObj(json) || !isObj(json.snapshot) || !Array.isArray(json.regions)) throw new Error('situationcheck: the world must be a world wiki ({snapshot, regions, …})');
  const w = json as { snapshot: WorldSnapshot; regions: { id: number; neighbours?: number[]; centre?: [number, number]; ground?: { min: number; max: number } }[]; world?: { w?: number; h?: number; sea?: number } };
  const byId = new Map(w.regions.map((r) => [r.id, r]));
  return {
    snapshot: w.snapshot,
    ground: (id) => byId.get(id)?.ground,
    sea: w.world?.sea,
    neighbours: (id) => byId.get(id)?.neighbours,
    centre: (id) => byId.get(id)?.centre,
    world: { w: w.world?.w ?? 16384, h: w.world?.h ?? 16406 },
  };
}

/**
 * (round 120, the phone bug) A world's fingerprint: its seed, its settlements (id, name, region, faction, size) and its
 * factions, hashed. The atlas is made on the GPU and its macro ground read back; the rivers, the sites and so the towns
 * and realms are planned on it — a phone's GPU can make the same seed with other towns than the desktop's that the wiki
 * cache was pulled from. A situation names towns, so it is for one print.
 */
export function worldPrint(snap: WorldSnapshot): string {
  let h = 2166136261;
  const add = (t: string) => {
    for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619);
  };
  add(`seed ${snap.seed};`);
  for (const s of snap.settlements) add(`${s.id} ${s.name} ${s.region} ${s.faction} ${s.size};`);
  for (const f of snap.factions) add(`${f.id};`);
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function checkSituation(input: unknown, world: SituationWorld): string[] {
  const P: string[] = [];
  const bad = (at: string, msg: string) => P.push(`${at}: ${msg}`);
  const snap = world.snapshot;
  const regionIds = new Set(snap.regions.map((r) => r.id));
  const factionIds = new Set(snap.factions.map((f) => f.id));
  const settlements = new Map(snap.settlements.map((s) => [s.id, s]));

  const keys = (at: string, o: J, req: string[], opt: string[] = []) => {
    for (const k of req) if (!(k in o)) bad(at, `missing "${k}"`);
    for (const k of Object.keys(o)) if (!req.includes(k) && !opt.includes(k)) bad(at, `"${k}" isn't a field of this type (no prose outside the fields)`);
  };
  const str = (at: string, v: unknown) => {
    if (typeof v !== 'string') return bad(at, `expected a string, got ${JSON.stringify(v)}`), false;
    if (!v.trim()) return bad(at, 'is empty'), false;
    return true;
  };
  const num = (at: string, v: unknown, lo = -Infinity, hi = Infinity) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return bad(at, `expected a number, got ${JSON.stringify(v)}`), false;
    if (v < lo || v > hi) return bad(at, `${v} is outside ${lo}..${hi}`), false;
    return true;
  };
  const int = (at: string, v: unknown, lo: number, hi: number) => num(at, v, lo, hi) && (Number.isInteger(v) || (bad(at, `${v} isn't a whole number`), false));
  const arr = (at: string, v: unknown): unknown[] => {
    if (!Array.isArray(v)) return bad(at, `expected an array, got ${JSON.stringify(v)}`), [];
    return v;
  };
  const ids = new Map<string, string>();
  const id = (at: string, v: unknown, what: string) => {
    if (!str(at, v)) return false;
    if (!ID.test(v as string)) return bad(at, `id "${v}" should be lowercase letters, digits and dashes`), false;
    if (ids.has(v as string)) bad(at, `id "${v}" is used twice (also ${ids.get(v as string)})`);
    else ids.set(v as string, what);
    return true;
  };
  const region = (at: string, v: unknown) => (regionIds.has(v as number) ? true : (bad(at, `region ${JSON.stringify(v)} isn't in the snapshot`), false));
  const faction = (at: string, v: unknown) => (factionIds.has(v as string) ? true : (bad(at, `faction ${JSON.stringify(v)} isn't in the snapshot`), false));
  const settlementIn = (at: string, s: unknown, r: unknown) => {
    const rec = settlements.get(s as string);
    if (!rec) return bad(at, `settlement ${JSON.stringify(s)} isn't in the snapshot`), false;
    if (r !== undefined && rec.region !== r) return bad(at, `${s} stands in region ${rec.region}, not ${r}`), false;
    return true;
  };

  if (!isObj(input)) return ['situation: expected an object'];
  const s = input as J;
  keys('situation', s, ['id', 'title', 'premise', 'from', 'hero', 'threat', 'target', 'refuge', 'areas', 'choices', 'items', 'endings']);
  id('situation.id', s.id, 'the situation');
  str('situation.title', s.title);
  str('situation.premise', s.premise);
  str('situation.hero', s.hero);
  if (isObj(s.from)) {
    keys('situation.from', s.from, ['worldVersion', 'run', 'seed'], ['print']);
    if (s.from.print !== undefined && s.from.print !== worldPrint(snap)) bad('situation.from.print', `${JSON.stringify(s.from.print)}, but this world's is ${worldPrint(snap)}: written for another make of seed ${snap.seed} (other towns)`);
    if (s.from.worldVersion !== snap.version) bad('situation.from.worldVersion', `${s.from.worldVersion}, but the snapshot is version ${snap.version}`);
    if (s.from.run !== snap.run) bad('situation.from.run', `${s.from.run}, but the snapshot's run to come is ${snap.run}`);
    if (s.from.seed !== snap.seed) bad('situation.from.seed', `${s.from.seed}, but the world's seed is ${snap.seed}`);
  } else bad('situation.from', 'expected an object');

  // ---- the target, the refuge, the threat ---------------------------------------------------------------------
  const target = isObj(s.target) ? s.target : null;
  if (!target) bad('situation.target', 'expected an object');
  else {
    keys('situation.target', target, ['settlement', 'region', 'name']);
    if (region('situation.target.region', target.region) && settlementIn('situation.target.settlement', target.settlement, target.region)) {
      const rec = settlements.get(target.settlement as string)!;
      if (rec.name !== target.name) bad('situation.target.name', `${JSON.stringify(target.name)}, but ${rec.id} is called ${rec.name}`);
      if (rec.condition === 'ruined' || rec.condition === 'abandoned') bad('situation.target.settlement', `${rec.name} is ${rec.condition}: there's no town left to save`);
    }
  }
  if (isObj(s.refuge)) {
    keys('situation.refuge', s.refuge, ['region', 'name']);
    str('situation.refuge.name', s.refuge.name);
    if (region('situation.refuge.region', s.refuge.region) && target && s.refuge.region !== target.region && !(world.neighbours(target.region as number) ?? []).includes(s.refuge.region as number))
      bad('situation.refuge.region', `${s.refuge.region} isn't the target's region or next to it (${(world.neighbours(target.region as number) ?? []).join(', ')}): the people can't walk there in a finale`);
  } else bad('situation.refuge', 'expected an object');
  const th = isObj(s.threat) ? s.threat : null;
  if (!th) bad('situation.threat', 'expected an object');
  else {
    keys('situation.threat', th, ['kind', 'name', 'faction', 'role', 'count', 'route', 'arrives'], ['outriders']);
    if (th.kind !== 'horde') bad('situation.threat.kind', `${JSON.stringify(th.kind)}: the only threat so far is 'horde'`);
    str('situation.threat.name', th.name);
    faction('situation.threat.faction', th.faction);
    str('situation.threat.role', th.role);
    int('situation.threat.count', th.count, 4, 60);
    num('situation.threat.arrives', th.arrives, 1, 120);
    const route = arr('situation.threat.route', th.route);
    if (route.length < 2) bad('situation.threat.route', 'needs at least two regions (where it rises, the target)');
    route.forEach((r, i) => {
      if (!region(`situation.threat.route[${i}]`, r)) return;
      if (i > 0 && !(world.neighbours(route[i - 1] as number) ?? []).includes(r as number)) bad(`situation.threat.route[${i}]`, `${r} doesn't border ${route[i - 1]}: a march goes border to border`);
    });
    if (target && route.length && route[route.length - 1] !== target.region) bad('situation.threat.route', `ends at ${route[route.length - 1]}, not the target's region ${target.region}`);
    if (th.outriders !== undefined) {
      if (!isObj(th.outriders)) bad('situation.threat.outriders', 'expected an object');
      else {
        keys('situation.threat.outriders', th.outriders, ['count', 'role', 'behind']);
        int('situation.threat.outriders.count', th.outriders.count, 1, 12);
        str('situation.threat.outriders.role', th.outriders.role);
        num('situation.threat.outriders.behind', th.outriders.behind, 0, 10);
      }
    }
  }

  // ---- items --------------------------------------------------------------------------------------------------
  const itemIds = new Set<string>();
  arr('situation.items', s.items).forEach((it, i) => {
    const at = `items[${i}]`;
    if (!isObj(it)) return bad(at, 'expected an ItemDef');
    keys(at, it, ['id', 'name', 'slot', 'text', 'effects'], ['also']);
    if (id(`${at}.id`, it.id, 'an item')) itemIds.add(it.id as string);
    str(`${at}.name`, it.name);
    str(`${at}.text`, it.text);
    if (!ITEM_SLOTS.includes(it.slot as never)) bad(`${at}.slot`, `${JSON.stringify(it.slot)} isn't a slot (${ITEM_SLOTS.join(', ')})`);
    arr(`${at}.also`, it.also ?? []).forEach((x, j) => {
      if (!ITEM_SLOTS.includes(x as never) || x === it.slot) bad(`${at}.also[${j}]`, `${JSON.stringify(x)}: another slot it fills (${ITEM_SLOTS.join(', ')}), not its own`);
    });
    const effs = arr(`${at}.effects`, it.effects);
    if (!effs.length) bad(`${at}.effects`, 'an item does something');
    effs.forEach((e, j) => {
      const ea = `${at}.effects[${j}]`;
      if (!isObj(e) || !ITEM_EFFECTS.includes(e.kind as string)) return bad(ea, `expected an effect (${ITEM_EFFECTS.join(', ')})`);
      switch (e.kind) {
        case 'call-allies':
          keys(ea, e, ['kind', 'count', 'uses']);
          int(`${ea}.count`, e.count, 1, 12);
          int(`${ea}.uses`, e.uses, 1, 5);
          break;
        case 'lure':
          keys(ea, e, ['kind', 'radius', 'seconds', 'uses']);
          num(`${ea}.radius`, e.radius, 5, 120);
          num(`${ea}.seconds`, e.seconds, 3, 120);
          int(`${ea}.uses`, e.uses, 1, 5);
          break;
        case 'fire-ward':
          keys(ea, e, ['kind', 'radius']);
          num(`${ea}.radius`, e.radius, 3, 120);
          break;
        case 'pace':
        case 'guard':
          keys(ea, e, ['kind', 'mult']);
          num(`${ea}.mult`, e.mult, 0.2, 1);
          break;
      }
    });
  });
  const offered = new Set<string>();
  const offer = (at: string, list: unknown) =>
    arr(at, list).forEach((x, j) => {
      if (!itemIds.has(x as string)) bad(`${at}[${j}]`, `${JSON.stringify(x)} isn't one of the situation's items`);
      offered.add(x as string);
    });

  // ---- areas --------------------------------------------------------------------------------------------------
  const areas = arr('situation.areas', s.areas).filter(isObj);
  if (areas.length < 3 || areas.length > 7) bad('situation.areas', `${areas.length} areas: a situation has 3 to 7 (a path plays 3-5)`);
  const areaById = new Map<string, J>();
  areas.forEach((a, i) => {
    const at = `areas[${i}](${a.id})`;
    keys(at, a, ['id', 'name', 'region', 'brief', 'minutes', 'play'], ['settlement', 'at', 'say']);
    if (id(`${at}.id`, a.id, 'an area')) areaById.set(a.id as string, a);
    str(`${at}.name`, a.name);
    str(`${at}.brief`, a.brief);
    region(`${at}.region`, a.region);
    num(`${at}.minutes`, a.minutes, 0.5, 15);
    if (a.settlement !== undefined) settlementIn(`${at}.settlement`, a.settlement, a.region);
    if (a.at !== undefined && (!Array.isArray(a.at) || a.at.length !== 2 || !a.at.every((v) => typeof v === 'number' && Number.isFinite(v)))) bad(`${at}.at`, 'expected [x, y] in world units');
    arr(`${at}.say`, a.say ?? []).forEach((b, j) => {
      if (!isObj(b)) return bad(`${at}.say[${j}]`, 'expected a bark');
      keys(`${at}.say[${j}]`, b, ['line'], ['by', 'seconds']);
      str(`${at}.say[${j}].line`, b.line);
    });
    const p = a.play;
    if (!isObj(p) || !PLAYS.includes(p.kind as string)) return bad(`${at}.play`, `expected a play (${PLAYS.join(', ')})`);
    const pa = `${at}.play`;
    switch (p.kind) {
      case 'flee':
      case 'town':
        keys(pa, p, ['kind']);
        break;
      case 'ambush':
        keys(pa, p, ['kind', 'foes', 'role', 'faction']);
        int(`${pa}.foes`, p.foes, 1, 20);
        str(`${pa}.role`, p.role);
        if (p.faction !== null) faction(`${pa}.faction`, p.faction);
        break;
      case 'deliver':
        keys(pa, p, ['kind', 'settlement', 'sends', 'limit'], ['gives']);
        if (settlementIn(`${pa}.settlement`, p.settlement, a.region) && a.settlement !== p.settlement) bad(`${pa}.settlement`, `the message goes to the area's own settlement (${a.settlement ?? 'none'})`);
        num(`${pa}.limit`, p.limit, 30, 600);
        if (!isObj(p.sends)) bad(`${pa}.sends`, 'expected { faction, role, count }');
        else {
          keys(`${pa}.sends`, p.sends, ['faction', 'role', 'count']);
          faction(`${pa}.sends.faction`, p.sends.faction);
          str(`${pa}.sends.role`, p.sends.role);
          int(`${pa}.sends.count`, p.sends.count, 1, 20);
        }
        if (p.gives !== undefined) offer(`${pa}.gives`, p.gives);
        break;
      case 'trader':
        keys(pa, p, ['kind', 'offers']);
        if (!arr(`${pa}.offers`, p.offers).length) bad(`${pa}.offers`, 'a trader has something to offer');
        offer(`${pa}.offers`, p.offers);
        break;
    }
  });
  for (const it of itemIds) if (!offered.has(it)) bad('situation.items', `${it} is never offered (a deliver's gives or a trader's offers)`);
  const finales = areas.filter((a) => isObj(a.play) && a.play.kind === 'town');
  if (finales.length !== 1) bad('situation.areas', `${finales.length} finales: exactly one area plays 'town'`);
  const fin = finales[0];
  if (fin && target && fin.settlement !== target.settlement) bad(`areas(${fin.id}).settlement`, `the finale is at the target (${target.settlement}), not ${fin.settlement ?? 'no settlement'}`);
  if (areas[0] && isObj(areas[0].play) && areas[0].play.kind === 'town') bad('areas[0]', 'the run starts away from the town (areas[0] is where it starts)');

  // ---- choices ------------------------------------------------------------------------------------------------
  const out = new Map<string, string[]>();
  arr('situation.choices', s.choices).forEach((c, i) => {
    const at = `choices[${i}](${isObj(c) ? c.id : '?'})`;
    if (!isObj(c)) return bad(at, 'expected a choice');
    keys(at, c, ['id', 'from', 'to', 'text', 'effects']);
    id(`${at}.id`, c.id, 'a choice');
    str(`${at}.text`, c.text);
    if (!areaById.has(c.from as string)) bad(`${at}.from`, `${JSON.stringify(c.from)} isn't an area`);
    if (!areaById.has(c.to as string)) bad(`${at}.to`, `${JSON.stringify(c.to)} isn't an area`);
    if (c.from === c.to) bad(at, 'goes nowhere (from is to)');
    if (fin && c.from === fin.id) bad(`${at}.from`, 'the finale has no way on');
    (out.get(c.from as string) ?? out.set(c.from as string, []).get(c.from as string)!).push(c.to as string);
    const effs = arr(`${at}.effects`, c.effects);
    const kinds = new Set<string>();
    effs.forEach((e, j) => {
      if (!isObj(e) || !EFFECTS.includes(e.kind as string)) return bad(`${at}.effects[${j}]`, `expected an effect (${EFFECTS.join(', ')})`);
      kinds.add(e.kind as string);
      if (e.kind === 'delay') {
        keys(`${at}.effects[${j}]`, e, ['kind', 'minutes']);
        num(`${at}.effects[${j}].minutes`, e.minutes, 0.5, 30);
      } else keys(`${at}.effects[${j}]`, e, ['kind']);
    });
    if (kinds.has('evacuate') && !kinds.has('warn')) bad(`${at}.effects`, "'evacuate' needs 'warn' too: the people follow a warning, not a stranger");
    if (kinds.has('evacuate') && fin && c.to !== fin.id) bad(`${at}.effects`, "'evacuate' is chosen on the way into the town (to the finale)");
  });
  // the run's shape: reached, ways on, a fork, no cycles, paths of 3-5 areas
  if (areas[0] && fin) {
    const start = areas[0].id as string;
    const seen = new Set<string>([start]);
    const q = [start];
    while (q.length) for (const n of out.get(q.shift()!) ?? []) if (!seen.has(n)) seen.add(n), q.push(n);
    for (const a of areas) {
      if (!seen.has(a.id as string)) bad(`areas(${a.id})`, 'no choice leads here from the start');
      if (a !== fin && !(out.get(a.id as string) ?? []).length) bad(`areas(${a.id})`, 'has no way on (only the finale ends the run)');
    }
    if (![...out.values()].some((v) => v.length >= 2)) bad('situation.choices', 'no fork: somewhere the player must choose between two ways');
    const lens: number[] = [];
    const walk = (a: string, path: string[]) => {
      if (path.includes(a)) return void bad('situation.choices', `a way back round: ${[...path, a].join(' → ')}`);
      if (a === fin.id) return void lens.push(path.length + 1);
      for (const n of out.get(a) ?? []) walk(n, [...path, a]);
    };
    walk(start, []);
    for (const l of new Set(lens)) if (l < 3 || l > 5) bad('situation.choices', `a path plays ${l} areas: 3-5 to start (the user: "3-5 areas, ~5-10 min each")`);
  }

  // ---- the clock ----------------------------------------------------------------------------------------------
  if (!P.length && th && target) {
    const map: SituationMap = {
      world: world.world,
      regionCentre: (r) => world.centre(r) ?? [0, 0],
      areaAt: (a) => (a.at ? a.at : a.settlement ? (settlements.get(a.settlement)!.at as [number, number]) : (world.centre(a.region) ?? [0, 0])),
    };
    const est = pathEstimates(s as unknown as Situation, map);
    const best = Math.min(...est.map((p) => p.minutes - (p.threat - (th.arrives as number))));
    if (!est.some((p) => p.minutes <= p.threat)) bad('situation.threat.arrives', `${th.arrives} min, but the quickest way there takes ${best.toFixed(1)} min (its delays counted): no path is in time`);
  }

  // ---- endings ------------------------------------------------------------------------------------------------
  if (!isObj(s.endings)) bad('situation.endings', 'expected { saved, burned, evacuated, fell }');
  else {
    keys('situation.endings', s.endings, [...SITUATION_ENDS]);
    for (const k of SITUATION_ENDS) {
      const e = s.endings[k];
      const at = `endings.${k}`;
      if (!isObj(e)) continue;
      keys(at, e, ['text', 'outcome'], ['settlement']);
      str(`${at}.text`, e.text);
      if (e.settlement !== undefined && !CONDITIONS.includes(e.settlement as string)) bad(`${at}.settlement`, `${JSON.stringify(e.settlement)} isn't a settlement condition (${CONDITIONS.join(', ')})`);
      if (!isObj(e.outcome)) {
        bad(`${at}.outcome`, 'expected an Outcome');
        continue;
      }
      keys(`${at}.outcome`, e.outcome, [], ['atlas', 'attitude']);
      const evs = arr(`${at}.outcome.atlas`, e.outcome.atlas ?? []);
      if (!evs.length) bad(`${at}.outcome.atlas`, 'an ending changes the world (an AtlasEvent)');
      evs.forEach((ev, i) => P.push(...atlasEventProblems(`${at}.outcome.atlas[${i}]`, ev, { regionIds, factionIds, ground: world.ground })));
      arr(`${at}.outcome.attitude`, e.outcome.attitude ?? []).forEach((a, i) => {
        const aa = `${at}.outcome.attitude[${i}]`;
        if (!isObj(a)) return bad(aa, 'expected { faction, delta }');
        keys(aa, a, ['faction', 'delta']);
        faction(`${aa}.faction`, a.faction);
        num(`${aa}.delta`, a.delta, -2, 2);
      });
      if (k === 'burned' && target && !evs.some((ev) => isObj(ev) && ev.kind === 'burn' && Array.isArray(ev.regions) && ev.regions.includes(target.region))) bad(`${at}.outcome.atlas`, `a burned town burns: a 'burn' event on the target's region ${target.region}`);
    }
  }
  return P;
}

/** a line for the validator's "ok": the paths and their minutes against the clock */
export function situationSummary(sit: Situation, world: SituationWorld): string {
  const sett = new Map(world.snapshot.settlements.map((s) => [s.id, s]));
  const map: SituationMap = {
    world: world.world,
    regionCentre: (r) => world.centre(r) ?? [0, 0],
    areaAt: (a) => (a.at ? a.at : a.settlement ? (sett.get(a.settlement)!.at as [number, number]) : (world.centre(a.region) ?? [0, 0])),
  };
  const est = pathEstimates(sit, map);
  return est.map((p) => `${p.areas.join(' → ')} [${p.effects.join(', ') || 'no effects'}]: ${p.minutes.toFixed(1)} min (${p.minutes <= p.threat ? 'in time' : 'late'}; the threat at ${p.threat.toFixed(1)})`).join('\n');
}
