// (trackA-opps, the season loop; docs/design/SEASON_LOOP.md) The season: the city loop's strategic step (DECISIONS
// round 128r and 2026-11-10 "the season loop"). Revived from the reverted ledger (6a619edb) on the six pools, its
// cards dealt by the one dealer (season/deal.ts) from the town catalog (season/catalog.ts) — no fixed scenario.
// Pure: no DOM, no GPU, no clock. Every function returns a new ledger and never changes the one it was given.
//   - commit: a card's cost paid now, a project started (worked 0); uncommit refunds it before the season ends;
//   - nextSeason: income added (Labor less Unrest), every project worked one season, its stage moving from k/n to
//     (k+1)/n — the ordered changes the showcase plays (`at` 0..1) — and a finished one's income and unrest applied.
import type { OpportunityKind } from '../api/contracts/citygen';

/** The pools (DECISIONS round 128r; the user 2026-11-10: "Use the six pools"). Small counting numbers. */
export const POOLS = ['magic', 'might', 'labor', 'resources', 'intel', 'unrest'] as const;
export type Pool = (typeof POOLS)[number];
export type Pools = Record<Pool, number>;
export const NO_POOLS: Pools = { magic: 0, might: 0, labor: 0, resources: 0, intel: 0, unrest: 0 };

/** what a card does to the town while it's built */
export type CardWork =
  /** a district of the town claimed for this purpose and built over the card's seasons (citygen claimDistrict) */
  | { kind: 'district'; district: OpportunityKind }
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
  /** paid when it's started */
  cost: Partial<Pools>;
  /** seasons to build: 1–4 */
  seasons: number;
  work: CardWork;
  /** added to the income every season once it's built */
  income: Partial<Pools>;
  /** Unrest changed once: when it's started (walls stir people up), when it's built (a market calms them) */
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
  /** the season it was started in */
  played: number;
  /** seasons worked so far */
  worked: number;
}

export interface SeasonLedger {
  season: number;
  pools: Pools;
  /** added every season (Labor less Unrest) */
  income: Pools;
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
  /** the pools' change over the season */
  delta: Pools;
}

export function newLedger(pools: Partial<Pools> = {}, income: Partial<Pools> = {}): SeasonLedger {
  return { season: 1, pools: { ...NO_POOLS, ...pools }, income: { ...NO_POOLS, ...income }, projects: [], built: [] };
}

/** what a card costs that the pools can't pay (empty: it can be started) */
export function short(l: SeasonLedger, card: Pick<SeasonCard, 'cost'>): Partial<Pools> {
  const out: Partial<Pools> = {};
  for (const [k, v] of Object.entries(card.cost) as [Pool, number][]) if (l.pools[k] < v) out[k] = v - l.pools[k];
  return out;
}

/** the Labor a season brings: Labor's income less Unrest (never under 0) */
export function laborIncome(l: Pick<SeasonLedger, 'income' | 'pools'>): number {
  return Math.max(0, l.income.labor - l.pools.unrest);
}

const projectId = (card: SeasonCard, season: number, n: number) => `${card.id}@${season}${n ? `#${n}` : ''}`;

/** Start a card: its cost paid now, a project begun. Throws if the pools can't pay. */
export function commit(l: SeasonLedger, card: SeasonCard): SeasonLedger {
  const s = short(l, card);
  if (Object.keys(s).length) throw new Error(`season: ${card.id} can't be paid (${JSON.stringify(s)} short)`);
  if (!(card.seasons >= 1)) throw new Error(`season: ${card.id} takes ${card.seasons} seasons`);
  const pools = { ...l.pools };
  for (const [k, v] of Object.entries(card.cost) as [Pool, number][]) pools[k] -= v;
  pools.unrest = Math.max(0, pools.unrest + (card.unrestOnStart ?? 0));
  let n = 0;
  while (l.projects.some((p) => p.id === projectId(card, l.season, n))) n++;
  return { ...l, pools, projects: [...l.projects, { id: projectId(card, l.season, n), card, played: l.season, worked: 0 }] };
}

/** Undo a start made this season: its cost back. Throws for a project already worked. */
export function uncommit(l: SeasonLedger, project: string): SeasonLedger {
  const p = l.projects.find((x) => x.id === project);
  if (!p) throw new Error(`season: no project ${project}`);
  if (p.worked > 0 || p.played !== l.season) throw new Error(`season: ${project} is under way: it can't be undone`);
  const pools = { ...l.pools };
  for (const [k, v] of Object.entries(p.card.cost) as [Pool, number][]) pools[k] += v;
  pools.unrest = Math.max(0, pools.unrest - (p.card.unrestOnStart ?? 0));
  return { ...l, pools, projects: l.projects.filter((x) => x !== p) };
}

/** The season resolved: everything at once. Pure. */
export function nextSeason(l: SeasonLedger): SeasonResult {
  const pools = { ...l.pools };
  const income = { ...l.income };
  for (const k of POOLS) pools[k] += k === 'labor' ? laborIncome(l) : income[k];
  pools.unrest = Math.max(0, pools.unrest);
  const changes: StageChange[] = [];
  const projects: Project[] = [];
  const finished: string[] = [];
  l.projects.forEach((p, i) => {
    const n = p.card.seasons;
    const worked = p.worked + 1;
    const done = worked >= n;
    // (the showcase starts the season's changes one after another over its first half: the oldest first)
    const at = l.projects.length > 1 ? (0.5 * i) / (l.projects.length - 1) : 0;
    changes.push({ at, project: p.id, card: p.card.id, from: p.worked / n, to: Math.min(1, worked / n), first: p.worked === 0, done });
    if (!done) {
      projects.push({ ...p, worked });
      return;
    }
    finished.push(p.card.id);
    for (const [k, v] of Object.entries(p.card.income) as [Pool, number][]) income[k] += v;
    pools.unrest = Math.max(0, pools.unrest + (p.card.unrestOnDone ?? 0));
  });
  const delta = { ...NO_POOLS };
  for (const k of POOLS) delta[k] = pools[k] - l.pools[k];
  return { ledger: { season: l.season + 1, pools, income, projects, built: [...l.built, ...finished] }, changes, finished, delta };
}
