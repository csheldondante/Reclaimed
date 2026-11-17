// (card-table; docs/design/PACK_FORMAT.md) The loader for outside-authored opportunity packs: one pack's JSON → the
// engine's own types. A card becomes a `TemplateDef` (living/engine.ts) whose conditions and effects are the template
// language's own (living/dsl.ts) and the Realm's and the mutators' existing helpers (`pool`, `income`, `mutateAt`,
// `mutate`, `sign`, `found`, `spell`, `neighbour`, `refugeeCohort`); what those cannot say is a small set of helpers
// here (`packHelpers`), given to the Realm through `RealmOptions.extra`. A pack's rules are the engine's `RuleDef` as
// they are. A pack with errors (packs/check.ts) is refused: nothing is patched.
// The text a card shows for "if taken" and "if left" is written here FROM its effects, so every number the player
// reads is the number the engine applies; the author's `say` sentences are added after it.
import type { EntityId } from '../api/contracts/facts';
import type { BindSpec, Effect, Helper, Pred } from '../living/dsl';
import type { Tier } from '../api/contracts/opportunity';
import type { TemplateDef } from '../living/engine';
import type { LiveCond, LiveDef, LiveWhere } from '../living/live';
import type { RuleDef, Thing } from '../living/rules';
import type { LawDef, LawDo } from '../living/laws';
import type { FactWorld } from '../living/world';
import { placeState, placeStates } from '../mutate/facts';
import { helper as dslHelper } from '../living/dsl';
import { checkPack, reportText, siteOf, GOODS, PEOPLE, type Pack, type PackAbility, type PackCard, type PackCond, type PackEffect, type PackEvent, type PackLeader, type PackTag, type PackThing, type Problem } from './check';

const POOL_WORD: Record<string, string> = { magic: 'Magic', might: 'Might', labor: 'Labor', materials: 'Materials', intel: 'Intel', unrest: 'Unrest' };
const LAND_WORD: Record<string, string> = { flooded: 'is flooded', burned: 'burns', melted: 'goes under lava', buried: 'is buried', dried: 'dries up', withered: 'withers', greened: 'grows over, thick and green' };
const FAR_WORD: Record<string, string> = { captured: 'is taken', vassal: 'swears to you', destroyed: 'is destroyed', abandoned: 'is abandoned' };
const SIGN_WORD: Record<string, string> = { ashfall: 'Ash falls on the town', darkness: 'The sky goes dark over the town', deadrise: 'The dead walk the streets', crime: 'Thieves work the streets' };
const SITE_NAME: Record<string, string> = { keep: 'the keep yard', forge: 'the smithy', quarter: 'the weavers\' street', fields: 'the east fields', market: 'the market', gate: 'the road gate', tower: 'the old tower', dam: 'the old dam', shrine: 'the mountain shrine', mill: 'the mill street', wall: 'the town\'s edge', watch: 'the watch post', harbour: 'the waterside', quarry: 'the quarry hill', woods: 'the woods', river: 'the river crossing', road: 'the trade road', pit: 'the ore yard', wagons: 'the wagon yard', graves: 'the old burial ground' };
const BASE_SPELL: Record<string, string> = { 'heat-ray': 'heatray', fire: 'fire', rain: 'rain', 'growth-rune': 'growth' };

/** the tag only a pack's thing itself carries (never lent, never shown): its upkeep rule reads it */
export const IS = 'is:';
const isTag = (thing: string): string => `${IS}${thing}`;
/** what a cast of each pack ability does to a live event (as living/live.ts SPELL_MECH for the spells) */
export function packMech(packs: readonly LoadedPack[]): Record<string, { kills?: number; douses?: number }> {
  return Object.fromEntries(packs.flatMap((p) => p.abilities).filter((a) => !!a.in_event).map((a) => [a.id, { ...(a.in_event!.kills ? { kills: a.in_event!.kills } : {}), ...(a.in_event!.douses ? { douses: a.in_event!.douses } : {}) }]));
}
/** the fact event that says a pack's ability is the player's (this run's history has it: saved with the world) */
export const UNLOCKED = 'ability-unlocked:';

/** the id of a pack's thing in the fact world */
export const thingEntity = (id: string): EntityId => `thing:${id}`;
/** the fact events a pack card leaves: resolved, run out */
const doneKind = (card: string): string => `pack-done:${card}`;
const lapsedKind = (card: string): string => `pack-lapsed:${card}`;

export interface LoadedPack {
  id: string;
  name: string;
  templates: TemplateDef[];
  /** the engine's RuleDef, as written */
  rules: RuleDef[];
  tags: PackTag[];
  things: PackThing[];
  events: PackEvent[];
  abilities: PackAbility[];
  /** (laws) the pack's laws as the engine's LawDef (spells by the engine's ids) */
  laws: LawDef[];
  /** (the record) the laws each card leaves for every later run (`laws_after`), and what each card's conditions ask of
   *  earlier cards: cards resolved, remains of things */
  recordLaws: { card: string; laws: string[]; results?: string[] }[];
  because: Record<string, { resolved: string[]; remains: string[] }>;
  /** cards left out, each with why (what the engine cannot play yet) */
  left: { card: string; why: string }[];
  problems: Problem[];
}

/** what the helpers ask of whoever runs the Realm (table/game.ts): the run as it stands */
export interface PackHost {
  season(): number;
  pool(k: string): number;
  leader(): string;
  home(): EntityId;
  /** the tags on the home town and on each of its sites now */
  tags(where: 'town' | 'site'): string[][];
  /** the history's turn of the run's first season (an ability unlocked in an earlier run is not this run's) */
  began(): number;
  /** (draft 7) the tags of the thing of the rules with this id now (a site, a far town, a found place); null: none */
  thingTags(id: EntityId): readonly string[] | null;
}

// ---- (ages) leaders the world offers ---------------------------------------------------------------------------------

/** whether the world fits a pack leader's `appears_when` (read before the run: the record, the far places, factions) */
export function leaderFits(w: FactWorld, l: PackLeader, home: EntityId): boolean {
  return (l.appears_when ?? []).every((c) => {
    if ('resolved' in c) return recordEvents(w).some((e) => e.card === c.resolved && (c.tier?.length ? c.tier.includes(e.result) : e.result !== 'lapsed'));
    if ('far_town_is' in c) return farThings(w, [], home).some((t) => t.tags.includes('far-town') && c.far_town_is.some((s) => t.tags.includes(s)));
    if ('faction_stance' in c) return c.is.includes(stanceOf(w, c.faction_stance, c.with ?? 'player'));
    if ('faction_holds' in c) {
      const fac = c.faction_holds === 'player' ? 'yours' : c.faction_holds;
      const n = farThings(w, [], home).filter((t) => t.tags.includes(fac) && t.tags.includes('standing')).length;
      return n >= (c.gte ?? (c.lte === undefined ? 1 : 0)) && n <= (c.lte ?? 1e9);
    }
    return false;
  });
}
/** the record's cards (card-done / card-lapsed fact events: season/realm.ts recordOf, read here without the Realm) */
function recordEvents(w: FactWorld): { card: string; result: string }[] {
  return w.facts
    .events()
    .filter((e) => (e.kind.startsWith('card-done:') || e.kind === 'card-lapsed') && !!e.about?.thing)
    .map((e) => ({ card: e.about!.thing!, result: e.kind === 'card-lapsed' ? 'lapsed' : e.kind.slice('card-done:'.length) }));
}
/** a pack leader's start on the run's world: its things put in play (at their own places) */
export function startThings(w: FactWorld, packs: readonly LoadedPack[], l: PackLeader, home: EntityId, siteOfKey: (k: string) => EntityId): void {
  const home_ = w.settlement(home)!;
  for (const id of l.things ?? []) {
    const t = packs.flatMap((p) => p.things).find((x) => x.id === id);
    if (!t || w.facts.entity(thingEntity(id))) continue;
    const k = siteOf(t.at);
    w.facts.add({ id: thingEntity(id), kind: 'building', name: t.name, at: { region: home_.region, settlement: home, ...(k ? { site: siteOfKey(k) } : {}) }, attrs: { thing: t.id, what: t.kind }, cause: `leader:${l.id}` });
  }
}

