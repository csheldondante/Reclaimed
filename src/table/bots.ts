// (card-table; docs/design/CARD_TABLE.md) Bots: simple policies that each play whole runs on the Realm through the
// table's driver (table/game.ts), and a report of what happened — how a run ended, the pools over the seasons, which
// synergy rules fired how often, which cards nobody took, how many decisions a season asked. Engine synergies tested
// in seconds, in Node. A policy only scores the cards on the board; it never reads or changes the model.
import { POOLS, total, type Pools } from '../season/ledger';
import { LEADERS, Table, type OppCard } from './game';

export interface Policy {
  name: string;
  /** a card's worth to this bot now (higher first); null: it never takes it */
  score(c: OppCard, t: Table): number | null;
  /** (step c on) abilities it casts before ending a season */
  cast?(t: Table): void;
}

const has = (c: OppCard, ...tags: string[]) => tags.some((x) => c.tags.includes(x));
const isOne = (c: OppCard, ...ids: string[]) => ids.includes(c.template);
/** a fixed order of preference: the first listed is worth most; anything else is left */
const order = (ids: string[]) => (c: OppCard) => (ids.includes(c.template) ? ids.length - ids.indexOf(c.template) : null);

export const POLICIES: Policy[] = [
  { name: 'idle', score: () => null },
  {
    // (soldiers and somewhere for them to gather; stone to pay for it; the heat ray)
    name: 'walls and might',
    score: (c) => (isOne(c, 'build:walls', 'build:keep') ? 10 : has(c, 'war', 'raiders') && c.template !== 'pay-raiders' ? 8 : isOne(c, 'tower-lens') ? 7 : isOne(c, 'build:quarry', 'build:lumber', 'build:houses', 'build:workshops') ? 5 : c.threat && c.template !== 'pay-raiders' ? 3 : null),
  },
  {
    // (income first, then pay the raiders off)
    name: 'growth and economy',
    score: (c) => (isOne(c, 'pay-raiders') ? 20 : has(c, 'economy', 'trade', 'stone', 'works', 'food', 'homes', 'expansion') ? 8 : isOne(c, 'guard-camp', 'house-refugees') ? 6 : null),
  },
  {
    // (Magic and what it answers; the calm town a festival needs)
    name: 'festival and magic',
    score: (c) => (has(c, 'magic', 'research', 'undead') ? 10 : isOne(c, 'fire-wards', 'feed-shrine') ? 9 : has(c, 'food', 'refugees', 'trade') ? 6 : isOne(c, 'build:quarry', 'build:houses', 'pay-raiders') ? 5 : null),
  },
  {
    // (greedy by tag: a card is worth the tags it shares with what was taken before; a threat is always worth one)
    name: 'greedy by shared tags',
    score: (c, t) => {
      const mine = new Set(t.taken.flatMap((id) => t.realm.engine.template(id).themes));
      return c.tags.filter((x) => mine.has(x)).length + (c.threat ? 1 : 0) + 0.5;
    },
  },
  { name: 'answer every threat', score: (c) => (c.threat ? 10 : isOne(c, 'build:quarry', 'build:lumber', 'build:walls', 'house-refugees') ? 4 : null) },
  { name: 'everything', score: (c) => (c.threat ? 2 : 1) },
  { name: 'trade and tribute', score: order(['pay-raiders', 'build:quarry', 'build:lumber', 'mining-outpost', 'build:houses', 'build:market', 'build:trade', 'guard-camp', 'build:farms']) },
];

export interface RunStat {
  policy: string;
  leader: string;
  seed: number;
  /** 'held', 'fell', 'paid off' */
  end: string;
  /** the first season a threat ran out unanswered, or Unrest kept every free worker away (null: never) */
  trouble: number | null;
  curve: Pools[];
  might: number;
  built: string[];
  taken: string[];
  seen: string[];
  lapsed: string[];
  asked: number[];
  took: number[];
  /** synergy rules fired: rule name → times */
  rules: Record<string, number>;
  moves: string[];
}

