// ---- opps/dealer.ts -----------------------------------------------------------------------------------------------
// (round 120, `opportunities`; BACKLOG RN2-2) The dealer: of everything the templates propose this turn, what is
// offered on the map. Generic (no slice in it): templates propose (src/opps/horde.ts for slice A), the dealer filters,
// picks a tier, scores, deals within the limits, and keeps the guarantees — and says why for every one it dealt and
// every one it didn't (the debug overlay shows the report).
// The user (round 120): "Part of the challenge here is designing a mechanical way to filter these and deal just the
// ones that make sense. I like your suggestion of most expensive cards you can afford." "The player may only have one
// option a turn depending on what makes sense." "I would limit the number of opportunities and instead show ones that
// require more resources." "I think we will need to tune the dealer and learn what is fun for play via iteration."
//
// The steps, in order (each rejection names its step):
//   1 sense    the template's own filters: the place (the GM's travel rule for a player opportunity), the conflict's
//              phase, the facts it needs — a proposal failing one is out, with that filter's line;
//   2 reach    a resource opportunity only within `reach` of where the player is (commitments are made from there);
//   3 tier     the largest tier what's available meets ("the most expensive you can afford"); none: unaffordable;
//   4 score    Σ weight × part (theme, foreshadow, variety, synergy, difficulty, hero, tier), each part 0..1;
//   5 one      one offer of a template at a place (the user's "only show one option"): the best-scoring;
//   6 forced   a forced opportunity is dealt alone among the player's;
//   7 limits   at most `playerMax` player and `resourceMax` resource opportunities, best first, none under
//              `minScore`; `unaffordable` slots for known ones that can't be met yet; `nextTier` shows the tier above;
//   8 keep     the guarantees: a way toward the climax among the player's; something tied to the conflict.

import { affords, needsPlayer, type Goods, type Holdings, type Opportunity, type Requirement } from '../api/contracts/opportunity';
import type { DealerTune } from './tune';

// (round 125, facts: capability, unlocks, urgency, neglect — the living world's templates give them; 0 from the rest)
export type ScorePart = 'theme' | 'foreshadow' | 'variety' | 'synergy' | 'difficulty' | 'hero' | 'tier' | 'ev' | 'capability' | 'unlocks' | 'urgency' | 'neglect';
export const SCORE_PARTS: readonly ScorePart[] = ['theme', 'foreshadow', 'variety', 'synergy', 'difficulty', 'hero', 'tier', 'ev', 'capability', 'unlocks', 'urgency', 'neglect'];
const WEIGHT: Record<ScorePart, keyof DealerTune> = { theme: 'wTheme', foreshadow: 'wForeshadow', variety: 'wVariety', synergy: 'wSynergy', difficulty: 'wDifficulty', hero: 'wHero', tier: 'wTier', ev: 'wEv', capability: 'wCapability', unlocks: 'wUnlocks', urgency: 'wUrgency', neglect: 'wNeglect' };

export interface TierOffer {
  requires: Requirement[];
  costs: Goods;
}

/** what the dealer leaves for itself to fill */
export type Made = Omit<Opportunity, 'tier' | 'tiers' | 'requires' | 'costs' | 'because' | 'affordable' | 'missing' | 'id'>;

/** A template's offer at a place this turn, before the dealer. */
export interface Proposal {
  template: string;
  offer: string;
  /** one offer of a template a place: this is the place's key */
  place: string;
  title: string;
  /** the requirement tiers, smallest first */
  tiers: TierOffer[];
  /** the opportunity at a tier (1-based) */
  make(tier: number): Made;
  /** the template's filters, each with its line (a failing one is why it isn't dealt) */
  sense: { ok: boolean; why: string }[];
  /** the template's part of the score (0..1 each); variety and tier are the dealer's */
  parts: Partial<Record<Exclude<ScorePart, 'variety' | 'tier'>, number>>;
  /** where it is (world units): the reach of a resource opportunity is measured to it */
  at: [number, number];
  /** a player opportunity that leads toward the climax (the guarantee) */
  towardClimax?: boolean;
  forced?: boolean;
  /** (round 124) a happening, not an offer: once it makes sense it is on the board whatever is held and outside the
   *  limits — letting it go has a consequence (the tribute demanded, the climax come), so it can't be hidden */
  event?: boolean;
  hooks: string[];
}

export interface DealContext {
  holdings: Holdings;
  turn: number;
  /** where the player is (world units), and the distance between two points (the torus's) */
  at: [number, number];
  dist: (a: [number, number], b: [number, number]) => number;
  /** what the conflict is about: a dealt opportunity sharing one is "tied to the conflict" */
  conflictHooks: string[];
  /** what was dealt on earlier turns (variety) */
  recent: { template: string; place: string; turn: number }[];
  tune: DealerTune;
  /** (round 125, facts) at most one card a place, whatever its template (the user's doc: "at most one displayed
   *  opportunity per location"); else one offer of a template a place */
  onePerPlace?: boolean;
}

export interface Dealt {
  opp: Opportunity;
  score: number;
  parts: Record<ScorePart, number>;
}

