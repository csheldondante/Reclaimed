// (card-table; docs/design/CARD_TABLE.md) Bots: simple policies that each play whole runs on the Realm through the
// table's driver (table/game.ts), and a report of what happened — how a run ended, the pools over the seasons, what
// was left unspent, which synergy rules fired how often and which never, how each live event came out, which cards
// nobody took, how many decisions a season asked. Engine synergies tested in seconds, in Node. A policy only scores
// the cards on the board and says how it casts; it never reads or changes the model.
import { POOLS, total, type Pools } from '../season/ledger';
import type { Pack } from '../packs/check';
import { LEADERS, Table, TIER_RANK, type OppCard } from './game';
import { dependence, greedy, modelOf, playTurn, solve, value, type Act } from './turn-search';

export interface Policy {
  name: string;
  /** a card's worth to this bot now (higher first); null: it never takes it */
  score(c: OppCard, t: Table): number | null;
  /** how it casts: 'none'; 'events' — into live events while a cast still changes them; 'all' — that, and a growth
   *  rune on a worked field each season, and a pack's abilities on what can take them (default 'all') */
  spells?: 'none' | 'events' | 'all';
  /** Magic it keeps back from growth runes and pack abilities for the events to come (default 3) */
  keep?: number;
  /** it settles an event it is winning at once ("Settle it now"), and plays what that starts in the same season */
  settle?: boolean;
  /** (draft 10, docs/design/TURN_PUZZLE.md) it plays the whole turn — cards, uses, pieces — as the solver's best turn
   *  or the greedy turn (table/turn-search.ts), in place of scoring cards */
  turn?: 'solver' | 'greedy';
}

/** (draft 10) the two turn players: they need the works (uses and slots) to differ from a card scorer */
export const TURN_POLICIES: Policy[] = [
  { name: 'SOLVER (best turn)', score: () => null, turn: 'solver', spells: 'events' },
  { name: 'GREEDY (best next action)', score: () => null, turn: 'greedy', spells: 'events' },
];

/** (draft 10) one season's turn, measured: the search's counts, the solver's and the greedy turn's scores, whether the
 *  best turn depends on order and on placement, and any difference between the simulation and the game */
export interface TurnStat {
  turns: number;
  ends: number;
  withPieces: number;
  withUses: number;
  capped: boolean;
  solver: number;
  greedy: number;
  start: number;
  order: boolean;
  orderIllegal: boolean;
  orderWorse: boolean;
  placement: boolean;
  posts: boolean;
  /** actions in the solver's best turn */
  length: number;
  mismatch: string[];
}

const has = (c: OppCard, ...tags: string[]) => tags.some((x) => c.tags.includes(x));
const isOne = (c: OppCard, ...ids: string[]) => ids.includes(c.template);
const TRIBUTE = 'pay-raiders';

export const POLICIES: Policy[] = [
  { name: 'idle', score: () => null, spells: 'none' },
  // (takes no card: only casts into what comes — how far Magic alone carries a town)
  { name: 'spells only', score: () => null, spells: 'events' },
  {
    // (soldiers and somewhere for them to gather; stone to pay for it; the heat ray; never the tribute)
    name: 'walls and might',
    score: (c) => (isOne(c, 'build:walls', 'build:keep') ? 10 : has(c, 'war', 'raiders') && c.template !== TRIBUTE ? 8 : isOne(c, 'tower-lens') ? 7 : isOne(c, 'build:quarry', 'build:lumber', 'build:houses', 'build:workshops') ? 5 : c.threat && c.template !== TRIBUTE ? 3 : null),
  },
  {
    // (the same with no spell cast: what the soldiers and the rules do by themselves)
    name: 'walls, no spells',
    score: (c) => (isOne(c, 'build:walls', 'build:keep') ? 10 : has(c, 'war', 'raiders') && c.template !== TRIBUTE ? 8 : isOne(c, 'build:quarry', 'build:lumber', 'build:houses', 'build:workshops') ? 5 : c.threat && c.template !== TRIBUTE ? 3 : null),
    spells: 'none',
  },
  {
    // (income first, then pay the raiders off)
    name: 'economy and tribute',
    score: (c) => (isOne(c, TRIBUTE) ? 20 : has(c, 'economy', 'trade', 'stone', 'works', 'food', 'homes', 'expansion') ? 8 : isOne(c, 'guard-camp', 'house-refugees', 'resettle-refugees') ? 6 : null),
  },
  {
    // (fields, a rune on them every season, parades, the shrine and the tower; never the tribute)
    name: 'fields and festival',
    score: (c) => (isOne(c, 'build:farms', 'gate-parade') ? 10 : has(c, 'magic', 'research', 'undead', 'festival') ? 9 : isOne(c, 'fire-wards', 'feed-shrine', 'build:market', 'build:houses') ? 8 : has(c, 'food', 'refugees', 'trade') ? 6 : isOne(c, 'build:quarry') ? 5 : c.threat && c.template !== TRIBUTE ? 3 : null),
    keep: 6,
  },
  {
    // (greedy by tag: a card is worth the tags it shares with what was taken before; a threat is always worth one)
    name: 'greedy by shared tags',
    score: (c, t) => {
      const mine = new Set(t.taken.flatMap((id) => t.realm.engine.template(id).themes));
      return c.template === TRIBUTE ? null : c.tags.filter((x) => mine.has(x)).length + (c.threat ? 1 : 0) + 0.5;
    },
  },
  { name: 'answer every threat', score: (c) => (c.threat ? 10 : isOne(c, 'build:quarry', 'build:lumber', 'build:walls', 'house-refugees') ? 4 : null) },
  { name: 'everything but tribute', score: (c) => (c.template === TRIBUTE ? null : c.threat ? 2 : 1) },
  // (a pack being tried: its cards first, then anything)
  { name: 'pack cards first', score: (c) => (c.tags.some((x) => x.startsWith('pack:')) ? 10 : c.template === TRIBUTE ? null : c.threat ? 2 : 1) },
  {
    // (hunts loops: first the cards a rule waits for or asks for — what re-triggers; then live cards, whose results
    // rules can wait for; then anything. It casts into every event to win it, and keeps little Magic back)
    name: 'loop hunter',
    score: (c, t) => {
      const named = t.ruleDefs().some((r) => {
        const on = r.on as { event?: string };
        const fx = r.effect as { offer?: string; start?: string };
        return on.event === `pack-done:${c.template}` || fx.offer === c.template || fx.start === c.template;
      });
      return c.template === TRIBUTE ? null : named ? 12 : c.live ? 9 : c.threat ? 2 : 1;
    },
    keep: 2,
    // (a chain's next step this season: win, settle, the next challenger, win again — each a move)
    settle: true,
  },
  {
    // (hunts laws: a card that brings a law first, then the packs' cards, then anything; settles events it wins)
    name: 'law hunter',
    score: (c) => (c.template === TRIBUTE ? null : c.laws.brings.length ? 15 : c.tags.some((x) => x.startsWith('pack:')) ? 8 : c.threat ? 2 : 1),
    keep: 2,
    settle: true,
  },
];

