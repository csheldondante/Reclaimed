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
import type { FactWorld } from '../living/world';
import { placeStates } from '../mutate/facts';
import { checkPack, reportText, siteOf, GOODS, PEOPLE, type Pack, type PackAbility, type PackCard, type PackCond, type PackEffect, type PackEvent, type PackTag, type PackThing, type Problem } from './check';

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
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const where = (ref: string | undefined): string => (ref === 'town' || !ref ? 'the town' : ref === 'far:neighbour' ? '{other}' : (SITE_NAME[siteOf(ref) ?? ''] ?? ref));

/** what a list of effects does, in plain sentences written from the data (the numbers are the engine's) */
export function effectsText(list: readonly PackEffect[], p: Pack): string {
  const out: string[] = [];
  const says: string[] = [];
  for (const e of list) {
    const x = e as Record<string, unknown>;
    if ('say' in e) says.push(String(e.say).trim());
    else if ('pool' in e) out.push(e.pool === 'unrest' ? `Unrest ${e.add > 0 ? '+' : ''}${e.add}.` : `${e.add > 0 ? '+' : ''}${e.add} ${POOL_WORD[e.pool]}.`);
    else if ('income' in e) out.push(`${e.add > 0 ? '+' : ''}${e.add} ${POOL_WORD[e.income]} each season.`);
    else if ('put' in e) out.push(`In play: ${p.things?.find((t) => t.id === e.put)?.name ?? e.put}.`);
    else if ('remove' in e) out.push(`You lose ${p.things?.find((t) => t.id === e.remove)?.name ?? e.remove}.`);
    else if ('tag' in e) out.push(`${cap(where(e.on))} is now ${e.tag}.`);
    else if ('untag' in e) out.push(`${cap(where(e.on))} is no longer ${e.untag}.`);
    else if ('mutate' in e) out.push(`${cap(where(e.where))} ${LAND_WORD[e.mutate]}.`);
    else if ('far' in e) out.push(e.far === 'founded' ? `${String(x.name)} is founded.` : `${cap(where(e.where))} ${FAR_WORD[e.far]}.`);
    else if ('sign' in e) out.push(`${SIGN_WORD[e.sign]} for ${e.seasons ?? 3} seasons.`);
    else if ('arrive' in e) out.push('40 refugees walk in from {other}.');
    else if ('unlock' in e) out.push(`You can cast ${p.abilities?.find((a) => a.id === e.unlock)?.name ?? e.unlock}.`);
  }
  return [...says, ...out].join(' ');
}

function conds(list: readonly PackCond[], site: string): Pred[] {
  return list.map((c): Pred => {
    if ('pool' in c) return { helper: 'packPool', args: [c.pool, c.gte ?? -1e9, c.lte ?? 1e9] };
    if ('season_gte' in c) return { helper: 'packSeason', args: [c.season_gte] };
    if ('has_thing' in c) return { helper: 'exists', args: [thingEntity(c.has_thing)] };
    if ('no_thing' in c) return { not: { helper: 'exists', args: [thingEntity(c.no_thing)] } };
    if ('town_has' in c) return { helper: 'packTags', args: ['town', ...c.town_has] };
    if ('site_has' in c) return { helper: 'packTags', args: ['site', ...c.site_has] };
    if ('far_town_is' in c) return { helper: 'packFar', args: [...c.far_town_is] };
    if ('resolved' in c) return { event: { kind: doneKind(c.resolved), involving: '$town' } };
    if ('leader' in c) return { helper: 'packLeader', args: [c.leader] };
    throw new Error(`pack: no condition ${JSON.stringify(c)} at ${site}`);
  });
}

/** a place reference as a template's bound name; the sites and far places it needs bound are collected in `need` */
function refOf(ref: string | undefined, need: Set<string>): string {
  if (!ref || ref === 'town') return '$town';
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
    else if ('mutate' in e) {
      const r = refOf(e.where, need);
      // (a site: the fact first, then its physical side, as the base game's hazards do — season/realm-templates.ts)
      if (r === '$site' || r.startsWith('$s_')) out.push({ setTag: [r, 'condition', e.mutate, true] }, { event: e.mutate, by: [], to: [r, '$town'], note, weight: -0.4 }, { helper: 'mutateAt', args: [e.mutate, r, 24, 1] });
      else out.push({ helper: 'mutate', args: [e.mutate, r] });
    } else if ('far' in e) {
      const x = e as { far: string; where?: string; by?: string; tribute?: number; id?: string; name?: string; purpose?: string };
      if (x.far === 'founded') out.push({ helper: 'found', args: [x.id!, x.name!, ...(x.purpose ? [x.purpose] : [])] }, { relate: ['player', 'controls', x.id!] });
      else {
        const r = refOf(x.where, need);
        if (x.far === 'captured') out.push({ setTag: [r, 'condition', 'occupied', true] });
        out.push({ helper: 'mutate', args: [x.far, r, 1, 1, x.far === 'vassal' ? 'player' : (x.by ?? 'raiders'), ...(x.far === 'vassal' ? [x.tribute ?? 1] : [])] });
      }
    } else if ('sign' in e) out.push({ helper: 'sign', args: [e.sign, '$town', e.strength ?? 0.6, e.seasons ?? 3] });
    else if ('arrive' in e) {
      need.add('far');
      out.push({ migrate: ['$other', '$town', 0.3], note: 'refugees from {other} walked in along the road' }, { helper: 'refugeeCohort', args: ['$town', '$town'] });
    } else if ('unlock' in e) out.push(BASE_SPELL[e.unlock] ? { helper: 'spell', args: [BASE_SPELL[e.unlock]] } : { helper: 'packUnlock', args: [e.unlock] });
  }
  return out;
}

