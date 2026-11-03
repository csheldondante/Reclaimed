// ---- opps/deck.ts -------------------------------------------------------------------------------------------------
// (round 124, `opportunities`; BACKLOG RN2-9) The card lab's loop: the opportunity system as a deck builder, with no
// encounters and no rolls. The user (round 124): "I recommend making a playground for the card mechanics that has no
// playable encounters. It would just be getting rewards that get new opportunities, decrease time spent to deal with
// card (distance based maybe) decrease resources etc. Think deck builder in terms of the design then we will work on
// thematic fits"; "Each should have world consequences that are visible. A occupied city, refugees fleeing, a toppled
// empire, a flooded civilization etc"; "Let's not even have rolls for now. Let's assume you assign resources it
// resolves one way and if not it may trigger an on expires effect"; on abilities: "this is like relics in slay the
// spire. They are just active effects tied to triggers" and "The relics here are unit abilities and tags and things
// you have built to be clear but yeah they work like relics".
//
// The same contract (contracts/opportunity.ts: holdings, commit, resolve, the triggered effects) and the same dealer
// (dealer.ts) as the map — a card is an opportunity with no odds (the contract's no-odds path: it resolves to its one
// outcome after its turns) and no challenge (the player's cards too) — so whatever is tuned here carries over. Cards
// are data (data/cards/lab.json, editable in the lab). What a card's reward does:
//   goods, agents (with their effects), tags (with effects) for those who went   → the holdings (the contract's resolve)
//   build: something built at a place, with its effects (lost if the place burns or is taken)
//   unlock / lock card ids → what can be dealt (the deck grows)
//   doom                    → the conflict's clock (the climax is forced at `climaxAt`)
//   world                   → AtlasEvents through WorldState.apply: settlement conditions and holders, refugees,
//                             faction power, regions flooded, darkened, raised dead
// The effects (relics) fire on their triggers, never by a button: 'commit' and 'resolve' in the contract, the rest
// here ('dealt': discount, extend, unlock; 'expiring': negate; 'turn': gain; 'threat': delay; 'agent-lost': gain,
// delay), each logged when it fires. Sacrifice is a card (its cost an agent lost, `losses: 1`), not an ability.
// Duration is distance: whole turns of travel from where the player is to the card's place (at `pace`), plus its work.
// Pure: the lab page (src/cardlab/) and the simulator drive the same code; Node-tested.

import { affords, commit, dropOwned, emptyHoldings, fired, relics, resolve, themed, type Agent, type AgentKind, type Bonus, type BonusRecord, type Commitment, type Goods, type Holdings, type OppEffect, type OppOutcome, type Opportunity, type Requirement, type Resolution, type Trigger } from '../api/contracts/opportunity';
import type { AtlasEvent, Faction, FactionId } from '../api/contracts/world';
import type { Settlement } from '../api/contracts/settlement';
import { MemoryWorldState } from '../api/contracts/world-state';
import { hashStr, rng } from '../runplan/rng';
import { deal, type DealReport, type Proposal, type ScorePart } from './dealer';
import { OPP_TUNE } from './tune';

// ---- the card definitions (JSON) ----------------------------------------------------------------------------------

/** a world consequence, as a card writes it (an AtlasEvent at the boundary: toEvent) */
export type WorldOp =
  | { kind: 'condition'; settlement: string; condition: Settlement['condition'] }
  | { kind: 'owner'; settlement: string; faction: FactionId | null }
  | { kind: 'refugees'; from: string; to: string; share: number }
  | { kind: 'power'; faction: FactionId; amount: number }
  | { kind: 'region'; place: string; event: 'flood' | 'drain' | 'shadow' | 'light' | 'raise-dead' | 'lay-dead' | 'burn' | 'ruin' | 'rebuild'; magnitude: number };

export interface CardOutcome {
  text: string;
  /** goods (gains scale with the tier dealt) */
  goods?: Goods;
  /** agents gained, with their own effects (abilities) */
  agents?: { kind: AgentKind; name: string; count: number; tags?: string[]; relics?: BonusRecord[] }[];
  /** tags (and their effects) for the committed agents that come back */
  tags?: string[];
  relics?: BonusRecord[];
  /** something built (at the card's place unless `place`), with its effects */
  build?: { name: string; place?: string; relics: BonusRecord[] };
  unlock?: string[];
  lock?: string[];
  doom?: number;
  /** the share of each committed group lost (a sacrifice card: 1) */
  losses?: number;
  world?: WorldOp[];
  /** the run ends: won or lost */
  end?: 'won' | 'lost';
}

export interface CardDef {
  id: string;
  /** (round 124, kingdoms) the stack it was made from: an unlock names the stack */
  stack?: string;
  title: string;
  /** where it is: a place of the lab's world */
  place: string;
  text?: string;
  /** requirement tiers, smallest first (the dealer deals the largest affordable; the reward's gains × the tier) */
  tiers: { requires: Requirement[]; costs: Goods }[];
  /** turns of work once there */
  work: number;
  /** what committing to it does, after its turns */
  reward: CardOutcome;
  /** turns it stays offered from when it is first dealt (default 1: this turn) */
  expires?: number;
  /** what letting it go does */
  onExpire?: CardOutcome;
  forced?: boolean;
  climax?: boolean;
  /** (round 124) a threat: dealt with by committing pawns and resources, or it fires its expiry and changes the world */
  threat?: boolean;
  /** dealt from the start (else only once unlocked) */
  start?: boolean;
  /** taken once a run */
  once?: boolean;
  when?: { doomAtLeast?: number; doomBelow?: number; turnAtLeast?: number; holdsTags?: string[]; holdsAgent?: AgentKind };
  themes: string[];
}

export interface LabPlace {
  id: string;
  name: string;
  at: [number, number];
  region: number;
  settlement?: { name: string; faction: FactionId | null; people: number; size: Settlement['size'] };
}

export interface LabDeck {
  world: { places: LabPlace[]; factions: Pick<Faction, 'id' | 'name' | 'attitude' | 'power'>[]; /** the player's own */ player: FactionId };
  start: { at: string; agents: (Omit<Agent, 'id' | 'committed' | 'statuses' | 'at'> & { relics?: BonusRecord[] })[]; goods: Goods; build?: { name: string; place: string; relics: BonusRecord[] }[] };
  cards: CardDef[];
}