export interface Rejected {
  template: string;
  offer: string;
  place: string;
  title: string;
  step: 'sense' | 'reach' | 'one' | 'forced' | 'limits';
  why: string;
  score?: number;
}

export interface DealReport {
  turn: number;
  dealt: Dealt[];
  rejected: Rejected[];
  /** what the guarantees did (or that they held as dealt) */
  guarantees: string[];
  ms: number;
}

interface Cand {
  p: Proposal;
  kind: 'player' | 'resources';
  tier: number;
  affordable: boolean;
  missing: string[];
  score: number;
  parts: Record<ScorePart, number>;
  because: string[];
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function deal(props: Proposal[], ctx: DealContext): DealReport {
  const t0 = now();
  const T = ctx.tune;
  const rejected: Rejected[] = [];
  const reject = (p: Proposal, step: Rejected['step'], why: string, score?: number) => rejected.push({ template: p.template, offer: p.offer, place: p.place, title: p.title, step, why, ...(score !== undefined ? { score: +score.toFixed(3) } : {}) });
  const cands: Cand[] = [];
  for (const p of props) {
    // 1 sense
    const fail = p.sense.find((s) => !s.ok);
    if (fail) {
      reject(p, 'sense', fail.why);
      continue;
    }
    const kind = needsPlayer({ requires: p.tiers[0].requires }) ? 'player' : 'resources';
    // 2 reach
    if (kind === 'resources') {
      const d = ctx.dist(ctx.at, p.at);
      if (d > T.reach) {
        reject(p, 'reach', `${Math.round(d)} world units from you: past the reach (${T.reach})`);
        continue;
      }
    }
    // 3 tier: the largest the holdings meet
    let tier = 0;
    for (let k = p.tiers.length; k >= 1; k--)
      if (affords(p.tiers[k - 1], ctx.holdings).ok) {
        tier = k;
        break;
      }
    const affordable = tier > 0;
    const missing = affordable ? [] : affords(p.tiers[0], ctx.holdings).missing;
    const t = affordable ? tier : 1;
    // 4 score
    const last = ctx.recent.filter((r) => r.template === p.template && ctx.turn - r.turn <= T.variety && r.turn < ctx.turn).sort((a, b) => b.turn - a.turn)[0];
    const parts: Record<ScorePart, number> = {
      theme: p.parts.theme ?? 0,
      foreshadow: p.parts.foreshadow ?? 0,
      variety: last ? (ctx.turn - last.turn) / (T.variety + 1) : 1,
      synergy: p.parts.synergy ?? 0,
      difficulty: p.parts.difficulty ?? 0.5,
      hero: p.parts.hero ?? 0,
      tier: p.tiers.length > 1 ? (t - 1) / (p.tiers.length - 1) : 1,
      // (round 124: the proposal's expected points a turn, 0..1 — the card lab's ev; the map's templates give none yet)
      ev: p.parts.ev ?? 0,
      capability: p.parts.capability ?? 0,
      unlocks: p.parts.unlocks ?? 0,
      urgency: p.parts.urgency ?? 0,
      neglect: p.parts.neglect ?? 0,
    };
    const score = SCORE_PARTS.reduce((s, k) => s + T[WEIGHT[k]] * parts[k], 0);
    const because = [
      ...p.sense.map((s) => s.why),
      affordable ? (p.tiers.length > 1 ? `tier ${tier} of ${p.tiers.length}: the largest your holdings meet` : 'your holdings meet it') : `unaffordable: ${missing.join('; ')}`,
      `score ${score.toFixed(2)} (${SCORE_PARTS.filter((k) => parts[k] > 0).map((k) => `${k} ${parts[k].toFixed(2)}`).join(', ')})`,
    ];
    cands.push({ p, kind, tier: t, affordable, missing, score, parts, because });
  }
  // 5 one offer of a template at a place
  const best = new Map<string, Cand>();
  for (const c of [...cands].sort((a, b) => Number(b.affordable) - Number(a.affordable) || b.score - a.score)) {
    const k = ctx.onePerPlace ? c.p.place : `${c.p.template}@${c.p.place}`;
    const had = best.get(k);
    if (!had) best.set(k, c);
    else reject(c.p, 'one', ctx.onePerPlace ? `one card a place: "${had.p.title}" scores higher at ${c.p.place}` : `one offer of ${c.p.template} at ${c.p.place}: "${had.p.title}" is dealt instead`, c.score);
  }
  const pool = [...best.values()].sort((a, b) => b.score - a.score);
  const guarantees: string[] = [];
  const dealt: Cand[] = [];
  const out = (c: Cand, why: string) => reject(c.p, 'limits', why, c.score);

  // 5b events: on the board, met or not, outside the limits
  for (const c of pool.filter((x) => x.p.event)) {
    dealt.push(c);
    c.because.push('an event: on the board whatever you hold');
  }
  // 6 forced: dealt alone among the player's
  const players = pool.filter((c) => c.kind === 'player' && !c.p.event);
  const forced = players.filter((c) => c.p.forced && c.affordable);
  if (forced.length) {
    dealt.push(forced[0]);
    for (const c of players) if (c !== forced[0]) reject(c.p, 'forced', `"${forced[0].p.title}" is forced: it is dealt alone`, c.score);
  } else {
    // 7 limits (player)
    const ok = players.filter((c) => c.affordable);
    for (const c of ok) {
      if (dealt.filter((d) => d.kind === 'player' && !d.p.event).length >= T.playerMax) out(c, `the player's limit (${T.playerMax}) is full: scored ${c.score.toFixed(2)}`);
      else if (c.score < T.minScore && !c.p.towardClimax) out(c, `scored ${c.score.toFixed(2)}, under the least (${T.minScore})`);
      else dealt.push(c);
    }
    for (const c of players.filter((x) => !x.affordable)) out(c, `the player can't take it: ${c.missing.join('; ')}`);
    // 8 a way toward the climax
    const mine = dealt.filter((d) => d.kind === 'player');
    if (mine.some((d) => d.p.towardClimax)) guarantees.push('a way toward the climax: dealt');
    else {
      const way = ok.find((c) => c.p.towardClimax && !dealt.includes(c));
      if (way) {
        const drop = mine.at(-1);
        if (drop && mine.length >= T.playerMax) {
          dealt.splice(dealt.indexOf(drop), 1);
          out(drop, `swapped out for "${way.p.title}": a way toward the climax is kept`);
        }
        dealt.push(way);
        dropRejection(rejected, way.p);
        guarantees.push(`a way toward the climax: "${way.p.title}" dealt by the guarantee`);
      } else if (ok.length) guarantees.push('a way toward the climax: none proposed this turn (the GM\'s travel rule)');
    }
  }
  // 7 limits (resources)
  const res = pool.filter((c) => c.kind === 'resources' && !c.p.event);
  let shown = 0;
  for (const c of res) {
    const n = dealt.filter((d) => d.kind === 'resources' && !d.p.event).length;
    if (c.affordable) {
      if (n >= T.resourceMax) out(c, `the resource limit (${T.resourceMax}) is full: scored ${c.score.toFixed(2)}`);
      else if (c.score < T.minScore) out(c, `scored ${c.score.toFixed(2)}, under the least (${T.minScore})`);
      else dealt.push(c);
    } else if (shown < T.unaffordable && n < T.resourceMax) {
      shown++;
      dealt.push(c);
    } else out(c, `unaffordable (${c.missing.join('; ')}) and no slot for a known one (${T.unaffordable})`);
  }
  // the tier above, as a goal
  const goals: Cand[] = [];
  if (T.nextTier >= 1)
    for (const c of dealt.filter((d) => d.affordable && d.tier < d.p.tiers.length)) {
      const up = c.tier + 1;
      const miss = affords(c.p.tiers[up - 1], ctx.holdings).missing;
      goals.push({ ...c, tier: up, affordable: false, missing: miss, because: [...c.because, `the next tier (${up}), shown as a goal: ${miss.join('; ')}`] });
    }
  // 8 tied to the conflict
  const tied = (c: Cand) => c.p.hooks.some((h) => ctx.conflictHooks.includes(h));
  if (dealt.some(tied)) guarantees.push('tied to the conflict: dealt');
  else {
    const t = pool.find((c) => c.affordable && tied(c) && !dealt.includes(c));
    if (t) {
      dealt.push(t);
      dropRejection(rejected, t.p);
      guarantees.push(`tied to the conflict: "${t.p.title}" dealt by the guarantee`);
    } else guarantees.push('tied to the conflict: nothing proposed answers it this turn');
  }
  const opps = [...dealt, ...goals].map((c): Dealt => {
    const made = c.p.make(c.tier);
    const tierOffer = c.p.tiers[c.tier - 1];
    const opp: Opportunity = {
      ...made,
      id: `${c.p.template}:${c.p.offer}:${c.p.place}:t${ctx.turn}${c.affordable ? '' : `:goal${c.tier}`}`,
      requires: structuredClone(tierOffer.requires),
      costs: { ...tierOffer.costs },
      tier: c.tier,
      tiers: c.p.tiers.length,
      because: c.because,
      affordable: c.affordable,
      missing: c.missing,
    };
    return { opp, score: +c.score.toFixed(3), parts: c.parts };
  });
  return { turn: ctx.turn, dealt: opps, rejected, guarantees, ms: +(now() - t0).toFixed(2) };
}

function dropRejection(rej: Rejected[], p: Proposal): void {
  for (let i = rej.length - 1; i >= 0; i--) if (rej[i].template === p.template && rej[i].offer === p.offer && rej[i].place === p.place) rej.splice(i, 1);
}

/** the report as lines (the debug overlay's, and a test's) */
export function reportLines(r: DealReport): string[] {
  return [
    `turn ${r.turn}: ${r.dealt.length} dealt, ${r.rejected.length} not (${r.ms} ms)`,
    ...r.dealt.map((d) => `+ ${d.opp.title}${d.opp.affordable ? '' : ' (unaffordable)'} — ${d.opp.because.join('; ')}`),
    ...r.rejected.map((x) => `- ${x.title} [${x.step}] ${x.why}`),
    ...r.guarantees.map((g) => `= ${g}`),
  ];
}