export interface RunStat {
  policy: string;
  leader: string;
  seed: number;
  /** 'held', 'fell', 'paid off', 'won by law', 'no raid' (the run reached its end and no raid came) */
  end: string;
  /** the first season a threat ran out unanswered, or Unrest kept every free worker away (null: never) */
  trouble: number | null;
  curve: Pools[];
  /** the pools when the run ended */
  last: Pools;
  might: number;
  /** Magic spent on casts; free workers at a season's start, on average, and all workers at the end */
  cast: number;
  idle: number;
  labor: number;
  built: string[];
  taken: string[];
  seen: string[];
  lapsed: string[];
  asked: number[];
  took: number[];
  /** synergy rules fired: rule name → times; and every rule's name */
  rules: Record<string, number>;
  ruleNames: string[];
  /** the engine it built: the season with the most rule firings (and which), what the rules paid over the run by
   *  pool, and how many times a rule acted (offered, started, tagged: a loop's turns) */
  peak: { season: number; firings: number; rules: string[] };
  paid: Record<string, number>;
  acts: number;
  /** how each live event came out, and the casts made into it (settled now, or at the season's end) */
  events: { template: string; tier: string; cast: number; season: number; now: boolean }[];
  moves: string[];
  /** (laws) the laws in force at the end (name, times), how many came into force over the run, the run won by a law */
  laws: { name: string; times: number }[];
  lawsMade: number;
  won: string | null;
  /** the single biggest rule firing of the run */
  biggest: { rule: string; delta: number; season: number; pool: string } | null;
  /** (draft 7: templates) every title a card of each template was offered under (one per binding) */
  titles: Record<string, string[]>;
  /** the ending a card or rule named (null: none) */
  ending: string | null;
  /** (draft 7) the far places at the end, one line each: "Millbrook: sworn. sworn to you." */
  far: string[];
  /** (draft 8) the content this run unlocked for later runs (ids) */
  unlocked: string[];
  /** (loop round 16) each season's board before a card was taken: the share of its asks the pools could pay for one at
   *  a time, and whether they could pay for all of them together */
  afford: number[];
  all: boolean[];
  /** (loop round 16) each season's decision space (decisionSpace) */
  space: Space[];
  /** (draft 10) each season's whole turn, measured (when asked for) */
  turn: TurnStat[];
}

/**
 * (loop round 16) A season's board as a decision. `n` cards offered (the raiders' tribute counted: paying it is a
 * choice); `k` the most of them the pools can pay for together, and `subsets` how many different sets of them can be
 * paid for together (the empty one not counted) — the size of the choice; `delayed` cards that cost now and pay in a
 * later season (more than one season's work, or an income each season); `converts` cards that spend one pool to give
 * another; `where` cards standing at a town site that a rule of place (`near`) reads; `threat` a standing threat with
 * its countdown on the board, and `answers` the cards offered that meet it (the tribute, or a card tagged war or
 * raiders).
 */
