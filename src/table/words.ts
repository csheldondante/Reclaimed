// (card-table; docs/design/CARD_TABLE.md) The card table's own lines (docs/WRITING.md: plain words, one idea a
// sentence, concrete numbers). The opportunities' words are their templates'; the pools' names and the fight's lines
// are the season's (season/words.ts, season/run-words.ts). Linted whole as a words module
// (test/unit/writing-sources.test.ts).
import type { RuleDef, RuleMissing, RuleTrigger, TagQuery } from '../living/rules';
import { POOLS, type Pool, type Pools } from '../season/ledger';
import { POOL_NAME } from '../season/words';

export const FAR = 'Far places';
export const PACK_REMOVE = 'Take out';
export const rulesCount = (paid: number, ready: number, of: number): string => `${paid} paid, ${ready} ready, of ${of}`;
export const PLAIN_PLACES = 'Places with nothing on them yet';
export const TAGS_TITLE = 'Tags in play';
export const RULES_HELP = 'A rule pays when one thing in play carries all its tags. Green rules paid at the end of last season.';
export const RULE_SPENT = 'It has paid this season.';
export const LIVE_NOTE = 'Taking it starts an event. You can cast spells into it before the season ends.';
export const PREDICT = 'If it ended now';
export const NO_RULES_APPLY = 'No rule would change it now.';
export const SPELL_TEXT: Record<string, string> = {
  growth: 'Cast it on a field. The field is growth-active until the season ends.',
  fire: 'Cast it into an event. It puts down 1 foe.',
  heatray: 'Cast it into an event. It puts down 2 foes.',
  rain: 'Cast it into a fire. It puts out 2 burning lots.',
};
/** a spell's line from what one cast does now (laws change the numbers) */
export function spellText(s: string, m?: { kills?: number; douses?: number }): string {
  if (s === 'growth' || !m) return SPELL_TEXT[s] ?? '';
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts = [...(m.kills ? [`It puts down ${plural(m.kills, 'foe', 'foes')}`] : []), ...(m.douses ? [`It puts out ${plural(m.douses, 'burning lot', 'burning lots')}`] : [])];
  return `Cast it into ${m.kills ? 'an event' : 'a fire'}. ${parts.length ? parts.join('. ') : 'It does nothing there now'}.`;
}

// ---- laws (docs/design/LAWS.md) ----
export const LAWS_TITLE = 'Laws in force';
export const LAWS_NONE = 'No law changes the rules yet. Some cards and things bring laws.';
export const LAWS_HELP = 'A law changes the rules of the game for this run. Laws apply in the order they came.';
export const LAW_BRINGS = 'Brings a law';
export const LAW_ON_LAPSE = 'If you leave it, a law';
export const LAW_CHANGES = 'What would change';
export const LAW_READY = 'ready';
export const LAW_NOT_READY = 'not ready';
export const LAW_OFF = 'off';
export const LAW_GONE = 'gone';
export const BY_LAW = 'By law';
export const WIN_LABEL = 'A way to win';
export const CAST_WORD = 'cast';
export const PRINTED = 'Printed';
export const CHANGED_BY = 'Changed by law';
export const RESOLVE_NOW = 'Settle it now';
export const RESOLVE_HELP = 'Settle it now with the spells cast so far. What it sets off happens at once.';
export const lawLine = (name: string, text: string): string => `${name}. ${text}`;
export const LAW_AFTER = 'In every run after the one that made it.';
// ---- the record and endings ----
export const RECORD_TITLE = 'What this world remembers';
export const RECORD_NONE = 'Nothing yet. Every card you finish or let run out is kept here, run after run.';
const RESULT_WORD: Record<string, string> = { triumph: 'Best result', success: 'Done', cost: 'Mixed result', failure: 'Bad result', disaster: 'Worst result', lapsed: 'Left to run out' };
export const recordLine = (run: number, leader: string, title: string, result: string): string => `Run ${run}, ${leader}: ${title}. ${RESULT_WORD[result] ?? result}.`;
export const becauseCard = (run: number, leader: string, title: string): string => `"${title}" in run ${run}, under ${leader}`;
export const becauseRemains = (name: string): string => `the remains of ${name}`;
export const because = (parts: string[]): string => `Here because of what came before: ${parts.join(' and ')}.`;
export const endedTitle = (result: string, name: string): string => (result === 'won' ? `You won the run: ${name}.` : result === 'fell' ? `The run is lost: ${name}.` : `The run ended: ${name}.`);
export const endedBy = (by: string): string => `It was ended by ${by}.`;
export const lawFrom = (from: string, until: string, times: number): string => `${times > 1 ? `In force ${times} times. ` : ''}Made by ${from}. ${until}`;
export const tagCount = (n: number): string => `${n} thing${n === 1 ? '' : 's'}`;
export const winLine = (count: number, tags: readonly string[]): string => `${count} things in play that are ${tags.map((t) => `"${t}"`).join(' + ')}`;
export const wonTitle = (law: string): string => `You won the run by law: ${law}.`;
export const ruleOff = (law: string): string => `Off, by the law "${law}".`;
const stop = (s: string): string => (/[.!?]$/.test(s) ? s : `${s}.`);
export const becomes = (label: string, was: string, now: string): string => (was || now ? `${label}. Now: ${stop(was || 'nothing')} With it: ${stop(now || 'nothing')}` : '');
export const becomesNew = (label: string, now: string): string => (now ? `${label}. New: ${stop(now)}` : '');