/** the deck's problems (references, the climax, the effects): the lab refuses a deck with any */
export function checkDeck(d: LabDeck): string[] {
  const p: string[] = [];
  const places = new Set(d.world.places.map((x) => x.id));
  const settl = new Set(d.world.places.filter((x) => x.settlement).map((x) => x.id));
  const facs = new Set(d.world.factions.map((f) => f.id));
  const ids = new Set([...d.cards.map((c) => c.id), ...d.cards.flatMap((c) => (c.stack ? [c.stack] : []))]);
  if (new Set(d.cards.map((c) => c.id)).size !== d.cards.length) p.push('a card id is used twice');
  if (!places.has(d.start.at)) p.push(`start.at: no place ${d.start.at}`);
  if (!facs.has(d.world.player)) p.push(`world.player: no faction ${d.world.player}`);
  const relicProblems = (at: string, b: BonusRecord) => {
    if (!b.why) p.push(`${at}: an effect needs its name (why)`);
    if (!['dealt', 'expiring', 'commit', 'resolve', 'turn', 'threat', 'agent-lost'].includes(b.on)) p.push(`${at}: no trigger ${b.on}`);
    if (b.effect?.kind === 'unlock') for (const c of b.effect.cards) if (!ids.has(c)) p.push(`${at}: unlocks no card ${c}`);
  };
  for (const [i, a] of d.start.agents.entries()) for (const b of a.relics ?? []) relicProblems(`start.agents[${i}]`, b);
  for (const [i, x] of (d.start.build ?? []).entries()) {
    if (!places.has(x.place)) p.push(`start.build[${i}]: no place ${x.place}`);
    for (const b of x.relics) relicProblems(`start.build[${i}]`, b);
  }
  for (const c of d.cards) {
    const at = `card ${c.id}`;
    if (!places.has(c.place)) p.push(`${at}: no place ${c.place}`);
    if (!c.tiers?.length) p.push(`${at}: no tiers`);
    if (!c.reward) p.push(`${at}: no reward`);
    if ((c.forced || c.climax) && !c.tiers.every((t) => t.requires.some((r) => r.kind === 'player'))) p.push(`${at}: a forced card is the player's`);
    for (const o of [c.reward, ...(c.onExpire ? [c.onExpire] : [])]) {
      if (!o) continue;
      for (const u of [...(o.unlock ?? []), ...(o.lock ?? [])]) if (!ids.has(u)) p.push(`${at}: unlocks no card ${u}`);
      for (const b of [...(o.relics ?? []), ...(o.build?.relics ?? []), ...(o.agents ?? []).flatMap((a) => a.relics ?? [])]) relicProblems(at, b);
      if (o.build?.place && !places.has(o.build.place)) p.push(`${at}: builds at no place ${o.build.place}`);
      for (const w of o.world ?? []) {
        if ((w.kind === 'condition' || w.kind === 'owner') && !settl.has(w.settlement)) p.push(`${at}: no settlement at ${w.settlement}`);
        if (w.kind === 'refugees' && (!settl.has(w.from) || !settl.has(w.to))) p.push(`${at}: refugees between ${w.from} and ${w.to}: not settlements`);
        if ((w.kind === 'owner' && w.faction !== null && !facs.has(w.faction)) || (w.kind === 'power' && !facs.has(w.faction))) p.push(`${at}: no faction ${(w as { faction: string }).faction}`);
        if (w.kind === 'region' && !places.has(w.place)) p.push(`${at}: no place ${w.place}`);
      }
    }
  }
  if (!d.cards.some((c) => c.climax)) p.push('no climax card');
  // (three resources only: labor, influence, power)
  const goodsOf = (o: CardOutcome | undefined) => Object.keys(o?.goods ?? {});
  for (const c of d.cards) {
    for (const g of [...c.tiers.flatMap((t) => Object.keys(t.costs)), ...goodsOf(c.reward), ...goodsOf(c.onExpire)]) if (!(RESOURCES as readonly string[]).includes(g)) p.push(`card ${c.id}: ${g} isn't a resource (labor, influence, power)`);
    if (c.threat && !c.onExpire) p.push(`card ${c.id}: a threat has its expiry`);
  }
  for (const g of Object.keys(d.start.goods)) if (!(RESOURCES as readonly string[]).includes(g)) p.push(`start.goods: ${g} isn't a resource`);
  return p;
}

// ---- the world the lab plays in -------------------------------------------------------------------------------------

export function labWorld(d: LabDeck): MemoryWorldState {
  const w = new MemoryWorldState(1, d.world.places.map((p) => ({ id: p.region, name: p.name, kind: 'lab' })), d.world.factions.map((f) => ({ ...f, ethos: '', era: 'medieval' as const, relations: {} })));
  for (const p of d.world.places) {
    w.region(p.region);
    if (p.settlement) w.settlements.push({ id: p.id, name: p.settlement.name, region: p.region, at: p.at, size: p.settlement.size, condition: 'thriving', faction: p.settlement.faction, people: [{ role: 'folk', count: p.settlement.people }] } as unknown as Settlement);
  }
  return w;
}

function toEvent(op: WorldOp, d: LabDeck, why: string): Omit<AtlasEvent, 'id' | 'run'> {
  const region = (place: string) => d.world.places.find((p) => p.id === place)!.region;
  const cause = { by: 'player' as const, ref: why };
  switch (op.kind) {
    case 'condition': return { kind: 'settlement-condition', regions: [region(op.settlement)], magnitude: 1, detail: { settlement: op.settlement, condition: op.condition }, cause };
    case 'owner': return { kind: 'settlement-owner', regions: [region(op.settlement)], magnitude: 1, detail: { settlement: op.settlement, faction: op.faction }, cause };
    case 'refugees': return { kind: 'migrate', regions: [region(op.from), region(op.to)], magnitude: op.share, detail: { from: op.from, to: op.to }, cause };
    case 'power': return { kind: 'faction-power', regions: [d.world.places[0].region], magnitude: op.amount, detail: { faction: op.faction }, cause };
    case 'region': return { kind: op.event, regions: [region(op.place)], magnitude: op.magnitude, ...(op.event === 'flood' ? { level: 1 } : {}), cause };
  }
}

