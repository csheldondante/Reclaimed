// (trackA-opps, the season loop; docs/design/SEASON_LOOP.md) The season: the city loop's strategic step (DECISIONS
// round 128r and 2026-11-10 "the season loop"). Its cards are dealt by the one dealer (season/deal.ts) from the town
// catalog (season/catalog.ts), and played through the one opportunity contract (api/contracts/opportunity.ts): the
// user, "Opportunities can take resources for a duration".
//   - commit: the card's people (Labor, Might — agents, one a unit) are locked for its seasons and its goods
//     (Materials, Magic, Intel) are spent — contract `commit`; uncommit undoes it before the season ends;
//   - nextSeason: goods income added, every card worked one season (its district's stage k/n → (k+1)/n, the ordered
//     changes the showcase plays), and a card at its end resolved — contract `resolve`: its people come back — and its
//     outcome applied (what it gives, its income from then on, its Unrest).
// Unrest keeps that many free workers away (on strike: not with you, so not available — the contract's own rule).
// Pure: no DOM, no GPU, no clock. Every function returns a new ledger and never changes the one it was given.
import type { OpportunityKind } from '../api/contracts/citygen';
import { available, commit as oppCommit, emptyHoldings, resolve as oppResolve, type AgentKind, type Commitment, type Holdings, type Opportunity } from '../api/contracts/opportunity';

/** The pools (DECISIONS round 128r; the user 2026-11-10: "Use the six pools"; Resources shown as Materials). */
export const POOLS = ['magic', 'might', 'labor', 'materials', 'intel', 'unrest'] as const;
export type Pool = (typeof POOLS)[number];
export type Pools = Record<Pool, number>;
export const NO_POOLS: Pools = { magic: 0, might: 0, labor: 0, materials: 0, intel: 0, unrest: 0 };

/**
 * What each pool is to a card (the contract: agents are locked while committed and come back when it resolves; goods
 * are spent). People are locked for the card's seasons; goods are spent when it starts; Unrest is the town's state,
 * never paid.
 */
export const POOL_ROLE: Record<Pool, 'people' | 'goods' | 'state'> = { labor: 'people', might: 'people', materials: 'goods', magic: 'goods', intel: 'goods', unrest: 'state' };
/** the agent kind a people pool's units are */
export const PEOPLE_KIND: Partial<Record<Pool, AgentKind>> = { labor: 'workers', might: 'army' };

/** a district in parts: a card's district covers some of them (the user, 2026-11-10: partial district claims) */
export const DISTRICT_PARTS = 6;

/** what a card does to the town while it's built */
export type CardWork =
  /** part of a district built over the card's seasons — `parts` of its DISTRICT_PARTS, its lots in growth order from
   *  the district's centre — complete when the card finishes. The next card of the kind goes on in the same district
   *  until it's full; then a new one is claimed for the purpose (citygen claimDistrict) */
  | { kind: 'district'; district: OpportunityKind; parts: number }
  /** no world change yet: pools only (quarry and lumber wait for trackA-haul; walls and bridges for a builder) */
  | { kind: 'stub'; waits: string };

export interface SeasonCard {
  /** the catalog's id ('houses', 'market', …) */
  id: string;
  /** what the player reads: "Build houses" */
  title: string;
  /** what's being built, for the summary: "the houses" */
  name: string;
  /** one plain line: why you might want it */
  pitch: string;
  /** people tied up for its seasons, back when it's done (Labor, Might) */
  locks: Partial<Pools>;
  /** goods spent when it starts (Materials, Magic, Intel) */
  costs: Partial<Pools>;
  /** seasons to build: 1–4 */
  seasons: number;
  work: CardWork;
  /** gained once when it's done (more workers from houses, soldiers from the keep) */
  gives?: Partial<Pools>;
  /** goods added every season once it's done */
  income?: Partial<Pools>;
  /** Unrest changed once: when it's started (walls stir people up), when it's built (farms calm them) */
  unrestOnStart?: number;
  unrestOnDone?: number;
  /** cards built before this one is offered (catalog ids) */
  needs?: string[];
  /** offered again once started (houses, farms, workshops); else once per town */
  repeat?: boolean;
}

export interface Project {
  /** unique in the ledger: the card's id and the season it was started */
  id: string;
  card: SeasonCard;
  /** the contract's commitment: the people it holds, the goods spent, the season it ends (resolvesTurn) */
  commitment: Commitment;
}