export const UNIT_NAME: Record<string, string> = { raider: 'raiders', guard: 'soldiers', soldier: 'soldiers', worker: 'townsfolk', cart: 'carts', shambler: 'risen dead' };
export const TIER_NAME: Record<string, string> = { triumph: 'Best result', success: 'Good result', cost: 'Mixed result', failure: 'Bad result', disaster: 'Worst result' };
export const eventBegan = (title: string): string => `It begins: ${title}.`;
export const eventEnded = (title: string, lines: string): string => `${title}. ${lines}`;
export const eventHow = (spells: string[]): string => (spells.length ? `It ends by itself when the season ends. You can cast ${spells.join(', ')} into it first.` : 'It ends by itself when the season ends.');
export const groupLine = (who: string, n: number, alive: number): string => (alive === n ? `${n} ${who}` : `${alive} of ${n} ${who} left`);
export const hazardLine = (burned: number, points: number): string => `Fire. ${burned} of ${points} lots would burn.`;
export const castsLine = (name: string, n: number): string => `${name} cast ${n === 1 ? 'once' : `${n} times`}`;
export const ruleLine = (name: string, why: string): string => `Rule: ${name}. ${why}.`;

const list = (tags: readonly string[]): string => tags.map((t) => `"${t}"`).join(' + ');
const pool = (k: string): string => POOL_NAME[k as Pool] ?? k;
const query = (q: TagQuery): string => `${list(q.tags)}${q.not?.length ? ` and not ${list(q.not)}` : ''}`;
const near = (cells: number): string => (cells <= 70 ? 'passing' : cells <= 90 ? 'next to' : 'close to');
/** when a rule is looked at */
export function ruleWhen(on: RuleTrigger): string {
  if (on === 'turn') return 'Each season';
  if (typeof on !== 'string' && 'live' in on) return on.tier ? `When a ${on.live} event ends in ${on.tier.map((t) => (TIER_NAME[t] ?? t).toLowerCase()).join(' or ')}` : `When a ${on.live} event ends`;
  return `When "${typeof on === 'string' ? on : on.event}" happens`;
}
/** what a rule reads and gives: "One thing that is "field" + "worked" + "growth-active". +2 Materials." */
export function ruleSays(r: RuleDef, card: (id: string) => string = (id) => id, law: (id: string) => string = (id) => id): string {
  const a = `One thing that is ${query(r.a)}${r.a.near && r.a.near.of !== 'a' ? `, ${near(r.a.near.cells)} the event` : ''}.`;
  const b = r.b ? ` And one that is ${query(r.b)}${r.b.near ? (r.b.near.of === 'a' ? `, ${near(r.b.near.cells)} the first` : `, ${near(r.b.near.cells)} the event`) : ''}.` : '';
  const need = r.need ? ` Needs ${pool(r.need.pool)} ${r.need.gte !== undefined ? `${r.need.gte} or more` : `${r.need.lte} or less`}.` : '';
  const fx = r.effect;
  const each = r.per === 'a' ? ' for each such thing' : r.per === 'b' ? ' for each second thing' : r.per ? ` for every ${r.per.each} of ${r.per.amount}` : '';
  if ('offer' in fx) return `${a}${b}${need} Then this is asked of you: "${card(fx.offer)}".`;
  if ('start' in fx) return `${a}${b}${need} Then this begins at once: "${card(fx.start)}".`;
  if ('tag' in fx) return `${a}${b}${need} Then it becomes "${fx.tag}"${fx.timed ? ' for the season' : ''}.`;
  if ('untag' in fx) return `${a}${b}${need} Then it is no longer "${fx.untag}".`;
  if ('law' in fx) return `${a}${b}${need} Then a new law: "${law(fx.law)}"${fx.seasons ? ` for ${fx.seasons} more seasons` : ' for the rest of the run'}.`;
  if ('end_run' in fx) return `${a}${b}${need} Then the run ends: ${fx.name ?? fx.end_run}.`;
  const times = r.fires !== undefined && r.fires !== 1 ? ` It pays ${r.fires} times each time it fires.` : '';
  const gives = 'pool' in fx ? `${fx.n > 0 ? '+' : ''}${fx.n} ${pool(fx.pool)}${each}` : fx.op === 'mul' ? `"${fx.amount}" times ${fx.n}${each}` : `${fx.n > 0 ? '+' : ''}${fx.n} "${fx.amount}"${each}`;
  return `${a}${b}${need} Gives ${gives}${r.cap !== undefined ? `, at most ${r.cap}` : ''}.${times}`;
}
/** a chain's links before a rule's line: the rule that had set it going, and what happened */
export const chainLine = (after: string | undefined, what: string | undefined, line: string): string => `${after ? `${after} → ` : ''}${what ? `${what} → ` : ''}${line}`;
/** on an event's card: what a result will set off */
export const setsOff = (tiers: string[], name: string, says: string): string => `If it ends in ${tiers.map((t) => (TIER_NAME[t] ?? t).toLowerCase()).join(' or ')}: ${name}. ${says}`;
export const resultWhat = (title: string, tier: string): string => `${title}: ${(TIER_NAME[tier] ?? tier).toLowerCase()}`;
export const ruleReady = (on: RuleTrigger, things: string[]): string => `Ready: ${things.join(' and ')}. ${on === 'turn' ? 'It pays when the season ends.' : `It pays ${ruleWhen(on).toLowerCase()}.`}`;
/** the one thing a rule lacks */
export function whyNot(m: RuleMissing): string {
  if (m.kind === 'spent') return RULE_SPENT;
  if (m.kind === 'need') return `Missing: ${pool(m.pool)} must be ${m.gte !== undefined ? `${m.gte} or more` : `${m.lte} or less`}. It is ${m.have}.`;
  if (m.kind === 'far') return `Missing: ${m.b} is too far from ${m.a}. It must be ${near(m.cells)} it.`;
  const what = m.kind === 'a' ? `Missing: nothing in play is ${list(m.tags)}.` : `Missing: ${m.a} needs a second thing that is ${list(m.tags)}.`;
  if (!m.closest) return what;
  const lacks = m.closest.lacks.length ? ` lacks ${list(m.closest.lacks)}` : '';
  const has = m.closest.has.length ? `${lacks ? ' and' : ''} is ${list(m.closest.has)}` : '';
  return `${what} Closest: ${m.closest.name}${lacks}${has}.`;
}

