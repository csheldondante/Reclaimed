// (card-table; docs/design/LAWS.md) A law in the player's words, written from its data (living/laws.ts LawDo), so the
// words always say what the engine does. For both front ends: the card table's "Laws in force" and a card's preview,
// and the 3D game's list when it draws one. Plain words, the numbers the engine applies.
import type { CardMatch, LawDo } from '../living/laws';
import type { TagQuery } from '../living/rules';
import type { Pool } from './ledger';
import { SPELL_NAME } from './run-words';
import { POOL_NAME } from './words';

const pool = (k: string): string => POOL_NAME[k as Pool] ?? k;
const spell = (k: string): string => (SPELL_NAME as Record<string, string>)[k] ?? k;
const tags = (q: readonly string[]): string => q.map((t) => `"${t}"`).join(' + ');
const query = (q: TagQuery): string => (q.tags.length ? `is ${tags(q.tags)}${q.not?.length ? ` and not ${tags(q.not)}` : ''}` : 'is in play');
const TIER: Record<string, string> = { triumph: 'the best result', success: 'a good result', cost: 'a mixed result', failure: 'a bad result', disaster: 'the worst result' };
const tiers = (t: readonly string[]): string => t.map((x) => TIER[x] ?? x).join(' or ');
const seasons = (n: number): string => `${n} season${Math.abs(n) === 1 ? '' : 's'}`;
const signed = (n: number, k: string): string => `${n > 0 ? '+' : ''}${n} ${pool(k)}`;

/** what a law's names point at: a rule's name, a card's title */
export interface LawNames {
  rule(id: string): string;
  card(id: string): string;
}