// ---- (draft 7) factions, stances, far towns as things ---------------------------------------------------------------

const STANCE_REL = { hostile: 'at_war_with', truce: 'truce_with', allied: 'allied_with' } as const;
/** the stance between two (a faction, the player, another faction): hostile, truce, allied, or none */
export function stanceOf(w: FactWorld, a: EntityId, b: EntityId): string {
  for (const [s, type] of Object.entries(STANCE_REL)) if (w.facts.relations({ type, from: a, to: b, historic: false }).length || w.facts.relations({ type, from: b, to: a, historic: false }).length) return s;
  return 'none';
}
/** whose a far town is: who occupies it, else its lord, else who founded it and holds it (the stored `controls`) */
export function farHolder(w: FactWorld, id: EntityId): EntityId | null {
  const f = w.facts;
  return f.relations({ type: 'occupies', to: id })[0]?.from ?? f.relations({ type: 'vassal_of', from: id, historic: false })[0]?.to ?? f.relations({ type: 'controls', to: id })[0]?.from ?? null;
}
/** the found place of a far town (where a card revealed what it is for): `<id>:find` */
export const findId = (place: string): EntityId => `${place}:find`;
/** the pack factions of the world (entities the packs declared) */
export function packFactions(w: FactWorld): EntityId[] {
  return w.facts.find({ kind: 'faction' }).filter((e) => !!e.attrs.packFaction).map((e) => e.id);
}
/** the packs' factions made entities of the world, once (a world that has them keeps them, run after run) */
export function seedFactions(w: FactWorld, packs: readonly Pack[]): void {
  for (const p of packs) for (const x of p.factions ?? []) if (!w.facts.entity(x.id)) w.facts.add({ id: x.id, kind: 'faction', name: x.name, attrs: { packFaction: x.kind, text: x.text }, cause: `pack:${p.pack.id}` });
}

/**
 * (draft 7) The far places as things the rules read: every far town with what it is now — `far-town`, its state
 * (standing, destroyed, abandoned, occupied, vassal, founded), `standing` or `ruined`, whose it is (`yours`, or a
 * pack faction's id), what it was founded for (its resource tag), `colony` (founded, yours, standing), the pack tags set
 * on it — and every place found and not yet settled (`found` and its resource).
 */
export function farThings(w: FactWorld, packs: readonly LoadedPack[], home: EntityId): Thing[] {
  // (read many times a deal — every candidate of a far variable, every reading of the rules: kept until the fact
  // store, the world's records or the turn move)
  const key = w.facts.version === undefined ? null : `${w.facts.version}|${w.ws.version}|${w.turn}|${home}|${packs.length}`;
  const hit = FAR_CACHE.get(w);
  if (key && hit?.key === key) return hit.things.map((t) => ({ ...t, tags: [...t.tags] }));
  const things = farThingsNow(w, packs, home);
  if (key) FAR_CACHE.set(w, { key, things: things.map((t) => ({ ...t, tags: [...t.tags] })) });
  return things;
}
const FAR_CACHE = new WeakMap<FactWorld, { key: string; things: Thing[] }>();
function farThingsNow(w: FactWorld, packs: readonly LoadedPack[], home: EntityId): Thing[] {
  const f = w.facts;
  const mine = new Set(packFactions(w));
  const out: Thing[] = [];
  const foundings = new Set(f.events({ kind: 'founding' }).flatMap((e) => e.to));
  for (const s of w.ws.settlements) {
    if (s.id === home || !f.entity(s.id)) continue;
    const st = placeState(w, s.id)?.status ?? 'standing';
    const holder = farHolder(w, s.id);
    const gone = st === 'destroyed' || st === 'abandoned';
    const standing = !gone && !(st === 'occupied' && holder !== 'player') && !f.tag(s.id, 'condition', 'lost')?.value;
    const founded = foundings.has(s.id);
    const resource = f.entity(findId(s.id))?.attrs.resource;
    const who = holder === 'player' ? 'yours' : holder && mine.has(holder) ? holder : null;
    // (a colony: founded by you — you hold its `controls` — still yours and standing; a haven sworn to you is no colony)
    const colony = founded && who === 'yours' && standing && f.relations({ type: 'controls', from: 'player', to: s.id }).length > 0;
    const tags = ['town', 'far-town', st, standing ? 'standing' : 'ruined', ...(who ? [who] : []), ...(typeof resource === 'string' ? [resource] : []), ...(founded ? ['founded'] : []), ...(colony ? ['colony'] : []), ...packTagsOn(w, s.id, packs)];
    out.push({ id: s.id, name: s.name, tags: [...new Set(tags)], at: [s.at[0], s.at[1]], town: s.id });
  }
  for (const d of f.find({ kind: 'deposit' })) if (d.attrs.packFound && !f.tag(d.id, 'condition', 'settled')) out.push({ id: d.id, name: d.name, tags: ['found', String(d.attrs.resource)], at: null, town: d.id });
  return out;
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
/** (places) the places a pack founds: id → name */
export function foundedOf(p: Pack): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of p.cards ?? [])
    for (const e of [...(c.if_taken ?? []), ...(c.if_expires ?? []), ...Object.values(c.if_tier ?? {}).flat()] as Record<string, unknown>[])
      if (e && (e.far === 'founded' || e.far === 'revealed') && typeof e.id === 'string') out[e.id] = String(e.name ?? e.id);
  return out;
}
/** (places) a far place selector other than the neighbour: every far town, the n nearest, those in a state, a place
 *  the pack founded, or the whole world */
export const isSelector = (ref: string | undefined): boolean => !!ref && (ref === 'world' || (ref.startsWith('far:') && ref !== 'far:neighbour'));
const STATE_WORD: Record<string, string> = { standing: 'standing town', destroyed: 'destroyed town', abandoned: 'abandoned town', occupied: 'occupied town', vassal: 'town sworn to you', founded: 'new town', 'trade-partner': 'town that trades with you', 'founded-by-player': 'town you founded' };
/** a selector in words, read as one ("every far town is flooded"); `founded`: the names of places the pack founds */
function selectorWord(ref: string, founded: Record<string, string> = {}): string {
  if (ref === 'world') return 'every town, yours too';
  if (ref === 'far:all') return 'every far town';
  const n = /^far:nearest:(\d+)$/.exec(ref)?.[1];
  if (n) return n === '1' ? 'the nearest standing town' : `each of the ${n} nearest standing towns`;
  const st = /^far:where:(.+)$/.exec(ref)?.[1];
  if (st) return `every ${STATE_WORD[st] ?? `${st} town`}`;
  const id = ref.slice(4);
  return founded[id] ?? id;
}
let FOUNDED: Record<string, string> = {};
/** (draft 7) the card being written: its variables' bound names (`$port` → `v_port`, the presenter's → `site`) and
 *  the pack's factions by id */
