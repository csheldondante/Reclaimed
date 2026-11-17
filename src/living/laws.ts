// (card-table; docs/design/LAWS.md) Laws: data that changes the rules of the game for the rest of a run. The owner
// (2026-11-16): "Since it is a roguelite with runs that end we can break things. Look at games like innovation and
// allow mechanics that mutate mechanics in potentially major world changing ways."
//
// One ordered list of laws in force, kept by whoever owns the run (season/realm.ts), layered over the base
// definitions. Nothing base is edited: each function here takes the base view (things, rules, a card's terms, a live
// event, the spells' table, the run's numbers) and the laws in force IN THE ORDER THEY CAME INTO FORCE, and returns
// the view with the laws applied. Pure: no world, no clock. Meta laws (`multipliers`) act on every law whatever its
// place in the order. No limits on power: broken combinations are wanted.
import type { LiveDef } from './live';
import type { RuleDef, RuleTrigger, TagQuery, Thing } from './rules';

/** which cards a card law is about: any theme listed, or any id listed; absent: every card */
export interface CardMatch {
  themes?: string[];
  ids?: string[];
}

/** what a law does: exactly one of these shapes */
export type LawDo =
  // 1. tags
  | { count_as: { tag: string; as: string } }
  | { grant: string; to: TagQuery }
  | { spare: string }
  // 2. rules
  | {
      rule: string;
      set?: { n?: number | null; cap?: number | null; each?: number | null; perSeason?: number | null };
      times?: number;
      on?: RuleTrigger;
      a?: TagQuery;
      b?: TagQuery;
      off?: boolean;
      fires?: number;
    }
  | { add_rule: RuleDef }
  // 3. cards
  | { cost: Record<string, number>; cards?: CardMatch }
  | { pay: Record<string, string>; cards?: CardMatch }
  | { build: number; cards?: CardMatch }
  | { stay: number; cards?: CardMatch }
  | { pool_as: Record<string, string> }
  // 4. spells and events
  | { spell: string; kills?: number; douses?: number; also_tag?: string; on?: TagQuery }
  | { event: string; allow?: string[]; shift?: number; foes?: number; tier?: string[]; counts_as?: { live: string; tier: string[] } }
  // 5. the run
  | { board: number }
  | { income: Record<string, number> }
  | { raiders: { add?: number; times?: number } }
  | { win: { count: number; tags: string[] } }
  // 6. meta
  | { multipliers: number }
  | { next_law: 'run' };

export interface LawDef {
  id: string;
  /** its name, as a card's */
  name: string;
  does: LawDo;
}

/** how long a law in force stands: while a thing stands (and is not ruined), to the end of a turn, or the run */
export type LawSource = { thing: string } | { until: number } | { run: true };

/** a law in force: which, who or what made it (the player's words), its source, its place in the order */
export interface ActiveLaw {
  law: string;
  from: string;
  source: LawSource;
  seq: number;
  /** the thing that brought it, when a meta law made it last the run (so the thing does not bring it again) */
  via?: string;
}

/** the kind of a law (its first word), for the lists and the validator */
export type LawKind = 'tags' | 'rules' | 'cards' | 'spells' | 'run' | 'meta';
export function lawKind(d: LawDo): LawKind {
  if ('count_as' in d || 'grant' in d || 'spare' in d) return 'tags';
  if ('rule' in d || 'add_rule' in d) return 'rules';
  if ('cost' in d || 'pay' in d || 'build' in d || 'stay' in d || 'pool_as' in d) return 'cards';
  if ('spell' in d || 'event' in d) return 'spells';
  if ('multipliers' in d || 'next_law' in d) return 'meta';
  return 'run';
}

/** every multiplier is multiplied by this (meta: `multipliers`) */
export function metaFactor(laws: readonly LawDef[]): number {
  return laws.reduce((f, l) => ('multipliers' in l.does ? f * l.does.multipliers : f), 1);
}

const has = (t: Thing, q: TagQuery): boolean => q.tags.every((x) => t.tags.includes(x)) && !(q.not ?? []).some((x) => t.tags.includes(x));

// ---- 1. tags --------------------------------------------------------------------------------------------------------

/** the ruin words that no longer ruin (`spare`) */
export function spared(laws: readonly LawDef[]): Set<string> {
  return new Set(laws.flatMap((l) => ('spare' in l.does ? [l.does.spare] : [])));
}

/** the things with the tag laws applied in order: a tag that counts as another, a tag granted to every match. A
 *  ruined thing is given nothing unless the query asks for `ruined` */
export function applyTags(things: readonly Thing[], laws: readonly LawDef[]): Thing[] {
  let out = things.map((t) => ({ ...t, tags: [...t.tags] }));
  for (const l of laws) {
    const d = l.does;
    if ('count_as' in d) out = out.map((t) => (t.tags.includes(d.count_as.tag) && !t.tags.includes(d.count_as.as) ? { ...t, tags: [...t.tags, d.count_as.as] } : t));
    else if ('grant' in d) out = out.map((t) => (has(t, d.to) && (!t.tags.includes('ruined') || d.to.tags.includes('ruined')) && !t.tags.includes(d.grant) ? { ...t, tags: [...t.tags, d.grant] } : t));
  }
  return out;
}

