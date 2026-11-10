// (trackA-opps, the season loop; docs/design/SEASON_LOOP.md "Data flow") The season's hand, dealt by the one dealer
// (opps/dealer.ts deal): each catalog card a proposal — no agents, its cost in the pools as goods, the town's filters
// as its sense (what it needs built, free land for a district, a one-off not started yet), its score parts (urgency,
// unlocks, value) — and the dealer filters, scores and limits as it does for every other run. Pure.
import { deal, type DealReport, type Proposal } from '../opps/dealer';
import type { DealerTune } from '../opps/tune';
import type { Holdings } from '../api/contracts/opportunity';
import { emptyHoldings } from '../api/contracts/opportunity';
import { CATALOG, card } from './catalog';
import { POOLS, short, type Pools, type SeasonCard, type SeasonLedger } from './ledger';
import { REASON } from './words';

/** cards in a hand at most (affordable), and the ones shown that can't be paid yet */
export const HAND = 4;
export const HAND_GOALS = 1;

export interface Offer {
  card: SeasonCard;
  /** the plain line why it's in the hand */
  reason: string;
  affordable: boolean;
  /** what the pools lack (empty when affordable) */
  missing: Partial<Pools>;
  score: number;
}

export interface HandContext {
  ledger: SeasonLedger;
  /** districts of the town not begun (the GPU's count, read back after a claim); null: not known yet */
  districtsLeft: number | null;
  /** what earlier hands held: the dealer's variety */
  recent: { template: string; place: string; turn: number }[];
  tune: DealerTune;
}

const PLACE = 'town';

/** district projects started and not yet given land (their first season to come) */
export function landWanted(l: SeasonLedger): number {
  return l.projects.filter((p) => p.card.work.kind === 'district' && p.worked === 0).length;
}

/** whether there's land for one more district card (unknown counts as yes) */
export function hasLand(l: SeasonLedger, left: number | null): boolean {
  return left === null || left - landWanted(l) > 0;
}

function holdings(l: SeasonLedger): Holdings {
  const h = emptyHoldings();
  for (const k of POOLS) h.goods[k] = l.pools[k];
  return h;
}

/** the catalog cards this one opens */
const opens = (c: SeasonCard) => CATALOG.filter((x) => x.needs?.includes(c.id));

function proposal(c: SeasonCard, ctx: HandContext): Proposal {
  const l = ctx.ledger;
  const started = l.built.includes(c.id) || l.projects.some((p) => p.card.id === c.id);
  const needs = c.needs ?? [];
  const sense = [
    ...needs.map((n) => ({ ok: l.built.includes(n), why: l.built.includes(n) ? `${n} built` : `needs ${n} built` })),
    { ok: c.repeat || !started, why: c.repeat ? 'can be built again' : started ? 'one a town: already started' : 'one a town: not started' },
    ...(c.work.kind === 'district' ? [{ ok: hasLand(l, ctx.districtsLeft), why: `districts left ${ctx.districtsLeft ?? '?'}, wanted ${landWanted(l)}` }] : []),
  ];
  const unrestCalm = (c.unrestOnDone ?? 0) < 0 && l.pools.unrest > 0 ? Math.min(1, l.pools.unrest / 3) : 0;
  const workers = (c.income.labor ?? 0) > 0 && l.pools.labor < 3 ? 0.6 : 0;
  const unlocks = opens(c).some((x) => !l.built.includes(x.id)) && !l.built.includes(c.id) ? 1 : 0;
  const value = Math.min(1, Object.values(c.income).reduce((s, v) => s + Math.abs(v ?? 0), 0) / 3);
  // (a stub card a little lower: it changes the pools, not the town you're looking at)
  const theme = c.work.kind === 'district' ? 1 : 0.4;
  return {
    template: c.id,
    offer: c.id,
    place: PLACE,
    title: c.title,
    tiers: [{ requires: [], costs: { ...c.cost } }],
    make: () => ({
      template: c.id,
      offer: c.id,
      title: c.title,
      pitch: c.pitch,
      location: { region: 0, at: [0, 0], name: PLACE },
      duration: { turns: c.seasons },
      outcomes: { success: { text: c.pitch, effects: [] } },
      visibility: 'known',
      expires: { turn: l.season + 1 },
      themes: ['town', c.work.kind],
      hooks: [],
    }),
    sense,
    parts: { theme, urgency: Math.max(unrestCalm, workers), unlocks, ev: value },
    at: [0, 0],
    hooks: [],
  };
}

/** the plain reason a card is in the hand */
function reasonFor(c: SeasonCard, l: SeasonLedger): string {
  if ((c.unrestOnDone ?? 0) < 0 && l.pools.unrest > 0) return REASON.calm(l.pools.unrest);
  if ((c.income.labor ?? 0) > 0 && l.pools.labor < 3) return REASON.workers;
  const next = opens(c).find((x) => !l.built.includes(x.id));
  if (next && !l.built.includes(c.id)) return REASON.opens(next);
  const need = (c.needs ?? []).at(-1);
  if (need) return REASON.ready(card(need));
  return c.pitch;
}

/** The season's hand: the dealer's report and the offers in it, best first. */
export function dealHand(ctx: HandContext): { offers: Offer[]; report: DealReport } {
  const l = ctx.ledger;
  const tune: DealerTune = { ...ctx.tune, resourceMax: HAND, unaffordable: HAND_GOALS, nextTier: 0, minScore: 0, reach: Number.MAX_VALUE };
  const report = deal(
    CATALOG.map((c) => proposal(c, ctx)),
    { holdings: holdings(l), turn: l.season, at: [0, 0], dist: () => 0, conflictHooks: [], recent: ctx.recent, tune, onePerPlace: false },
  );
  const offers = report.dealt.map((d): Offer => {
    const c = card(d.opp.template);
    const missing = short(l, c);
    return { card: c, reason: reasonFor(c, l), affordable: d.opp.affordable, missing, score: d.score };
  });
  return { offers, report };
}
