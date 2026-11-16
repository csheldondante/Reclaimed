// (loop-skeleton; docs/design/LOOP_SKELETON.md) The run record and the world record: the main loop's rules, pure.
// A run: a leader picked, petitions dealt (each one opportunity card in the fixed format — a cost, an effect if
// played, an effect if it expires unplayed, a named presenter), played by committing their cost through the season
// ledger (season/ledger.ts: the one place pools live), aged a season at a time, a threat among them whose expiry is the
// attack. A world record outlives runs: what changed in the world (each change recorded once), near — a part of your
// town — or far — another place of the world, founded, captured, destroyed or made a vassal, at once; and the world's
// places with their owner, status and tribute (tribute is paid into the pools each season; a place's status deals cards).
// No DOM, no GPU, no clock. Every function returns new records and never changes the ones it was given.
import { commit, grant, lose, pools, short, type Pool, type Pools, type SeasonCard, type SeasonLedger } from './ledger';
import type { MutationKind, PlaceStatus, SignKind } from './mutation';

/** a card's suit: what a leader's hand leans to */
export type Suit = 'build' | 'arms' | 'lore';

export type SpellId = 'heatray' | 'telekinesis';

export interface Leader {
  id: string;
  name: string;
  /** one plain line under the name */
  line: string;
  /** the pools this leader's town starts a run with, and what each season brings */
  pools: Partial<Pools>;
  income: Partial<Pools>;
  /** the suit this leader's petitions lean to */
  suit: Suit;
  /** the petition this leader always hears first (their own people's plan) */
  opens: string;
}

/** what a card does when played, or when it expires unplayed */
export interface Effect {
  /** one plain sentence or two the player reads */
  text: string;
  /** goods and Unrest changed (+ or −; never people) */
  pools?: Partial<Pools>;
  /** a spell unlocked for the rest of the run */
  spell?: SpellId;
  /** an attack by this many raiders in the season that follows */
  raid?: number;
  /** the world changed (season/mutation.ts), at once */
  mutation?: Mutation;
  /** signs over your town for some seasons after (ash fall and darkness after a far eruption) */
  signs?: { kinds: SignKind[]; seasons: number };
}

/** a world's place as the world record keeps it: who holds it, how it stands, what it pays you each season */
export interface Place {
  id: string;
  name: string;
  owner: 'you' | 'raiders' | 'free';
  status: PlaceStatus;
  tribute: Partial<Pools>;
}

/**
 * A world change a card names. Near: a part of your town (`near`: which part — the scene finds the spot — and its size
 * as a share of the town's radius). Far: another place of the world set to a new owner and status (`far`), wherever
 * the camera is.
 */
export interface Mutation {
  kind: MutationKind;
  /** "the lower town", "Harrowgate" */
  where: string;
  near?: { spot: 'low' | 'centre' | 'east' | 'north' | 'west'; size: number };
  far?: Place;
}

/** One opportunity card: exactly a cost, an effect if played, an effect if it expires (DECISIONS: the fixed format). */
export interface Petition {
  id: string;
  suit: Suit;
  /** the named character who brings it, and what they are in the town */
  presenter: { name: string; role: string };
  title: string;
  /** the presenter's ask, in their words */
  ask: string;
  /** the cost: a town project (people locked for its seasons, goods spent, its building raised by the season loop), or
   *  goods spent at once */
  cost: { project: SeasonCard } | { spend: Partial<Pools> };
  played: Effect;
  expires: Effect;
  /** seasons it stays offered (its countdown) */
  seasons: number;
  /** a threat: its countdown is shown from the first season, what helps against it, and the world change it brings
   *  if the attack breaks through */
  threat?: { helps: string; brings: Mutation; broke: string };
  /** about a far place: dealt in a run's first hand */
  first?: boolean;
  /** dealt only while a place of the world stands so (a captured town sends worse cards) */
  when?: { place: string; status: PlaceStatus };
  /** signs seen in your town while the card is in the hand: the warning the card's words point at */
  warns?: SignKind[];
  /** what the threat's "what helps" names: dealt right after the first hand, so there is time to build it before the
   *  threat's countdown ends */
  defence?: boolean;
}