/** one whole run by a policy */
export function playRun(p: Policy, o: { seed: number; leader: string; seasons: number }): RunStat {
  const t = new Table(o);
  let trouble: number | null = null;
  while (!t.over) {
    // (the board changes as cards are taken: scored again after each)
    for (;;) {
      const best = t
        .cards()
        .filter((c) => !Object.keys(c.short).length)
        .map((c) => ({ c, s: p.score(c, t) }))
        .filter((x): x is { c: OppCard; s: number } => x.s !== null)
        .sort((a, b) => b.s - a.s || (a.c.template < b.c.template ? -1 : 1))[0];
      if (!best || !t.take(best.c.id)) break;
    }
    p.cast?.(t);
    const lapsed = t.lapsed.length;
    const season = t.season;
    t.endSeason();
    const pv = t.poolViews();
    const labor = pv.find((x) => x.pool === 'labor')!;
    const unrest = pv.find((x) => x.pool === 'unrest')!.have;
    if (trouble === null && (t.lapsed.length > lapsed || (unrest > 0 && labor.have === 0 && unrest >= (labor.of ?? 0)))) trouble = season;
  }
  const r = t.realm;
  return {
    policy: p.name,
    leader: o.leader,
    seed: o.seed,
    end: r.averted ? 'paid off' : r.fight?.held ? 'held' : 'fell',
    trouble,
    curve: t.curve,
    might: total(r.ledger, 'might'),
    built: t.built(),
    taken: t.taken,
    seen: [...t.seen],
    lapsed: t.lapsed,
    asked: t.asked,
    took: t.took,
    rules: t.ruleCounts(),
    moves: t.moves,
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
export function runBots(o: { seeds: number[]; seasons: number; policies?: Policy[]; leaders?: string[]; templates: string[] }): BotReport {
  const policies = o.policies ?? POLICIES;
  const leaders = o.leaders ?? LEADERS.map((l) => l.id);
  const runs: RunStat[] = [];
  for (const p of policies) for (const leader of leaders) for (const seed of o.seeds) runs.push(playRun(p, { seed, leader, seasons: o.seasons }));
  const L: string[] = [];
  L.push(`Bots: ${policies.length} policies x ${leaders.length} leaders x ${o.seeds.length} seeds = ${runs.length} runs of ${o.seasons} seasons`);
  L.push('');
  L.push(`${pad('policy', 24)}${pad('held', 6)}${pad('paid', 6)}${pad('fell', 6)}${pad('trouble', 9)}${pad('asked', 7)}${pad('took', 6)}${pad('Might', 7)}${pad('built', 7)}pools at the end (Magic Might Labor Materials Intel Unrest)`);
  for (const p of policies) {
    const mine = runs.filter((r) => r.policy === p.name);
    const n = (e: string) => mine.filter((r) => r.end === e).length;
    const tr = mine.filter((r) => r.trouble !== null).map((r) => r.trouble!);
    const last = POOLS.map((k) => mean(mine.map((r) => r.curve[r.curve.length - 1][k])).toFixed(1)).join(' ');
    L.push(`${pad(p.name, 24)}${pad(n('held'), 6)}${pad(n('paid off'), 6)}${pad(n('fell'), 6)}${pad(tr.length ? `S${mean(tr).toFixed(1)}` : 'never', 9)}${pad(mean(mine.flatMap((r) => r.asked)).toFixed(1), 7)}${pad(mean(mine.flatMap((r) => r.took)).toFixed(1), 6)}${pad(mean(mine.map((r) => r.might)).toFixed(1), 7)}${pad(mean(mine.map((r) => r.built.length)).toFixed(1), 7)}${last}`);
  }
  L.push('');
  L.push('"trouble": the mean first season a threat ran out unanswered or Unrest kept every worker away. "asked", "took": cards on the board and cards taken, a season.');
  L.push('');
  L.push('Pool curves (mean over a policy\'s runs; seasons 1, a quarter, half, three quarters, last):');
  for (const p of policies) {
    const mine = runs.filter((r) => r.policy === p.name);
    const len = Math.min(...mine.map((r) => r.curve.length));
    const at = [0, Math.floor(len / 4), Math.floor(len / 2), Math.floor((3 * len) / 4), len - 1];
    L.push(`  ${pad(p.name, 24)}${(['materials', 'magic', 'might', 'labor', 'unrest'] as const).map((k) => `${k} ${at.map((i) => mean(mine.map((r) => r.curve[i][k])).toFixed(0)).join('>')}`).join('   ')}`);
  }
  L.push('');
  const fired = new Map<string, Map<string, number>>();
  for (const r of runs) for (const [k, v] of Object.entries(r.rules)) fired.set(k, new Map([...(fired.get(k) ?? []), [r.policy, (fired.get(k)?.get(r.policy) ?? 0) + v]]));
  L.push('Synergy rules fired (times over all runs, by policy):');
  if (!fired.size) L.push('  none');
  for (const [k, by] of [...fired].sort((a, b) => (a[0] < b[0] ? -1 : 1))) L.push(`  ${pad(k, 30)}${[...by].map(([p, v]) => `${p} ${v}`).join(', ')}`);
  L.push('');
  const taken = new Set(runs.flatMap((r) => r.taken));
  const seen = new Set(runs.flatMap((r) => r.seen));
  L.push(`Cards never taken by any bot: ${[...seen].filter((x) => !taken.has(x)).sort().join(', ') || 'none'}`);
  L.push(`Cards never on a board: ${o.templates.filter((x) => !seen.has(x)).sort().join(', ') || 'none'}`);
  const lapsed = new Map<string, number>();
  for (const r of runs) for (const x of r.lapsed) lapsed.set(x, (lapsed.get(x) ?? 0) + 1);
  L.push(`Threats that ran out (times): ${[...lapsed].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  const same = policies.filter((p) => new Set(runs.filter((r) => r.policy === p.name).map((r) => `${r.leader}:${r.moves.join('|')}`)).size === leaders.length);
  if (o.seeds.length > 1 && same.length === policies.length) L.push('Note: every seed gave the same run for a policy and leader. The seed only names the people (BACKLOG CT-3).');
  return { runs, text: L.join('\n') };
}