export interface SeasonLedger {
  season: number;
  /** the people (agents: workers, soldiers) and the goods (Materials, Magic, Intel, Unrest) — the contract's */
  holdings: Holdings;
  /** goods added every season */
  income: Partial<Pools>;
  projects: Project[];
  /** what's built: a catalog id for each finished project, oldest first */
  built: string[];
}

/** One change for the showcase: a project's stage moving `from` → `to` (0..1 of its build), at `at` of the season. */
export interface StageChange {
  at: number;
  project: string;
  card: string;
  from: number;
  to: number;
  /** its first season: the town finds it a place */
  first: boolean;
  done: boolean;
}

export interface SeasonResult {
  ledger: SeasonLedger;
  changes: StageChange[];
  /** what was built this season (catalog ids) */
  finished: string[];
  /** the pools' change over the season (free people, goods) */
  delta: Pools;
}

const people = (h: Holdings, k: Pool) => h.agents.filter((a) => a.kind === PEOPLE_KIND[k]);

/** what's free to use now: free people (not tied up, not on strike), goods held */
export function pools(l: Pick<SeasonLedger, 'holdings'>): Pools {
  const out = { ...NO_POOLS };
  const free = available(l.holdings);
  for (const k of POOLS) out[k] = POOL_ROLE[k] === 'people' ? free.filter((a) => a.kind === PEOPLE_KIND[k]).length : (l.holdings.goods[k] ?? 0);
  return out;
}

/** all the town's people of a pool (free, tied up, on strike), or a good's stock */
export function total(l: Pick<SeasonLedger, 'holdings'>, k: Pool): number {
  return POOL_ROLE[k] === 'people' ? people(l.holdings, k).length : (l.holdings.goods[k] ?? 0);
}

/** people added: `n` more of a pool's kind, with you */
function addPeople(h: Holdings, k: Pool, n: number): void {
  const kind = PEOPLE_KIND[k]!;
  let i = h.agents.length;
  for (let j = 0; j < n; j++) {
    while (h.agents.some((a) => a.id === `${kind}${i}`)) i++;
    h.agents.push({ id: `${kind}${i}`, kind, name: `${kind} ${i}`, count: 1, tags: [], statuses: [], at: { with: 'player' } });
  }
}

/** Unrest keeps that many free workers away: on strike (not with you: not available), the rest back with you */
function strike(h: Holdings): void {
  let n = Math.max(0, h.goods.unrest ?? 0);
  for (const a of [...h.agents].reverse()) {
    if (a.kind !== PEOPLE_KIND.labor || a.committed) continue;
    a.at = n > 0 ? { settlement: 'on strike' } : { with: 'player' };
    if (n > 0) n--;
  }
}

/** add goods or people (gains; never under 0) */
function gain(h: Holdings, g: Partial<Pools>): void {
  for (const [k, v] of Object.entries(g) as [Pool, number][]) {
    if (!v) continue;
    if (POOL_ROLE[k] === 'people') {
      if (v < 0) throw new Error(`season: people are never taken away by a gain (${k} ${v})`);
      addPeople(h, k, v);
    } else h.goods[k] = Math.max(0, (h.goods[k] ?? 0) + v);
  }
}

export function newLedger(start: Partial<Pools> = {}, income: Partial<Pools> = {}): SeasonLedger {
  const h = emptyHoldings();
  for (const k of POOLS) if (POOL_ROLE[k] !== 'people') h.goods[k] = 0;
  gain(h, start);
  strike(h);
  return { season: 1, holdings: h, income: { ...income }, projects: [], built: [] };
}

/** the card as the contract's opportunity: its people required (locked), its goods its costs (spent), its seasons */
export function opportunityOf(card: SeasonCard, season: number): Opportunity {
  const requires = (Object.entries(card.locks) as [Pool, number][]).filter(([, n]) => n > 0).map(([k, n]) => ({ kind: PEOPLE_KIND[k]!, count: n }));
  const costs = Object.fromEntries((Object.entries(card.costs) as [Pool, number][]).filter(([, n]) => n > 0));
  return {
    id: card.id,
    template: card.id,
    offer: card.id,
    title: card.title,
    pitch: card.pitch,
    location: { region: 0, at: [0, 0], name: 'town' },
    requires,
    tier: 1,
    tiers: 1,
    costs,
    duration: { turns: card.seasons },
    outcomes: { success: { text: card.pitch, effects: [] } },
    visibility: 'known',
    expires: { turn: season + 1 },
    themes: ['town', card.work.kind],
    hooks: [],
    because: [],
    affordable: true,
    missing: [],
  };
}

