// (loop-skeleton round 6; docs/SYSTEMS.md recipe 7) Tags and synergy rules as data. The owner (2026-11-16): "Those
// engines should all be defined in terms of tags and synnergies designed like a card game not hard coded." and "I would
// have abilities like double output from the field of growth effect is active. Etc. make the tags and synnergies
// thematically appropriate and then finding them and optimizing engines to deal with crises will be fun."
//
// A rule is a card's line: when something happens (a season turns, a fact event is recorded, a live event is read),
// and things carrying these tags stand in this relation of place, change a pool or one of the event's numbers by this
// much, up to a capacity, at most so often a season. Every firing is a `RuleHit` with its reason in the player's words;
// the realm records it in the fact layer (kind 'rule-fired') and shows it on the season's summary.
//
// Things and their tags are not stored here: the owner of the world gives them (season/realm.ts `things`): each
// persistent thing's tags come from what it is (field, temple, market, wall, gate, water) and its state (worked,
// standing, garrison, growth-active, festival, burned, flooded); a ruined or burned thing has lost its working tags
// there, so every rule about it stops by itself.
//
// Chains (card-table; the owner, 2026-11-16: "an in play thing that makes winning a fight cause a new challenger
// opportunity and a next fight"). A rule may also ACT: put a card on offer, start a live card, set or clear a tag on
// the thing it matched. What an act causes is a trigger like any other — a tag changed is re-read by the next rule, an
// offered card's result fires the rules about results — so rules chain.
//
// Loops are wanted (the owner, 2026-11-16: "I think we want loops and fun engines I wouldn't limit that. I would make
// it so the infinite loops are tied to user actions so they don't run infinitely on their own. But crazy multipliers
// and triggers are fun."). So nothing here bounds an engine: a rule fires every time its trigger occurs, multipliers
// stack, `perSeason` and `cap` are words an author may use ("the temple holds so many") and nothing asks for them.
// What ends a loop is its structure. A CASCADE is everything set off by one player action (a card taken, a spell
// cast, the season ended) or one season's turn (`begin`). In a cascade a rule fires once on each occurrence of its
// trigger (an occurrence has an `id`: a fact event's, a live event's), and no rule fires inside another: an act
// takes effect only through the world — an offered card waits to be taken, a started event waits for the season's
// end — so the next turn of a loop costs the player an action or a season. A loop can go on for ever; it cannot go
// on by itself. A rule's own record ('rule-fired') is never a trigger.

/** firings in one cascade past which the book stops with an error naming the chain. A defect detector for the
 *  engine (an act that takes effect inside its own cascade would be a bug), not a rule of the game */
export const CASCADE_LIMIT = 10_000;

export interface Thing {
  id: string;
  name: string;
  tags: readonly string[];
  /** where it is (world cells), when the world knows */
  at: readonly [number, number] | null;
  /** the settlement it is part of (a settlement: itself) */
  town: string | null;
}

export interface TagQuery {
  /** carries every one of these */
  tags: string[];
  /** and none of these */
  not?: string[];
  /** and stands within `cells` of: the first thing (`a`), the live event's place, or the live event's route (the
   *  straight way from where its marchers start to where they go) */
  near?: { of: 'a' | 'event' | 'route'; cells: number };
  /** and is in the same town as the first thing */
  sameTown?: boolean;
}

/** `live` with no `tier`: when a live event of that kind is read, BEFORE its result is picked (to change its
 *  numbers). With `tier`: AFTER, when its result is one of these (to act on a win or a loss) */
export type RuleTrigger = 'turn' | { event: string } | { live: string; tier?: string[] };

/** what an acting rule does: a card put on offer now, a live card's event begun now, a tag set or cleared on the
 *  first thing matched (`timed`: it lasts to the end of the season) */
export type RuleAct = { offer: string } | { start: string } | { tag: string; on: 'a'; timed?: boolean } | { untag: string; on: 'a' };
export const isAct = (fx: RuleDef['effect']): fx is RuleAct => 'offer' in fx || 'start' in fx || 'tag' in fx || 'untag' in fx;

export interface RuleDef {
  id: string;
  /** its name, as a card's */
  name: string;
  on: RuleTrigger;
  /** the thing it is about: it fires once for all that match */
  a: TagQuery;
  /** a second thing it needs, in some relation of place to the first or to the event */
  b?: TagQuery;
  /** a pool's level it needs */
  need?: { pool: string; gte?: number; lte?: number };
  /** what it changes: a pool (add), or one of a live event's numbers (add, or multiply); or what it does (RuleAct) */
  effect: { pool: string; n: number } | { amount: string; op: 'add' | 'mul'; n: number } | RuleAct;
  /** `n` counts once for each: first thing matched, second thing matched, or `each` of one of the event's numbers */
  per?: 'a' | 'b' | { amount: string; each: number };
  /** the most it may add in one firing (a temple holds so many) */
  cap?: number;
  /** the most firings a season, if the author wants one (absent: it fires every time its trigger occurs) */
  perSeason?: number;
  /** why, in the player's words: {a} and {b} the things' names, {n} how much, {count} how many matched */
  why: string;
}