let VARS: Record<string, string> = {};
let FACTIONS: Record<string, string> = {};
/** bound name → what it binds */
let VARKIND: Record<string, 'site' | 'far' | 'faction'> = {};
/** a variable's bound name in the template (the presenter's site variable is the card's own `site`) */
export function varName(c: Pick<PackCard, 'presenter'>, v: string): string {
  return c.presenter?.at === `$${v}` ? 'site' : `v_${v}`;
}
/** a reference with its variable renamed: '$port' → '$v_port' (anything else as it is) */
const vref = (ref: string): string => (ref.startsWith('$') ? `$${VARS[ref.slice(1)] ?? `v_${ref.slice(1)}`}` : ref);
/** text with its `{var}` placeholders renamed to the bound names the engine fills */
export const vtext = (s: string, vars: Record<string, string>): string => s.replace(/\{([a-z][\w-]*)\}/gi, (m, k: string) => (vars[k] ? `{${vars[k]}}` : m));
const where = (ref: string | undefined): string => (ref === 'town' || !ref ? 'the town' : ref.startsWith('$') ? `{${vref(ref).slice(1)}}` : ref === 'far:neighbour' ? '{other}' : isSelector(ref) ? selectorWord(ref, FOUNDED) : (SITE_NAME[siteOf(ref) ?? ''] ?? ref));
/** a faction (or the player, the raiders, the dead) in words */
const whoWord = (by: string | undefined): string => (!by || by === 'raiders' ? 'raiders' : by === 'player' ? 'you' : by === 'dead' ? 'the dead' : by.startsWith('$') ? `{${vref(by).slice(1)}}` : (FACTIONS[by] ?? by));
const STANCE_WORD: Record<string, string> = { hostile: 'are enemies now', truce: 'keep a truce', allied: 'are allies', none: 'owe each other nothing now' };
const SIGN_OVER: Record<string, string> = { ashfall: 'Ash falls on', darkness: 'Darkness falls over', deadrise: 'The dead walk in', crime: 'Thieves work the streets of' };

/** what a list of effects does, in plain sentences written from the data (the numbers are the engine's) */
export function effectsText(list: readonly PackEffect[], p: Pack, vars: Record<string, string> = {}): string {
  FOUNDED = foundedOf(p);
  VARS = vars;
  FACTIONS = Object.fromEntries((p.factions ?? []).map((f) => [f.id, f.name]));
  const out: string[] = [];
  const says: string[] = [];
  for (const e of list) {
    const x = e as Record<string, unknown>;
    if ('say' in e) says.push(vtext(String(e.say).trim(), vars));
    // (draft 7: a place found, a camp founded at it or by a faction, a town taken or sworn to a faction, a stance)
    else if ('far' in e && e.far === 'revealed') out.push(`${String(x.name)} is marked on the map: ${String(x.resource)}, not yet settled.`);
    else if ('far' in e && e.far === 'founded' && typeof x.where === 'string') out.push(`A camp is settled at ${where(x.where)}${x.by && x.by !== 'player' ? ` by ${whoWord(String(x.by))}` : ''}.`);
    else if ('far' in e && e.far === 'founded' && x.by && x.by !== 'player') out.push(`${String(x.name)} is founded by ${whoWord(String(x.by))}.`);
    else if ('far' in e && (e.far === 'captured' || e.far === 'vassal') && x.by && x.by !== 'player' && x.by !== 'raiders') out.push(`${cap(where(e.where))} ${e.far === 'captured' ? 'is taken by' : 'swears to'} ${whoWord(String(x.by))}.`);
    else if ('stance' in e) out.push(`${cap(whoWord(e.stance))} and ${x.with && x.with !== 'player' ? whoWord(String(x.with)) : 'you'} ${STANCE_WORD[e.to]}.`);
    else if ('pool' in e) out.push(e.pool === 'unrest' ? `Unrest ${e.add > 0 ? '+' : ''}${e.add}.` : `${e.add > 0 ? '+' : ''}${e.add} ${POOL_WORD[e.pool]}.`);
    else if ('income' in e) out.push(`${e.add > 0 ? '+' : ''}${e.add} ${POOL_WORD[e.income]} each season.`);
    else if ('put' in e) out.push(`In play: ${p.things?.find((t) => t.id === e.put)?.name ?? e.put}.`);
    else if ('remove' in e) out.push(`You lose ${p.things?.find((t) => t.id === e.remove)?.name ?? e.remove}.`);
    else if ('tag' in e) out.push(`${cap(where(e.on))} is now ${e.tag}.`);
    else if ('untag' in e) out.push(`${cap(where(e.on))} is no longer ${e.untag}.`);
    else if ('mutate' in e) out.push(`${cap(where(e.where))} ${LAND_WORD[e.mutate]}.`);
    else if ('far' in e) out.push(e.far === 'founded' ? `${String(x.name)} is founded.` : `${cap(where(e.where))} ${FAR_WORD[e.far]}.`);
    else if ('sign' in e) out.push(`${!x.where || x.where === 'town' ? SIGN_WORD[e.sign] : `${SIGN_OVER[e.sign]} ${where(String(x.where))}`} for ${e.seasons ?? 3} seasons.`);
    else if ('trade' in e) out.push(x.end ? `${cap(where(e.trade))} no longer trades with you.` : `${cap(where(e.trade))} trades with you.`);
    else if ('arrive' in e) out.push('40 refugees walk in from {other}.');
    else if ('unlock' in e) out.push(`You can cast ${p.abilities?.find((a) => a.id === e.unlock)?.name ?? e.unlock}.`);
    else if ('law' in e) out.push(`A new law, "${p.laws?.find((l) => l.id === e.law)?.name ?? e.law}", ${e.seasons ? `for this season and ${e.seasons} more` : 'for the rest of the run'}.`);
    else if ('far_all' in e) out.push(`Every far town ${FAR_WORD[e.far_all === 'captured' ? 'captured' : e.far_all] ?? e.far_all}${e.by && e.by !== 'raiders' ? ` by ${whoWord(e.by)}` : ''}.`);
    else if ('end_run' in e) out.push(`The run ends here: ${e.name}.`);
  }
  return [...says, ...out].join(' ');
}

function conds(list: readonly PackCond[], site: string, need: Set<string> = new Set()): Pred[] {
  return list.map((c): Pred => {
    if ('pool' in c) return { helper: 'packPool', args: [c.pool, c.gte ?? -1e9, c.lte ?? 1e9] };
    if ('season_gte' in c) return { helper: 'packSeason', args: [c.season_gte] };
    if ('has_thing' in c) return { helper: 'exists', args: [thingEntity(c.has_thing)] };
    if ('no_thing' in c) return { not: { helper: 'exists', args: [thingEntity(c.no_thing)] } };
    if ('town_has' in c) return { helper: 'packTags', args: ['town', ...c.town_has] };
    if ('site_has' in c) return { helper: 'packTags', args: ['site', ...c.site_has] };
    if ('far_town_is' in c) return { helper: 'packFar', args: [...c.far_town_is] };
    // (the record: with a result, a place or "earlier", the Realm's record of resolved cards over every run)
    if ('resolved' in c) {
      // (draft 7: `about` — done about this place or faction: the card's record names what it was bound to)
      const about = c.about ? (c.about.startsWith('$') ? vref(c.about) : c.about.replace(/^far:/, '')) : '';
      if (!c.tier && !c.at && !c.run && !about) return { event: { kind: doneKind(c.resolved), involving: '$town' } };
      return { helper: 'recordHas', args: [c.resolved, (c.tier ?? []).join('|'), c.at ? (c.at === 'town' ? '$town' : refOf(c.at, need)) : '', c.run ?? 'any', about] };
    }
    if ('leader' in c) return { helper: 'packLeader', args: [c.leader] };
    // (draft 7: factions)
    if ('faction_holds' in c) return { helper: 'packHolds', args: [vref(c.faction_holds), c.gte ?? (c.lte === undefined ? 1 : 0), c.lte ?? 1e9] };
    if ('faction_stance' in c) return { helper: 'packStanceIs', args: [vref(c.faction_stance), vref(c.with ?? 'player'), ...c.is] };
    throw new Error(`pack: no condition ${JSON.stringify(c)} at ${site}`);
  });
}

