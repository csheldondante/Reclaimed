// (trackA-opps, the season loop; docs/design/SEASON_LOOP.md "Data flow") The season's hand, dealt by the one dealer
// (opps/dealer.ts deal): each catalog card a proposal — the people it ties up as the contract's requirements (workers,
// soldiers), the goods it spends as its costs, the town's filters as its sense (what it needs built, land for its
// district, a one-off not started yet), its score parts (urgency, unlocks, value) — over the ledger's own holdings, so
// the dealer and the ledger read the same people and goods. Pure.
import { deal, type DealReport, type Proposal } from '../opps/dealer';
import type { DealerTune } from '../opps/tune';
import { CATALOG, card } from './catalog';
import { DISTRICT_PARTS, opportunityOf, pools, short, type Pools, type SeasonCard, type SeasonLedger } from './ledger';
import type { OpportunityKind } from '../api/contracts/citygen';
import { REASON } from './words';

/** cards in a hand at most (affordable), and the ones shown that can't be paid yet */
export const HAND = 4;
export const HAND_GOALS = 1;

export interface Offer {
  card: SeasonCard;
  /** the plain line why it's in the hand */
  reason: string;
  affordable: boolean;
  /** what's not free (empty when affordable) */
  missing: Partial<Pools>;
  score: number;
}

/** a district being built in: its kind, its parts still free, which of its two slots a card is building in now */
export interface OpenDistrict {
  kind: OpportunityKind;
  key: string;
  room: number;
  busy: [boolean, boolean];
}

/**
 * The town's land as the season sees it: districts not begun (the GPU's count, read back after a claim; null until the
 * town is made) and the districts begun with parts still free (a district is DISTRICT_PARTS parts).
 */
export interface Land {
  left: number | null;
  open: OpenDistrict[];
}

export interface HandContext {
  ledger: SeasonLedger;
  land: Land;
  /** what earlier hands held: the dealer's variety */
  recent: { template: string; place: string; turn: number }[];
  tune: DealerTune;
}

const PLACE = 'town';

/**
 * Where a district card's parts go — the one rule the loop builds by and the dealer offers by: on in an open district
 * of its kind with the room and a slot free (two cards build in a district at once — the GPU's stage table holds two
 * shares), else a new district (one fewer left, the rest of it open). A copy, the slot taken; null: no land.
 */
export function allocate(land: Land, kind: OpportunityKind, parts: number): { land: Land; key: string | null; slot: 0 | 1 } | null {
  const i = land.open.findIndex((d) => d.kind === kind && d.room >= parts && d.busy.includes(false));
  if (i >= 0) {
    const slot = land.open[i].busy.indexOf(false) as 0 | 1;
    const open = land.open.map((d, j) => (j === i ? { ...d, room: d.room - parts, busy: d.busy.map((b, k) => b || k === slot) as [boolean, boolean] } : d));
    return { land: { left: land.left, open }, key: land.open[i].key, slot };
  }
  if (land.left !== null && land.left <= 0) return null;
  const key = `new${land.open.length}`;
  return { land: { left: land.left === null ? null : land.left - 1, open: [...land.open, { kind, key, room: DISTRICT_PARTS - parts, busy: [true, false] }] }, key: null, slot: 0 };
}

/** the land left once this season's started district cards (not yet built on) have theirs */
export function landAfterStarts(l: SeasonLedger, land: Land): Land | null {
  let cur: Land | null = land;
  for (const p of l.projects)
    if (cur && p.commitment.turn === l.season && p.card.work.kind === 'district') cur = allocate(cur, p.card.work.district, p.card.work.parts)?.land ?? null;
  return cur;
}

/** whether there's land for this card on top of this season's starts */
export function hasLand(l: SeasonLedger, land: Land, c: SeasonCard): boolean {
  if (c.work.kind !== 'district') return true;
  const after = landAfterStarts(l, land);
  return !!after && !!allocate(after, c.work.district, c.work.parts);
}

/** the catalog cards this one opens */
const opens = (c: SeasonCard) => CATALOG.filter((x) => x.needs?.includes(c.id));

function proposal(c: SeasonCard, ctx: HandContext): Proposal {
  const l = ctx.ledger;
  const free = pools(l);
  const started = l.built.includes(c.id) || l.projects.some((p) => p.card.id === c.id);
  const needs = c.needs ?? [];
  const sense = [
    ...needs.map((n) => ({ ok: l.built.includes(n), why: l.built.includes(n) ? `${n} built` : `needs ${n} built` })),
    { ok: c.repeat || !started, why: c.repeat ? 'can be built again' : started ? 'one a town: already started' : 'one a town: not started' },
    ...(c.work.kind === 'district' ? [{ ok: hasLand(l, ctx.land, c), why: `land: ${ctx.land.left ?? '?'} districts left, ${ctx.land.open.length} begun` }] : []),
  ];
  const unrestCalm = (c.unrestOnDone ?? 0) < 0 && free.unrest > 0 ? Math.min(1, free.unrest / 3) : 0;
  const workers = (c.gives?.labor ?? 0) > 0 && free.labor < 3 ? 0.6 : 0;
  const unlocks = opens(c).some((x) => !l.built.includes(x.id)) && !l.built.includes(c.id) ? 1 : 0;
  const value = Math.min(1, [...Object.values(c.income ?? {}), ...Object.values(c.gives ?? {})].reduce((s, v) => s + Math.abs(v ?? 0), 0) / 3);
  // (a stub card a little lower: it changes the pools, not the town you're looking at)
  const theme = c.work.kind === 'district' ? 1 : 0.4;
  const opp = opportunityOf(c, l.season);
  return {
    template: c.id,
    offer: c.id,
    place: PLACE,
    title: c.title,
    tiers: [{ requires: opp.requires, costs: opp.costs }],
    make: () => {
      const { id: _i, tier: _t, tiers: _n, requires: _r, costs: _c, because: _b, affordable: _a, missing: _m, ...made } = opp;
      return made;
    },
    sense,
    parts: { theme, urgency: Math.max(unrestCalm, workers), unlocks, ev: value },
    at: [0, 0],
    hooks: [],
  };
}

/** the plain reason a card is in the hand */
function reasonFor(c: SeasonCard, l: SeasonLedger): string {
  const free = pools(l);
  if ((c.unrestOnDone ?? 0) < 0 && free.unrest > 0) return REASON.calm(free.unrest);
  if ((c.gives?.labor ?? 0) > 0 && free.labor < 3) return REASON.workers;
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
    { holdings: l.holdings, turn: l.season, at: [0, 0], dist: () => 0, conflictHooks: [], recent: ctx.recent, tune, onePerPlace: false },
  );
  const offers = report.dealt.map((d): Offer => {
    const c = card(d.opp.template);
    return { card: c, reason: reasonFor(c, l), affordable: d.opp.affordable, missing: short(l, c), score: d.score };
  });
  return { offers, report };
}