export interface Space {
  n: number;
  k: number;
  subsets: number;
  delayed: number;
  converts: number;
  where: number;
  threat: boolean;
  answers: number;
}
const POOL_WORDS: Record<string, RegExp> = { magic: /Magic/, might: /Might/, labor: /Labor|workers/i, materials: /Materials/, intel: /Intel/, unrest: /Unrest/ };
function decisionSpace(t: Table, board: OppCard[]): Space {
  const have = Object.fromEntries(t.poolViews().map((x) => [x.pool, x.have])) as Record<string, number>;
  const cost = board.map((c) => {
    const m: Record<string, number> = {};
    for (const part of [c.locks, c.costs]) for (const [k, n] of Object.entries(part)) m[k] = (m[k] ?? 0) + (n ?? 0);
    return m;
  });
  const n = Math.min(board.length, 14);
  let k = 0;
  let subsets = 0;
  for (let mask = 1; mask < 1 << n; mask++) {
    const sum: Record<string, number> = {};
    let size = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) (size++, Object.entries(cost[i]).forEach(([p, v]) => (sum[p] = (sum[p] ?? 0) + v)));
    if (Object.entries(sum).every(([p, v]) => (have[p] ?? 0) >= v)) {
      subsets++;
      k = Math.max(k, size);
    }
  }
  const nearTags = new Set(t.ruleDefs().flatMap((r) => [r.a, r.b].filter((q) => !!q?.near).flatMap((q) => q!.tags)));
  const sites = new Set(t.things().filter((x) => x.tags.some((g) => nearTags.has(g))).map((x) => x.name));
  const threat = board.some((c) => c.threat && c.template === TRIBUTE) || t.realm.standingThreat() !== null;
  return {
    n: board.length,
    k,
    subsets,
    delayed: board.filter((c) => c.turns > 1 || /each season|every season/i.test(c.gives)).length,
    converts: board.filter((c) => {
      const spends = Object.keys(cost[board.indexOf(c)]);
      return Object.entries(POOL_WORDS).some(([p, re]) => !spends.includes(p) && re.test(c.gives)) && spends.length > 0;
    }).length,
    where: board.filter((c) => sites.has(c.place)).length,
    threat,
    answers: board.filter((c) => c.template === TRIBUTE || c.tags.includes('war') || c.tags.includes('raiders')).length,
  };
}

/** the bot's settling: each event it is winning, settled now; what that starts, cast into and settled too, while it
 *  wins (a bot's guard of 30 settles a season, not a rule of the game) */
function settleSeason(p: Policy, t: Table): void {
  if (!p.settle) return;
  for (let guard = 0; guard < 30 && !t.over; guard++) {
    castSeason({ ...p, spells: 'events' }, t);
    const e = t.liveEvents().find((x) => x.template !== 'raid' && TIER_RANK.indexOf(x.tier) >= TIER_RANK.indexOf('success'));
    if (!e || !t.resolveNow(e.id)) break;
  }
}

/** the bot's casts for the season: into live events while a cast still changes them and the result is not yet the
 *  best; then (spells 'all') a growth rune on a worked field and a pack's abilities, keeping some Magic back */
function castSeason(p: Policy, t: Table): void {
  const mode = p.spells ?? 'all';
  if (mode === 'none') return;
  for (const e of t.liveEvents()) {
    for (let guard = 0; guard < 40; guard++) {
      const now = t.liveEvents().find((x) => x.id === e.id);
      if (!now || TIER_RANK.indexOf(now.tier) >= TIER_RANK.indexOf('success')) break;
      const a = t.abilities().find((x) => x.can && x.targets.includes(e.id) && t.useful(x.id, e.id));
      if (!a || !t.cast(a.id, e.id)) break;
    }
  }
  if (mode !== 'all') return;
  const magic = () => t.poolViews().find((x) => x.pool === 'magic')!.have;
  const keep = p.keep ?? 3;
  for (const a of t.abilities()) {
    if (a.id.startsWith('spell:') && a.id !== 'spell:growth') continue;
    const things = t.things();
    const target = a.targets.map((id) => things.find((x) => x.id === id)).find((x) => !!x && (a.id !== 'spell:growth' || x.tags.includes('worked')));
    if (target && a.can && magic() - a.cost >= keep) t.cast(a.id, target.id);
  }
}

/** the engine a run built, read from its rule firings (upkeep and other costs are firings too: `paid` is net) */
function engineOf(t: Table): Pick<RunStat, 'peak' | 'paid' | 'acts'> {
  const bySeason = new Map<number, string[]>();
  const paid: Record<string, number> = {};
  let acts = 0;
  for (const { season, hit } of t.hits) {
    bySeason.set(season, [...(bySeason.get(season) ?? []), hit.name]);
    if (hit.pool) paid[hit.pool] = (paid[hit.pool] ?? 0) + hit.delta;
    if (hit.act) acts++;
  }
  const best = [...bySeason].sort((a, b) => b[1].length - a[1].length || a[0] - b[0])[0];
  return { peak: best ? { season: best[0], firings: best[1].length, rules: best[1] } : { season: 0, firings: 0, rules: [] }, paid, acts };
}