export interface RuleHit {
  rule: string;
  name: string;
  things: string[];
  pool?: string;
  amount?: string;
  /** what it added (a multiply: the difference it made); an act: 1 */
  delta: number;
  text: string;
  /** an acting rule: what it did */
  act?: RuleAct;
  /** what set it off, in the player's words (the occasion's `what`), and the rule that had offered or started the
   *  card this is the result of (the occasion's `after`): a chain is read back from these */
  what?: string;
  after?: string;
}

/** what a trigger carries: a live event's numbers (changed in place), its place and its route; and, for the log,
 *  what happened in words and the rule that caused it (a chain's link) */
export interface RuleOccasion {
  on: RuleTrigger;
  vars?: Record<string, number>;
  at?: readonly [number, number] | null;
  route?: readonly [readonly [number, number], readonly [number, number]] | null;
  what?: string;
  after?: string;
  /** which occurrence of the trigger this is (a fact event's id, a live event's): in one cascade a rule fires once
   *  on it. Absent: every call is its own occurrence */
  id?: string;
}

export interface RuleWorld {
  things(): Thing[];
  pool(k: string): number;
  /** add to a pool (negative: take); returns what was really added */
  gain(k: string, n: number): number;
  /** an acting rule's act, on the things it matched; false: it changed nothing (the card is on offer already, done for
   *  good, or not known; the tag is there already). Absent: this world has no acts and an acting rule never fires */
  act?(fx: RuleAct, things: Thing[], rule: RuleDef): boolean;
}

/** the rules' own state, saved with a run: firings by rule in the season it is in (for a rule with `perSeason`, and
 *  for the list that shows what fired) */
export interface RuleState {
  season: number;
  fired: Record<string, number>;
}

/** (card-table) what a rule lacks to fire: its firings spent, a pool's level, no first thing (the closest and what it
 *  lacks or has too much of), no second thing, or a second thing too far away */
export type RuleMissing =
  | { kind: 'spent' }
  | { kind: 'need'; pool: string; have: number; gte?: number; lte?: number }
  | { kind: 'a'; tags: string[]; closest: { name: string; lacks: string[]; has: string[] } | null }
  | { kind: 'b'; a: string; tags: string[]; closest: { name: string; lacks: string[]; has: string[] } | null }
  | { kind: 'far'; a: string; b: string; cells: number };

export interface RuleCheck {
  rule: string;
  name: string;
  on: RuleTrigger;
  /** times it has fired this season */
  fired: number;
  ok: boolean;
  missing?: RuleMissing;
  /** the things it would be about (their names) */
  things?: string[];
}

/** a rule's trigger against an occasion's. A rule about results (`tier`) fires on an occasion that carries a result,
 *  one of its own; a rule about a live event's numbers on one that carries none */
const same = (a: RuleTrigger, b: RuleTrigger): boolean => {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  if ('event' in a) return 'event' in b && a.event === b.event;
  if (!('live' in b) || a.live !== b.live) return false;
  return a.tier ? !!b.tier && b.tier.some((t) => a.tier!.includes(t)) : !b.tier;
};