/** a card in the hand: the petition and the seasons it has left */
export interface Held {
  id: string;
  left: number;
}

export interface RunRecord {
  v: 1;
  /** which run of this world it is (1 the first) */
  n: number;
  leader: string;
  season: number;
  hand: Held[];
  /** petition ids not yet dealt, in the order they will be */
  deck: string[];
  played: { id: string; season: number }[];
  expired: { id: string; season: number }[];
  spells: SpellId[];
  /** an attack due: its size and the season it plays in */
  raid: { n: number; season: number } | null;
  /** the attack's result, once played */
  fight: { raiders: number; left: number; fallen: number; held: boolean } | null;
  /** world changes made in this run (WorldChange ids) */
  mutations: string[];
  /** world changes cards have set off, to be applied and recorded at once by the scene (`mutate`) */
  due: Due[];
  /** signs over your town left by effects: each until the start of a season */
  signs: { kind: SignKind; until: number }[];
  over: boolean;
}

export interface WorldChange {
  /** unique in the world record: recorded once */
  id: string;
  kind: MutationKind;
  /** one plain sentence for the end-of-run list */
  text: string;
  /** where it happened, in the player's words ("the lower town", "Harrowgate") */
  where: string;
  /** near: the town it happened in, its place in the town's own frame (world units from the town's corner: the window
   *  slides) and its radius. Far: the place's id */
  near?: { town: string; at: [number, number]; radius: number };
  far?: string;
  run: number;
  season: number;
  leader: string;
}

/** a world change set off, waiting for the scene to apply and record it: the card it came from and its sentence */
export interface Due {
  id: string;
  mutation: Mutation;
  text: string;
}

export interface WorldRecord {
  v: 1;
  /** runs begun in this world */
  runs: number;
  changes: WorldChange[];
  /** the world's other places that play has touched */
  places: Place[];
}

export const newWorld = (): WorldRecord => ({ v: 1, runs: 0, changes: [], places: [] });

/** cards in the hand beside the threat */
export const HAND_SIZE = 3;