/** one whole run by a policy */
export function playRun(p: Policy, o: { seed: number; leader: string; seasons: number; packs?: Pack[]; raiders?: number; works?: boolean; measure?: boolean }): RunStat {
  const t = new Table(o);
  const turn: TurnStat[] = [];
  let trouble: number | null = null;
  const idle: number[] = [];
  const titles: Record<string, Set<string>> = {};
  const note = (): void => void t.cards().forEach((c) => (titles[c.template] ??= new Set()).add(c.title));
  const afford: number[] = [];
  const all: boolean[] = [];
  const space: Space[] = [];
  while (!t.over) {
    idle.push(t.poolViews().find((x) => x.pool === 'labor')!.have);
    note();
    // (loop round 16, scarcity: the season's board before anything is taken — the share of its asks (not the raiders'
    // tribute, not a card that starts by itself) the pools could pay for one at a time, and whether they could pay for
    // every one together)
    const board = t.cards();
    const asks = board.filter((c) => c.template !== TRIBUTE);
    if (asks.length) {
      afford.push(asks.filter((c) => !Object.keys(c.short).length).length / asks.length);
      const have = Object.fromEntries(t.poolViews().map((x) => [x.pool, x.have])) as Record<string, number>;
      const need: Record<string, number> = {};
      for (const c of asks) for (const part of [c.locks, c.costs]) for (const [k, n] of Object.entries(part)) need[k] = (need[k] ?? 0) + (n ?? 0);
      all.push(Object.entries(need).every(([k, n]) => (have[k] ?? 0) >= n));
    }
    // (loop round 16, the owner on Faeria: "resources constrain you to an n choose k that is fairly large but not
    // overwhelmingly so and where you have lots of choices that interact" — the season's decision space, measured)
    space.push(decisionSpace(t, board));
    // (draft 10: the whole turn searched — every legal turn, the best, the greedy one, order and placement)
    let planned: Act[] | null = null;
    if (p.turn || o.measure) {
      const m = modelOf(t);
      const sr = solve(m);
      const g = greedy(m);
      const dep = dependence(m, sr.best, sr.value);
      planned = p.turn === 'solver' ? sr.best : p.turn === 'greedy' ? g.seq : null;
      const mismatch = planned ? playTurn(t, m, planned) : [];
      turn.push({ turns: sr.turns, ends: sr.ends, withPieces: sr.withPieces, withUses: sr.withUses, capped: sr.capped, solver: sr.value, greedy: g.value, start: value(m, m.start), order: dep.order, orderIllegal: dep.orderIllegal, orderWorse: dep.orderWorse, placement: dep.placement, posts: dep.posts, length: sr.best.length, mismatch });
    }
    // (the board changes as cards are taken: scored again after each)
    for (; !planned; ) {
      const best = t
        .cards()
        .filter((c) => !Object.keys(c.short).length)
        .map((c) => ({ c, s: p.score(c, t) }))
        .filter((x): x is { c: OppCard; s: number } => x.s !== null)
        .sort((a, b) => b.s - a.s || (a.c.template < b.c.template ? -1 : 1))[0];
      if (!best || !t.take(best.c.id)) break;
    }
    castSeason(p, t);
    settleSeason(p, t);
    if (t.over) break;
    const lapsed = t.lapsed.length;
    const season = t.season;
    t.endSeason();
    const pv = t.poolViews();
    const labor = pv.find((x) => x.pool === 'labor')!;
    const unrest = pv.find((x) => x.pool === 'unrest')!.have;
    if (trouble === null && (t.lapsed.length > lapsed || (unrest > 0 && labor.have === 0 && unrest >= (labor.of ?? 0)))) trouble = season;
  }
  const r = t.realm;
  const last = Object.fromEntries(t.poolViews().map((x) => [x.pool, x.have])) as Pools;
  const won = r.won();
  const big = t.hits.filter((h) => !!h.hit.pool).sort((a, b) => b.hit.delta - a.hit.delta)[0];
  return {
    policy: p.name,
    leader: o.leader,
    seed: o.seed,
    // (an ending card or rule: a loss counts as fell, any other ending as a win by law or card)
    // (the raid is a card: a run that reached its last season says how the raiders' card ended — paid, held, broke in —
    // or that no raid came at all)
    end: r.ended && r.ended.result !== 'stood' ? (r.ended.result === 'fell' ? 'fell' : 'won by law') : won ? 'won by law' : r.history().some((e) => e.kind === 'tribute-paid') ? 'paid off' : r.fight ? (r.fight.held ? 'held' : 'fell') : 'no raid',
    laws: t.laws().reduce((a, l) => {
      const x = a.find((y) => y.name === l.name);
      if (x) x.times += l.times;
      else a.push({ name: l.name, times: l.times });
      return a;
    }, [] as { name: string; times: number }[]),
    lawsMade: r.history().filter((e) => e.kind === 'law-made').length,
    won: won?.law ?? null,
    biggest: big ? { rule: big.hit.name, delta: big.hit.delta, season: big.season, pool: big.hit.pool! } : null,
    trouble,
    curve: t.curve,
    last,
    might: total(r.ledger, 'might'),
    cast: t.spent,
    idle: idle.reduce((a, b) => a + b, 0) / Math.max(1, idle.length),
    labor: total(r.ledger, 'labor'),
    built: t.built(),
    taken: t.taken,
    seen: [...t.seen],
    lapsed: t.lapsed,
    asked: t.asked,
    took: t.took,
    rules: t.ruleCounts(),
    ...engineOf(t),
    ruleNames: t.ruleDefs().map((x) => x.name),
    events: t.events.map((e) => ({ template: e.template, tier: e.tier, cast: e.cast, season: e.season, now: e.now })),
    moves: t.moves,
    titles: Object.fromEntries(Object.entries(titles).map(([k, v]) => [k, [...v]])),
    ending: r.ended && r.ended.result !== 'stood' ? r.ended.name : null,
    far: t.farNews().places.map((x) => `${x.name}: ${x.line}`),
    unlocked: t.opened().filter((x) => x.turn > r.w.turn - r.season).map((x) => x.id),
    afford,
    all,
    space,
    turn,
  };
}