const dist = (a: readonly [number, number], b: readonly [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** a point's distance from a segment */
function toSegment(p: readonly [number, number], s: readonly [readonly [number, number], readonly [number, number]]): number {
  const [a, b] = s;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const k = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - k * dx, p[1] - a[1] - k * dy);
}

function matches(t: Thing, q: TagQuery, o: RuleOccasion, a?: Thing): boolean {
  if (!q.tags.every((x) => t.tags.includes(x)) || (q.not ?? []).some((x) => t.tags.includes(x))) return false;
  if (q.sameTown && (!a || t.town === null || t.town !== a.town)) return false;
  if (q.near) {
    if (!t.at) return false;
    if (q.near.of === 'a') return !!a?.at && a.id !== t.id && dist(t.at, a.at) <= q.near.cells;
    if (q.near.of === 'event') return !!o.at && dist(t.at, o.at) <= q.near.cells;
    return !!o.route && toSegment(t.at, o.route) <= q.near.cells;
  }
  return true;
}

export class RuleBook {
  private state: RuleState = { season: -1, fired: {} };

  constructor(
    readonly rules: readonly RuleDef[],
    private w: RuleWorld,
  ) {
    const ids = new Set<string>();
    for (const r of rules) {
      if (ids.has(r.id)) throw new Error(`rules: the id ${r.id} is used twice`);
      ids.add(r.id);
      if ('amount' in r.effect && (typeof r.on === 'string' || !('live' in r.on))) throw new Error(`rule ${r.id}: only a live event has numbers to change`);
      if (!isAct(r.effect) && (r.effect.n === 0 || ('op' in r.effect && r.effect.op === 'mul' && r.effect.n < 0))) throw new Error(`rule ${r.id}: its effect changes nothing`);
      if ('amount' in r.effect && typeof r.on !== 'string' && 'live' in r.on && r.on.tier) throw new Error(`rule ${r.id}: a rule about a result comes after the event's numbers are read: it cannot change one`);
      if (r.per === 'b' && !r.b) throw new Error(`rule ${r.id}: counts a second thing it does not name`);
    }
  }

  save(): RuleState {
    return structuredClone(this.state);
  }
  load(s: RuleState): void {
    this.state = structuredClone(s);
  }

  /** a new season: the counts of firings start again */
  season(n: number): void {
    if (n !== this.state.season) this.state = { season: n, fired: {} };
  }

  /** the cascade under way: its firings in order, and each rule's occurrences already fired on */
  private cascade = { chain: [] as string[], seen: new Set<string>() };
  /** A cascade begins: one player action (a card taken, a spell cast, the season ended) or one season's turn. Whoever
   *  owns the world calls this before the first trigger the action sets off. */
  begin(): void {
    this.cascade = { chain: [], seen: new Set() };
  }

  /**
   * What fires on an occasion, in the rules' order; each changes its pool, or the occasion's number, at once. A rule
   * that would change nothing (no match, its capacity 0, the pool already empty) does not fire and is not counted.
   */
  fire(o: RuleOccasion): RuleHit[] {
    return this.run(o, false);
  }

  /** (card-table) What would fire on an occasion now, with nothing changed: no pool moves, no firing is counted. The
   *  occasion's numbers ARE changed (give a copy): a live event's result can be predicted from them */
  preview(o: RuleOccasion): RuleHit[] {
    return this.run(o, true);
  }

  /** times a rule has fired this season */
  fired(id: string): number {
    return this.state.fired[id] ?? 0;
  }

  /**
   * (card-table) Why a rule would not fire now, apart from its trigger: the first thing missing, as data (the front
   * end words it). `ok`: its pool level, its things and their places all hold — it fires when its trigger next happens.
   * A place test against a live event (`near` of 'event' or 'route') is not checked here: there is no event to measure.
   */
  check(r: RuleDef): RuleCheck {
    const base = { rule: r.id, name: r.name, on: r.on, fired: this.fired(r.id) };
    if (r.perSeason !== undefined && base.fired >= r.perSeason) return { ...base, ok: false, missing: { kind: 'spent' } };
    if (r.need) {
      const have = this.w.pool(r.need.pool);
      if ((r.need.gte !== undefined && have < r.need.gte) || (r.need.lte !== undefined && have > r.need.lte)) return { ...base, ok: false, missing: { kind: 'need', pool: r.need.pool, have, ...(r.need.gte !== undefined ? { gte: r.need.gte } : {}), ...(r.need.lte !== undefined ? { lte: r.need.lte } : {}) } };
    }
    const things = this.w.things();
    const loose = (q: TagQuery): TagQuery => (q.near && q.near.of !== 'a' ? { ...q, near: undefined } : q);
    const o: RuleOccasion = { on: r.on };
    /** the thing that carries most of a query's tags, and what it lacks or has too much of */
    const closest = (q: TagQuery, pool: Thing[]): { name: string; lacks: string[]; has: string[] } | null => {
      let best: { name: string; lacks: string[]; has: string[] } | null = null;
      for (const t of pool) {
        const lacks = q.tags.filter((x) => !t.tags.includes(x));
        const has = (q.not ?? []).filter((x) => t.tags.includes(x));
        if (lacks.length === q.tags.length) continue;
        if (!best || lacks.length + has.length < best.lacks.length + best.has.length) best = { name: t.name, lacks, has };
      }
      return best;
    };
    const as = things.filter((t) => matches(t, loose(r.a), o));
    if (!as.length) return { ...base, ok: false, missing: { kind: 'a', tags: r.a.tags, closest: closest(r.a, things) } };
    if (r.b) {
      const b = loose(r.b);
      const withB = as.filter((a) => things.some((t) => t.id !== a.id && matches(t, b, o, a)));
      if (!withB.length) {
        // (a second thing with the tags exists, but not in the rule's relation of place: say that, not "missing")
        const anywhere = things.filter((t) => matches(t, { tags: b.tags, ...(b.not ? { not: b.not } : {}) }, o) && !as.every((a) => a.id === t.id));
        return { ...base, ok: false, missing: anywhere.length && b.near ? { kind: 'far', a: as[0].name, b: anywhere[0].name, cells: b.near.cells } : { kind: 'b', a: as[0].name, tags: b.tags, closest: closest(b, things.filter((t) => !as.some((a) => a.id === t.id) || as.length > 1)) } };
      }
      return { ...base, ok: true, things: [withB[0].name, things.find((t) => t.id !== withB[0].id && matches(t, b, o, withB[0]))!.name] };
    }
    return { ...base, ok: true, things: [as[0].name] };
  }

  private run(o: RuleOccasion, dry: boolean): RuleHit[] {
    const hits: RuleHit[] = [];
    let things = this.w.things();
    for (const r of this.rules) {
      if (!same(r.on, o.on)) continue;
      if (r.perSeason !== undefined && (this.state.fired[r.id] ?? 0) >= r.perSeason) continue;
      // (in one cascade a rule fires once on one occurrence of its trigger)
      const occurrence = o.id !== undefined ? `${r.id}|${o.id}` : null;
      if (!dry && occurrence && this.cascade.seen.has(occurrence)) continue;
      if (r.need) {
        const have = this.w.pool(r.need.pool);
        if ((r.need.gte !== undefined && have < r.need.gte) || (r.need.lte !== undefined && have > r.need.lte)) continue;
      }
      // (the first things, and for each the second things that stand in the rule's relation to it)
      const as: Thing[] = [];
      const bs = new Map<string, Thing>();
      for (const a of things) {
        if (!matches(a, r.a, o)) continue;
        if (r.b) {
          const mine = things.filter((b) => b.id !== a.id && matches(b, r.b!, o, a));
          if (!mine.length) continue;
          for (const b of mine) bs.set(b.id, b);
        }
        as.push(a);
      }
      if (!as.length) continue;
      const fx = r.effect;
      let times = 1;
      if (r.per === 'a') times = as.length;
      else if (r.per === 'b') times = bs.size;
      else if (r.per) {
        const v = o.vars?.[r.per.amount];
        if (typeof v !== 'number') throw new Error(`rule ${r.id}: the event has no number ${r.per.amount}`);
        times = Math.floor(v / r.per.each);
      }
      let delta: number;
      if (isAct(fx)) {
        // (an act: done by the world's owner; nothing changed — the card stands already, the tag is there — is no firing)
        delta = dry ? (this.w.act ? 1 : 0) : this.w.act?.(fx, as, r) ? 1 : 0;
        // (a tag set or cleared is read by the rules that come after)
        if (delta && !dry) things = this.w.things();
      } else if ('pool' in fx) {
        let n = fx.n * times;
        if (r.cap !== undefined) n = Math.sign(n) * Math.min(Math.abs(n), r.cap);
        delta = !n ? 0 : dry ? n : this.w.gain(fx.pool, n);
      } else {
        const v = o.vars;
        if (!v || typeof v[fx.amount] !== 'number') throw new Error(`rule ${r.id}: the event has no number ${fx.amount}`);
        const was = v[fx.amount];
        let next = fx.op === 'mul' ? Math.round(was * Math.pow(fx.n, times)) : was + fx.n * times;
        if (r.cap !== undefined) next = was + Math.sign(next - was) * Math.min(Math.abs(next - was), r.cap);
        next = Math.max(0, next);
        v[fx.amount] = next;
        delta = next - was;
      }
      if (!delta) continue;
      if (!dry) {
        this.state.fired[r.id] = (this.state.fired[r.id] ?? 0) + 1;
        if (occurrence) this.cascade.seen.add(occurrence);
        this.cascade.chain.push(r.id);
        // (the defect detector: nothing in the game takes effect inside its own cascade, so this is never reached)
        if (this.cascade.chain.length > CASCADE_LIMIT) throw new Error(`rules: more than ${CASCADE_LIMIT} firings in one cascade — an engine defect, not a rule of the game. The chain ends: ${this.cascade.chain.slice(-12).join(' -> ')}`);
      }
      const first = as[0];
      const second = [...bs.values()][0];
      const text = r.why.replace(/\{(a|b|n|count)\}/g, (_, k: string) => (k === 'a' ? first.name : k === 'b' ? (second?.name ?? '') : k === 'n' ? String(Math.abs(delta)) : String(r.per === 'b' ? bs.size : as.length)));
      hits.push({ rule: r.id, name: r.name, things: [...as.map((t) => t.id), ...bs.keys()], ...(isAct(fx) ? { act: fx } : 'pool' in fx ? { pool: fx.pool } : { amount: fx.amount }), delta, text: text.charAt(0).toUpperCase() + text.slice(1), ...(o.what ? { what: o.what } : {}), ...(o.after ? { after: o.after } : {}) });
    }
    return hits;
  }
}
