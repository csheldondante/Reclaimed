// (card-table, docs/design/TURN_PUZZLE.md, FACTORY.md) The bots' measure of a season's turn as a puzzle. A turn is a
// sequence of actions — take a card (committed), make a use (a recipe), post or recall a piece (instant) — then the
// season's end. This file reads the table as it stands into a small turn model (the stock by good, pieces, cards on
// offer, things with slots, clicks and uses) and simulates actions on it with the model's own rules (ledger strike,
// uses' `per`, one move a piece a season, draft 11: one click a posted crew a season, shared by a thing's recipes). It
// does not change the game: a bot's chosen turn is played on the real table and the real stock is compared with the
// simulated one (`verify`) — a difference is reported, never hidden.
//
// The SOLVER searches every legal turn of the season (depth-first, states seen once per set of actions), the GREEDY bot
// takes the single action that raises the score most until none does. Both score a turn's end with `value`: a bot's
// plain estimate of what the position is worth (goods, people, this season's yields of posted pieces, what the cards
// taken will give, the needs met, bread for the houses), the same for both, so "the solver is better" means "it found
// a better turn by the same yardstick".
import { card as catalogCard } from '../season/catalog';
import { cardOfTemplate, RAIDERS } from '../season/realm-templates';
import { pools } from '../season/ledger';
import type { Table } from './game';

export type PieceKind = 'crew' | 'soldier';
export type Act = { k: 'take'; card: string } | { k: 'use'; use: string; thing: string } | { k: 'post'; kind: PieceKind; thing: string } | { k: 'recall'; kind: PieceKind; thing: string };
export const actKey = (a: Act): string => (a.k === 'take' ? `take ${a.card}` : a.k === 'use' ? `use ${a.use}@${a.thing}` : `${a.k} ${a.kind}@${a.thing}`);

type Goods = Record<string, number>;
/** the score's weights: a bot's estimate, the same for every bot */
export const W = { unrest: -2.5, crew: 2, soldier: 2.5, tied: -0.5, discount: 0.85, hungry: -3 } as const;
/** what a unit of each good is worth to a bot (raw goods less than made ones) */
export const GOOD_W: Record<string, number> = { materials: 1, magic: 1.5, intel: 0.8, wood: 0.5, stone: 0.6, ore: 0.7, grain: 0.4, planks: 0.9, iron: 1.6, bread: 0.7, tools: 1.8, weapons: 2 };
const gw = (k: string): number => GOOD_W[k] ?? 0.8;

interface CardM {
  id: string;
  title: string;
  labor: number;
  might: number;
  costs: Goods;
  value: number;
}
interface UseM {
  key: string;
  id: string;
  name: string;
  thing: string;
  cost: Goods;
  gives: Goods;
  per?: PieceKind;
  needs?: PieceKind;
  left: number;
}
interface ThingM {
  id: string;
  name: string;
  slots: Record<PieceKind, number>;
  /** what one posted piece of each kind gives a season, scored */
  yields: Record<PieceKind, number>;
  /** (draft 11) clicks a posted crew gives a season (0: its uses need none), and clicks already made this season; the
   *  best of its recipes by what it adds (gives less cost, scored) */
  cpc: number;
  used: number;
  best: number;
  /** (draft 11) raiders a soldier posted here stops (the watchtower, the wall walk) */
  stops: number;
}
export interface TurnModel {
  cards: CardM[];
  uses: UseM[];
  things: ThingM[];
  start: S;
  /** (draft 11) bread the town eats at the season's end for every so many crews (0: nothing eats) */
  eats: { good: string; n: number; per: number }[];
  /** (draft 11) the raiders to come (0: none threaten) and what stands against them besides soldiers (a wall) */
  raid: { raiders: number; fixed: number; w: number };
  /** (draft 11) a bot's own extra worth of some goods (Aim) */
  aimGoods: Record<string, number>;
}
interface S {
  goods: Goods;
  unrest: number;
  /** crews not tied to a project or a post (free, and those on strike); free soldiers */
  U: number;
  S: number;
  crews: number;
  soldiers: number;
  posted: Record<string, Record<PieceKind, number>>;
  /** posted this season (they may not move again) */
  fresh: Record<string, Record<PieceKind, number>>;
  /** free pieces that moved this season (recalled) */
  moved: Record<PieceKind, number>;
  left: Record<string, number>;
  /** (draft 11) clicks made at each thing this season */
  clicked: Record<string, number>;
  taken: number;
  gained: number;
}