/** a place reference as a template's bound name; the sites and far places it needs bound are collected in `need` */
function refOf(ref: string | undefined, need: Set<string>): string {
  if (!ref || ref === 'town') return '$town';
  // (draft 7: a variable of the card: bound by its own spec)
  if (ref.startsWith('$')) return vref(ref);
  if (ref === 'far:neighbour') {
    need.add('far');
    return '$other';
  }
  const k = siteOf(ref)!;
  // (the card's own site is bound already: an entity is bound once)
  if (need.has(`own:${k}`)) return '$site';
  need.add(k);
  return `$s_${k}`;
}

function effects(list: readonly PackEffect[], p: Pack, need: Set<string>, note: string): Effect[] {
  const out: Effect[] = [];
  for (const e of list) {
    if ('say' in e) continue;
    if ('pool' in e) out.push({ helper: 'pool', args: [e.pool, e.add] });
    else if ('income' in e) out.push({ helper: 'income', args: [e.income, e.add] });
    else if ('put' in e) out.push({ helper: 'packPut', args: [e.put, refOf(e.at ?? p.things!.find((t) => t.id === e.put)!.at, need)] });
    else if ('remove' in e) out.push({ helper: 'packRemove', args: [e.remove] });
    else if ('tag' in e) out.push({ helper: 'packTag', args: [refOf(e.on, need), e.tag, p.tags?.find((t) => t.id === e.tag)?.timed || ['festival', 'growth-active'].includes(e.tag) ? 1 : 0] });
    else if ('untag' in e) out.push({ helper: 'packUntag', args: [refOf(e.on, need), e.untag] });
    // (places: a selector — every far town, the n nearest, those in a state, a place the pack founded, the world —
    // through the Realm's `eachTown`; the card appears only while the selector names a town)
    else if ('mutate' in e && isSelector(e.where)) {
      need.add(`sel:${e.where}`);
      out.push({ helper: 'eachTown', args: [e.where, 'mutate', e.mutate, '$each'] });
    } else if ('far' in e && e.far !== 'founded' && isSelector(e.where)) {
      const x = e as { far: string; where: string; by?: string; tribute?: number };
      need.add(`sel:${x.where}`);
      out.push({ helper: 'eachTown', args: [x.where, 'mutate', x.far, '$each', 1, 1, vref(x.by ?? (x.far === 'vassal' ? 'player' : 'raiders')), ...(x.far === 'vassal' ? [x.tribute ?? 1] : [])] });
    } else if ('sign' in e && e.where && e.where !== 'town') {
      need.add(`sel:${e.where}`);
      out.push({ helper: 'eachTown', args: [e.where === 'far:neighbour' ? 'far:neighbour' : e.where, 'sign', e.sign, '$each', e.strength ?? 0.6, e.seasons ?? 3] });
    } else if ('trade' in e) {
      need.add(`sel:${e.trade}`);
      out.push({ helper: 'trade', args: [e.trade, e.end ? 'off' : 'on'] });
    } else if ('mutate' in e) {
      const r = refOf(e.where, need);
      // (a site: the fact first, then its physical side, as the base game's hazards do — season/realm-templates.ts)
      if (r === '$site' || r.startsWith('$s_') || VARKIND[r.slice(1)] === 'site') out.push({ setTag: [r, 'condition', e.mutate, true] }, { event: e.mutate, by: [], to: [r, '$town'], note, weight: -0.4 }, { helper: 'mutateAt', args: [e.mutate, r, 24, 1] });
      else out.push({ helper: 'mutate', args: [e.mutate, r] });
    } else if ('far' in e) {
      const x = e as { far: string; where?: string; by?: string; tribute?: number; id?: string; name?: string; purpose?: string; resource?: string };
      // (draft 7: who does it — the player, the raiders, the dead, a faction of the pack or a faction variable)
      const by = vref(x.by ?? (x.far === 'vassal' || x.far === 'founded' ? 'player' : 'raiders'));
      if (x.far === 'revealed') out.push({ helper: 'packReveal', args: [x.id!, x.name!, x.resource!] });
      else if (x.far === 'founded' && x.where) out.push({ helper: 'packFoundAt', args: [refOf(x.where, need), x.purpose ?? '', by] });
      else if (x.far === 'founded') out.push({ helper: 'packFound', args: [x.id!, x.name!, x.purpose ?? '', by, x.resource ?? ''] });
      else {
        const r = refOf(x.where, need);
        if (x.far === 'captured') out.push({ setTag: [r, 'condition', 'occupied', true] });
        out.push({ helper: 'mutate', args: [x.far, r, 1, 1, by, ...(x.far === 'vassal' ? [x.tribute ?? 1] : [])] });
      }
    } else if ('stance' in e) {
      const x = e as { stance: string; to: string; with?: string };
      out.push({ helper: 'packStance', args: [vref(x.stance), vref(x.with ?? 'player'), x.to] });
    } else if ('sign' in e) out.push({ helper: 'sign', args: [e.sign, '$town', e.strength ?? 0.6, e.seasons ?? 3] });
    else if ('arrive' in e) {
      need.add('far');
      out.push({ migrate: ['$other', '$town', 0.3], note: 'refugees from {other} walked in along the road' }, { helper: 'refugeeCohort', args: ['$town', '$town'] });
    } else if ('unlock' in e) out.push(BASE_SPELL[e.unlock] ? { helper: 'spell', args: [BASE_SPELL[e.unlock]] } : { helper: 'packUnlock', args: [e.unlock] });
    // (laws: the Realm's own `law` helper — season/realm.ts)
    else if ('law' in e) out.push({ helper: 'law', args: [e.law, e.seasons ?? 0] });
    // (endings and the world: the Realm's `endRun` and `farAll`)
    else if ('end_run' in e) out.push({ helper: 'endRun', args: [e.end_run, e.name] });
    else if ('far_all' in e) out.push({ helper: 'eachTown', args: ['far:all', 'mutate', e.far_all, '$each', 1, 1, vref(e.by ?? 'raiders')] });
  }
  return out;
}

/** (draft 7) a card's variables as the engine's bindings: a site of the home town, a far place (or a found one), a
 *  faction of a pack — each tested by what the rules read (the place's tags, its holder, the faction's stance) */
function varBinds(c: PackCard): { binds: BindSpec[]; site: BindSpec | null; refs: string[] } {
  const binds: BindSpec[] = [];
  let site: BindSpec | null = null;
  const refs: string[] = [];
  for (const [v, s] of Object.entries(c.bind ?? {})) {
    const as = varName(c, v);
    const asked: Pred[] = s.set_off ? [{ helper: 'askedOn', args: [`$${as}`, c.id] }] : [];
    if ('site' in s) {
      const spec: BindSpec = { as, kind: 'site', ...(as === 'site' ? {} : { shared: true }), where: [{ helper: 'packSite', args: [`$${as}`] }, { helper: 'packIs', args: [`$${as}`, (s.site.tags ?? []).join('|'), (s.site.not ?? []).join('|')] }, ...asked] };
      if (as === 'site') site = spec;
      else binds.push(spec);
    } else if ('far' in s) {
      const st = s.far.state ?? [];
      binds.push({ as, kind: st.includes('found') ? ['settlement', 'deposit'] : 'settlement', shared: true, where: [{ helper: 'packFarIs', args: [`$${as}`, st.join('|'), (s.far.tags ?? []).join('|'), (s.far.not ?? []).join('|'), s.far.holder ? vref(s.far.holder) : ''] }, ...asked] });
    } else binds.push({ as, kind: 'faction', shared: true, where: [{ helper: 'packFactionIs', args: [`$${as}`, (s.faction.stance ?? []).join('|'), vref(s.faction.with ?? 'player')] }, ...asked] });
    refs.push(`$${as}`);
  }
  return { binds, site, refs };
}