/** what a card needs that's not free now (empty: it can be started) */
export function short(l: SeasonLedger, card: Pick<SeasonCard, 'locks' | 'costs'>): Partial<Pools> {
  const have = pools(l);
  const out: Partial<Pools> = {};
  for (const [k, v] of [...Object.entries(card.locks), ...Object.entries(card.costs)] as [Pool, number][]) if (v > 0 && have[k] < v) out[k] = v - have[k];
  return out;
}

const projectId = (card: SeasonCard, season: number, n: number) => `${card.id}@${season}${n ? `#${n}` : ''}`;

/** Start a card (the contract's commit): its people locked, its goods spent. Throws if they aren't free. */
export function commit(l: SeasonLedger, card: SeasonCard): SeasonLedger {
  const s = short(l, card);
  if (Object.keys(s).length) throw new Error(`season: ${card.id} can't be started (${JSON.stringify(s)} short)`);
  if (!(card.seasons >= 1)) throw new Error(`season: ${card.id} takes ${card.seasons} seasons`);
  for (const k of Object.keys(card.locks) as Pool[]) if (POOL_ROLE[k] !== 'people') throw new Error(`season: ${card.id} locks ${k}, which isn't people`);
  for (const k of Object.keys(card.costs) as Pool[]) if (POOL_ROLE[k] !== 'goods') throw new Error(`season: ${card.id} spends ${k}, which isn't goods`);
  let n = 0;
  while (l.projects.some((p) => p.id === projectId(card, l.season, n))) n++;
  const id = projectId(card, l.season, n);
  const { holdings, commitment } = oppCommit(l.holdings, opportunityOf(card, l.season), { id, now: l.season, turn: l.season });
  gain(holdings, { unrest: card.unrestOnStart ?? 0 });
  strike(holdings);
  return { ...l, holdings, projects: [...l.projects, { id, card, commitment }] };
}

/** Undo a start made this season: its people free and its goods back, as if never started. */
export function uncommit(l: SeasonLedger, project: string): SeasonLedger {
  const p = l.projects.find((x) => x.id === project);
  if (!p) throw new Error(`season: no project ${project}`);
  if (p.commitment.turn !== l.season) throw new Error(`season: ${project} is under way: it can't be undone`);
  const h = structuredClone(l.holdings);
  for (const a of h.agents) if (a.committed === p.id) delete a.committed;
  for (const [g, v] of Object.entries(p.commitment.spent)) h.goods[g] = (h.goods[g] ?? 0) + v;
  h.goods.unrest = Math.max(0, (h.goods.unrest ?? 0) - (p.card.unrestOnStart ?? 0));
  strike(h);
  return { ...l, holdings: h, projects: l.projects.filter((x) => x !== p) };
}

/** The season resolved: everything at once. Pure. */
export function nextSeason(l: SeasonLedger): SeasonResult {
  const season = l.season + 1;
  const before = pools(l);
  let h = structuredClone(l.holdings);
  const income = { ...l.income };
  gain(h, income);
  const changes: StageChange[] = [];
  const projects: Project[] = [];
  const finished: string[] = [];
  l.projects.forEach((p, i) => {
    const n = p.card.seasons;
    const worked = season - p.commitment.turn;
    const done = season >= p.commitment.resolvesTurn!;
    // (the showcase starts the season's changes one after another over its first half: the oldest first)
    const at = l.projects.length > 1 ? (0.5 * i) / (l.projects.length - 1) : 0;
    changes.push({ at, project: p.id, card: p.card.id, from: (worked - 1) / n, to: Math.min(1, worked / n), first: worked === 1, done });
    if (!done) {
      projects.push(p);
      return;
    }
    // (the contract's resolve: its people back; then what the card gives)
    h = oppResolve(h, p.commitment, { now: season, turn: season }).holdings;
    finished.push(p.card.id);
    gain(h, p.card.gives ?? {});
    gain(h, { unrest: p.card.unrestOnDone ?? 0 });
    for (const [k, v] of Object.entries(p.card.income ?? {}) as [Pool, number][]) income[k] = (income[k] ?? 0) + v;
  });
  strike(h);
  const ledger: SeasonLedger = { season, holdings: h, income, projects, built: [...l.built, ...finished] };
  const after = pools(ledger);
  const delta = { ...NO_POOLS };
  for (const k of POOLS) delta[k] = after[k] - before[k];
  return { ledger, changes, finished, delta };
}
