// (round 128r, Track A "Next season") The season: the city loop's strategic step (DECISIONS round 128r; the draft
// DESIGN §18/§21, docs/handoff/DESIGN_18_21_DRAFT.md; docs/design/NEXT_SEASON.md). Pure: `nextSeason` resolves
// everything due at once, the same input giving the same output, and writes nothing. What it returns is the truth of
// the season, at the atlas scale (docs/SYSTEMS.md "Three time scales"):
//   - the next ledger (the pools, the projects);
//   - AtlasEvents for the world state (WorldState.apply: flood, drain, ruin, overgrow, mark);
//   - the settlement's history marks (SettlementStoryEvent: what the generator wears into a town — structures/purpose.ts
//     markWear — and what the live plan is worn by now, season/realise.ts);
//   - the changes to realise in the live window, ordered, each at a fraction of the season (the showcase plays them
//     over a few seconds; skipping applies the rest at once: SimTiers.showcase);
//   - a plain line of what happened (docs/WRITING.md).
// A season's cards are shaped as card outcomes (an AtlasEvent each, contracts/opportunity.ts OppEffect 'atlas'), so the
// dealer can feed them next slice; this slice plays a fixed list (season/scenario.ts).
import type { AtlasEvent } from '../api/contracts/world';
import type { SettlementStoryEvent } from '../api/contracts/settlement';
import type { CityMark, V2, Wear } from '../api/contracts/structures';
import { markWear } from '../structures/purpose';
import { cardLines, wordsLine, type SeasonWords } from './words';

/** The pools (DECISIONS round 128r: the five plus Unrest are the truth; the set is data). Small counting numbers. */
export const POOLS = ['magic', 'might', 'labor', 'resources', 'intel', 'unrest'] as const;
export type Pool = (typeof POOLS)[number];
export type Pools = Record<Pool, number>;

export const NO_POOLS: Pools = { magic: 0, might: 0, labor: 0, resources: 0, intel: 0, unrest: 0 };

/** what a card does over its seasons */
export type CardWork =
  /** a landmark: its planned levels stand, `storeys` a season, scaffolded first (ST18's stored progress, realised now) */
  | { kind: 'raise'; structure: number; storeys: number }
  /** a quarter's decay: one history mark a season, in order (a storey lost, then a ruin, then green over it) */
  | { kind: 'decay'; at: V2; r: number; marks: ('raided' | 'ruined' | 'overgrown')[] }
  /** a basin flooded to its spill height (or `level`), held `hold` seasons, then drained */
  | { kind: 'flood'; at: V2; level?: number; hold: number };

export interface SeasonCard {
  id: string;
  /** its plain name for the summary ("the bell tower", "the east quarter", "the low fields") */
  name: string;
  /** paid when it's played: committed is committed */
  cost: Partial<Pools>;
  work: CardWork;
}

export interface Project {
  card: SeasonCard;
  /** the season it was played in */
  played: number;
  /** seasons worked so far */
  worked: number;
}

/** what the season reads of the live plan (the plan is authored state: the CPU's) */
export interface PlanView {
  /** a structure's planned blocks, bottom up, and whether each stands */
  blocks(id: number): { cell: number; level: number; standing: boolean }[];
  /** its centre (window world), floor (z) and storeys now; null: gone */
  structure(id: number): { centre: V2; base: number; storeys: number } | null;
  /** every structure's id, centre, floor and storeys (the decay marks are judged on them) */
  structures(): { id: number; centre: V2; base: number; storeys: number }[];
}

export interface SeasonLedger {
  season: number;
  pools: Pools;
  /** added each season */
  income: Partial<Pools>;
  projects: Project[];
  /** (the settlement's history marks, oldest first: kept here while the fortress's town has no settlement record) */
  story: SettlementStoryEvent[];
}