function template(c: PackCard, p: Pack, after: string[], boost: boolean): TemplateDef {
  // (draft 7: the card's variables, renamed for the engine; the presenter may sit at a bound site)
  VARS = Object.fromEntries(Object.keys(c.bind ?? {}).map((v) => [v, varName(c, v)]));
  VARKIND = Object.fromEntries(Object.entries(c.bind ?? {}).map(([v, s]) => [varName(c, v), 'site' in s ? 'site' : 'far' in s ? 'far' : 'faction']));
  const vars = VARS;
  const vb = varBinds(c);
  const site = vb.site ? '' : siteOf(c.presenter.at)!;
  const need = new Set<string>(site ? [`own:${site}`] : []);
  const event = c.live ? p.events!.find((e) => e.id === c.live)! : null;
  const taken = c.if_taken ?? [];
  const left = c.if_expires ?? [];
  // (a live card: what the player reads for "if taken" is what there is to do at the event)
  const takenText = event ? vtext(event.how, vars) : effectsText(taken, p, vars);
  const leftText = effectsText(left, p, vars);
  VARS = vars;
  const outcome = effects(taken, p, need, takenText);
  const onExpire = effects(left, p, need, leftText);
  // (the record and `once` read what the card was bound to: its site, the town, and each variable)
  const about = [...new Set(['$site', '$town', ...vb.refs])];
  const done = (note: string): Effect => ({ event: doneKind(c.id), by: ['player'], to: about, note, weight: 0.2 });
  // (each result of its event: its effects, and its words written from them)
  const outcomes = event
    ? Object.fromEntries(
        (Object.entries(c.if_tier ?? {}) as [Tier, PackEffect[]][]).map(([tier, list]) => {
          const words = effectsText(list, p, vars);
          VARS = vars;
          return [tier, { text: words, effects: [...effects(list, p, need, words), done(words)] }];
        }),
      )
    : null;
  const cost = c.cost ?? {};
  const agents = PEOPLE.filter((k) => cost[k] > 0).map((k) => ({ kind: k === 'labor' ? ('workers' as const) : ('army' as const), count: cost[k] }));
  const goods = Object.fromEntries(GOODS.filter((k) => cost[k] > 0).map((k) => [k, cost[k]]));
  const when: PackCond[] = [...(p.pack.appears_when ?? []), ...(c.appears_when ?? []), ...after.map((id) => ({ resolved: id }))];
  // (its conditions first: one may name a place to bind; then one test a selector its effects name — it appears only
  // while that names a town)
  // (`once`: true — once for each binding (a card with no variables: once, as before); "run" — once a run whatever it
  // binds; false — it comes back)
  const once: Pred[] = c.once === false ? [] : [{ helper: 'packNotDone', args: [c.id, c.once === 'run' ? 'run' : 'any', '$town', ...vb.refs] }];
  const eligible: Pred[] = [...conds(when, c.id, need), ...[...need].filter((k) => k.startsWith('sel:')).map((k): Pred => ({ helper: 'townsExist', args: [k.slice(4)] })), ...once];
  // (a card that names no far place needs none: one that does appears only while a neighbour stands)
  // (draft 7: its variables — factions first, then far places, then sites, so a later one may name an earlier)
  const order = { faction: 0, settlement: 1, deposit: 1, site: 2 } as Record<string, number>;
  const varSpecs = [...vb.binds].sort((a, b) => order[[a.kind].flat()[0]] - order[[b.kind].flat()[0]]);
  const bind: BindSpec[] = [
    { as: 'town', kind: 'settlement', where: [{ helper: 'isHome', args: ['$town'] }] },
    ...varSpecs.filter((s) => [s.kind].flat()[0] !== 'site'),
    vb.site ?? { as: 'site', kind: 'site', where: [{ helper: 'siteIs', args: ['$site', site] }] },
    ...varSpecs.filter((s) => [s.kind].flat()[0] === 'site'),
    ...[...need].filter((k) => k !== 'far' && !k.startsWith('own:') && !k.startsWith('sel:')).map((k): BindSpec => ({ as: `s_${k}`, kind: 'site', shared: true, where: [{ helper: 'siteIs', args: [`$s_${k}`, k] }] })),
    ...(need.has('far') ? [{ as: 'other', kind: 'settlement' as const, shared: true, where: [{ helper: 'neighbour', args: ['$other'] }] as Pred[] }] : []),
  ];
  return {
    id: c.id,
    title: vtext(c.title, vars),
    pitch: vtext(c.pitch, vars),
    themes: [...(p.pack.themes ?? []), `pack:${p.pack.id}`],
    bind,
    eligible,
    at: 'site',
    // (the dealer's score parts: as the base game's hazards and mid-value projects; `boost`: above them, so a pack
    // being tried comes up early)
    // (`weight` 1..5 is the card's own say, with or without the boost: 0.2 a step, 3 a middling base card)
    ...(c.threat ? { threat: true, parts: { urgency: c.weight ? 0.4 + 0.1 * c.weight : boost ? 0.9 : 0.7 } } : { parts: { ev: c.weight ? 0.2 * c.weight - 0.1 : boost ? 0.95 : 0.5 } }),
    live: true,
    requires: { agents, goods },
    turns: c.build_seasons ?? 1,
    work: 'labour',
    ...(event && outcomes ? { play: { area: '$site', event: liveDef(event) }, vars: 'live', outcomes } : { outcome: [...outcome, done(takenText)], outcomeText: takenText }),
    ...(left.length ? { onExpire: [...onExpire, { event: lapsedKind(c.id), by: [], to: about, note: leftText, weight: -0.3 }], expireText: leftText } : {}),
    presenter: { of: '$town', role: c.presenter.role, own: true, verb: c.threat ? 'warns' : 'asks', line: vtext(c.pitch, vars) },
    reward: { text: takenText },
    offerTurns: c.offer_seasons ?? 3,
    cooldown: 3,
    ...(c.once === false ? {} : { once: true }),
  };
}