const cards = (m: CardMatch | undefined, n: LawNames): string => {
  if (!m) return 'Every card';
  const parts = [...(m.themes?.length ? [`every card about ${m.themes.join(' or ')}`] : []), ...(m.ids ?? []).map((id) => `"${n.card(id)}"`)];
  const s = parts.join(' and ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** one law, in one or two plain sentences */
export function lawText(d: LawDo, n: LawNames): string {
  if ('count_as' in d) return `Whatever is "${d.count_as.tag}" also counts as "${d.count_as.as}".`;
  if ('grant' in d) return `Everything that ${query(d.to)} is also "${d.grant}".`;
  if ('spare' in d) return `"${d.spare}" no longer ruins a place. It keeps working.`;
  if ('add_rule' in d) return `A new rule while this law stands: "${d.add_rule.name}".`;
  if ('rule' in d) {
    const name = `"${n.rule(d.rule)}"`;
    if (d.off) return `The rule ${name} is off.`;
    const out: string[] = [];
    if (d.set)
      for (const [k, v] of Object.entries(d.set)) {
        const what = k === 'n' ? 'it gives' : k === 'cap' ? 'it gives at most' : k === 'each' ? 'it counts every' : 'it fires at most, a season,';
        out.push(v === null ? (k === 'cap' ? 'it has no most' : k === 'perSeason' ? 'it fires every time' : '') : `${what} ${v}`);
      }
    if (d.times !== undefined) out.push(`it gives ${d.times} times as much`);
    if (d.fires !== undefined) out.push(`it pays ${d.fires} times each time it fires`);
    if (d.on) out.push(`it fires ${d.on === 'turn' ? 'each season' : 'event' in d.on ? `when "${d.on.event}" happens` : `when a ${d.on.live} event ends${d.on.tier ? ` in ${tiers(d.on.tier)}` : ''}`}`);
    if (d.a) out.push(`it reads one thing that ${query(d.a)}`);
    if (d.b) out.push(`and a second that ${query(d.b)}`);
    return `The rule ${name}: ${out.filter(Boolean).join(', ')}.`;
  }
  if ('cost' in d) {
    const parts = Object.entries(d.cost).map(([k, v]) => (v < 0 ? `${-v} ${pool(k)} less` : `${v} ${pool(k)} more`));
    return `${cards(d.cards, n)} costs ${parts.join(' and ')}. No cost goes below 0.`;
  }
  if ('pay' in d) return `${cards(d.cards, n)}: ${Object.entries(d.pay).map(([k, v]) => `the ${pool(k)} part of the cost is paid in ${pool(v)}`).join('; ')}.`;
  if ('build' in d) return `${cards(d.cards, n)} takes ${seasons(Math.abs(d.build))} ${d.build < 0 ? 'less' : 'more'} to build. Building takes 1 season at least.`;
  if ('stay' in d) return `${cards(d.cards, n)} dealt from now stays on offer ${seasons(Math.abs(d.stay))} ${d.stay < 0 ? 'less' : 'more'}.`;
  if ('pool_as' in d) return Object.entries(d.pool_as).map(([k, v]) => `In a fight, each ${pool(k)} counts as 1 ${pool(v)}.`).join(' ');
  if ('spell' in d) {
    const out: string[] = [];
    if (d.kills !== undefined) out.push(`One cast of ${spell(d.spell)} puts down ${d.kills} foe${d.kills === 1 ? '' : 's'} in an event.`);
    if (d.douses !== undefined) out.push(`One cast of ${spell(d.spell)} puts out ${d.douses} burning lot${d.douses === 1 ? '' : 's'}.`);
    if (d.also_tag) out.push(`Each cast of ${spell(d.spell)} also makes everything that ${query(d.on ?? { tags: [] })} "${d.also_tag}" for the season.`);
    return out.join(' ');
  }
  if ('event' in d) {
    const out: string[] = [];
    if (d.allow?.length) out.push(`${d.allow.map(spell).join(', ')} can be cast into a ${d.event} event.`);
    if (d.shift) out.push(`A ${d.event} event ends ${Math.abs(d.shift)} step${Math.abs(d.shift) === 1 ? '' : 's'} ${d.shift > 0 ? 'better' : 'worse'}.`);
    if (d.foes) out.push(`A ${d.event} event has ${Math.abs(d.foes)} ${d.foes > 0 ? 'more' : 'fewer'} foe${Math.abs(d.foes) === 1 ? '' : 's'} in each group of foes.`);
    if (d.counts_as) out.push(`A ${d.event} event that ends in ${d.tier ? tiers(d.tier) : 'any result'} also counts as a ${d.counts_as.live} event that ends in ${tiers(d.counts_as.tier)}.`);
    return out.join(' ');
  }
  if ('board' in d) return `${Math.abs(d.board)} ${d.board > 0 ? 'more' : 'fewer'} card${Math.abs(d.board) === 1 ? '' : 's'} on offer at once.`;
  if ('income' in d) return `${Object.entries(d.income).map(([k, v]) => signed(v, k)).join(', ')} each season.`;
  if ('raiders' in d) return [d.raiders.add ? `The raid has ${Math.abs(d.raiders.add)} ${d.raiders.add > 0 ? 'more' : 'fewer'} raiders.` : '', d.raiders.times !== undefined ? `The raid has ${d.raiders.times} times as many raiders.` : ''].filter(Boolean).join(' ');
  if ('win' in d) return `You win the run when ${d.win.count} things in play are ${tags(d.win.tags)}.`;
  if ('multipliers' in d) return `Every multiplier is ${d.multipliers} times as big: a rule that multiplies, a law that multiplies.`;
  return 'The next new law lasts the rest of the run.';
}

/** how long a law in force stands, in words */
export function lawUntil(source: { thing: string } | { until: number } | { run: true }, now: number, thing: (id: string) => string): string {
  if ('thing' in source) return `While ${thing(source.thing)} stands.`;
  if ('until' in source) return source.until <= now ? 'To the end of this season.' : `For ${seasons(source.until - now)} after this one.`;
  return 'For the rest of the run.';
}