const freeCrews = (s: S): number => Math.max(0, s.U - s.unrest);
const free = (s: S, k: PieceKind): number => (k === 'crew' ? freeCrews(s) : s.S);
const goodsValue = (g: Record<string, number | undefined>): number => {
  let v = 0;
  for (const [k, n] of Object.entries(g)) {
    if (!n) continue;
    v += k === 'unrest' ? n * W.unrest : k === 'labor' ? n * W.crew : k === 'might' ? n * W.soldier : n * gw(k);
  }
  return v;
};
const POOL_KEYS = new Set(['labor', 'might', 'unrest']);

/** (draft 11) a bot's aim on top of the shared yardstick: more for some cards (by template) and some goods, and a
 *  raider met worth more (a planner that builds toward the raid) */
export interface Aim {
  cards?: Record<string, number>;
  goods?: Record<string, number>;
  raid?: number;
}

/** the table as a turn model, now */
export function modelOf(t: Table, aim: Aim = {}): TurnModel {
  const r = t.realm;
  const p = pools(r.ledger);
  const pieces = r.pieces();
  const seasonsLeft = Math.max(1, r.seasons - r.season);
  const defs = t.packs.flatMap((x) => x.things);
  const works = r.works();
  const things: ThingM[] = works.map((w) => {
    const def = defs.find((d) => `thing:${d.id}` === w.id);
    const per = (k: PieceKind) => goodsValue((def?.slots ?? []).find((s) => s.takes === k)?.each_season ?? {});
    const ck = r.clicks(w.id);
    const best = Math.max(0, ...w.uses.map((u) => goodsValue(u.gives as Record<string, number>) - goodsValue(u.cost as Record<string, number>)));
    // (draft 11: a crew posted on a building with recipes is worth a click of its best recipe each season to come)
    return { id: w.id, name: w.name, slots: { crew: w.slots.crew ?? 0, soldier: w.slots.soldier ?? 0 }, yields: { crew: per('crew') + (w.clicksPerCrew ? FUTURE * best * w.clicksPerCrew : 0), soldier: per('soldier') }, cpc: w.clicksPerCrew ?? 0, used: ck ? ck.of - ck.left : 0, best, stops: 0 };
  });
  const posted: S['posted'] = {};
  const fresh: S['fresh'] = {};
  for (const th of things) {
    posted[th.id] = { crew: 0, soldier: 0 };
    fresh[th.id] = { crew: 0, soldier: 0 };
  }
  const moved = { crew: 0, soldier: 0 };
  for (const x of pieces) {
    if (x.where === 'posted' && x.on && posted[x.on]) {
      posted[x.on][x.kind]++;
      if (x.moved) fresh[x.on][x.kind]++;
    }
    if (x.where === 'free' && x.moved) moved[x.kind]++;
  }
  const uses: UseM[] = r.uses().map((u) => ({ key: `${u.thing}|${u.use.id}`, id: u.use.id, name: u.use.name, thing: u.thing, cost: { ...(u.use.cost as Goods) }, gives: { ...(u.use.gives as Goods) }, ...(u.use.per ? { per: u.use.per } : {}), ...(u.use.needs ? { needs: u.use.needs } : {}), left: u.left }));
  const cards: CardM[] = t.cards().map((c) => {
    const costs: Goods = {};
    for (const [k, n] of Object.entries(c.costs)) if (n && !POOL_KEYS.has(k)) costs[k] = n;
    return { id: c.id, title: c.title, labor: c.locks.labor ?? 0, might: c.locks.might ?? 0, costs, value: cardValue(t, c.id, seasonsLeft) + (aim.cards?.[c.template] ?? 0) };
  });
  const goods: Goods = {};
  for (const [k, n] of Object.entries(r.ledger.holdings.goods)) if (!POOL_KEYS.has(k)) goods[k] = n;
  const start: S = {
    goods,
    unrest: p.unrest,
    U: pieces.filter((x) => x.kind === 'crew' && (x.where === 'free' || x.where === 'strike')).length,
    S: p.might,
    crews: pieces.filter((x) => x.kind === 'crew').length,
    soldiers: pieces.filter((x) => x.kind === 'soldier').length,
    posted,
    fresh,
    moved,
    left: Object.fromEntries(uses.map((u) => [u.key, u.left])),
    clicked: Object.fromEntries(things.map((th) => [th.id, th.used])),
    taken: 0,
    gained: 0,
  };
  const eats = works.flatMap((w) => Object.entries(w.eats ?? {}).map(([good, n]) => ({ good, n, per: w.eatsPer ?? 0 })));
  // (draft 11: the raid to come — every soldier fights, 3 raiders each; a wall stops some by itself)
  const tags = new Map(r.things().map((x) => [x.id, x.tags]));
  for (const th of things) th.stops = tags.get(th.id)?.includes('watchtower') ? 3 : tags.get(th.id)?.includes('town-wall') ? 1 : 0;
  const raiders = r.raidersThreaten() ? r.runNumbers().raid || RAIDERS : 0;
  const fixed = [...tags.values()].some((x) => x.includes('town-wall')) ? 4 : 0;
  return { cards, uses, things, start, eats, raid: { raiders, fixed, w: aim.raid ?? RAID_W }, aimGoods: aim.goods ?? {} };
}
/** (draft 11) a raider the town would meet, to a bot (the same for every bot) */
export const RAID_W = 0.6;