/** A pack loaded. Throws, with the validator's report, if the pack has errors. */
export function loadPack(p: Pack, base: { cards?: readonly string[]; rules?: readonly string[]; boost?: boolean } = {}): LoadedPack {
  const problems = checkPack(p, base);
  if (problems.some((x) => x.level === 'error')) throw new Error(reportText(`Pack ${p?.pack?.id ?? '?'}`, problems));
  const left: LoadedPack['left'] = [];
  const templates: TemplateDef[] = [];
  for (const c of p.cards ?? []) {
    const after = (p.cards ?? []).filter((o) => o.leads_to?.includes(c.id)).map((o) => o.id);
    templates.push(template(c, p, after, !!base.boost));
  }
  // (a thing's upkeep is a rule like any other: each season it is in play, so much of a pool goes — and the rules
  // list shows it. The thing alone carries the tag the rule reads: it is not lent to its place)
  const upkeep: RuleDef[] = (p.things ?? []).flatMap((t) =>
    Object.entries(t.upkeep ?? {}).map(([pool, n]): RuleDef => ({ id: `upkeep:${t.id}:${pool}`, name: `Upkeep: ${t.name}`, on: 'turn', a: { tags: [isTag(t.id)] }, effect: { pool, n: -n }, why: `{a} cost you {n} ${POOL_WORD[pool]}` })),
  );
  // (a pack's rules are the engine's RuleDef as written: the validator has checked their shape. A rule that sets a
  // timed tag is told so here: the tag's declaration says it)
  const timed = new Set(['festival', 'growth-active', ...(p.tags ?? []).filter((t) => t.timed).map((t) => t.id)]);
  const asRule = (r: RuleDef): RuleDef => ('tag' in r.effect && timed.has(r.effect.tag) ? { ...r, effect: { ...r.effect, timed: true } } : r);
  const own = ((p.rules ?? []) as unknown as RuleDef[]).map(asRule);
  // (laws: as written, but spells by the engine's ids and a rule a law adds told of its timed tags)
  const spellId = (s: string): string => BASE_SPELL[s] ?? s;
  const laws = (p.laws ?? []).map((l): LawDef => {
    const d = structuredClone(l.does) as Record<string, unknown>;
    if (typeof d.spell === 'string') d.spell = spellId(d.spell);
    if (Array.isArray(d.allow)) d.allow = (d.allow as string[]).map(spellId);
    if (d.add_rule) d.add_rule = asRule(d.add_rule as RuleDef);
    return { id: l.id, name: l.name, does: d as unknown as LawDo };
  });
  const recordLaws = (p.cards ?? []).filter((c) => c.laws_after?.length).map((c) => ({ card: c.id, laws: [...c.laws_after!], ...(c.laws_after_if?.length ? { results: [...c.laws_after_if] } : {}) }));
  const because: LoadedPack['because'] = {};
  for (const c of p.cards ?? []) {
    const when = (c.appears_when ?? []) as Record<string, unknown>[];
    const resolved = when.filter((x) => typeof x.resolved === 'string' && x.run === 'earlier').map((x) => String(x.resolved));
    const remains = when.flatMap((x) => [...((x.site_has as string[] | undefined) ?? []), ...((x.town_has as string[] | undefined) ?? [])]).filter((t) => t.startsWith('remains-of-'));
    if (resolved.length || remains.length) because[c.id] = { resolved, remains };
  }
  return { id: p.pack.id, name: p.pack.name, templates, rules: [...own, ...upkeep], tags: p.tags ?? [], things: p.things ?? [], events: p.events ?? [], abilities: p.abilities ?? [], laws, recordLaws, because, left, problems };
}

/** (trade routes) the selectors of the pack things in play, on places not ruined, that carry a trade route
 *  (RealmOptions.extra.tradeThings) */
export function tradeThings(w: FactWorld, packs: readonly LoadedPack[]): string[] {
  const ruin = ['burned', 'flooded', 'buried', 'melted', 'abandoned', 'destroyed', 'occupied', 'lost'];
  return packThings(w, packs)
    .filter((t) => !!t.def.trade && !(t.site && ruin.some((k) => !!w.facts.tag(t.site!, 'condition', k)?.value)))
    .map((t) => t.def.trade!);
}

/** (laws) the pack things in play that carry laws: each as the Realm's things name it, with its laws
 *  (RealmOptions.extra.lawThings) */
export function lawThings(w: FactWorld, packs: readonly LoadedPack[]): { id: string; name: string; laws: string[] }[] {
  return packThings(w, packs).filter((t) => t.def.laws?.length).map((t) => ({ id: t.id, name: t.def.name, laws: [...t.def.laws!] }));
}

/**
 * (chains) The loaded packs joined: a card that some rule of the set offers or starts comes up only by that rule. Its
 * own conditions are replaced by the Realm's `ruleAsked` (and "not done for good" if it is `once`); it is dealt
 * outside the board's limits, like the base game's tribute card, so it is on the table the season it is asked for;
 * a started live card is `forced`: its event begins as it is dealt. Call once, over all the packs of a run.
 */
export function linkPacks(packs: readonly LoadedPack[]): void {
  const templates = new Map(packs.flatMap((p) => p.templates.map((t) => [t.id, t] as const)));
  for (const r of packs.flatMap((p) => p.rules)) {
    const fx = r.effect;
    const id = 'offer' in fx ? fx.offer : 'start' in fx ? fx.start : null;
    const t = id ? templates.get(id) : undefined;
    if (!t) continue;
    // (its `once` test kept: once for each binding, or once a run)
    t.eligible = [{ helper: 'ruleAsked', args: [t.id] }, ...(t.eligible ?? []).filter((p) => 'helper' in p && p.helper === 'packNotDone')];
    if (!t.threat) t.threat = 'arc';
    t.cooldown = 0;
    if ('start' in fx && t.play?.event) t.play = { ...t.play, forced: true };
  }
}

/** a pack's place word as a live event's place: a site, the gate or the road the event's column came by, or the
 *  event's own place (the site of the card that starts it) */
function liveWhere(ref: string | undefined): LiveWhere {
  if (ref === 'gate') return { place: 'gate', road: 'entry' };
  if (ref === 'road') return { place: 'spawn', road: 'entry' };
  const k = siteOf(ref);
  return { site: k ?? 'here' };
}
const UNIT_KIND: Record<string, { kind: string; side: 'town' | 'foe' | 'folk' }> = { soldier: { kind: 'guard', side: 'town' }, raider: { kind: 'raider', side: 'foe' }, dead: { kind: 'shambler', side: 'foe' }, worker: { kind: 'worker', side: 'folk' }, cart: { kind: 'cart', side: 'folk' } };

/** a pack's event as the engine's LiveDef (living/live.ts): played at the site of the card that starts it */
export function liveDef(e: PackEvent): LiveDef {
  const groups: LiveDef['groups'] = (e.groups ?? []).map((g, i) => ({
    id: `g${i}`,
    kind: UNIT_KIND[g.who].kind,
    side: UNIT_KIND[g.who].side,
    n: Number(g.count),
    tags: [...new Set([...g.tags, g.who])],
    from: liveWhere(g.from),
    ...(g.order ? { order: { kind: g.order as 'go' | 'guard' | 'attack', at: liveWhere(g.to ?? 'event'), ...(g.formation ? { formation: g.formation as 'column' | 'line' | 'loose' } : {}) } } : {}),
  }));
  const foe = groups.find((g) => g.side === 'foe');
  const goer = groups.find((g) => g.order?.kind === 'go');
  return {
    tag: e.tag,
    title: e.title,
    how: e.how,
    line: e.how,
    groups,
    ...(e.hazard ? { hazard: { kind: 'fire' as const, at: { site: 'here' }, points: e.hazard.points, spread: e.hazard.spread, radius: 2.5, intensity: 0.9 } } : {}),
    camera: { at: { site: 'here' }, zoom: 10 },
    ...(e.seconds !== undefined ? { seconds: e.seconds } : {}),
    spells: (e.abilities ?? []).map((a) => BASE_SPELL[a] ?? a),
    ends: e.hazard ? [{ when: 'out', after: 20 }] : foe ? [{ when: 'none', tag: foe.tags[0] }] : goer ? [{ when: 'arrived', group: goer.id }] : [],
    result: e.amounts.map((a) => {
      const m = /^(alive|dead):(.+)$/.exec(a);
      if (m) return { as: a, count: m[1] as 'alive' | 'dead', tag: m[2] };
      if (a === 'burned') return { as: a, read: 'burned' as const };
      if (a === 'crowd') return { as: a, count: 'arrived' as const, tag: 'crowd' };
      return { as: a, value: 0 };
    }),
    tiers: e.tiers.map((t) => ({ tier: t.tier as Tier, ...(t.when?.length ? { when: t.when.map((c): LiveCond => [c.amount, c.lte !== undefined ? '<=' : '>=', (c.lte ?? c.gte)!]) } : {}) })),
  };
}

