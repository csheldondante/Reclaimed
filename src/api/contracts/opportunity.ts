// ---- api/contracts/opportunity.ts ------------------------------------------------------------------------------
// (round 120, `opportunities`; BACKLOG RN2-1) The opportunity contract: one kind of thing the player is offered on the
// strategic map, whatever the scale (a lone hero, a party, a ruler, an empire). docs/design/STRATEGIC_MAP.md (the
// user's text) is the authority; docs/design/RUN_LOOP.md revision 4 the design.
// The user (round 120): "Every opportunity has predefined resource requirements, costs, duration, possible outcomes,
// and a location. The player selects opportunities and commits the required resources." "Opportunities are uniform.
// Their resource requirements determine who undertakes them; committing the player resource makes an opportunity
// interactive." And on availability: "for simplicity they must be available to your character".
//
// What is here: the resources (the player, agents with tags, goods), the holdings, an opportunity, a commitment and a
// resolution, and the pure rules over them — what's available (`available`), whether an opportunity can be met and
// with which agents (`meet`), committing (`commit`: the agents locked, the costs spent) and resolving (`resolve`: the
// survivors back with their new tags, the goods and agents gained). Pure: no DOM, no GPU, no clock of its own; every
// function returns new holdings and never changes what it was given (unit-tested in Node: test/unit/opportunity.test.ts).
// What is not here: which opportunities exist (templates, src/opps/), which are offered (the dealer, src/opps/dealer.ts)
// and what a conflict does with its effects (the run's conflict, src/opps/horde.ts for slice A). An effect of kind
// 'conflict' is carried as data and applied by whoever owns the conflict; 'atlas' effects go to WorldState.apply.

import type { AtlasEvent, RegionId } from './world';

/** Agents: locked while committed, they return (or are lost) when it resolves. 'player' is the hero the player controls. */
export type AgentKind = 'player' | 'companion' | 'knight' | 'diplomat' | 'scout' | 'prospector' | 'priest' | 'workers' | 'army' | 'ship';
export const AGENT_KINDS: readonly AgentKind[] = ['player', 'companion', 'knight', 'diplomat', 'scout', 'prospector', 'priest', 'workers', 'army', 'ship'];

/** Goods: spent as costs, earned as rewards ('supplies', 'coin', 'materials', 'renown', a material or a tag). */
export type GoodKind = string;
export type Goods = Record<GoodKind, number>;

/**
 * One agent. Agents of a kind are interchangeable (the user: "Interchangeable but I would have tags so named characters
 * are also knights or whatever"): quality is never a number, it is the tags (which unlock special opportunities) and
 * the bonuses (which change how some resolve). A group is one agent with a count (an army of 8).
 */
export interface Agent {
  id: string;
  kind: AgentKind;
  name: string;
  /** the CharacterRecord it is (run.ts), when the world remembers it: its tags and bonuses persist through it */
  character?: string;
  /** a group's size (an army's soldiers); 1 for a person */
  count: number;
  /** 'veteran', 'named', 'sapper', 'oath-sworn' … */
  tags: string[];
  /** lasting conditions (CharacterRecord.statuses' words); a 'wounded' agent isn't available */
  statuses: string[];
  /** where it is: with the player, or stationed at a settlement (availability reads this) */
  at: { with: 'player' } | { settlement: string };
  /** the commitment that holds it, if any */
  committed?: string;
}

/** Everything the player holds. The scale is derived from it, never stored. */
export interface Holdings {
  agents: Agent[];
  goods: Goods;
  /** settlements the character rules: what is stationed there is available to it (a city's ruler: the city) */
  rules: string[];
  /** bonuses: the holdings' as a whole, or one agent's (`holder`; they persist on its CharacterRecord) */
  bonuses: Bonus[];
}

export function emptyHoldings(): Holdings {
  return { agents: [], goods: {}, rules: [], bonuses: [] };
}

/**
 * Won by levelling up (the user: "gaining better opportunities or resolution bonuses. Negate a negative effect of
 * certain types of opportunity or resolve some instantly"). `holder`: the agent whose bonus it is (it applies only when
 * that agent is committed); absent, the holdings'.
 */
export type Bonus =
  /** a resolution of `tier` on an opportunity with one of these themes is lifted to the next better tier */
  | { kind: 'negate'; themes: string[]; tier: Tier; holder?: string; why: string }
  /** opportunities with one of these themes resolve at once when committed */
  | { kind: 'instant'; themes: string[]; holder?: string; why: string };