/** a card's worth to a bot: what it gives (and when), its income, the thing it puts in play, the need it meets; less
 *  the crew-seasons it ties up */
function cardValue(t: Table, id: string, seasonsLeft: number): number {
  const r = t.realm;
  const o = r.offers().find((x) => x.id === id)!;
  const tp = r.engine.template(o.template);
  const turns = 'turns' in o.opp.duration ? o.opp.duration.turns : 1;
  const disc = Math.pow(W.discount, turns);
  let v = 0;
  const cat = cardOfTemplate(o.template);
  if (cat) {
    const c = catalogCard(cat);
    v += goodsValue(c.gives ?? {}) * disc + goodsValue(c.income ?? {}) * Math.min(4, Math.max(0, seasonsLeft - turns)) * disc + 2 * disc + (c.unrestOnDone ?? 0) * W.unrest + (c.unrestOnStart ?? 0) * W.unrest;
  }
  const fx = [...(tp.outcome ?? [])] as { helper?: string; args?: unknown[] }[];
  for (const e of fx) {
    if (e.helper === 'pool') v += goodsValue({ [String(e.args?.[0])]: Number(e.args?.[1]) }) * disc;
    if (e.helper === 'income') v += goodsValue({ [String(e.args?.[0])]: Number(e.args?.[1]) }) * Math.min(4, Math.max(0, seasonsLeft - turns)) * disc;
    if (e.helper === 'packPut') {
      const def = t.packs.flatMap((x) => x.things).find((x) => x.id === String(e.args?.[0]));
      // (draft 11: a building's recipes are worth what one click makes, for the seasons left)
      const recipe = (def?.uses ?? []).reduce((m, u) => Math.max(m, goodsValue(u.gives) - goodsValue(u.cost ?? {})), 0);
      if (def) v += ((def.slots ?? []).reduce((n, s) => n + s.n * Math.max(0.5, goodsValue(s.each_season ?? {})), 0) * 1.5 + (def.uses?.length ?? 0) + 1 + Math.max(0, recipe) * Math.min(4, seasonsLeft - turns)) * disc;
      // (draft 11: what it stops in the raid to come — a wall by itself, a watchtower once manned)
      if (def && r.raidersThreaten()) v += RAID_W * (def.tags.includes('town-wall') ? 4 : def.tags.includes('watchtower') ? 1.5 : 0);
    }
  }
  // (a need met, or a threat: the harm its running out would do)
  if (tp.threat) {
    let harm = 0;
    for (const e of (tp.onExpire ?? []) as { helper?: string; args?: unknown[]; event?: string }[]) {
      if (e.helper === 'pool') harm += Math.abs(goodsValue({ [String(e.args?.[0])]: Number(e.args?.[1]) }));
      else if (e.helper && e.helper !== 'say') harm += 4;
    }
    v += Math.max(harm, 3);
  }
  if (!cat && !fx.some((e) => e.helper === 'pool' || e.helper === 'income' || e.helper === 'packPut') && !tp.threat) v += 6 * (tp.parts?.ev ?? 0.3);
  const locks = o.opp.requires.reduce((n, q) => n + (q.kind === 'workers' || q.kind === 'army' ? q.count : 0), 0);
  return v + W.tied * locks * turns;
}