export const PAGE_TITLE = 'Card table';
export const OPPS_TITLE = 'Asked of you this season';
export const OPPS_NONE = 'Nobody is asking for anything this season.';
export const WORK_TITLE = 'Under way';
export const PLAY_TITLE = 'In play';
export const PLAY_NONE = 'Nothing is built yet.';
export const ABILITIES_TITLE = 'Abilities';
export const EVENTS_TITLE = 'Happening now';
export const LOG_TITLE = 'What happened';
export const LOG_NONE = 'Nothing has happened yet.';
export const RULES_TITLE = 'Rules';
export const TAKE = 'Take';
export const PASS = 'Pass';
export const END_SEASON = 'End the season';
export const NEW_RUN = 'Start the next run in this world';
export const RESTART = 'Start again';
export const SETUP = 'Seed, leader and length';
export const SEED = 'Seed';
export const LEADER = 'Leader';
export const LENGTH = 'Seasons';
export const RUN_OVER = 'The run is over.';
export const CARRY = 'The next run keeps what you built. The world keeps what happened.';
export const COST = 'Cost';
export const IF_TAKEN = 'If you take it';
export const IF_LEFT = 'If you leave it';
export const NO_LAPSE = 'Nothing. The offer goes away.';
export const STORY_TITLE = 'What happened this run';
export const BUILT_TITLE = 'Built';