// ---- 2. rules -------------------------------------------------------------------------------------------------------

export interface DerivedRules {
  rules: RuleDef[];
  /** each rule a law changed or added: the laws' names, in order */
  changed: Record<string, string[]>;
  /** each rule turned off, and by which law */
  off: Record<string, string>;
}

/** the rule list with the rule laws applied in order, and every multiplier multiplied by the meta factor */
export function deriveRules(base: readonly RuleDef[], laws: readonly LawDef[]): DerivedRules {
  const f = metaFactor(laws);
  let rules: RuleDef[] = base.map((r) => structuredClone(r) as RuleDef);
  const changed: Record<string, string[]> = {};
  const off: Record<string, string> = {};
  const mark = (id: string, name: string) => void (changed[id] ??= []).push(name);
  for (const l of laws) {
    const d = l.does;
    if ('add_rule' in d) {
      if (rules.some((r) => r.id === d.add_rule.id)) continue;
      rules.push(structuredClone(d.add_rule) as RuleDef);
      mark(d.add_rule.id, l.name);
      continue;
    }
    if (!('rule' in d)) continue;
    const r = rules.find((x) => x.id === d.rule);
    if (!r) continue;
    if (d.off) {
      rules = rules.filter((x) => x !== r);
      off[r.id] = l.name;
      continue;
    }
    const fx = r.effect as { n?: number };
    if (d.set) {
      for (const [k, v] of Object.entries(d.set) as [keyof NonNullable<typeof d.set>, number | null][]) {
        if (k === 'n') {
          if (typeof fx.n === 'number' && v !== null) fx.n = v;
        } else if (k === 'each') {
          if (typeof r.per === 'object' && v !== null) r.per = { ...r.per, each: v };
        } else if (v === null) delete r[k];
        else r[k] = v;
      }
    }
    if (d.times !== undefined && typeof fx.n === 'number') {
      fx.n *= d.times * f;
      if (r.cap !== undefined) r.cap *= d.times * f;
    }
    if (d.on) r.on = structuredClone(d.on);
    if (d.a) r.a = structuredClone(d.a);
    if (d.b) r.b = structuredClone(d.b);
    if (d.fires !== undefined) r.fires = d.fires;
    mark(r.id, l.name);
  }
  // (meta: every multiplier — a rule's `mul` — is multiplied)
  if (f !== 1)
    for (const r of rules) {
      const fx = r.effect as { op?: string; n?: number };
      if (fx.op === 'mul' && typeof fx.n === 'number') {
        fx.n *= f;
        for (const l of laws) if ('multipliers' in l.does) mark(r.id, l.name);
      }
    }
  return { rules, changed, off };
}

// ---- 3. cards -------------------------------------------------------------------------------------------------------

/** a card's terms: people locked, goods spent, seasons to build */
export interface CardTerms {
  locks: Record<string, number>;
  costs: Record<string, number>;
  turns: number;
}
const matches = (card: { id: string; themes: readonly string[] }, m: CardMatch | undefined): boolean =>
  !m || (m.themes ?? []).some((t) => card.themes.includes(t)) || (m.ids ?? []).includes(card.id);
const PEOPLE = ['labor', 'might'];

/** a card's terms with the card laws applied in order; no number below 0, build at least 1 season */
export function cardTerms(card: { id: string; themes: readonly string[] }, printed: CardTerms, laws: readonly LawDef[]): CardTerms {
  const t: CardTerms = { locks: { ...printed.locks }, costs: { ...printed.costs }, turns: printed.turns };
  const part = (k: string): Record<string, number> => (PEOPLE.includes(k) ? t.locks : t.costs);
  for (const l of laws) {
    const d = l.does;
    if ('cost' in d && matches(card, d.cards)) for (const [k, n] of Object.entries(d.cost)) part(k)[k] = (part(k)[k] ?? 0) + n;
    else if ('pay' in d && matches(card, d.cards))
      for (const [from, to] of Object.entries(d.pay)) {
        const n = part(from)[from] ?? 0;
        if (n <= 0) continue;
        delete part(from)[from];
        part(to)[to] = (part(to)[to] ?? 0) + n;
      }
    else if ('build' in d && matches(card, d.cards)) t.turns += d.build;
  }
  for (const p of [t.locks, t.costs]) for (const k of Object.keys(p)) if (p[k] <= 0) delete p[k];
  t.turns = Math.max(1, t.turns);
  return t;
}

/** seasons more (or fewer) a card dealt now stays on offer */
export function stayOf(card: { id: string; themes: readonly string[] }, laws: readonly LawDef[]): number {
  return laws.reduce((n, l) => ('stay' in l.does && matches(card, l.does.cards) ? n + l.does.stay : n), 0);
}

/** the pools that count as another in a fight (unrest → might) */
export function poolsAs(laws: readonly LawDef[]): [string, string][] {
  return laws.flatMap((l) => ('pool_as' in l.does ? Object.entries(l.does.pool_as) : []));
}