/** goods kept are worth less past a working stock (a bot that only hoards scores no better than one that builds) */
export const STOCK = 6;
const kept = (g: string, n: number): number => gw(g) * (Math.min(n, STOCK) + 0.3 * Math.max(0, n - STOCK));

/** the position's score: goods, Unrest, people (wherever they are), this season's yields of posted pieces, the cards
 *  taken, and (draft 11) bread short for the houses at the season's end */
export function value(m: TurnModel, s: S): number {
  let v = s.unrest * W.unrest + s.crews * W.crew + s.soldiers * W.soldier + s.gained;
  for (const [k, n] of Object.entries(s.goods)) v += kept(k, n) + (m.aimGoods[k] ?? 0) * Math.min(n, STOCK);
  for (const th of m.things) {
    v += s.posted[th.id].crew * th.yields.crew + s.posted[th.id].soldier * th.yields.soldier;
    // (draft 11: a click not yet made is worth part of the best recipe it could make — a reason to post a crew)
    const left = clicksLeft(th, s);
    if (th.cpc && left > 0) v += POTENTIAL * th.best * left;
  }
  // (draft 11: the raid to come — the raiders the town would meet, up to their number)
  if (m.raid.raiders) {
    let met = 3 * s.soldiers + m.raid.fixed;
    for (const th of m.things) met += th.stops * s.posted[th.id].soldier;
    v += m.raid.w * Math.min(met, m.raid.raiders);
  }
  // (the houses' bread at the season's end: short is Unrest; under two seasons' worth is a worry)
  for (const e of m.eats) {
    const want = e.n * (e.per ? Math.ceil(s.crews / e.per) : 1);
    const have = s.goods[e.good] ?? 0;
    if (have < want) v += W.hungry;
    else if (have < 2 * want) v += W.hungry / 3;
  }
  return v;
}
/** the share of its best recipe a click not yet made is worth; and a posted crew's clicks in seasons to come */
const POTENTIAL = 0.5;
const FUTURE = 0.8;

const clone = (s: S): S => ({ goods: { ...s.goods }, unrest: s.unrest, U: s.U, S: s.S, crews: s.crews, soldiers: s.soldiers, posted: Object.fromEntries(Object.entries(s.posted).map(([k, v]) => [k, { ...v }])), fresh: Object.fromEntries(Object.entries(s.fresh).map(([k, v]) => [k, { ...v }])), moved: { ...s.moved }, left: { ...s.left }, clicked: { ...s.clicked }, taken: s.taken, gained: s.gained });
const has = (s: S, costs: Goods): boolean => Object.entries(costs).every(([g, n]) => (s.goods[g] ?? 0) >= n);
/** clicks a thing has left in a state (Infinity: it needs none) */
const clicksLeft = (th: ThingM | undefined, s: S): number => (!th || !th.cpc ? Infinity : Math.max(0, th.cpc * s.posted[th.id].crew - s.clicked[th.id]));

/** the legal actions now */
export function acts(m: TurnModel, s: S): Act[] {
  const out: Act[] = [];
  m.cards.forEach((c, i) => {
    if (s.taken & (1 << i)) return;
    if (freeCrews(s) >= c.labor && s.S >= c.might && has(s, c.costs)) out.push({ k: 'take', card: c.id });
  });
  for (const u of m.uses) if (apply(m, s, { k: 'use', use: u.id, thing: u.thing })) out.push({ k: 'use', use: u.id, thing: u.thing });
  for (const th of m.things)
    for (const k of ['crew', 'soldier'] as const) {
      if (th.slots[k] > s.posted[th.id][k] && free(s, k) - Math.min(free(s, k), s.moved[k]) > 0) out.push({ k: 'post', kind: k, thing: th.id });
      if (s.posted[th.id][k] - s.fresh[th.id][k] > 0) out.push({ k: 'recall', kind: k, thing: th.id });
    }
  return out;
}