/** a world consequence as a line (the effect card, the world log) */
export function worldLine(op: WorldOp, d: LabDeck): string {
  const nm = (id: string) => d.world.places.find((p) => p.id === id)?.settlement?.name ?? d.world.places.find((p) => p.id === id)?.name ?? id;
  const fac = (id: string | null) => (id ? (d.world.factions.find((f) => f.id === id)?.name ?? id) : 'no one');
  switch (op.kind) {
    case 'condition': return `${nm(op.settlement)} ${op.condition === 'ruined' ? 'burned' : op.condition}`;
    case 'owner': return `${nm(op.settlement)} held by ${fac(op.faction)}`;
    case 'refugees': return `${Math.round(op.share * 100)}% of ${nm(op.from)} flee to ${nm(op.to)}`;
    case 'power': return `${fac(op.faction)} ${op.amount >= 0 ? 'rises' : 'falls'} (${op.amount > 0 ? '+' : ''}${op.amount})`;
    case 'region': return `${nm(op.place)}: ${op.event === 'shadow' ? 'darkness' : op.event === 'raise-dead' ? 'the dead rise' : op.event === 'flood' ? 'flooded' : op.event}`;
  }
}

const ON: Record<Trigger, string> = { dealt: 'when dealt', expiring: 'when let go', commit: 'on commit', resolve: 'when done', turn: 'each turn', threat: 'when the threat advances', 'agent-lost': 'when an agent is lost' };
/** an effect as a line (a tooltip, the effect card) */
export function relicLine(b: BonusRecord): string {
  const e = b.effect;
  const g = (x: Goods) => Object.entries(x).map(([k, n]) => `${n} ${k}`).join(', ');
  const what =
    e.kind === 'negate' ? (e.tier ? `${e.tier} lifted` : 'its penalty negated')
    : e.kind === 'delay' ? `the threat ${e.turns} turn${e.turns === 1 ? '' : 's'} later`
    : e.kind === 'shorten' ? `${e.turns} turn${e.turns === 1 ? '' : 's'} faster`
    : e.kind === 'extend' ? `stays ${e.turns} turn${e.turns === 1 ? '' : 's'} longer`
    : e.kind === 'instant' ? 'done at once'
    : e.kind === 'better' ? `gains ×${e.factor}`
    : e.kind === 'unlock' ? `unlocks ${e.cards.join(', ')}`
    : e.kind === 'gain' ? `+${g(e.goods)}`
    : `costs −${g(e.goods)}`;
  return `${b.why}: ${ON[b.on]}${b.themes ? ` (${b.themes.join('/')})` : ''}, ${what}${b.charges !== undefined ? ` · ${b.charges} left` : ''}${b.cooldown ? ` · every ${b.cooldown} turns` : ''}`;
}

// ---- the run ----------------------------------------------------------------------------------------------------------

/** (round 124, the user: "Labor, influence, power") the lab's only resources */
export const RESOURCES = ['labor', 'influence', 'power'] as const;

export interface DeckEvent {
  turn: number;
  text: string;
  world?: string[];
}

export class DeckRun {
  holdings: Holdings;
  turn = 0;
  doom = 0;
  /** where the player is (a place id) */
  at: string;
  readonly world: MemoryWorldState;
  /** the cards that can be dealt (start + unlocked − locked), and those taken once */
  readonly pool = new Set<string>();
  readonly done = new Set<string>();
  offered: Opportunity[] = [];
  report: DealReport | null = null;
  readonly commitments: Commitment[] = [];
  readonly resolutions: Resolution[] = [];
  readonly log: DeckEvent[] = [];
  readonly worldLog: DeckEvent[] = [];
  end: 'won' | 'lost' | null = null;
  /** the simulator's tallies: dealt, taken, effects fired (by name), choices a turn */
  readonly dealtCount: Record<string, number> = {};
  readonly takenCount: Record<string, number> = {};
  readonly firedCount: Record<string, number> = {};
  readonly choicesPerTurn: number[] = [];
  /** the first turn each card was dealt in its current stay, and the turns effects extended it */
  private seen = new Map<string, number>();
  private extended: Record<string, number> = {};
  private recent: { template: string; place: string; turn: number }[] = [];
  private n = 0;

  constructor(readonly deck: LabDeck, readonly seed = 1) {
    const p = checkDeck(deck);
    if (p.length) throw new Error(`the card deck has ${p.length} problems:\n${p.join('\n')}`);
    this.world = labWorld(deck);
    this.at = deck.start.at;
    this.holdings = emptyHoldings();
    this.holdings.agents.push({ id: 'player', kind: 'player', name: 'you', count: 1, tags: [], statuses: [], at: { with: 'player' } });
    deck.start.agents.forEach((a, i) => {
      const { relics: r, ...rest } = structuredClone(a);
      const id = `${a.kind}${i}`;
      this.holdings.agents.push({ ...rest, id, statuses: [], at: { with: 'player' } });
      for (const b of r ?? []) this.holdings.bonuses.push({ ...b, holder: id });
    });
    for (const x of deck.start.build ?? []) this.build(x.name, x.place, x.relics);
    this.holdings.goods = { labor: 0, influence: 0, power: 0, ...structuredClone(deck.start.goods) };
    for (const c of deck.cards) if (c.start) this.pool.add(c.id);
    this.deal();
  }

  card(id: string): CardDef {
    const c = this.deck.cards.find((x) => x.id === id);
    if (!c) throw new Error(`no card ${id}`);
    return c;
  }

  place(id: string): LabPlace {
    return this.deck.world.places.find((p) => p.id === id)!;
  }

  /** an owner's effects (an agent's, a building's) */
  owned(o: { agent?: string; building?: string }): Bonus[] {
    return this.holdings.bonuses.filter((b) => (o.agent && b.holder === o.agent) || (o.building && b.building === o.building));
  }

  private build(name: string, place: string, rs: BonusRecord[]): void {
    const id = `b${this.holdings.buildings.length + 1}-${place}`;
    this.holdings.buildings.push({ id, name, place });
    for (const b of rs) this.holdings.bonuses.push({ ...structuredClone(b), building: id });
  }