/** One change to realise in the live window, at a fraction of the season (`at`, 0..1; a flood rises until `until`). */
export type SeasonChange =
  | { at: number; kind: 'scaffold'; structure: number; cell: number; level: number }
  | { at: number; kind: 'stand'; structure: number; cell: number; level: number }
  | { at: number; kind: 'wear'; structure: number; wear: Wear; storeys: number }
  | { at: number; kind: 'grow'; x: number; y: number; r: number }
  | { at: number; until: number; kind: 'flood'; card: string; x: number; y: number; level?: number }
  | { at: number; until: number; kind: 'drain'; card: string };

export interface SeasonResult {
  ledger: SeasonLedger;
  atlas: Omit<AtlasEvent, 'regions' | 'run'>[];
  story: SettlementStoryEvent[];
  changes: SeasonChange[];
  /** the plain line of what happened */
  summary: string;
}

export function newLedger(pools: Partial<Pools> = {}, income: Partial<Pools> = {}): SeasonLedger {
  return { season: 0, pools: { ...NO_POOLS, ...pools }, income: { ...income }, projects: [], story: [] };
}

/** what a card costs that the pools can't pay (empty: it can be played) */
export function short(l: SeasonLedger, card: SeasonCard): Partial<Pools> {
  const out: Partial<Pools> = {};
  for (const [k, v] of Object.entries(card.cost) as [Pool, number][]) if (l.pools[k] < v) out[k] = v - l.pools[k];
  return out;
}

/** Play a card: its cost paid now, its work done season by season. A copy; throws if the pools can't pay. */
export function play(l: SeasonLedger, card: SeasonCard): SeasonLedger {
  const s = short(l, card);
  if (Object.keys(s).length) throw new Error(`season: ${card.id} can't be paid (${JSON.stringify(s)} short)`);
  if (l.projects.some((p) => p.card.id === card.id)) throw new Error(`season: ${card.id} is already played`);
  const pools = { ...l.pools };
  for (const [k, v] of Object.entries(card.cost) as [Pool, number][]) pools[k] -= v;
  return { ...l, pools, projects: [...l.projects, { card, played: l.season, worked: 0 }] };
}