/** a bonus as a character's record keeps it (no holder: the record is the holder) */
export type BonusRecord = Bonus extends infer B ? (B extends unknown ? Omit<B, 'holder'> : never) : never;

/** how a resolution came out, best first */
export type Tier = 'triumph' | 'success' | 'cost' | 'failure' | 'disaster';
export const TIERS: readonly Tier[] = ['triumph', 'success', 'cost', 'failure', 'disaster'];

/** an opportunity's needs: this many agents of the kind, each carrying these tags */
export interface Requirement {
  kind: AgentKind;
  count: number;
  tags?: string[];
}

/** where an opportunity is (world units on the torus) */
export interface OppLocation {
  region: RegionId;
  settlement?: string;
  at: [number, number];
  name: string;
}

/**
 * What an outcome does. 'goods', 'agent', 'tag' and 'bonus' change the holdings (applied by `resolve`); 'atlas' is an
 * AtlasEvent for the world state; 'conflict' is the run's conflict's own operation (slice A: 'delay', 'hasten',
 * 'thin', 'provision'), applied by the conflict's owner. `text`: a line for the report.
 */
export type OppEffect =
  | { kind: 'goods'; goods: Goods }
  | { kind: 'agent'; agent: Omit<Agent, 'committed'> }
  /** tags (and bonuses) for the committed agents that come back */
  | { kind: 'tag'; add: string[]; bonuses?: Bonus[] }
  | { kind: 'atlas'; event: Omit<AtlasEvent, 'id' | 'run'> }
  | { kind: 'conflict'; op: string; amount: number };

export interface OppOutcome {
  text: string;
  effects: OppEffect[];
  /** the share of each committed group lost (0..1; a person is lost at 0.5 or more) */
  losses?: number;
}

/** what is played when the player is committed: a challenge of character control or building */
export interface Challenge {
  system: 'character' | 'building';
  /** what is played (slice A: an AreaPlay kind — flee, ambush, deliver, trader, town) */
  play: string;
  /** the playable place it opens (slice A: a situation area id) */
  area: string;
  /** minutes it is planned to take */
  minutes: number;
}

export interface Opportunity {
  id: string;
  /** the template it was dealt from, and the offer of it (one option at a time: the user's "only show one option") */
  template: string;
  offer: string;
  title: string;
  pitch: string;
  location: OppLocation;
  /** agents held until it resolves */
  requires: Requirement[];
  /** the requirement tier dealt (1-based) of `tiers` (the dealer deals the largest the holdings meet) */
  tier: number;
  tiers: number;
  /** goods spent at commitment */
  costs: Goods;
  /** how long from commitment to resolution: a player opportunity's in run minutes (the leg there and its play), a
   *  resource opportunity's in turns */
  duration: { minutes: number } | { turns: number };
  /** iff `requires` has the player */
  challenge?: Challenge;
  /** iff not: the fixed odds of each tier (they sum to 1; the roll is made at commitment) */
  odds?: Partial<Record<Tier, number>>;
  /** what each tier does (a player opportunity's are read from how its challenge came out) */
  outcomes: Partial<Record<Tier, OppOutcome>>;
  visibility: 'rumour' | 'known';
  /** it leaves the map at the end of this turn if not committed */
  expires: { turn: number };
  /** what letting it expire does (the user: "Some can have negative effects for letting them expire") */
  onExpire?: OppOutcome;
  /** it must be played now (the outriders on you; the night assault) */
  forced?: boolean;
  /** its challenge is the run's climax */
  climax?: boolean;
  /** themes (what bonuses and variety read) and the conflict hooks it answers or foreshadows */
  themes: string[];
  hooks: string[];
  /** the dealer's: why it was dealt, the parts of its score */
  because: string[];
  /** whether what's available meets it now, and what's missing if not (a known but unaffordable one stays visible) */
  affordable: boolean;
  missing: string[];
}

export function needsPlayer(o: Pick<Opportunity, 'requires'>): boolean {
  return o.requires.some((r) => r.kind === 'player');
}

/** A commitment: the opportunity, the agents it holds, what it spent, when it resolves. */
export interface Commitment {
  id: string;
  opp: Opportunity;
  agents: string[];
  spent: Goods;
  /** run minute and turn it was made */
  start: number;
  turn: number;
  /** a resource opportunity's: the turn it resolves (start turn + duration; the start turn with an 'instant' bonus) */
  resolvesTurn?: number;
  /** a resource opportunity's tier, rolled at commitment from its odds (the card showed them) */
  rolled?: Tier;
}