/** one action on a copy of the state (null: not legal) */
export function apply(m: TurnModel, s0: S, a: Act): S | null {
  if (a.k === 'take') {
    const i = m.cards.findIndex((c) => c.id === a.card);
    const c = m.cards[i];
    if (i < 0 || s0.taken & (1 << i) || freeCrews(s0) < c.labor || s0.S < c.might || !has(s0, c.costs)) return null;
    const s = clone(s0);
    s.U -= c.labor;
    s.S -= c.might;
    for (const [g, n] of Object.entries(c.costs)) s.goods[g] -= n;
    s.taken |= 1 << i;
    s.gained += c.value;
    return s;
  }
  if (a.k === 'use') {
    const u = m.uses.find((x) => x.id === a.use && x.thing === a.thing);
    if (!u || s0.left[u.key] <= 0 || (u.needs && s0.posted[u.thing][u.needs] <= 0)) return null;
    const th = m.things.find((x) => x.id === u.thing);
    if (clicksLeft(th, s0) <= 0) return null;
    const n = u.per ? s0.posted[u.thing][u.per] : 1;
    const gives = Object.entries(u.gives).map(([k, v]) => [k, (v ?? 0) * n] as const).filter(([, v]) => v !== 0);
    if (!gives.length) return null;
    for (const [k, v] of Object.entries(u.cost)) {
      const have = k === 'labor' ? freeCrews(s0) : k === 'might' ? s0.S : (s0.goods[k] ?? 0);
      if (have < v) return null;
    }
    const s = clone(s0);
    for (const [k, v] of Object.entries(u.cost)) {
      if (k === 'labor') (s.U -= v, (s.crews -= v));
      else if (k === 'might') (s.S -= v, (s.soldiers -= v));
      else s.goods[k] -= v;
    }
    for (const [k, v] of gives) {
      if (k === 'labor') (s.U += v, (s.crews += v));
      else if (k === 'might') (s.S += v, (s.soldiers += v));
      else if (k === 'unrest') s.unrest = Math.max(0, s.unrest + v);
      else s.goods[k] = Math.max(0, (s.goods[k] ?? 0) + v);
    }
    s.left[u.key]--;
    if (th?.cpc) s.clicked[th.id]++;
    return s;
  }
  const th = m.things.find((x) => x.id === a.thing);
  if (!th) return null;
  if (a.k === 'post') {
    if (th.slots[a.kind] <= s0.posted[th.id][a.kind] || free(s0, a.kind) - Math.min(free(s0, a.kind), s0.moved[a.kind]) <= 0) return null;
    const s = clone(s0);
    if (a.kind === 'crew') s.U--;
    else s.S--;
    s.posted[th.id][a.kind]++;
    s.fresh[th.id][a.kind]++;
    return s;
  }
  if (s0.posted[th.id][a.kind] - s0.fresh[th.id][a.kind] <= 0) return null;
  const s = clone(s0);
  s.posted[th.id][a.kind]--;
  if (a.kind === 'crew') s.U++;
  else s.S++;
  s.moved[a.kind]++;
  return s;
}

/** a sequence played from the start (null: an action in it is not legal where it stands) */
export function play(m: TurnModel, seq: readonly Act[]): S | null {
  let s: S | null = m.start;
  for (const a of seq) {
    s = apply(m, s, a);
    if (!s) return null;
  }
  return s;
}

const stateKey = (s: S): string =>
  `${Object.keys(s.goods)
    .sort()
    .map((k) => s.goods[k])
    .join(',')},${s.unrest},${s.U},${s.S},${s.crews},${s.soldiers},${Object.values(s.posted).map((p) => `${p.crew}.${p.soldier}`).join('/')},${Object.values(s.fresh).map((p) => `${p.crew}.${p.soldier}`).join('/')},${s.moved.crew}.${s.moved.soldier},${Object.values(s.left).join('.')},${Object.values(s.clicked).join('.')},${s.taken}`;