function template(c: PackCard, p: Pack, after: string[], boost: boolean): TemplateDef {
  const site = siteOf(c.presenter.at)!;
  const need = new Set<string>([`own:${site}`]);
  const event = c.live ? p.events!.find((e) => e.id === c.live)! : null;
  const taken = c.if_taken ?? [];
  const left = c.if_expires ?? [];
  // (a live card: what the player reads for "if taken" is what there is to do at the event)
  const takenText = event ? event.how : effectsText(taken, p);
  const leftText = effectsText(left, p);
  const outcome = effects(taken, p, need, takenText);
  const onExpire = effects(left, p, need, leftText);
  const done = (note: string): Effect => ({ event: doneKind(c.id), by: ['player'], to: ['$site', '$town'], note, weight: 0.2 });
  // (each result of its event: its effects, and its words written from them)
  const outcomes = event
    ? Object.fromEntries(
        (Object.entries(c.if_tier ?? {}) as [Tier, PackEffect[]][]).map(([tier, list]) => {
          const words = effectsText(list, p);
          return [tier, { text: words, effects: [...effects(list, p, need, words), done(words)] }];
        }),
      )
    : null;
  const cost = c.cost ?? {};
  const agents = PEOPLE.filter((k) => cost[k] > 0).map((k) => ({ kind: k === 'labor' ? ('workers' as const) : ('army' as const), count: cost[k] }));
  const goods = Object.fromEntries(GOODS.filter((k) => cost[k] > 0).map((k) => [k, cost[k]]));
  const when: PackCond[] = [...(p.pack.appears_when ?? []), ...(c.appears_when ?? []), ...after.map((id) => ({ resolved: id }))];
  // (a card that names no far place needs none: one that does appears only while a neighbour stands)
  const bind: BindSpec[] = [
    { as: 'town', kind: 'settlement', where: [{ helper: 'isHome', args: ['$town'] }] },
    { as: 'site', kind: 'site', where: [{ helper: 'siteIs', args: ['$site', site] }] },
    ...[...need].filter((k) => k !== 'far' && !k.startsWith('own:')).map((k): BindSpec => ({ as: `s_${k}`, kind: 'site', shared: true, where: [{ helper: 'siteIs', args: [`$s_${k}`, k] }] })),
    ...(need.has('far') ? [{ as: 'other', kind: 'settlement' as const, shared: true, where: [{ helper: 'neighbour', args: ['$other'] }] as Pred[] }] : []),
  ];
  return {
    id: c.id,
    title: c.title,
    pitch: c.pitch,
    themes: [...(p.pack.themes ?? []), `pack:${p.pack.id}`],
    bind,
    eligible: [...conds(when, c.id), ...(c.once === false ? [] : [{ not: { event: { kind: doneKind(c.id), involving: '$town' } } } as Pred])],
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
    ...(left.length ? { onExpire: [...onExpire, { event: lapsedKind(c.id), by: [], to: ['$site', '$town'], note: leftText, weight: -0.3 }], expireText: leftText } : {}),
    presenter: { of: '$town', role: c.presenter.role, own: true, verb: c.threat ? 'warns' : 'asks', line: c.pitch },
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
  // (a pack's rules are the engine's RuleDef as written: the validator has checked their shape)
  return { id: p.pack.id, name: p.pack.name, templates, rules: [...((p.rules ?? []) as unknown as RuleDef[]), ...upkeep], tags: p.tags ?? [], things: p.things ?? [], events: p.events ?? [], abilities: p.abilities ?? [], left, problems };
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
  for (const t of packThings(w, packs)) {
    const place = t.site ? base.find((x) => x.id === t.site) : town;
    const ruined = !!place?.tags.includes('ruined');
    out.push({ id: t.id, name: t.def.name, tags: [...(ruined ? ['ruined'] : [...t.def.tags, ...packTagsOn(w, t.id, packs)]), isTag(t.def.id)], at: place?.at ?? null, town: home });
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