/** a project's work this season: its changes, atlas events, marks and summary words; whether it's finished after */
function work(p: Project, season: number, plan: PlanView): { changes: SeasonChange[]; atlas: SeasonResult['atlas']; story: SettlementStoryEvent[]; words: SeasonWords[]; done: boolean } {
  const out = { changes: [] as SeasonChange[], atlas: [] as SeasonResult['atlas'], story: [] as SettlementStoryEvent[], words: [] as SeasonWords[], done: false };
  const w = p.card.work;
  const id = `${p.card.id}-s${season}`;
  const cause = { by: 'player' as const, ref: p.card.id };
  if (w.kind === 'raise') {
    const blocks = plan.blocks(w.structure);
    if (!blocks.length) throw new Error(`season: ${p.card.id} raises structure ${w.structure}, which has no planned blocks`);
    const levels = [...new Set(blocks.filter((b) => !b.standing).map((b) => b.level))].sort((a, b) => a - b);
    const now = levels.slice(0, w.storeys);
    const next = levels.slice(w.storeys, w.storeys * 2);
    // (each storey's blocks stand one after another over the season; the next storeys' scaffolding goes up first)
    const rows = now.map((l) => blocks.filter((b) => b.level === l && !b.standing));
    const all = rows.flat();
    for (const b of all) out.changes.push({ at: 0, kind: 'scaffold', structure: w.structure, cell: b.cell, level: b.level });
    all.forEach((b, k) => out.changes.push({ at: 0.15 + (0.7 * (k + 1)) / all.length, kind: 'stand', structure: w.structure, cell: b.cell, level: b.level }));
    for (const b of blocks.filter((x) => next.includes(x.level))) out.changes.push({ at: 0.9, kind: 'scaffold', structure: w.structure, cell: b.cell, level: b.level });
    out.done = levels.length <= w.storeys;
    out.words.push({ kind: 'raise', name: p.card.name, storeys: now.length, done: out.done });
    if (out.done) {
      const s = plan.structure(w.structure);
      out.atlas.push({ id, kind: 'mark', magnitude: 1, detail: { name: p.card.name, kind: 'landmark', at: s?.centre }, cause });
      out.story.push({ what: 'grew', run: season, note: wordsLine({ kind: 'raise', name: p.card.name, storeys: 0, done: true }), at: s?.centre, cause: id });
    }
    return out;
  }
  if (w.kind === 'decay') {
    const kind = w.marks[p.worked];
    const mark: CityMark = { kind, at: w.at, r: w.r };
    let k = 0;
    for (const s of plan.structures().sort((a, b) => a.id - b.id)) {
      const hit = markWear(mark, s.centre, s.base, s.id, s.storeys);
      if (!hit) continue;
      out.changes.push({ at: 0.2 + 0.6 * ((k++ * 0.618) % 1), kind: 'wear', structure: s.id, wear: hit.wear, storeys: hit.storeys });
    }
    if (kind === 'overgrown') {
      // (green over the quarter: the plants' grow, out from the middle — after the ruins are down, so what the
      // structures' columns are written with doesn't depend on when, within the season, the plants came)
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        const d = i === 0 ? 0 : w.r * 0.55;
        out.changes.push({ at: 0.86 + 0.04 * i, kind: 'grow', x: w.at[0] + Math.cos(a) * d, y: w.at[1] + Math.sin(a) * d, r: w.r * 0.6 });
      }
    }
    const atlasKind = kind === 'overgrown' ? 'overgrow' : 'ruin';
    out.atlas.push({ id, kind: atlasKind, area: { at: w.at, radius: w.r }, magnitude: kind === 'raided' ? 0.3 : 0.4, cause });
    out.story.push({ what: kind, run: season, note: wordsLine({ kind, name: p.card.name }), at: w.at, radius: w.r, cause: id });
    out.words.push({ kind, name: p.card.name });
    out.done = p.worked + 1 >= w.marks.length;
    return out;
  }
  // a flood: rises in its first season, holds, then drains
  if (p.worked === 0) {
    out.changes.push({ at: 0.1, until: 0.8, kind: 'flood', card: p.card.id, x: w.at[0], y: w.at[1], level: w.level });
    // (the level is the basin's spill height, found by the fill: realise.ts sets it on the event before it's applied)
    out.atlas.push({ id, kind: 'flood', area: { at: w.at, radius: 0 }, magnitude: 1, level: w.level, cause });
    out.story.push({ what: 'flooded', run: season, note: wordsLine({ kind: 'flood', name: p.card.name }), at: w.at, level: w.level, cause: id });
    out.words.push({ kind: 'flood', name: p.card.name });
  } else if (p.worked < 1 + w.hold) {
    out.words.push({ kind: 'flood-holds', name: p.card.name });
  } else {
    out.changes.push({ at: 0.1, until: 0.8, kind: 'drain', card: p.card.id });
    out.atlas.push({ id, kind: 'drain', magnitude: 1, cause });
    out.words.push({ kind: 'drain', name: p.card.name });
    out.done = true;
  }
  return out;
}

/** The season resolved: everything due, at once. Pure: the same ledger and plan give the same result. */
export function nextSeason(l: SeasonLedger, plan: PlanView): SeasonResult {
  const season = l.season + 1;
  const pools = { ...l.pools };
  for (const [k, v] of Object.entries(l.income) as [Pool, number][]) pools[k] += v;
  const changes: SeasonChange[] = [];
  const atlas: SeasonResult['atlas'] = [];
  const story: SettlementStoryEvent[] = [];
  const words: SeasonWords[] = [];
  const projects: Project[] = [];
  for (const p of l.projects) {
    const r = work(p, season, plan);
    changes.push(...r.changes);
    atlas.push(...r.atlas);
    story.push(...r.story);
    words.push(...r.words);
    if (!r.done) projects.push({ ...p, worked: p.worked + 1 });
  }
  // (the order the showcase plays them: by fraction, then as listed — a sort that keeps ties stable)
  const order = changes.map((c, i) => [c, i] as const).sort((a, b) => a[0].at - b[0].at || a[1] - b[1]).map(([c]) => c);
  return { ledger: { season, pools, income: { ...l.income }, projects, story: [...l.story, ...story] }, atlas, story, changes: order, summary: cardLines(season, words) };
}