export interface Resolution {
  commitment: string;
  opp: string;
  tier: Tier;
  /** the tier before bonuses lifted it */
  rolled: Tier;
  outcome: OppOutcome;
  /** agents back (their count after losses), agents lost */
  returns: { agent: string; count: number }[];
  lost: { agent: string; count: number }[];
  /** what the bonuses did */
  bonuses: string[];
  /** the effects not applied to the holdings: for the conflict's owner ('conflict') and the world state ('atlas') */
  out: OppEffect[];
  at: number;
  turn: number;
}

// ---- the rules ---------------------------------------------------------------------------------------------------

/** What can be committed now: the user's "they must be available to your character". */
export function available(h: Holdings): Agent[] {
  return h.agents.filter((a) => !a.committed && !a.statuses.includes('wounded') && ('with' in a.at || h.rules.includes(a.at.settlement)));
}

const hasTags = (a: Agent, tags?: string[]) => !tags || tags.every((t) => a.tags.includes(t));

/**
 * The agents that would meet these requirements from what's available (fewest-tagged first, so a veteran isn't spent
 * where any would do), or what's missing. A count is agents of the kind, not soldiers: "two armies" is two army agents.
 */
export function meet(reqs: Requirement[], h: Holdings): { ok: true; agents: string[] } | { ok: false; missing: string[] } {
  const free = available(h);
  const used = new Set<string>();
  const missing: string[] = [];
  // (tagged requirements first: they have fewer agents to choose from)
  for (const r of [...reqs].sort((a, b) => (b.tags?.length ?? 0) - (a.tags?.length ?? 0))) {
    const fits = free.filter((a) => a.kind === r.kind && !used.has(a.id) && hasTags(a, r.tags)).sort((a, b) => a.tags.length - b.tags.length);
    if (fits.length < r.count) missing.push(`${r.count} ${r.kind}${r.tags?.length ? ` (${r.tags.join(', ')})` : ''}: ${fits.length} free`);
    for (const a of fits.slice(0, r.count)) used.add(a.id);
  }
  return missing.length ? { ok: false, missing } : { ok: true, agents: [...used] };
}

/** the goods short for these costs */
export function short(costs: Goods, h: Holdings): string[] {
  return Object.entries(costs)
    .filter(([g, n]) => n > 0 && (h.goods[g] ?? 0) < n)
    .map(([g, n]) => `${n} ${g}: ${h.goods[g] ?? 0} held`);
}

/** whether what's available meets an opportunity now, and what's missing */
export function affords(o: Pick<Opportunity, 'requires' | 'costs'>, h: Holdings): { ok: boolean; missing: string[] } {
  const m = meet(o.requires, h);
  const missing = [...(m.ok ? [] : m.missing), ...short(o.costs, h)];
  return { ok: missing.length === 0, missing };
}

/** a tier drawn from the odds by a uniform u in [0, 1) */
export function rollTier(odds: Partial<Record<Tier, number>>, u: number): Tier {
  let acc = 0;
  for (const t of TIERS) {
    acc += odds[t] ?? 0;
    if (u < acc) return t;
  }
  // (u past the sum's rounding: the worst tier given)
  return [...TIERS].reverse().find((t) => (odds[t] ?? 0) > 0) ?? 'success';
}

/** the bonuses that apply to a commitment: the holdings' own, and those held by its committed agents */
export function bonusesFor(h: Holdings, agents: string[]): Bonus[] {
  return h.bonuses.filter((b) => !b.holder || agents.includes(b.holder));
}

const themed = (b: Bonus, o: Opportunity) => b.themes.some((t) => o.themes.includes(t));

/**
 * Commit an opportunity: its agents locked, its costs spent. A resource opportunity's tier is rolled now (`u`: the
 * run's random for it) and it resolves `duration.turns` turns on (at once with an 'instant' bonus).
 */