// ---- 4. spells and events -------------------------------------------------------------------------------------------

/** (loop round 10, LS-94) `berserk`, `hides`: a pack ability's reach (cells) — the foes there turn on anyone near; your
 *  people there are hidden. No law changes them yet */
export type Mech = Record<string, { kills?: number; douses?: number; berserk?: number; hides?: number; shield?: number; seconds?: number }>;

/** what one cast of each spell does in an event, with the spell laws applied in order (a law sets the number) */
export function spellMech(base: Mech, laws: readonly LawDef[]): Mech {
  const out: Mech = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, { ...v }]));
  for (const l of laws) {
    const d = l.does;
    if (!('spell' in d) || (d.kills === undefined && d.douses === undefined)) continue;
    out[d.spell] = { ...(out[d.spell] ?? {}), ...(d.kills !== undefined ? { kills: d.kills } : {}), ...(d.douses !== undefined ? { douses: d.douses } : {}) };
  }
  return out;
}

/** what a cast of a spell also does: a tag set for the season on every thing that matches */
export function spellAlso(spell: string, laws: readonly LawDef[]): { tag: string; on: TagQuery; law: string }[] {
  return laws.flatMap((l) => ('spell' in l.does && l.does.spell === spell && l.does.also_tag ? [{ tag: l.does.also_tag, on: l.does.on ?? { tags: [] }, law: l.name }] : []));
}

/** a live event with the event laws applied: spells allowed, foes added to each foe group (a group sized by a run's
 *  number is not changed) */
export function liveLaw(def: LiveDef, laws: readonly LawDef[]): LiveDef {
  const mine = laws.filter((l) => 'event' in l.does && l.does.event === def.tag);
  if (!mine.length) return def;
  const out: LiveDef = { ...def, groups: def.groups.map((g) => ({ ...g })), ...(def.spells ? { spells: [...def.spells] } : {}) };
  for (const l of mine) {
    const d = l.does as Extract<LawDo, { event: string }>;
    if (d.allow) out.spells = [...new Set([...(out.spells ?? []), ...d.allow])];
    if (d.foes) for (const g of out.groups) if (g.side === 'foe' && typeof g.n === 'number') g.n = Math.max(0, g.n + d.foes);
  }
  return out;
}

const RANK = ['disaster', 'failure', 'cost', 'success', 'triumph'];
/** a result moved up or down by the `shift` laws on its kind, among the results the event can give */
export function shiftTier<T extends string>(def: LiveDef, tier: T, laws: readonly LawDef[]): T {
  const n = laws.reduce((s, l) => ('event' in l.does && l.does.event === def.tag && l.does.shift ? s + l.does.shift : s), 0);
  if (!n) return tier;
  const can = [...new Set(def.tiers.map((t) => t.tier as string))].sort((a, b) => RANK.indexOf(a) - RANK.indexOf(b));
  const i = can.indexOf(tier);
  if (i < 0) return tier;
  return can[Math.max(0, Math.min(can.length - 1, i + n))] as T;
}

/** the other results this result also counts as (`counts_as`), for the rules that wait for them */
export function resultAlso(kind: string, tier: string, laws: readonly LawDef[]): { live: string; tier: string[] }[] {
  return laws.flatMap((l) => {
    const d = l.does;
    if (!('event' in d) || d.event !== kind || !d.counts_as) return [];
    if (d.tier && !d.tier.includes(tier)) return [];
    return [{ live: d.counts_as.live, tier: [...d.counts_as.tier] }];
  });
}

// ---- 5. the run -----------------------------------------------------------------------------------------------------

/** cards on offer at once, more or fewer */
export function boardDelta(laws: readonly LawDef[]): number {
  return laws.reduce((n, l) => ('board' in l.does ? n + l.does.board : n), 0);
}
/** goods each season by law */
export function lawIncome(laws: readonly LawDef[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of laws) if ('income' in l.does) for (const [k, n] of Object.entries(l.does.income)) out[k] = (out[k] ?? 0) + n;
  return out;
}
/** the raid's size with the raider laws applied in order (a `times` is a multiplier: the meta factor applies) */
export function raidersOf(n: number, laws: readonly LawDef[]): number {
  const f = metaFactor(laws);
  let x = n;
  for (const l of laws) if ('raiders' in l.does) x = (x + (l.does.raiders.add ?? 0)) * (l.does.raiders.times !== undefined ? l.does.raiders.times * f : 1);
  return Math.max(0, Math.round(x));
}
/** the ways to win the run by law: so many things that carry these tags */
export function winsOf(laws: readonly LawDef[]): { law: string; count: number; tags: string[] }[] {
  return laws.flatMap((l) => ('win' in l.does ? [{ law: l.name, count: l.does.win.count, tags: [...l.does.win.tags] }] : []));
}
/** the first way to win that the things in play meet (null: none) */
export function wonBy(things: readonly Thing[], laws: readonly LawDef[]): { law: string; count: number; tags: string[] } | null {
  return winsOf(laws).find((w) => things.filter((t) => w.tags.every((x) => t.tags.includes(x))).length >= w.count) ?? null;
}