  /** turns of travel from where the player is to a place */
  travel(place: string): number {
    const a = this.place(this.at).at;
    const b = this.place(place).at;
    return Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / OPP_TUNE.lab.pace);
  }

  /** a card's turns as it would go now: travel + work, less the 'commit' shorten effects of what's held */
  turns(c: CardDef): number {
    const cut = relics(this.holdings, 'commit', c, undefined, this.turn).reduce((s, b) => s + (b.effect.kind === 'shorten' ? b.effect.turns : 0), 0);
    return Math.max(0, this.travel(c.place) + c.work - cut);
  }

  /** what a card costs now: less the 'dealt' discounts held */
  private costs(c: CardDef, tier: number): Goods {
    const off = relics(this.holdings, 'dealt', c, undefined, this.turn).filter((b) => b.effect.kind === 'discount');
    const out: Goods = {};
    for (const [g, n] of Object.entries(c.tiers[tier - 1].costs)) out[g] = Math.max(0, n - off.reduce((s, b) => s + (b.effect.kind === 'discount' ? (b.effect.goods[g] ?? 0) : 0), 0));
    return out;
  }

  /** the synergy of a card with what is held: its themes among the agents' tags and the effects that touch it */
  synergy(c: CardDef): { value: number; why: string[] } {
    const tags = new Set(this.holdings.agents.flatMap((a) => a.tags));
    const why: string[] = [];
    for (const t of c.themes) if (tags.has(t)) why.push(`you hold a ${t}`);
    for (const b of this.holdings.bonuses) if (b.themes && themed(b, c)) why.push(b.why);
    return { value: Math.min(1, why.length / 2), why };
  }

  private outcome(c: CardDef, o: CardOutcome, tier: number): OppOutcome {
    const fx: OppEffect[] = [];
    if (o.goods) fx.push({ kind: 'goods', goods: Object.fromEntries(Object.entries(o.goods).map(([g, n]) => [g, n > 0 ? n * tier : n])) });
    for (const [i, a] of (o.agents ?? []).entries()) fx.push({ kind: 'agent', agent: { id: `${c.id}-${a.kind}-t${this.turn}-${i}`, kind: a.kind, name: a.name, count: a.count, tags: a.tags ?? [], statuses: [], at: { with: 'player' } } });
    if (o.tags?.length || o.relics?.length) fx.push({ kind: 'tag', add: o.tags ?? [], bonuses: o.relics });
    for (const w of o.world ?? []) fx.push({ kind: 'atlas', event: toEvent(w, this.deck, c.id) });
    if (o.doom) fx.push({ kind: 'conflict', op: 'doom', amount: o.doom });
    return { text: o.text, effects: fx, ...(o.losses ? { losses: o.losses } : {}) };
  }

  /** when a card's stay on the board ends (its first deal + its expiry + what effects extended) */
  expiresAt(c: CardDef): number {
    return (this.seen.get(c.id) ?? this.turn) + (c.expires ?? 1) - 1 + (this.extended[c.id] ?? 0);
  }

  /** the cards the held effects unlock */
  private unlocked(): Set<string> {
    return new Set(this.holdings.bonuses.flatMap((b) => (b.effect.kind === 'unlock' ? b.effect.cards : [])));
  }

  /** the dealer's proposals: every card, with the filters that say whether it makes sense now */
  proposals(): Proposal[] {
    const T = OPP_TUNE.lab;
    const tags = new Set(this.holdings.agents.flatMap((a) => a.tags));
    const unlocked = this.unlocked();
    return this.deck.cards.map((c): Proposal => {
      const w = c.when ?? {};
      const due = !!c.climax && this.doom >= T.climaxAt;
      const inPool = (this.pool.has(c.id) || (!!c.stack && (this.pool.has(c.stack) || unlocked.has(c.stack))) || unlocked.has(c.id) || due) && !(c.climax && !due);
      const running = this.commitments.some((k) => k.opp.template === c.id && !this.resolutions.some((r) => r.commitment === k.id));
      const sense = [
        { ok: inPool, why: inPool ? (c.climax ? `the climax: doom ${this.doom} of ${T.climaxAt}` : c.start ? 'in the deck from the start' : unlocked.has(c.id) ? 'unlocked by what you hold' : 'unlocked') : c.climax ? `the climax at doom ${T.climaxAt} (now ${this.doom})` : 'not unlocked' },
        { ok: !(c.once && this.done.has(c.id)), why: c.once && this.done.has(c.id) ? 'taken once already' : 'open' },
        { ok: !running, why: running ? 'running' : 'not running' },
        { ok: w.doomAtLeast === undefined || this.doom >= w.doomAtLeast, why: `doom ${this.doom}${w.doomAtLeast !== undefined ? ` (from ${w.doomAtLeast})` : ''}` },
        { ok: w.doomBelow === undefined || this.doom < w.doomBelow, why: w.doomBelow !== undefined ? `doom under ${w.doomBelow}` : 'any doom' },
        { ok: w.turnAtLeast === undefined || this.turn >= w.turnAtLeast, why: `turn ${this.turn}` },
        { ok: !w.holdsTags || w.holdsTags.every((t) => tags.has(t)), why: w.holdsTags ? `needs ${w.holdsTags.join(', ')} held` : 'no tag needed' },
        { ok: !w.holdsAgent || this.holdings.agents.some((a) => a.kind === w.holdsAgent), why: w.holdsAgent ? `needs a ${w.holdsAgent}` : 'no agent needed' },
      ];
      const syn = this.synergy(c);
      const v = this.ev(c).perTurn;
      const parts: Partial<Record<Exclude<ScorePart, 'variety' | 'tier'>, number>> = { theme: 0.5, foreshadow: c.climax ? 1 : c.themes.includes('conflict') ? 0.8 : 0.3, synergy: syn.value, difficulty: 1 / (1 + this.turns(c)), hero: 0.5, ev: Math.max(0, v) / (1 + Math.max(0, v)) };
      return {
        template: c.id, offer: c.id, place: c.place, title: c.title,
        tiers: c.tiers.map((t, i) => ({ requires: t.requires, costs: this.costs(c, i + 1) })),
        sense, parts, at: this.place(c.place).at, forced: !!(c.forced || due), event: !!(c.onExpire || due), towardClimax: !!c.climax, hooks: c.themes.includes('conflict') || c.climax ? ['conflict'] : [],
        make: (tier) => ({
          template: c.id, offer: c.id, title: c.title,
          pitch: [c.text ?? '', ...syn.why.map((x) => `synergy: ${x}`)].filter(Boolean).join(' · '),
          location: { region: this.place(c.place).region, at: this.place(c.place).at, name: this.place(c.place).name },
          // (the lab: no encounters, no odds — the player's cards too resolve to their one outcome after their turns;
          // the contract takes the 'commit' effects off)
          duration: { turns: this.travel(c.place) + c.work },
          outcomes: { success: this.outcome(c, c.reward, tier) },
          visibility: 'known',
          expires: { turn: this.expiresAt(c) },
          ...(c.onExpire ? { onExpire: this.outcome(c, c.onExpire, 1) } : {}),
          ...(c.forced || due ? { forced: true } : {}),
          ...(c.climax ? { climax: true } : {}),
          themes: c.themes, hooks: [],
        }),
      };
    });
  }

  private fire(b: Bonus, text: string): void {
    fired(this.holdings, b, this.turn);
    dropOwned(this.holdings);
    this.firedCount[b.why] = (this.firedCount[b.why] ?? 0) + 1;
    this.log.push({ turn: this.turn, text: `✦ ${b.why}: ${text}` });
  }

  deal(): DealReport {
    const r = deal(this.proposals(), { holdings: this.holdings, turn: this.turn, at: this.place(this.at).at, dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]), conflictHooks: ['conflict'], recent: this.recent, tune: { ...OPP_TUNE.dealer, reach: 1e9 } });
    this.report = r;
    // (a card not dealt this turn has left the board: its stay ends, a later deal starts a new one — a stale stay
    // showed a timer of −2 over City 5)
    const now = new Set(r.dealt.map((d) => d.opp.template));
    for (const k of [...this.seen.keys()]) if (!now.has(k)) (this.seen.delete(k), delete this.extended[k]);
    if (r.dealt.some((d) => !this.seen.has(d.opp.template))) for (const d of r.dealt) if (!this.seen.has(d.opp.template)) d.opp.expires = { turn: this.turn + (this.card(d.opp.template).expires ?? 1) - 1 };
    this.offered = r.dealt.map((d) => d.opp);
    for (const d of r.dealt) {
      const fresh = !this.seen.has(d.opp.template);
      if (fresh) {
        this.seen.set(d.opp.template, this.turn);
        // ('dealt' effects that act on the card: it stays longer)
        for (const b of relics(this.holdings, 'dealt', d.opp, undefined, this.turn))
          if (b.effect.kind === 'extend') {
            this.extended[d.opp.template] = (this.extended[d.opp.template] ?? 0) + b.effect.turns;
            d.opp.expires = { turn: this.expiresAt(this.card(d.opp.template)) };
            this.fire(b, `${d.opp.title} stays ${b.effect.turns} turns longer`);
          }
      }
      this.recent.push({ template: d.opp.template, place: d.opp.location.name, turn: this.turn });
      this.dealtCount[d.opp.template] = (this.dealtCount[d.opp.template] ?? 0) + 1;
    }
    this.choicesPerTurn.push(this.affordable().length);
    return r;
  }

  /** the cards that can be committed now */
  affordable(): Opportunity[] {
    return this.offered.filter((o) => o.affordable && affords(o, this.holdings).ok);
  }

  /** commit a card: its agents (the player too) locked for its turns, its costs spent */
  commit(id: string): Commitment {
    if (this.end) throw new Error('the run is over');
    const o = this.offered.find((x) => x.id === id);
    if (!o) throw new Error(`card ${id} isn't offered`);
    const cid = `k${++this.n}`;
    const { holdings, commitment } = commit(this.holdings, o, { id: cid, now: this.turn, turn: this.turn });
    this.holdings = holdings;
    for (const w of commitment.fired ?? []) {
      this.firedCount[w] = (this.firedCount[w] ?? 0) + 1;
      this.log.push({ turn: this.turn, text: `✦ ${w}: ${o.title} ${commitment.resolvesTurn === this.turn ? 'done at once' : 'faster'}` });
    }
    this.commitments.push(commitment);
    this.offered = this.offered.filter((x) => x.id !== id);
    this.seen.delete(o.template);
    this.takenCount[o.template] = (this.takenCount[o.template] ?? 0) + 1;
    this.log.push({ turn: this.turn, text: `committed ${o.title}${o.tiers > 1 ? ` (tier ${o.tier})` : ''}: done on turn ${commitment.resolvesTurn}` });
    if (commitment.resolvesTurn! <= this.turn) this.settle(commitment);
    return commitment;
  }

  /** the commitments running, with their turns left */
  running(): { c: Commitment; turnsLeft: number }[] {
    return this.commitments.filter((c) => !this.resolutions.some((r) => r.commitment === c.id)).map((c) => ({ c, turnsLeft: Math.max(0, (c.resolvesTurn ?? this.turn) - this.turn) }));
  }

  /**
   * The turn ends: what wasn't taken and is due expires (its onExpire, unless an 'expiring' effect negates it), the
   * turn's effects fire ('turn'), the threat advances ('threat' effects may hold it back), what's due resolves, the deal.
   */
  nextTurn(): void {
    if (this.end) return;
    for (const o of this.offered) {
      if (o.expires.turn > this.turn) continue;
      this.seen.delete(o.template);
      delete this.extended[o.template];
      // (an event that has passed has passed: a once card is done)
      if (this.card(o.template).once && o.onExpire) this.done.add(o.template);
      if (!o.onExpire) continue;
      const neg = relics(this.holdings, 'expiring', o, undefined, this.turn).find((b) => b.effect.kind === 'negate');
      if (neg) {
        this.fire(neg, `${o.title} let go — its penalty negated`);
        continue;
      }
      this.log.push({ turn: this.turn, text: `let go: ${o.title} — ${o.onExpire.text}` });
      const def = this.card(o.template);
      if (def.threat && !def.climax) this.missed++;
      this.apply(def, def.onExpire!, o.onExpire);
      if (this.end) return;
    }
    this.turn++;
    for (const b of relics(this.holdings, 'turn', undefined, undefined, this.turn))
      if (b.effect.kind === 'gain') {
        for (const [g, n] of Object.entries(b.effect.goods)) this.holdings.goods[g] = (this.holdings.goods[g] ?? 0) + n;
        this.fire(b, `+${Object.entries(b.effect.goods).map(([g, n]) => `${n} ${g}`).join(', ')}`);
      }
    let step = OPP_TUNE.lab.doomPerTurn;
    for (const b of relics(this.holdings, 'threat', undefined, undefined, this.turn))
      if (b.effect.kind === 'delay' && step > 0) {
        const held = Math.min(step, b.effect.turns * OPP_TUNE.lab.doomPerTurn);
        step -= held;
        this.fire(b, `the threat held back (doom +${step} instead of +${OPP_TUNE.lab.doomPerTurn})`);
      }
    this.doom += step;
    for (const { c } of this.running()) if ((c.resolvesTurn ?? 0) <= this.turn) this.settle(c);
    // (the climax has come: the player's commitment is called back — settled now — so the player can meet it)
    if (this.doom >= OPP_TUNE.lab.climaxAt) for (const { c } of this.running()) if (c.agents.includes('player')) this.settle(c);
    if (!this.end && this.turn >= OPP_TUNE.lab.maxTurns) this.finish('lost', `${this.turn} turns and no end`);
    if (!this.end) this.deal();
  }

  private settle(c: Commitment): void {
    const before = this.holdings;
    const { holdings, resolution } = resolve(this.holdings, c, { now: this.turn, turn: this.turn });
    this.holdings = holdings;
    this.resolutions.push(resolution);
    const def = this.card(c.opp.template);
    if (c.agents.includes('player')) this.at = def.place;
    if (def.once) this.done.add(def.id);
    if (def.threat && !def.climax) this.handled++;
    for (const n of resolution.bonuses) {
      const w = n.split(':')[0];
      this.firedCount[w] = (this.firedCount[w] ?? 0) + 1;
    }
    this.log.push({ turn: this.turn, text: `${c.opp.title}: ${resolution.outcome.text}${resolution.lost.length ? ` (lost ${resolution.lost.map((l) => `${l.count} of ${before.agents.find((a) => a.id === l.agent)?.name ?? l.agent}`).join(', ')})` : ''}${resolution.bonuses.length ? ` [✦ ${resolution.bonuses.join('; ')}]` : ''}` });
    // (the agents' effects that came in with this reward: an agent gained with its abilities)
    const gained = resolution.outcome.effects.filter((e): e is Extract<OppEffect, { kind: 'agent' }> => e.kind === 'agent');
    gained.forEach((e, i) => {
      for (const b of def.reward.agents?.[i]?.relics ?? []) this.holdings.bonuses.push({ ...structuredClone(b), holder: e.agent.id });
    });
    // ('agent-lost' effects of what is still held)
    if (resolution.lost.some((l) => !this.holdings.agents.some((a) => a.id === l.agent))) {
      for (const b of relics(this.holdings, 'agent-lost', undefined, undefined, this.turn)) {
        if (b.effect.kind === 'delay') {
          this.doom = Math.max(0, this.doom - b.effect.turns * OPP_TUNE.lab.doomPerTurn);
          this.fire(b, `the threat ${b.effect.turns} turns later (doom ${this.doom})`);
        } else if (b.effect.kind === 'gain') {
          for (const [g, n] of Object.entries(b.effect.goods)) this.holdings.goods[g] = (this.holdings.goods[g] ?? 0) + n;
          this.fire(b, `+${Object.entries(b.effect.goods).map(([g, n]) => `${n} ${g}`).join(', ')}`);
        }
      }
    }
    this.apply(def, def.reward, resolution.outcome, resolution.out);
  }

  /** an outcome's deck and world parts (the holdings' parts are the contract's resolve; an expiry's goods here) */
  private apply(def: CardDef, o: CardOutcome, oc: OppOutcome, out?: OppEffect[]): void {
    for (const u of o.unlock ?? []) this.pool.add(u);
    for (const u of o.lock ?? []) this.pool.delete(u);
    if (o.build) this.build(o.build.name, o.build.place ?? def.place, o.build.relics);
    const fx = out ?? oc.effects.filter((e) => e.kind === 'atlas' || e.kind === 'conflict');
    if (!out) {
      for (const e of oc.effects) if (e.kind === 'goods') for (const [g, n] of Object.entries(e.goods)) this.holdings.goods[g] = Math.max(0, (this.holdings.goods[g] ?? 0) + n);
      for (const e of oc.effects) if (e.kind === 'agent') this.holdings.agents.push(structuredClone(e.agent));
    }
    for (const e of fx) {
      if (e.kind === 'conflict' && e.op === 'doom') this.doom = Math.max(0, this.doom + e.amount);
      if (e.kind === 'atlas') this.world.apply({ ...e.event, id: `e${this.world.history().length + 1}`, run: 0 } as AtlasEvent);
    }
    if (o.world?.length) {
      this.worldLog.push({ turn: this.turn, text: `${def.title}: ${o.text}`, world: o.world.map((w) => worldLine(w, this.deck)) });
      this.loseBuildings();
    }
    if (o.end) this.finish(o.end, o.text);
  }

  /** what's built where a settlement burned, emptied or was taken from the player's faction is lost, with its effects */
  private loseBuildings(): void {
    const gone = this.holdings.buildings.filter((b) => {
      const s = this.world.settlements.find((x) => x.id === b.place);
      return s && (s.condition === 'ruined' || s.condition === 'abandoned' || s.faction !== this.deck.world.player);
    });
    if (!gone.length) return;
    this.holdings.buildings = this.holdings.buildings.filter((b) => !gone.includes(b));
    dropOwned(this.holdings);
    for (const b of gone) this.log.push({ turn: this.turn, text: `lost: ${b.name} at ${this.place(b.place).settlement?.name ?? b.place}` });
  }

  private finish(end: 'won' | 'lost', why: string): void {
    if (this.end) return;
    this.end = end;
    this.log.push({ turn: this.turn, text: `the run is ${end}: ${why}` });
  }

  // ---- expected value (round 124, RN3-2) -------------------------------------------------------------------------
  // The user: "converting your actions into expected point values and trying to maximize the per turn points over
  // approximately the game time frame". Points are the score (10 the climax met, 2 a threat dealt with). Everything is priced in
  // points: goods by what they buy, strength by how far the climax's need is off, a turn of doom by the points a turn
  // is worth, an agent by what it can do over the turns left, an effect by its expected fires over the turns left, an
  // unlock by its stack's cards. A card's value a turn = (its reward's value − its costs − what it loses + the penalty
  // it avoids) ÷ its turns. Heuristic on purpose: the simulator's bots and the dealer's `ev` term read it, and the
  // sliders tune the prices.

  /** (round 124) threats dealt with and let fire; the score: 10 for the climax met, 2 a threat dealt with, −1 a threat let fire */
  handled = 0;
  missed = 0;
  score(): number {
    return (this.end === 'won' ? 10 : 0) + 2 * this.handled - this.missed;
  }

  /** turns left until the climax at the current doom rate */
  horizon(): number {
    return Math.max(1, (OPP_TUNE.lab.climaxAt - this.doom) / Math.max(0.25, OPP_TUNE.lab.doomPerTurn));
  }

  /** the climax's need: its first tier's goods */
  need(): Goods {
    return this.deck.cards.find((c) => c.climax)?.tiers[0].costs ?? {};
  }

  /** a good's worth in points now; `spent` for a cost (its own worth, not what it could be turned into) */
  price(g: string, spent = false): number {
    const T = OPP_TUNE.lab;
    const need = this.need()[g];
    // (the climax's good: dearer the further behind the need is for the turns left)
    if (need) {
      const short = need - (this.holdings.goods[g] ?? 0);
      return short > 0 ? (OPP_TUNE.lab.winPoints / need) * Math.max(0.5, Math.min(4, (2 * short) / this.horizon())) : 0.1;
    }
    const base = g === 'labor' ? T.laborPoints : g === 'influence' ? T.influencePoints : 0.2;
    if (spent) return base;
    // (a good is also worth what it buys of the climax's: a card in the deck that turns it into that good)
    let conv = 0;
    for (const [ng, n] of Object.entries(this.need())) {
      const short = n - (this.holdings.goods[ng] ?? 0);
      if (short <= 0) continue;
      const pn = (T.winPoints / n) * Math.max(0.5, Math.min(4, (2 * short) / this.horizon()));
      for (const c of this.deck.cards) {
        const gain = c.reward.goods?.[ng] ?? 0;
        if (gain <= 0 || c.climax) continue;
        c.tiers.forEach((t, i) => {
          const spend = Object.values(t.costs).reduce((s, v) => s + v, 0);
          if ((t.costs[g] ?? 0) > 0 && spend > 0) conv = Math.max(conv, (0.6 * gain * (i + 1) * pn) / spend);
        });
      }
    }
    return Math.max(base, conv);
  }

  private agentValue(kind: string): number {
    const H = this.horizon();
    const base: Record<string, number> = { army: 2.5, workers: 1.5, scout: 1.2, knight: 3, companion: 1.5 };
    return (base[kind] ?? 1) * Math.min(1, H / 8);
  }

  private relicValue(b: Omit<Bonus, 'holder' | 'building'>, after = 0): number {
    // (it fires only once it's had: the turns left after the card that brings it)
    const H = Math.max(0, this.horizon() - after);
    const T = OPP_TUNE.lab;
    const uses = b.cooldown ? H / b.cooldown : b.on === 'turn' || b.on === 'threat' ? H : H / 4;
    const e = b.effect;
    const per =
      e.kind === 'gain' ? Object.entries(e.goods).reduce((s, [g, n]) => s + n * this.price(g), 0)
      : e.kind === 'delay' ? e.turns * T.turnPoints
      : e.kind === 'shorten' ? e.turns * T.turnPoints * 0.5
      : e.kind === 'discount' ? Object.entries(e.goods).reduce((s, [g, n]) => s + n * this.price(g), 0)
      : e.kind === 'better' ? 0.8
      : e.kind === 'instant' ? T.turnPoints
      : e.kind === 'negate' ? 1
      : e.kind === 'extend' ? 0.3
      : 0.5;
    return per * uses * (b.charges !== undefined ? Math.min(1, b.charges / Math.max(1, uses)) : 1);
  }

  /** an outcome's value in points: `direct` its resources now; `engine` what it builds (agents, effects, unlocks) */
  outcomeValue(o: CardOutcome, tier = 1, after = 0): { direct: number; engine: number } {
    const T = OPP_TUNE.lab;
    let direct = 0;
    for (const [g, n] of Object.entries(o.goods ?? {})) direct += (n > 0 ? n * tier : n) * this.price(g);
    if (o.doom) direct -= o.doom * T.turnPoints;
    if (o.end === 'won') direct += 30;
    if (o.end === 'lost') direct -= 30;
    let engine = 0;
    for (const a of o.agents ?? []) engine += this.agentValue(a.kind) + (a.relics ?? []).reduce((s, b) => s + this.relicValue(b, after), 0);
    for (const b of [...(o.relics ?? []), ...(o.build?.relics ?? [])]) engine += this.relicValue(b, after);
    if (o.tags?.length) engine += 0.3 * o.tags.length;
    const H = this.horizon();
    for (const u of o.unlock ?? []) {
      const n = this.deck.cards.filter((c) => c.stack === u || c.id === u).length;
      if (!this.pool.has(u)) engine += 0.6 * Math.min(3, n) * Math.min(1, H / 6);
    }
    return { direct, engine };
  }

  /** a card's expected value: its value, its turns, its points a turn; `direct` and `engine` apart for the bots */
  ev(c: CardDef, tier = 1): { value: number; direct: number; engine: number; turns: number; perTurn: number } {
    const { direct, engine } = this.outcomeValue(c.reward, tier, this.turns(c));
    let cost = 0;
    for (const [g, n] of Object.entries(this.costs(c, tier))) cost += n * this.price(g, g !== Object.keys(this.need())[0]);
    const lose = (c.reward.losses ?? 0) * c.tiers[tier - 1].requires.reduce((s, r) => s + (r.kind === 'player' ? 0 : this.agentValue(r.kind) * r.count), 0);
    // (taking it avoids its penalty for letting it go)
    const avoided = c.onExpire ? -this.outcomeValue(c.onExpire).direct + 0.4 * (c.onExpire.world?.length ?? 0) : 0;
    const turns = Math.max(1, this.turns(c));
    const value = direct + engine - cost - lose + avoided + (c.threat && !c.climax ? OPP_TUNE.lab.threatPoints : 0);
    return { value, direct: direct - cost, engine, turns, perTurn: value / turns };
  }

  /** how much the world changed: events by kind, settlements changed */
  worldChange(): { events: number; byKind: Record<string, number>; settlements: number } {
    const h = this.world.history();
    const byKind: Record<string, number> = {};
    for (const e of h) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    const changed = this.world.settlements.filter((s) => s.condition !== 'thriving' || s.people.some((p) => p.role === 'refugee') || s.faction !== this.deck.world.places.find((p) => p.id === s.id)?.settlement?.faction).length;
    return { events: h.length, byKind, settlements: changed };
  }
}