export interface SearchResult {
  best: Act[];
  value: number;
  /** distinct legal turns: sets of actions that can be played in some order (the empty turn counted) */
  turns: number;
  /** distinct positions a turn can end in */
  ends: number;
  /** of the turns: how many post or recall a piece, how many make a use */
  withPieces: number;
  withUses: number;
  nodes: number;
  /** the search stopped at its node budget (the counts are then lower bounds) */
  capped: boolean;
  /** (draft 11) distinct outcomes a turn can end in, not counting where the pieces stand: the stock, Unrest, the
   *  pieces' numbers and the cards taken */
  outcomes: number;
}

/**
 * The season's turn searched whole. The best turn: every position the turn can reach, each searched once (the score
 * reads only the position), shortest way to the best kept — exact unless `budget` positions are passed. The count of
 * distinct legal turns: every set of actions that can be played in some order (a set reached in two orders that end
 * differently is still one turn), up to `budget` (set, position) pairs.
 */
export function solve(m: TurnModel, budget = 60_000): SearchResult {
  // (the best: breadth first over positions, so the first way to a position is a shortest)
  const startKey = stateKey(m.start);
  const way = new Map<string, Act[]>([[startKey, []]]);
  const outcomeKey = (s: S): string => `${Object.keys(s.goods).sort().map((k) => s.goods[k]).join(',')}|${s.unrest}|${s.crews}|${s.soldiers}|${s.taken}`;
  const outcomes = new Set<string>([outcomeKey(m.start)]);
  let frontier: S[] = [m.start];
  let best: Act[] = [];
  let bestV = value(m, m.start);
  let capped = false;
  while (frontier.length && !capped) {
    const next: S[] = [];
    for (const s of frontier) {
      const seq = way.get(stateKey(s))!;
      for (const a of acts(m, s)) {
        const n = apply(m, s, a);
        if (!n) continue;
        const k = stateKey(n);
        if (way.has(k)) continue;
        if (way.size >= budget) {
          capped = true;
          break;
        }
        const ns = [...seq, a];
        way.set(k, ns);
        outcomes.add(outcomeKey(n));
        next.push(n);
        const v = value(m, n);
        if (v > bestV + 1e-9) {
          bestV = v;
          best = ns;
        }
      }
      if (capped) break;
    }
    frontier = next;
  }
  // (the count: depth first over (set of actions, position))
  const seen = new Set<string>();
  const turns = new Set<string>();
  let withPieces = 0;
  let withUses = 0;
  let nodes = 0;
  const seq: Act[] = [];
  const dfs = (s: S): void => {
    const set = seq.map(actKey).sort().join('|');
    const key = `${set}#${stateKey(s)}`;
    if (seen.has(key)) return;
    if (seen.size >= budget) {
      capped = true;
      return;
    }
    seen.add(key);
    nodes++;
    if (!turns.has(set)) {
      turns.add(set);
      if (seq.some((a) => a.k === 'post' || a.k === 'recall')) withPieces++;
      if (seq.some((a) => a.k === 'use')) withUses++;
    }
    for (const a of acts(m, s)) {
      const n = apply(m, s, a);
      if (!n) continue;
      seq.push(a);
      dfs(n);
      seq.pop();
    }
  };
  dfs(m.start);
  return { best, value: bestV, turns: turns.size, ends: way.size, withPieces, withUses, nodes, capped, outcomes: outcomes.size };
}

/** the greedy turn: the single action that raises the score most, again and again, until none does */
export function greedy(m: TurnModel): { seq: Act[]; value: number } {
  let s = m.start;
  const seq: Act[] = [];
  for (;;) {
    let pick: { a: Act; s: S; v: number } | null = null;
    for (const a of acts(m, s)) {
      const n = apply(m, s, a);
      if (!n) continue;
      const v = value(m, n);
      if (!pick || v > pick.v + 1e-9) pick = { a, s: n, v };
    }
    if (!pick || pick.v <= value(m, s) + 1e-9) break;
    seq.push(pick.a);
    s = pick.s;
  }
  return { seq, value: value(m, s) };
}

/**
 * Does the best turn depend on ORDER (another order of the same actions is not legal, or ends worse) and on PLACEMENT
 * (a piece it posts, put on another thing with room, ends worse)? Up to `cap` orders are tried.
 */