export function commit(h: Holdings, o: Opportunity, at: { id: string; now: number; turn: number; u?: number }): { holdings: Holdings; commitment: Commitment } {
  const m = meet(o.requires, h);
  if (!m.ok) throw new Error(`commit ${o.id}: ${m.missing.join('; ')}`);
  const s = short(o.costs, h);
  if (s.length) throw new Error(`commit ${o.id}: short of ${s.join('; ')}`);
  const player = needsPlayer(o);
  if (player !== !!o.challenge) throw new Error(`commit ${o.id}: a challenge iff the player is required`);
  if (!player && !o.odds) throw new Error(`commit ${o.id}: a resource opportunity needs its odds`);
  const out = structuredClone(h);
  for (const a of out.agents) if (m.agents.includes(a.id)) a.committed = at.id;
  for (const [g, n] of Object.entries(o.costs)) out.goods[g] = (out.goods[g] ?? 0) - n;
  const c: Commitment = { id: at.id, opp: o, agents: m.agents, spent: { ...o.costs }, start: at.now, turn: at.turn };
  if (!player) {
    if (at.u === undefined) throw new Error(`commit ${o.id}: a resource opportunity's roll needs its random`);
    const instant = bonusesFor(h, m.agents).some((b) => b.kind === 'instant' && themed(b, o));
    c.rolled = rollTier(o.odds!, at.u);
    c.resolvesTurn = at.turn + (instant ? 0 : 'turns' in o.duration ? o.duration.turns : 0);
  }
  return { holdings: out, commitment: c };
}

/**
 * Resolve a commitment at `tier` (a resource opportunity's rolled tier; a player one's from its challenge): bonuses
 * lift it, the committed agents come back with their losses taken and their new tags, the holdings' effects applied.
 * The effects for others (conflict, atlas) are in the resolution's `out`.
 */
export function resolve(h: Holdings, c: Commitment, at: { now: number; turn: number; tier?: Tier }): { holdings: Holdings; resolution: Resolution } {
  const rolled = at.tier ?? c.rolled;
  if (!rolled) throw new Error(`resolve ${c.id}: no tier (a player opportunity's comes from its challenge)`);
  let tier = rolled;
  const notes: string[] = [];
  for (const b of bonusesFor(h, c.agents))
    if (b.kind === 'negate' && b.tier === tier && themed(b, c.opp)) {
      const better = TIERS[Math.max(0, TIERS.indexOf(tier) - 1)];
      notes.push(`${b.why}: ${tier} → ${better}`);
      tier = better;
    }
  const outcome = outcomeAt(c.opp, tier);
  const out = structuredClone(h);
  const returns: Resolution['returns'] = [];
  const lost: Resolution['lost'] = [];
  const tags = outcome.effects.filter((e): e is Extract<OppEffect, { kind: 'tag' }> => e.kind === 'tag');
  for (const a of out.agents) {
    if (a.committed !== c.id) continue;
    delete a.committed;
    // (the player is never lost by an outcome's share: its challenge says if it fell)
    const share = a.kind === 'player' ? 0 : Math.max(0, Math.min(1, outcome.losses ?? 0));
    const gone = a.count === 1 ? (share >= 0.5 ? 1 : 0) : Math.round(a.count * share);
    if (gone) lost.push({ agent: a.id, count: gone });
    a.count -= gone;
    if (a.count > 0) {
      returns.push({ agent: a.id, count: a.count });
      for (const t of tags) {
        for (const tag of t.add) if (!a.tags.includes(tag)) a.tags.push(tag);
        for (const b of t.bonuses ?? []) out.bonuses.push({ ...b, holder: a.id });
      }
    }
  }
  out.agents = out.agents.filter((a) => a.count > 0);
  const rest: OppEffect[] = [];
  for (const e of outcome.effects) {
    if (e.kind === 'goods') for (const [g, n] of Object.entries(e.goods)) out.goods[g] = Math.max(0, (out.goods[g] ?? 0) + n);
    else if (e.kind === 'agent') out.agents.push(structuredClone(e.agent));
    else if (e.kind !== 'tag') rest.push(e);
  }
  return { holdings: out, resolution: { commitment: c.id, opp: c.opp.id, tier, rolled, outcome, returns, lost, bonuses: notes, out: rest, at: at.now, turn: at.turn } };
}

/** an opportunity's outcome at a tier: its own, else the nearest worse one given, else the nearest better */
export function outcomeAt(o: Pick<Opportunity, 'id' | 'outcomes'>, tier: Tier): OppOutcome {
  const i = TIERS.indexOf(tier);
  for (let k = i; k < TIERS.length; k++) if (o.outcomes[TIERS[k]]) return o.outcomes[TIERS[k]]!;
  for (let k = i - 1; k >= 0; k--) if (o.outcomes[TIERS[k]]) return o.outcomes[TIERS[k]]!;
  throw new Error(`opportunity ${o.id}: no outcomes`);
}

/** the scale, derived (never stored): for the map's line and the requirement tiers */
export function scaleOf(h: Holdings): 'lone' | 'party' | 'ruler' | 'empire' {
  if (h.rules.length > 1) return 'empire';
  if (h.rules.length === 1) return 'ruler';
  if (h.agents.some((a) => a.kind !== 'player')) return 'party';
  return 'lone';
}