// ---- the simulator ----------------------------------------------------------------------------------------------------

/**
 * The bots (round 124, RN3-3): `ev` maximises expected points a turn over the time left; `bigmoney` (Dominion's baseline)
 * takes the most direct reward a turn — resources now, never an engine; `engine` invests in agents, effects and
 * unlocks while more than half the time is left, then cashes in as bigmoney; `random`; `greedy` the dealer's own order.
 */
export type Policy = 'ev' | 'bigmoney' | 'engine' | 'random' | 'greedy';
export const POLICIES: readonly Policy[] = ['ev', 'bigmoney', 'engine', 'random', 'greedy'];

export interface SimReport {
  runs: number;
  policy: Policy;
  wins: number;
  winRate: number;
  meanScore: number;
  meanTurns: number;
  /** cards that could be committed, on the mean turn */
  meanChoices: number;
  cards: { id: string; title: string; dealt: number; taken: number; rate: number; winTaken: number | null }[];
  never: string[];
  always: string[];
  /** the effects (relics): fires a run, and the win rate of runs where it fired against those where it didn't */
  relics: { why: string; firesPerRun: number; winFired: number | null; winNot: number | null }[];
  world: { meanEvents: number; byKind: Record<string, number>; meanSettlements: number };
  ms: number;
}