export const header = (name: string, season: number, of: number, run: number): string => `${name}. Season ${season} of ${of}. Run ${run}.`;
export const runBegan = (name: string, run: number, seasons: number): string => `Run ${run} begins. ${name} leads the town for ${seasons} seasons.`;
export const took = (title: string): string => `You took "${title}".`;
export const passed = (title: string): string => `You passed on "${title}".`;
export const builtLine = (name: string): string => `Built: ${name}.`;
export const leftLine = (left: number): string => (left <= 1 ? 'This is its last season.' : `It stays ${left} seasons.`);
export const doneIn = (left: number): string => (left <= 1 ? 'Done next season.' : `Done in ${left} seasons.`);
export const needLine = (miss: string): string => `You need ${miss} more.`;
export const incomeText = (n: number): string => (n > 0 ? `+${n} a season` : n < 0 ? `${n} a season` : '');
export const freeOf = (have: number, of: number): string => `${have} of ${of} free`;
export const storyLine = (season: number, note: string): string => `Season ${season}. ${note.charAt(0).toUpperCase()}${note.slice(1)}${/[.!?]$/.test(note) ? '' : '.'}`;

/** the pools' change over a season: "Materials +2, Magic +1" (empty: nothing changed) */
export function deltaLine(before: Pools, after: Pools): string {
  const parts = POOLS.filter((k) => after[k] !== before[k]).map((k) => `${POOL_NAME[k]} ${after[k] > before[k] ? '+' : ''}${after[k] - before[k]}`);
  return parts.length ? `The season changed your pools. ${parts.join(', ')}.` : '';
}

export const TOWN = 'The town';
export const castNote = (ability: string, on: string): string => `you cast ${ability} on ${on}`;
export const castLine = (ability: string, on: string, cost: number): string => `You cast ${ability} on ${on}. It cost ${cost} Magic.`;
export const castCost = (cost: number): string => `${cost} Magic`;
export const PICK_TARGET = 'Tap a lit card to cast it there.';
export const NO_TARGET = 'Nothing in play can take it now.';
export const ABILITIES_NONE = 'You have no abilities yet. Some cards give you one.';
export const PACK_TITLE = 'Packs';
export const PACK_LOAD = 'Load a pack file';
export const PACK_NONE = 'Only the base cards are in play.';
export const packLine = (name: string, cards: number): string => `${name}. ${cards} cards added.`;
export const packLeft = (card: string, why: string): string => `Left out: ${card}. ${why}`;