/** a small seeded random (mulberry32): the deck's order */
function rand(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** how much likelier a card of the leader's suit comes up early */
export const SUIT_WEIGHT = 3;

/**
 * The deck's order for a leader: the leader's own opening card, then the cards about far places (`first`) — the first
 * hand; then the defence cards (so the threat can be prepared for in time); then a weighted shuffle of the town's other
 * cards, the leader's suit SUIT_WEIGHT times as likely at each draw. Cards dealt on a place's status (`when`) are not
 * in it: `fill` deals them while their place stands so.
 */
export function deckFor(leader: Leader, cards: readonly Petition[], seed: number): string[] {
  const r = rand(seed);
  const town = cards.filter((c) => !c.threat && !c.first && !c.when);
  const opens = town.filter((c) => c.id === leader.opens).map((c) => c.id);
  const defence = town.filter((c) => c.defence && c.id !== leader.opens).map((c) => c.id);
  const left = town.filter((c) => !opens.includes(c.id) && !defence.includes(c.id)).map((c) => ({ id: c.id, w: c.suit === leader.suit ? SUIT_WEIGHT : 1 }));
  const out: string[] = [];
  while (left.length) {
    let x = r() * left.reduce((s, c) => s + c.w, 0);
    let i = 0;
    while (i < left.length - 1 && x >= left[i].w) x -= left[i++].w;
    out.push(left.splice(i, 1)[0].id);
  }
  const far = cards.filter((c) => c.first && !c.threat && !c.when).map((c) => c.id);
  return [...opens, ...far, ...defence, ...out];
}

const find = (cards: readonly Petition[], id: string): Petition => {
  const c = cards.find((x) => x.id === id);
  if (!c) throw new Error(`run: no petition ${id}`);
  return c;
};

/** the cards a place's status deals now, not yet seen in this run */
function sent(run: RunRecord, cards: readonly Petition[], world: WorldRecord): string[] {
  const seen = new Set([...run.hand.map((h) => h.id), ...run.deck, ...run.played.map((p) => p.id), ...run.expired.map((p) => p.id)]);
  return cards.filter((c) => c.when && !seen.has(c.id) && world.places.some((p) => p.id === c.when!.place && p.status === c.when!.status)).map((c) => c.id);
}

/** the hand filled up to HAND_SIZE cards beside the threat: the cards the world's places send first, then the deck */
function fill(run: RunRecord, cards: readonly Petition[], world: WorldRecord): RunRecord {
  const hand = [...run.hand];
  const deck = [...sent(run, cards, world), ...run.deck];
  while (deck.length && hand.filter((h) => !find(cards, h.id).threat).length < HAND_SIZE) {
    const id = deck.shift()!;
    hand.push({ id, left: find(cards, id).seasons });
  }
  return { ...run, hand, deck };
}

/**
 * A run begun in a world: the leader's deck shuffled, the threat in the hand from the first season, the hand filled.
 * The world record counts the run.
 */
export function newRun(leader: Leader, cards: readonly Petition[], world: WorldRecord, seed: number): { run: RunRecord; world: WorldRecord } {
  const threats = cards.filter((c) => c.threat);
  const w: WorldRecord = { ...world, runs: world.runs + 1 };
  const run: RunRecord = {
    v: 1,
    n: w.runs,
    leader: leader.id,
    season: 1,
    hand: threats.map((t) => ({ id: t.id, left: t.seasons })),
    deck: deckFor(leader, cards, seed),
    played: [],
    expired: [],
    spells: [],
    raid: null,
    fight: null,
    mutations: [],
    due: [],
    signs: [],
    over: false,
  };
  return { run: fill(run, cards, w), world: w };
}

/** the ledger a run starts with: the leader's pools and income, the town's buildings from earlier runs kept */
export function startLedger(leader: Leader, before: SeasonLedger | null, fresh: (pools: Partial<Pools>, income: Partial<Pools>) => SeasonLedger): SeasonLedger {
  const l = fresh(leader.pools, leader.income);
  return before ? { ...l, built: [...before.built] } : l;
}

/** what a petition's cost is short of now (empty: it can be played) */
export function shortOf(ledger: SeasonLedger, p: Petition): Partial<Pools> {
  if ('project' in p.cost) return short(ledger, p.cost.project);
  const have = pools(ledger);
  const out: Partial<Pools> = {};
  for (const [k, v] of Object.entries(p.cost.spend) as [Pool, number][]) if (v > 0 && have[k] < v) out[k] = v - have[k];
  return out;
}

/** goods and Unrest changed by an effect: gains granted, losses taken (never under 0) */
function applyPools(ledger: SeasonLedger, d: Partial<Pools> | undefined): SeasonLedger {
  if (!d) return ledger;
  const up: Partial<Pools> = {};
  const down: Partial<Pools> = {};
  for (const [k, v] of Object.entries(d) as [Pool, number][]) {
    if (!v) continue;
    if (k === 'unrest') down.unrest = (down.unrest ?? 0) + v;
    else if (v > 0) up[k] = v;
    else down[k] = -v;
  }
  let l = Object.keys(up).length ? grant(ledger, up) : ledger;
  if (Object.keys(down).length) l = lose(l, down);
  return l;
}

/** an effect applied to the run and the pools: a spell unlocked once, a raid set for next season, a world change due */
function apply(run: RunRecord, ledger: SeasonLedger, e: Effect, from: string): { run: RunRecord; ledger: SeasonLedger } {
  const spells = e.spell && !run.spells.includes(e.spell) ? [...run.spells, e.spell] : run.spells;
  const raid = e.raid ? { n: e.raid, season: run.season + 1 } : run.raid;
  const due = e.mutation ? [...run.due, { id: `${from}:${run.n}:${run.season}`, mutation: e.mutation, text: e.text }] : run.due;
  const signs = e.signs ? [...run.signs, ...e.signs.kinds.map((kind) => ({ kind, until: run.season + 1 + e.signs!.seasons }))] : run.signs;
  return { run: { ...run, spells, raid, due, signs }, ledger: applyPools(ledger, e.pools) };
}

/**
 * Play a card from the hand: its cost committed from the pools (a project's people locked and goods spent by the
 * ledger's commit; goods spent at once otherwise), its played effect applied, the card out of the hand for good.
 * Throws if it isn't in the hand or its cost isn't free.
 */
export function play(run: RunRecord, ledger: SeasonLedger, cards: readonly Petition[], id: string): { run: RunRecord; ledger: SeasonLedger } {
  if (run.over) throw new Error('run: it is over');
  if (!run.hand.some((h) => h.id === id)) throw new Error(`run: ${id} is not in the hand`);
  const p = find(cards, id);
  const miss = shortOf(ledger, p);
  if (Object.keys(miss).length) throw new Error(`run: ${id} can't be played (${JSON.stringify(miss)} short)`);
  const paid = 'project' in p.cost ? commit(ledger, p.cost.project) : lose(ledger, p.cost.spend);
  const next: RunRecord = { ...run, hand: run.hand.filter((h) => h.id !== id), played: [...run.played, { id, season: run.season }] };
  return apply(next, paid, p.played, id);
}

/** what the world's places pay you each season: your settlements' and your vassals' tribute */
export function tribute(world: WorldRecord): Partial<Pools> {
  const out: Partial<Pools> = {};
  for (const p of world.places) {
    if (p.owner !== 'you' && p.status !== 'vassal') continue;
    for (const [k, v] of Object.entries(p.tribute) as [Pool, number][]) out[k] = (out[k] ?? 0) + v;
  }
  return out;
}

/** people a fallen town's refugees add to your town, and the wagons a settlement of yours sends down its road */
export const REFUGEES = 40;
export const WAGONS = 14;

/**
 * What the world's far places bring home, to be seen in your town (the user: "You let a city fall and you get
 * refugees. You lose a mining colony and ship volume decreases"): refugees from each captured or destroyed place walk
 * your streets; each settlement of yours sends wagons. The living town's counts take these on top of the ledger's.
 */
export function comesHome(world: WorldRecord): { people: number; wagons: number } {
  let people = 0;
  let wagons = 0;
  for (const p of world.places) {
    if (p.status === 'captured' || p.status === 'destroyed') people += REFUGEES;
    if (p.owner === 'you' && p.status === 'founded') wagons += WAGONS;
  }
  return { people, wagons };
}

/**
 * The season's end for the cards: each card left in the hand a season older; one at its end expires — its expiry
 * effect applied once, the card out of the hand for good; the world's places pay their tribute; then the next season's
 * hand is filled (a place's cards first, then the deck).
 * (The ledger's own season — income, projects worked — is season/ledger.ts nextSeason, run after this. A far change
 * an expiry sets off is recorded by `mutate` before the next `endSeason`, so its place deals from the season after.)
 */
export function endSeason(run: RunRecord, ledger: SeasonLedger, cards: readonly Petition[], world: WorldRecord): { run: RunRecord; ledger: SeasonLedger; expired: Petition[]; tribute: Partial<Pools> } {
  if (run.over) throw new Error('run: it is over');
  const hand: Held[] = [];
  const gone: Petition[] = [];
  for (const h of run.hand) {
    if (h.left > 1) hand.push({ id: h.id, left: h.left - 1 });
    else gone.push(find(cards, h.id));
  }
  let cur: RunRecord = { ...run, hand, expired: [...run.expired, ...gone.map((p) => ({ id: p.id, season: run.season }))] };
  let l = ledger;
  for (const p of gone) ({ run: cur, ledger: l } = apply(cur, l, p.expires, p.id));
  const paid = tribute(world);
  l = applyPools(l, paid);
  cur = fill({ ...cur, season: run.season + 1 }, cards, world);
  return { run: cur, ledger: l, expired: gone, tribute: paid };
}

/** Unrest from which crime shows in the streets */
export const CRIME_UNREST = 2;

/**
 * The signs seen in your town now: the warnings of the cards in the hand, what effects left (until their season), and
 * crime while Unrest is high. Each kind once.
 */
export function signsNow(run: RunRecord, ledger: SeasonLedger, cards: readonly Petition[]): SignKind[] {
  const out = new Set<SignKind>();
  for (const h of run.hand) for (const k of find(cards, h.id).warns ?? []) out.add(k);
  for (const s of run.signs) if (run.season < s.until) out.add(s.kind);
  if (pools(ledger).unrest >= CRIME_UNREST) out.add('crime');
  return [...out];
}

/** the attack due this season (its size), or null */
export function raidDue(run: RunRecord, season: number): number | null {
  return run.raid && run.raid.season === season && !run.fight ? run.raid.n : null;
}

/** the attack's result written to the run: held when no raider is left alive; broken through, the threat's world
 *  change is due */
export function fought(run: RunRecord, f: { raiders: number; left: number; fallen: number }, threat?: Petition): RunRecord {
  const held = f.left === 0;
  const brings = !held && threat?.threat ? [{ id: `${threat.id}:${run.n}:${run.season}`, mutation: threat.threat.brings, text: threat.threat.broke }] : [];
  return { ...run, fight: { ...f, held }, due: [...run.due, ...brings] };
}

/**
 * A due world change recorded: once — a change with an id the world already holds is not added again (a reload, a
 * replay). It leaves the run's due list and the run lists it. A near change is recorded where the scene put it in the
 * town; a far one sets its place's owner, status and tribute in the world's places.
 */
export function mutate(run: RunRecord, world: WorldRecord, id: string, near?: { town: string; at: [number, number]; radius: number }): { run: RunRecord; world: WorldRecord; added: boolean } {
  const d = run.due.find((x) => x.id === id);
  if (!d) throw new Error(`run: no world change ${id} is due`);
  const due = run.due.filter((x) => x.id !== id);
  if (world.changes.some((c) => c.id === id)) return { run: { ...run, due }, world, added: false };
  const far = d.mutation.far;
  if (!far && !near) throw new Error(`run: the world change ${id} is in the town: it needs its place there`);
  const change: WorldChange = { id, kind: d.mutation.kind, text: d.text, where: d.mutation.where, ...(far ? { far: far.id } : { near }), run: run.n, season: run.season, leader: run.leader };
  const places = far ? [...world.places.filter((p) => p.id !== far.id), { ...far }] : world.places;
  return { run: { ...run, due, mutations: [...run.mutations, id] }, world: { ...world, changes: [...world.changes, change], places }, added: true };
}

/** the run's threat resolved (the attack fought, or its card played and gone): the run can end */
export function threatDone(run: RunRecord, cards: readonly Petition[]): boolean {
  const threats = cards.filter((c) => c.threat).map((c) => c.id);
  if (run.fight) return true;
  if (run.raid) return false;
  return threats.every((id) => !run.hand.some((h) => h.id === id));
}

export const endRun = (run: RunRecord): RunRecord => ({ ...run, over: true });

/**
 * (LS-16) Where the camera looks down a road before a raid is called on it. `road`: its points from the town outward,
 * ending where the town's box does; `sure`: the cells round the camera's target the world's window is sure to hold.
 * The point `sure` back from the road's end, measured along each axis: the window then holds the road from there to
 * its end — the stretch a spawn point stands on (past the town's limit, short of the road's end). A road shorter than
 * that: its first point. Null: no road.
 */
export function roadLook(road: readonly (readonly [number, number])[], sure: number): [number, number] | null {
  if (road.length < 2) return null;
  const end = road[road.length - 1];
  for (let i = road.length - 1; i >= 0; i--) {
    if (Math.max(Math.abs(road[i][0] - end[0]), Math.abs(road[i][1] - end[1])) >= sure) return [road[i][0], road[i][1]];
  }
  return [road[0][0], road[0][1]];
}

/** the records as bytes for the world store, and back (a version this build doesn't read is an error, not a guess) */
export function encode(o: WorldRecord | RunRecord): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(o));
}
export function decodeWorld(b: Uint8Array): WorldRecord {
  const w = JSON.parse(new TextDecoder().decode(b)) as WorldRecord;
  if (w.v !== 1) throw new Error(`run: a world record of version ${w.v} (this build reads 1)`);
  return w;
}