/** a policy's turn: commit what it will (forced first, each one re-scored as the holdings change), then the next turn */
export function autoTurn(run: DeckRun, policy: Policy, pick: () => number): void {
  const early = run.turn < run.horizon() * 0.5;
  for (let k = 0; k < 10 && !run.end; k++) {
    const can = run.affordable();
    if (!can.length) break;
    const forced = can.find((x) => x.forced);
    let c: Opportunity | undefined = forced;
    if (!c) {
      if (policy === 'random') {
        if (pick() < 0.35) break;
        c = can[Math.floor(pick() * can.length)];
      } else if (policy === 'greedy') c = can[0];
      else {
        const key = (o: Opportunity) => {
          const e = run.ev(run.card(o.template), o.tier);
          if (policy === 'ev') return e.perTurn;
          if (policy === 'bigmoney') return e.direct / e.turns;
          return early ? (e.engine > 0 ? 100 + e.engine / e.turns : e.direct / e.turns) : e.direct / e.turns;
        };
        const best = [...can].sort((a, b) => key(b) - key(a))[0];
        if (key(best) <= 0) break;
        c = best;
      }
    }
    run.commit(c.id);
  }
  run.nextTurn();
}

/** auto-play `runs` runs of one deck (a kingdom) with one policy */
export function simulate(deck: LabDeck, o: { runs: number; seed: number; policy: Policy }): SimReport {
  const t0 = Date.now();
  let wins = 0;
  let score = 0;
  let turns = 0;
  let choices = 0;
  let choiceTurns = 0;
  const dealt: Record<string, number> = {};
  const taken: Record<string, number> = {};
  const takenWon: Record<string, { runs: number; wins: number }> = {};
  const fires: Record<string, { fires: number; runs: number; wins: number }> = {};
  let events = 0;
  let settl = 0;
  const byKind: Record<string, number> = {};
  for (let i = 0; i < o.runs; i++) {
    const run = new DeckRun(deck, o.seed + i);
    const pick = rng(hashStr(`sim:${o.seed}:${i}`));
    let guard = 0;
    while (!run.end && guard++ < 400) autoTurn(run, o.policy, pick);
    const won = run.end === 'won';
    if (won) wins++;
    score += run.score();
    turns += run.turn;
    choices += run.choicesPerTurn.reduce((s, v) => s + v, 0);
    choiceTurns += run.choicesPerTurn.length;
    for (const [k, v] of Object.entries(run.dealtCount)) dealt[k] = (dealt[k] ?? 0) + v;
    for (const [k, v] of Object.entries(run.takenCount)) {
      taken[k] = (taken[k] ?? 0) + v;
      const t = (takenWon[k] ??= { runs: 0, wins: 0 });
      t.runs++;
      if (won) t.wins++;
    }
    for (const [k, v] of Object.entries(run.firedCount)) {
      const f = (fires[k] ??= { fires: 0, runs: 0, wins: 0 });
      f.fires += v;
      f.runs++;
      if (won) f.wins++;
    }
    const w = run.worldChange();
    events += w.events;
    settl += w.settlements;
    for (const [k, v] of Object.entries(w.byKind)) byKind[k] = (byKind[k] ?? 0) + v;
  }
  const cards = deck.cards.map((c) => ({ id: c.id, title: c.title, dealt: dealt[c.id] ?? 0, taken: taken[c.id] ?? 0, rate: dealt[c.id] ? +((taken[c.id] ?? 0) / dealt[c.id]).toFixed(2) : 0, winTaken: takenWon[c.id] ? +(takenWon[c.id].wins / takenWon[c.id].runs).toFixed(2) : null }));
  return {
    runs: o.runs,
    policy: o.policy,
    wins,
    winRate: +(wins / o.runs).toFixed(3),
    meanScore: +(score / o.runs).toFixed(1),
    meanTurns: +(turns / o.runs).toFixed(1),
    meanChoices: +(choices / Math.max(1, choiceTurns)).toFixed(2),
    cards,
    never: cards.filter((c) => c.dealt > 0 && c.taken === 0).map((c) => c.id),
    always: cards.filter((c) => c.dealt >= o.runs && c.rate >= 0.95).map((c) => c.id),
    relics: Object.entries(fires).map(([why, f]) => ({ why, firesPerRun: +(f.fires / o.runs).toFixed(2), winFired: f.runs ? +(f.wins / f.runs).toFixed(2) : null, winNot: o.runs - f.runs ? +((wins - f.wins) / (o.runs - f.runs)).toFixed(2) : null })),
    world: { meanEvents: +(events / o.runs).toFixed(1), byKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, +(v / o.runs).toFixed(2)])), meanSettlements: +(settl / o.runs).toFixed(2) },
    ms: Date.now() - t0,
  };
}