// ---- the helpers a pack's cards name (given to the Realm: RealmOptions.extra.helpers) --------------------------------

const idOf = (b: Record<string, EntityId>, r: unknown): EntityId => {
  const s = String(r ?? '');
  return s.startsWith('$') ? (b[s.slice(1)] ?? s) : s;
};
/** a tag's value in the fact layer: true, or for a timed one the turn it ends with, as text (the Realm's own way:
 *  season/realm.ts `mark` — a number in the fact layer is an intensity) */
const tagValue = (w: FactWorld, timed: boolean): true | string => (timed ? String(w.turn) : true);
const inForce = (w: FactWorld, v: unknown): boolean => v === true || (typeof v === 'string' && Number(v) >= w.turn);

/** a camp founded through the Realm's own `found` (its record, its place on the map, its fact event), held by `by` */
function foundIt(c: Parameters<NonNullable<Helper['effect']>>[0], id: string, name: string, purpose: string, by: EntityId): void {
  if (c.w.settlement(id)) return;
  const h = dslHelper(c, 'found');
  if (!h?.effect) throw new Error('pack: the Realm has no found helper');
  h.effect(c, [id, name, purpose, by]);
  if (!c.w.facts.relations({ type: 'controls', from: by, to: id }).length) c.w.facts.relate({ type: 'controls', from: by, to: id, cause: c.cause });
}

export function packHelpers(packs: readonly LoadedPack[], host: PackHost): Record<string, Helper> {
  const things = new Map(packs.flatMap((p) => p.things.map((t) => [t.id, t] as const)));
  const abilityName = (id: string): string => packs.flatMap((p) => p.abilities).find((a) => a.id === id)?.name ?? id;
  return {
    packPool: { pred: (_c, a) => host.pool(String(a[0])) >= Number(a[1]) && host.pool(String(a[0])) <= Number(a[2]) },
    packSeason: { pred: (_c, a) => host.season() >= Number(a[0]) },
    packLeader: { pred: (_c, a) => host.leader() === a[0] },
    // (every tag on one thing: the town, or some one site)
    packTags: { pred: (_c, a) => host.tags(a[0] as 'town' | 'site').some((tags) => a.slice(1).every((t) => tags.includes(String(t)))) },
    // (some far town is in one of these states)
    packFar: {
      pred: (c, a) => {
        const states = new Map(placeStates(c.w).map((s) => [s.id, s.status as string]));
        return c.w.ws.settlements.some((s) => s.id !== host.home() && a.includes(states.get(s.id) ?? (s.condition === 'ruined' ? 'destroyed' : s.condition === 'abandoned' ? 'abandoned' : 'standing')));
      },
    },
    packPut: {
      effect: (c, a) => {
        const t = things.get(String(a[0]));
        if (!t) throw new Error(`pack: no thing ${String(a[0])}`);
        const id = thingEntity(t.id);
        const at = idOf(c.b, a[1]);
        if (c.w.facts.entity(id)) return;
        const home = c.w.settlement(host.home())!;
        c.w.facts.add({ id, kind: 'building', name: t.name, at: { region: home.region, settlement: host.home(), ...(at !== host.home() && c.w.facts.entity(at)?.kind === 'site' ? { site: at } : {}) }, attrs: { thing: t.id, what: t.kind }, cause: c.cause });
      },
    },
    packRemove: {
      effect: (c, a) => {
        const id = thingEntity(String(a[0]));
        if (c.w.facts.entity(id)) c.w.facts.remove(id, c.cause);
      },
    },
    packTag: {
      effect: (c, a) => {
        c.w.facts.setTag(idOf(c.b, a[0]), 'condition', String(a[1]), tagValue(c.w, !!Number(a[2])), c.cause);
      },
    },
    packUntag: { effect: (c, a) => void c.w.facts.dropTag(idOf(c.b, a[0]), 'condition', String(a[1])) },

    // ---- (draft 7) variables, factions, found places ----
    // (a site of the home town)
    packSite: { pred: (c, a) => { const e = c.w.facts.entity(idOf(c.b, a[0])); return e?.kind === 'site' && !!e.attrs.site && e.at.settlement === host.home(); } },
    // (its thing of the rules carries every tag of the first list and none of the second: '|'-joined)
    packIs: {
      pred: (c, a) => {
        const t = host.thingTags(idOf(c.b, a[0]));
        const all = String(a[1] ?? '').split('|').filter(Boolean);
        const not = String(a[2] ?? '').split('|').filter(Boolean);
        return !!t && all.every((x) => t.includes(x)) && !not.some((x) => t.includes(x));
      },
    },
    // (a far place: one of the states, every tag, none of the not-tags, held by the holder — 'player' or a faction)
    packFarIs: {
      pred: (c, a) => {
        const id = idOf(c.b, a[0]);
        if (id === host.home()) return false;
        const t = host.thingTags(id);
        if (!t) return false;
        const [states, all, not] = [a[1], a[2], a[3]].map((x) => String(x ?? '').split('|').filter(Boolean));
        const holder = String(a[4] ?? '');
        const who = holder === 'player' ? 'yours' : holder ? idOf(c.b, holder) : '';
        return (!states.length || states.some((s) => t.includes(s))) && all.every((x) => t.includes(x)) && !not.some((x) => t.includes(x)) && (!who || t.includes(who));
      },
    },
    // (a faction a pack declared, at one of these stances with the player or another: '' any)
    packFactionIs: {
      pred: (c, a) => {
        const id = idOf(c.b, a[0]);
        if (!c.w.facts.entity(id)?.attrs.packFaction) return false;
        const st = String(a[1] ?? '').split('|').filter(Boolean);
        return !st.length || st.includes(stanceOf(c.w, id, idOf(c.b, a[2] ?? 'player')));
      },
    },
    // (how many far towns, standing, the faction holds: gte .. lte)
    packHolds: {
      pred: (c, a) => {
        const fac = a[0] === 'player' ? 'yours' : idOf(c.b, a[0]);
        const n = farThings(c.w, packs, host.home()).filter((t) => t.tags.includes(fac) && t.tags.includes('standing')).length;
        return n >= Number(a[1]) && n <= Number(a[2]);
      },
    },
    packStanceIs: { pred: (c, a) => a.slice(2).map(String).includes(stanceOf(c.w, idOf(c.b, a[0]), idOf(c.b, a[1]))) },
    // (once: no record of this card done about all of these — in any run ('any'), or this run ('run'))
    packNotDone: {
      pred: (c, a) => {
        const evs = c.w.facts.events({ kind: doneKind(String(a[0])) });
        if (a[1] === 'run') return !evs.some((e) => e.turn >= host.began());
        const about = a.slice(2).map((r) => idOf(c.b, r));
        return !evs.some((e) => about.every((x) => e.to.includes(x)));
      },
    },
    // (a stance set: the old one ends — its history edge kept — and the new one holds both ways)
    packStance: {
      effect: (c, a) => {
        const [x, y] = [idOf(c.b, a[0]), idOf(c.b, a[1])];
        const was = stanceOf(c.w, x, y);
        const to = String(a[2]);
        if (was === to) return;
        for (const type of Object.values(STANCE_REL)) for (const [p, q] of [[x, y], [y, x]]) if (c.w.facts.relations({ type, from: p, to: q, historic: false }).length) c.w.facts.unrelate({ type, from: p, to: q }, c.cause);
        if (to !== 'none') c.w.facts.relate({ type: STANCE_REL[to as keyof typeof STANCE_REL], from: x, to: y, symmetric: true, cause: c.cause });
        c.w.facts.record({ kind: 'stance', by: [x], to: [y], about: { opp: c.cause }, note: `${c.w.name(x)} and ${y === 'player' ? 'you' : c.w.name(y)}: ${to === 'none' ? 'no longer bound' : to}` });
      },
    },
    // (a place revealed on the map, what it is good for, not yet settled: a found place of the fact world)
    packReveal: {
      effect: (c, a) => {
        const [id, name, resource] = a.map(String);
        if (c.w.facts.entity(findId(id)) || c.w.facts.entity(id)) return;
        const home = c.w.settlement(host.home())!;
        c.w.facts.add({ id: findId(id), kind: 'deposit', name, at: { region: home.region }, attrs: { place: id, resource, packFound: true }, cause: c.cause });
        c.w.facts.record({ kind: 'revealed', by: ['player'], to: [findId(id)], about: { opp: c.cause }, note: `${name} found: ${resource}, not settled` });
      },
    },
    // (a camp founded: the Realm's `found`, then whoever founded it holds it — the player or a faction — and what it
    // was founded for is kept as its found place, settled)
    packFound: {
      effect: (c, a) => {
        const [id, name, purpose, by, resource] = a.map(String);
        foundIt(c, id, name, purpose, idOf(c.b, by));
        if (resource && !c.w.facts.entity(findId(id))) {
          c.w.facts.add({ id: findId(id), kind: 'deposit', name, at: { region: c.w.settlement(host.home())!.region }, attrs: { place: id, resource, packFound: true }, cause: c.cause });
          c.w.facts.setTag(findId(id), 'condition', 'settled', true, c.cause);
        }
      },
    },
    // (a camp founded at a found place: its id and name are the place's)
    packFoundAt: {
      effect: (c, a) => {
        const d = c.w.facts.entity(idOf(c.b, a[0]));
        if (!d || d.kind !== 'deposit') throw new Error(`pack: ${String(a[0])} is no found place to settle`);
        foundIt(c, String(d.attrs.place), d.name, String(a[1] ?? ''), idOf(c.b, a[2] ?? 'player'));
        c.w.facts.setTag(d.id, 'condition', 'settled', true, c.cause);
      },
    },
    // (written in the history, so the run's save has it: Table.unlocked reads this run's events)
    packUnlock: { effect: (c, a) => void (c.w.facts.events({ kind: `${UNLOCKED}${String(a[0])}` }).some((e) => e.turn >= host.began()) || c.w.facts.record({ kind: `${UNLOCKED}${String(a[0])}`, by: ['player'], to: [host.home()], note: `you learned ${abilityName(String(a[0]))}` })) },
  };
}