export function dependence(m: TurnModel, seq: readonly Act[], v: number, cap = 5040): { order: boolean; orderIllegal: boolean; orderWorse: boolean; placement: boolean; posts: boolean } {
  let orderIllegal = false;
  let orderWorse = false;
  let tried = 0;
  const perm = (rest: Act[], acc: Act[]): void => {
    if (tried >= cap || (orderIllegal && orderWorse)) return;
    if (!rest.length) {
      tried++;
      const s = play(m, acc);
      if (!s) orderIllegal = true;
      else if (value(m, s) < v - 1e-9) orderWorse = true;
      return;
    }
    const done = new Set<string>();
    for (let i = 0; i < rest.length; i++) {
      const k = actKey(rest[i]);
      if (done.has(k)) continue;
      done.add(k);
      perm([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, rest[i]]);
    }
  };
  if (seq.length > 1) perm([...seq], []);
  let placement = false;
  const posts = seq.some((a) => a.k === 'post');
  seq.forEach((a, i) => {
    if (a.k !== 'post') return;
    // (the position before this post: a piece put on another thing with room there is a real choice; if the rest of
    // the turn then cannot be played, or ends worse, where the piece went mattered)
    const before = play(m, seq.slice(0, i));
    if (!before) return;
    for (const th of m.things) {
      if (th.id === a.thing) continue;
      const alt = [...seq];
      alt[i] = { ...a, thing: th.id };
      if (!apply(m, before, alt[i])) continue;
      const s = play(m, alt);
      if (!s || value(m, s) < v - 1e-9) placement = true;
    }
  });
  return { order: orderIllegal || orderWorse, orderIllegal, orderWorse, placement, posts };
}

/**
 * Play a turn on the real table, then compare the real stock, pools and posts with the simulated end (the simulation
 * must agree with the game; a difference is returned in words, never hidden).
 */
export function playTurn(t: Table, m: TurnModel, seq: readonly Act[]): string[] {
  const out: string[] = [];
  for (const a of seq) {
    const ok = a.k === 'take' ? t.take(a.card) : a.k === 'use' ? t.use(a.use, a.thing) : a.k === 'post' ? t.post(a.kind, a.thing) : t.recall(a.kind, a.thing);
    if (!ok) out.push(`the game refused "${actKey(a)}"`);
  }
  const s = play(m, seq);
  if (!s) return [...out, 'the simulation refused its own turn'];
  const p = pools(t.realm.ledger);
  const goods = t.realm.ledger.holdings.goods;
  for (const k of new Set([...Object.keys(s.goods), ...Object.keys(goods).filter((x) => !POOL_KEYS.has(x))])) if ((goods[k] ?? 0) !== (s.goods[k] ?? 0)) out.push(`${k}: the game has ${goods[k] ?? 0}, the simulation ${s.goods[k] ?? 0}`);
  const want = { unrest: s.unrest, labor: freeCrews(s), might: s.S };
  for (const [k, v] of Object.entries(want)) if (p[k as keyof typeof p] !== v) out.push(`${k}: the game has ${p[k as keyof typeof p]}, the simulation ${v}`);
  const real = new Map<string, number>();
  for (const x of t.realm.pieces()) if (x.where === 'posted') real.set(`${x.on}|${x.kind}`, (real.get(`${x.on}|${x.kind}`) ?? 0) + 1);
  for (const th of m.things) for (const k of ['crew', 'soldier'] as const) if ((real.get(`${th.id}|${k}`) ?? 0) !== s.posted[th.id][k]) out.push(`${k}s on ${th.name}: the game has ${real.get(`${th.id}|${k}`) ?? 0}, the simulation ${s.posted[th.id][k]}`);
  return out;
}

/** a turn in words, for the played sample */
export function actText(m: TurnModel, a: Act): string {
  if (a.k === 'take') return `take "${m.cards.find((c) => c.id === a.card)?.title ?? a.card}"`;
  const th = m.things.find((x) => x.id === a.thing)?.name ?? a.thing;
  if (a.k === 'use') return `use ${m.uses.find((u) => u.id === a.use)?.name ?? a.use} at ${th}`;
  return `${a.k === 'post' ? 'post' : 'call back'} a ${a.kind} ${a.k === 'post' ? 'on' : 'from'} ${th}`;
}