/**
 * (round 124, RN3-3) Every bot on every kingdom: win rate and mean score each, and per kingdom which bots are viable
 * (within 80 % of the best score and winning at least half as often as the best). The balance target: in most
 * kingdoms two or more strategies viable, none best everywhere.
 */
export function tournament(make: (kingdomSeed: number) => LabDeck, o: { kingdoms: number[]; policies?: readonly Policy[]; runs?: number }): { kingdom: number; results: { policy: Policy; winRate: number; meanScore: number }[]; viable: Policy[] }[] {
  return o.kingdoms.map((k) => {
    const deck = make(k);
    const results = (o.policies ?? POLICIES).map((p) => {
      const s = simulate(deck, { runs: p === 'random' ? (o.runs ?? 20) : 1, seed: k, policy: p });
      return { policy: p, winRate: s.winRate, meanScore: s.meanScore };
    });
    // (viable: winning at least half as often as the best, and scoring within 80 % of the best of those)
    const bestWin = Math.max(...results.map((r) => r.winRate));
    const winners = results.filter((r) => r.winRate >= bestWin * 0.5);
    const best = Math.max(...winners.map((r) => r.meanScore));
    const viable = winners.filter((r) => r.meanScore >= best - 0.2 * Math.abs(best)).map((r) => r.policy);
    return { kingdom: k, results, viable };
  });
}