/** a pack tag set on an entity and still in force (a timed one: only in the season it was set) */
export function packTagsOn(w: FactWorld, id: EntityId, packs: readonly LoadedPack[]): string[] {
  const e = w.facts.entity(id);
  if (!e) return [];
  const known = new Set(packs.flatMap((p) => p.tags.map((t) => t.id)));
  return e.tags.filter((t) => t.scope === 'condition' && known.has(t.key) && inForce(w, t.value)).map((t) => t.key);
}

/** the tags the pack things standing at a place lend it (null: the town itself) */
export function lentTo(w: FactWorld, packs: readonly LoadedPack[], place: EntityId | null): string[] {
  return packThings(w, packs)
    .filter((t) => t.site === place)
    .flatMap((t) => [...t.def.tags, ...packTagsOn(w, t.id, packs)]);
}

/**
 * The Realm's things with the packs' added (RealmOptions.extra.things): each pack thing in play as a thing of its own,
 * at its site's place; a thing on a ruined site carries only 'ruined'. A thing's tags are also lent to the place it
 * stands at (its site, or the home town) while that place is not ruined, so a rule can ask one thing for "field" and
 * "granary", or "home" and "night-watch". Pack tags set on the Realm's own things are added to them.
 * (Round 6 has not this lending: BACKLOG LS-75.)
 */
export function withPackThings(w: FactWorld, packs: readonly LoadedPack[], base: readonly Thing[], home: EntityId): Thing[] {
  const out: Thing[] = base.map((t) => {
    if (t.tags.includes('ruined')) return { ...t };
    const more = [...packTagsOn(w, t.id, packs), ...(t.id === home ? lentTo(w, packs, null) : lentTo(w, packs, t.id))];
    return { ...t, tags: [...new Set([...t.tags, ...more])] };
  });
  const town = base.find((t) => t.id === home);
  // (draft 7: the home town carries "<faction>:<stance>" for each faction it has a stance with)
  const homeAt = out.findIndex((t) => t.id === home);
  if (homeAt >= 0) out[homeAt] = { ...out[homeAt], tags: [...out[homeAt].tags, ...packFactions(w).flatMap((x) => (stanceOf(w, x, 'player') === 'none' ? [] : [`${x}:${stanceOf(w, x, 'player')}`]))] };
  // (draft 7: the far places as things; a trade partner the Realm lists already gets the far town's tags too)
  for (const t of farThings(w, packs, home)) {
    const i = out.findIndex((x) => x.id === t.id);
    if (i < 0) out.push(t);
    else out[i] = { ...out[i], tags: [...new Set([...out[i].tags.filter((x) => x !== 'standing' && x !== 'ruined'), ...t.tags])] };
  }
  for (const t of packThings(w, packs)) {
    const place = t.site ? base.find((x) => x.id === t.site) : town;
    const ruined = !!place?.tags.includes('ruined');
    // (the record: a thing on a ruined place stays a thing of the world — its remains, with what it was)
    out.push({ id: t.id, name: t.def.name, tags: [...(ruined ? ['ruined', ...t.def.tags.map((x) => `remains-of-${x}`)] : [...t.def.tags, ...packTagsOn(w, t.id, packs)]), isTag(t.def.id)], at: place?.at ?? null, town: home });
  }
  return out;
}

/** the pack things in play: each with its tags and the site it stands at (null: the town) */
export function packThings(w: FactWorld, packs: readonly LoadedPack[]): { id: EntityId; def: PackThing; site: EntityId | null }[] {
  return packs.flatMap((p) => p.things).flatMap((t) => {
    const e = w.facts.entity(thingEntity(t.id));
    return e ? [{ id: e.id, def: t, site: e.at.site ?? null }] : [];
  });
}

/**
 * An ability of a pack cast on a thing: its tag effects written to the fact world (a timed tag lasts to the end of
 * this season); returns the pools it changes, for the caller to apply to its ledger. Pure but for the fact world.
 */
export function castAbility(w: FactWorld, a: PackAbility, target: EntityId, packs: readonly LoadedPack[]): Record<string, number> {
  const timed = ['festival', 'growth-active', ...packs.flatMap((p) => p.tags.filter((t) => t.timed).map((t) => t.id))];
  const e = w.facts.entity(target);
  if (!e) throw new Error(`pack: no thing ${target} to cast ${a.id} on`);
  const gains: Record<string, number> = {};
  for (const fx of a.effect ?? []) {
    if ('tag' in fx) w.facts.setTag(target, 'condition', fx.tag, tagValue(w, timed.includes(fx.tag)), `ability:${a.id}`);
    else if ('untag' in fx) w.facts.dropTag(target, 'condition', fx.untag);
    else if ('pool' in fx) gains[fx.pool] = (gains[fx.pool] ?? 0) + fx.add;
  }
  return gains;
}