export interface BotReport {
  runs: RunStat[];
  /** the report as lines of plain text */
  text: string;
}

const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pad = (s: string | number, n: number): string => String(s).padEnd(n);

/** every policy plays every leader on each seed; the table of what happened */
export function runBots(o: { seeds: number[]; seasons: number; policies?: Policy[]; leaders?: string[]; templates: string[]; packs?: Pack[]; raiders?: number; works?: boolean; measure?: boolean }): BotReport {
  // (draft 10: with the works, the solver and the greedy turn player play too)
  const policies = (o.policies ?? [...POLICIES, ...(o.works ? TURN_POLICIES : [])]).filter((p) => p.name !== 'pack cards first' || !!o.packs?.length);
  const leaders = o.leaders ?? LEADERS.map((l) => l.id);
  const runs: RunStat[] = [];
  for (const p of policies) for (const leader of leaders) for (const seed of o.seeds) runs.push(playRun(p, { seed, leader, seasons: o.seasons, ...(o.packs ? { packs: o.packs } : {}), ...(o.raiders !== undefined ? { raiders: o.raiders } : {}), ...(o.works ? { works: true } : {}), ...(o.measure ? { measure: true } : {}) }));
  const L: string[] = [];
  if (o.works) L.push('The works are on (season/works.ts, draft 10): things with slots for crews and soldiers and instant uses; a board of 5, two needs at once.');
  if (o.raiders !== undefined) L.push(`Raiders in the last season: ${o.raiders}`);
  if (o.packs?.length) L.push(`Packs in play: ${o.packs.map((x) => x.pack.name).join(', ')}`);
  L.push(`Bots: ${policies.length} policies x ${leaders.length} leaders x ${o.seeds.length} seeds = ${runs.length} runs of ${o.seasons} seasons`);
  L.push('');
  L.push(`${pad('policy', 24)}${pad('held', 5)}${pad('paid', 5)}${pad('fell', 5)}${pad('won', 4)}${pad('none', 5)}${pad('trouble', 8)}${pad('asked', 6)}${pad('took', 5)}${pad('built', 6)}${pad('cast', 6)}${pad('idle', 9)}left at the end: Magic Might Labor Materials Intel Unrest`);
  for (const p of policies) {
    const mine = runs.filter((r) => r.policy === p.name);
    const n = (e: string) => mine.filter((r) => r.end === e).length;
    const tr = mine.filter((r) => r.trouble !== null).map((r) => r.trouble!);
    const last = POOLS.map((k) => mean(mine.map((r) => r.last[k])).toFixed(0)).join(' ');
    L.push(`${pad(p.name, 24)}${pad(n('held'), 5)}${pad(n('paid off'), 5)}${pad(n('fell'), 5)}${pad(n('won by law'), 4)}${pad(n('no raid'), 5)}${pad(tr.length ? `S${mean(tr).toFixed(1)}` : 'never', 8)}${pad(mean(mine.flatMap((r) => r.asked)).toFixed(1), 6)}${pad(mean(mine.flatMap((r) => r.took)).toFixed(1), 5)}${pad(mean(mine.map((r) => r.built.length)).toFixed(1), 6)}${pad(mean(mine.map((r) => r.cast)).toFixed(1), 6)}${pad(`${mean(mine.map((r) => r.idle)).toFixed(1)}/${mean(mine.map((r) => r.labor)).toFixed(0)}`, 9)}${last}`);
  }
  L.push('');
  L.push('"trouble": mean first season a threat ran out or Unrest kept every worker away. "asked", "took": cards on the board and taken, a season. "cast": Magic spent on spells. "idle": free workers at a season\'s start / workers at the end. "left": free pools when the run ended.');
  L.push('');
  // (loop round 16: scarcity and synergy at the moment of choice — the owner could pay for every card and saw few rules
  // fire; the aim is about half of what is asked affordable, with rules firing in most runs)
  const fired = (r: RunStat) => Object.values(r.rules).reduce((a, b) => a + b, 0);
  const pct = (x: number) => `${(100 * x).toFixed(0)}%`;
  const allRuns = { afford: mean(runs.flatMap((r) => r.afford)), all: mean(runs.flatMap((r) => r.all.map((x) => (x ? 1 : 0)))), fired: mean(runs.map(fired)), any: runs.filter((r) => fired(r) > 0).length };
  L.push(`Scarcity: asks affordable one at a time ${pct(allRuns.afford)} of a board; every ask affordable together in ${pct(allRuns.all)} of seasons. Synergy: ${allRuns.fired.toFixed(1)} rule firings a run; a rule fired in ${allRuns.any} of ${runs.length} runs.`);
  for (const p of policies) {
    const mine = runs.filter((r) => r.policy === p.name);
    L.push(`  ${pad(p.name, 24)}affordable ${pad(pct(mean(mine.flatMap((r) => r.afford))), 5)} all ${pad(pct(mean(mine.flatMap((r) => r.all.map((x) => (x ? 1 : 0))))), 5)} firings a run ${mean(mine.map(fired)).toFixed(1)}`);
  }
  L.push('');
  // (loop round 16: the season's decision space, over every season of every run — see `Space`)
  const sp = runs.flatMap((r) => r.space);
  const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
  const th = sp.filter((s) => s.threat);
  L.push(`Decision space a season (${sp.length} seasons): offered n ${mean(sp.map((s) => s.n)).toFixed(1)}; most affordable together k ${mean(sp.map((s) => s.k)).toFixed(1)}; affordable sets ${mean(sp.map((s) => s.subsets)).toFixed(1)} mean, ${med(sp.map((s) => s.subsets))} median; no decision (all affordable together) ${pct(mean(sp.map((s) => (s.n > 0 && s.k === s.n ? 1 : 0))))}; delayed return ${mean(sp.map((s) => s.delayed)).toFixed(1)}; converts a pool ${mean(sp.map((s) => s.converts)).toFixed(1)}; worth depends on where ${mean(sp.map((s) => s.where)).toFixed(1)}; a standing threat with its countdown ${pct(th.length / Math.max(1, sp.length))} of seasons, an offered card meets it in ${pct(th.filter((s) => s.answers > 0).length / Math.max(1, th.length))} of those.`);
  L.push('');
  // (draft 10, docs/design/TURN_PUZZLE.md: the whole turn as a puzzle — table/turn-search.ts)
  const ts = runs.flatMap((r) => r.turn);
  if (ts.length) {
    const medN = (a: number[]) => med(a);
    const q = (a: number[], f: number) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(f * (a.length - 1))] : 0);
    const gap = ts.map((s) => s.solver - s.greedy);
    const better = ts.filter((s) => s.solver > s.greedy + 1e-9).length;
    const mis = runs.flatMap((r) => r.turn.flatMap((s) => s.mismatch.map((x) => `${r.policy}/${r.leader}: ${x}`)));
    L.push(`The whole turn (${ts.length} seasons searched; cards, uses, posts and recalls, in any order):`);
    L.push(`  distinct legal turns a season: median ${medN(ts.map((s) => s.turns))} (quartiles ${q(ts.map((s) => s.turns), 0.25)} to ${q(ts.map((s) => s.turns), 0.75)}, most ${Math.max(...ts.map((s) => s.turns))}); distinct end positions median ${medN(ts.map((s) => s.ends))}; ${ts.filter((s) => s.capped).length} searches stopped at the node budget`);
    L.push(`  of a season's turns, median share that post or recall a piece ${pct(medN(ts.map((s) => s.withPieces / Math.max(1, s.turns))))}, that make a use ${pct(medN(ts.map((s) => s.withUses / Math.max(1, s.turns))))}`);
    L.push(`  the solver's turn beats the greedy turn in ${better} of ${ts.length} seasons (${pct(better / ts.length)}); by ${mean(gap).toFixed(2)} points on average (${(mean(ts.map((s) => s.greedy - s.start)) > 0 ? (100 * mean(gap)) / mean(ts.map((s) => s.greedy - s.start)) : 0).toFixed(0)}% of what the greedy turn gains), most ${Math.max(...gap).toFixed(1)}`);
    L.push(`  the best turn depends on ORDER in ${pct(ts.filter((s) => s.order).length / ts.length)} of seasons (another order of its actions is not legal ${pct(ts.filter((s) => s.orderIllegal).length / ts.length)}, ends worse ${pct(ts.filter((s) => s.orderWorse).length / ts.length)}); it posts a piece in ${pct(ts.filter((s) => s.posts).length / ts.length)}, and PLACEMENT matters (the piece elsewhere ends worse) in ${pct(ts.filter((s) => s.placement).length / ts.length)}; actions in the best turn: median ${medN(ts.map((s) => s.length))}`);
    L.push(`  the simulation against the game: ${mis.length ? `${mis.length} differences — ${mis.slice(0, 5).join('; ')}` : 'no difference in any turn played'}`);
    L.push('');
  }
  L.push('Pool curves (mean over a policy\'s runs; seasons 1, a quarter, half, three quarters, last):');
  for (const p of policies) {
    const mine = runs.filter((r) => r.policy === p.name);
    const len = Math.min(...mine.map((r) => r.curve.length));
    const at = [0, Math.floor(len / 4), Math.floor(len / 2), Math.floor((3 * len) / 4), len - 1];
    L.push(`  ${pad(p.name, 24)}${(['materials', 'magic', 'might', 'labor', 'unrest'] as const).map((k) => `${k} ${at.map((i) => mean(mine.map((r) => r.curve[i][k])).toFixed(0)).join('>')}`).join('   ')}`);
  }
  L.push('');
  const names = [...new Set(runs.flatMap((r) => r.ruleNames))];
  L.push(`Synergy rules fired (times over a policy's ${leaders.length * o.seeds.length} runs):`);
  for (const k of names) {
    const by = policies.map((p) => [p.name, runs.filter((r) => r.policy === p.name).reduce((a, r) => a + (r.rules[k] ?? 0), 0)] as const).filter(([, v]) => v > 0);
    L.push(`  ${pad(k, 28)}${by.length ? by.map(([p, v]) => `${p} ${v}`).join(', ') : 'NEVER'}`);
  }
  L.push('');
  L.push('Biggest engine of each policy (its run with the most rule firings in one season; what the rules paid over that run, net of upkeep; "acts": times a rule offered, started or tagged — a loop\'s turns):');
  for (const p of policies) {
    const best = runs.filter((r) => r.policy === p.name).sort((a, b) => b.peak.firings - a.peak.firings || b.acts - a.acts)[0];
    if (!best || !best.peak.firings) continue;
    const counts = new Map<string, number>();
    for (const x of best.peak.rules) counts.set(x, (counts.get(x) ?? 0) + 1);
    L.push(`  ${pad(p.name, 24)}${best.leader}, S${best.peak.season}: ${best.peak.firings} firings (${[...counts].map(([k, v]) => (v > 1 ? `${k} x${v}` : k)).join(', ')}); paid ${Object.entries(best.paid).map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`).join(', ') || 'nothing'}; acts ${best.acts}; ${best.end}`);
  }
  L.push('');
  L.push('Biggest single firing of each policy (one rule, one trigger):');
  for (const p of policies) {
    const best = runs.filter((r) => r.policy === p.name && r.biggest).sort((a, b) => b.biggest!.delta - a.biggest!.delta)[0];
    if (best) L.push(`  ${pad(p.name, 24)}${best.biggest!.rule}: ${best.biggest!.pool} ${best.biggest!.delta > 0 ? '+' : ''}${best.biggest!.delta} (${best.leader}, S${best.biggest!.season})`);
  }
  L.push('');
  // (laws: how many came into force, which stood at the end, runs won by a law)
  const lawRuns = runs.filter((r) => r.lawsMade > 0);
  L.push(`Laws: made in ${lawRuns.length} of ${runs.length} runs; ${runs.filter((r) => r.won).length} runs won by a law.`);
  for (const p of policies) {
    const mine = runs.filter((r) => r.policy === p.name && r.lawsMade > 0);
    if (!mine.length) continue;
    const at = new Map<string, number>();
    for (const r of mine) for (const l of r.laws) at.set(l.name, (at.get(l.name) ?? 0) + l.times);
    const won = mine.filter((r) => r.won).map((r) => `${r.leader} by ${r.won}`);
    L.push(`  ${pad(p.name, 24)}made ${mean(mine.map((r) => r.lawsMade)).toFixed(1)} a run; at the end: ${[...at].map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}${won.length ? `; won: ${won.join(', ')}` : ''}`);
  }
  L.push('');
  // (loops: an event that came 3 or more times in one run, its casts turn by turn — a cost that does not rise while
  // the pay stays is a loop that may be strictly better than leaving it)
  L.push('Loops (live events 3 or more times in one run): casts a turn, mean, turn 1, 2, 3, …; settled now / at the season\'s end:');
  const loops = new Map<string, { casts: number[][]; now: number; end: number; won: number; of: number }>();
  for (const r of runs) {
    const by = new Map<string, RunStat['events']>();
    for (const e of r.events) by.set(e.template, [...(by.get(e.template) ?? []), e]);
    for (const [k, list] of by) {
      if (list.length < 3) continue;
      const x = loops.get(k) ?? { casts: [], now: 0, end: 0, won: 0, of: 0 };
      list.forEach((e, i) => ((x.casts[i] ??= []).push(e.cast), e.now ? x.now++ : x.end++, TIER_RANK.indexOf(e.tier) >= TIER_RANK.indexOf('success') && x.won++, x.of++));
      loops.set(k, x);
    }
  }
  if (!loops.size) L.push('  none');
  for (const [k, x] of loops) {
    const series = x.casts.slice(0, 8).map((c) => mean(c).toFixed(1));
    const rising = x.casts.length > 1 && mean(x.casts[Math.min(3, x.casts.length - 1)]) > mean(x.casts[0]);
    // (an event nobody casts into — a parade the player pays for as a card — is no loop of casts)
    const free = x.casts.every((c) => mean(c) === 0);
    L.push(`  ${pad(k, 28)}${series.join(', ')}; ${x.now} / ${x.end}; won ${x.won} of ${x.of}${free ? '  (no casts: its cost is the card\'s)' : rising ? '' : '  <- cost does not rise: look for a strictly better choice'}`);
  }
  L.push('');
  L.push('Live events (how they came out, over all runs):');
  const ev = new Map<string, Map<string, number>>();
  for (const r of runs) for (const e of r.events) ev.set(e.template, new Map([...(ev.get(e.template) ?? []), [e.tier, (ev.get(e.template)?.get(e.tier) ?? 0) + 1]]));
  if (!ev.size) L.push('  none');
  for (const [k, by] of ev) L.push(`  ${pad(k, 28)}${[...by].sort((a, b) => TIER_RANK.indexOf(b[0]) - TIER_RANK.indexOf(a[0])).map(([t, v]) => `${t} ${v}`).join(', ')}`);
  L.push('');
  const taken = new Map<string, number>();
  for (const r of runs) for (const x of new Set(r.taken)) taken.set(x, (taken.get(x) ?? 0) + 1);
  const seen = new Set(runs.flatMap((r) => r.seen));
  const active = runs.filter((r) => r.taken.length).length;
  L.push(`Cards taken in the most runs (of ${active} that took any): ${[...taken].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  // (an event that begins by itself — the raid, refugees on the road — is neither offered nor taken)
  const began = new Set(runs.flatMap((r) => r.events.map((e) => e.template)));
  L.push(`Cards never taken by any bot: ${[...seen].filter((x) => !taken.has(x) && !began.has(x)).sort().join(', ') || 'none'}`);
  L.push(`Cards never on a board: ${o.templates.filter((x) => !seen.has(x) && !began.has(x)).sort().join(', ') || 'none'}`);
  const lapsed = new Map<string, number>();
  for (const r of runs) for (const x of r.lapsed) lapsed.set(x, (lapsed.get(x) ?? 0) + 1);
  L.push(`Threats that ran out (times): ${[...lapsed].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  // (draft 7: each pack card — runs it was on a board, runs it was taken, and the distinct cards its template made:
  // one per binding; the endings named; the far places at the end)
  if (o.packs?.length) {
    L.push('');
    L.push('Pack cards (runs on a board / runs taken / distinct cards the template made, over all runs):');
    for (const c of o.packs.flatMap((p) => p.cards ?? [])) {
      const on = runs.filter((r) => r.seen.includes(c.id) || r.events.some((e) => e.template === c.id)).length;
      const tk = runs.filter((r) => r.taken.includes(c.id) || r.events.some((e) => e.template === c.id)).length;
      const ts = [...new Set(runs.flatMap((r) => r.titles[c.id] ?? []))];
      L.push(`  ${pad(c.id, 28)}${pad(`${on} / ${tk}`, 9)}${ts.length}${ts.length > 1 ? `: ${ts.join('; ')}` : ''}`);
    }
    const ends = new Map<string, number>();
    for (const r of runs) if (r.ending) ends.set(r.ending, (ends.get(r.ending) ?? 0) + 1);
    L.push(`Endings named by a card or rule: ${[...ends].map(([k, v]) => `${k} ${v}`).join(', ') || 'none'} (of ${runs.length} runs)`);
    const far = new Map<string, number>();
    for (const r of runs) for (const x of r.far) far.set(x, (far.get(x) ?? 0) + 1);
    L.push('Far places at the end of a run (runs):');
    for (const [k, v] of [...far].sort((a, b) => b[1] - a[1]).slice(0, 14)) L.push(`  ${v}  ${k}`);
    // (draft 8: unlocks — how many a run earns, what no bot unlocked, and what nothing in the packs can unlock)
    const locked = o.packs.flatMap((p) => [...(p.pack.locked ? [`pack:${p.pack.id}`] : []), ...[...(p.cards ?? []), ...(p.leaders ?? [])].filter((x) => x.locked).map((x) => x.id)]);
    const named = JSON.stringify(o.packs);
    const never = locked.filter((id) => !named.includes(`"unlock":"${id}"`));
    const got = new Map<string, number>();
    for (const r of runs) for (const x of r.unlocked) got.set(x, (got.get(x) ?? 0) + 1);
    L.push(`Unlocks: ${mean(runs.map((r) => r.unlocked.length)).toFixed(1)} a run (${runs.filter((r) => r.unlocked.length).length} of ${runs.length} runs unlocked something); by content: ${[...got].map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
    L.push(`Locked content no bot unlocked: ${locked.filter((x) => !got.has(x)).join(', ') || 'none'}. Nothing in the packs can unlock: ${never.join(', ') || 'none'}`);
  }
  const same = policies.filter((p) => new Set(runs.filter((r) => r.policy === p.name).map((r) => `${r.leader}:${r.moves.join('|')}`)).size === leaders.length);
  if (o.seeds.length > 1 && same.length === policies.length) L.push('Note: every seed gave the same run for a policy and leader. The seed only names the people (BACKLOG CT-3).');
  return { runs, text: L.join('\n') };
}
