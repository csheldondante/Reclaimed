// (loop-skeleton; docs/design/LOOP_SKELETON.md) The lines of the home-town run's own screens: the leaders, the top bar,
// the season, the attack, the end of the run (docs/WRITING.md: plain words, one idea a sentence, concrete numbers).
// The opportunities' own words are their templates' (season/realm-templates.ts) and the petition dialog's
// (dialog/petition.ts). Linted whole as a words module (test/unit/writing-sources.test.ts).
import type { Pools } from './ledger';
import type { Leader, SpellId } from './realm';
import { poolsLine } from './words';

export const LEADERS: readonly Leader[] = [
  { id: 'ysolt', name: 'Marshal Ysolt', line: 'A soldier. She starts with more Might.', pools: { magic: 1, might: 3, labor: 4, materials: 6, intel: 1, unrest: 0 }, income: { materials: 2, magic: 1 } },
  { id: 'dunstan', name: 'Master Dunstan', line: 'A builder. He starts with more Labor and Materials.', pools: { magic: 1, might: 1, labor: 6, materials: 9, intel: 1, unrest: 0 }, income: { materials: 2, magic: 1 } },
  { id: 'ilveth', name: 'Sister Ilveth', line: 'A keeper of the tower. She starts with more Magic and Intel.', pools: { magic: 4, might: 1, labor: 4, materials: 6, intel: 3, unrest: 0 }, income: { materials: 2, magic: 2 } },
];

export const leader = (id: string): Leader => {
  const l = LEADERS.find((x) => x.id === id);
  if (!l) throw new Error(`run: no leader ${id}`);
  return l;
};

export const SPELL_NAME: Record<SpellId, string> = { heatray: 'Heat ray', fire: 'Fire', rain: 'Rain', growth: 'Growth rune' };
export const SPELL_NONE = 'You have no spells. Some projects give you one.';
export const SPELL_AIM = 'Tap the ground to cast it.';
export const SPELL_STANDIN = 'Stand-in. Heat ray shows as a lightning strike for now.';
export const SPELL_LATER = 'Telekinesis arrives with the new physics. Later you will draw a rune to cast.';
export const TELEKINESIS = 'Telekinesis';

export const PICK_TITLE = 'Pick a leader';
export const PICK_SUB = 'Each leader starts with different pools.';
export const PICK_BUTTON = 'Lead the town';
export const PORTRAIT = 'Portrait to come';
export const WORLD_KEPT = 'This world remembers your earlier runs.';
/** (loop round 10) a pack leader who plays from another town of the world */
export const playsFrom = (town: string): string => `Rules from ${town}. The game opens there.`;
/** (loop round 10) a locked leader: how to open them */
export const lockedLine = (hint: string): string => (hint ? `Not yet found. ${hint}` : 'Not yet found.');

export const ASKS_TITLE = 'People are asking for you';
export const ASKS_NONE = 'Nobody is asking for you this season';
export const TAP_MARKER = 'Tap a name on the map to hear them out.';
/** (loop round 13) folding the town's sheet and the names away, to look at the land, and back */
export const SHEET_HIDE = 'Hide';
export const SHEET_SHOW = 'Show the town list';
export const NEXT = 'Next season';
export const MAP = 'Map';
export const SKIP = 'Skip';
export const BUILDING = 'The season passes. The town builds.';
export const RESULT_HELD = 'The town held';
export const RESULT_BROKEN = 'The raiders broke through';
export const RESULT_NONE = 'No raid came';
export const CONTINUE = 'Continue';
export const END_TITLE = 'The run is over';
export const END_LIST = 'What happened this run';
export const END_NONE = 'Nothing changed in the world this run.';
export const END_BEFORE = 'From earlier runs';
export const END_LAND = 'Changes to the land';
export const NEW_RUN = 'Start a new run in this world';
export const AGREE = 'Agree.';
export const WORKING = 'Under way';

export const leaderTitle = (name: string, season: number, of: number, run: number): string => `${name} · Season ${season} of ${of} · Run ${run}`;

const seasons = (n: number): string => (n === 1 ? '1 season' : `${n} seasons`);

/** the countdown on a card over the map */
export const leftText = (left: number): string => (left <= 1 ? 'last season' : `${seasons(left)} left`);

/** the standing threat's countdown on the top bar (Realm.standingThreat: the threat card on the board with the most
 *  seasons left — the raiders' "Raiders on the road", or a pack's final threat): its own title and its own countdown */
export function threatText(t: { title: string; left: number } | null): string {
  if (!t) return '';
  return `${t.title}: ${t.left <= 1 ? 'last season to answer it' : `${seasons(t.left)} left`}.`;
}
/** the standing threat's marker over the road */
export const threatTag = (title: string, n: number): string => `${title}: ${n <= 1 ? 'last season' : seasons(n)}`;

/** what a card costs, in the pools' words: "Lock 2 Labor for 2 seasons. Spend 3 Materials." */
export function costText(locks: Partial<Pools>, costs: Partial<Pools>, turns: number): string {
  const out: string[] = [];
  const l = poolsLine(locks);
  if (l) out.push(`Lock ${l} for ${seasons(turns)}.`);
  const c = poolsLine(costs);
  if (c) out.push(`Spend ${c}.`);
  return out.join(' ') || 'Nothing.';
}
/** how long a card's work takes */
export const takesText = (turns: number): string => seasons(turns);
export const agreedLine = (who: string, title: string): string => `You agreed with ${who}. ${title}.`;
export const refusedLine = (who: string): string => `You said no to ${who}.`;
export const shortText = (miss: Partial<Pools>): string => `You need ${poolsLine(miss)} more.`;

export interface Fight {
  raiders: number;
  left: number;
  fallen: number;
  held: boolean;
}
/** the result's title: nobody came (LS-20), the town held, or the raiders broke through */
export const resultTitle = (f: Fight): string => (f.raiders === 0 ? RESULT_NONE : f.held ? RESULT_HELD : RESULT_BROKEN);

export function resultLines(f: Fight, lost: { might: number; materials: number; unrest: number }): string[] {
  const out: string[] = [];
  if (f.raiders === 0) out.push('No raider reached the town.');
  else if (f.left === 0) out.push(`All ${f.raiders} raiders are dead.`);
  else {
    const dead = f.raiders - f.left;
    out.push(`${f.left} of ${f.raiders} raiders got into the town.${dead === 1 ? ' 1 raider died.' : dead ? ` ${dead} raiders died.` : ''}`);
  }
  out.push(f.fallen === 0 ? 'You lost no soldiers.' : f.fallen === 1 ? '1 soldier died.' : `${f.fallen} soldiers died.`);
  if (lost.might) out.push(`You lost ${lost.might} Might.`);
  if (lost.materials) out.push(`They took ${lost.materials} Materials.`);
  if (lost.unrest) out.push(`Unrest +${lost.unrest}.`);
  return out;
}

/** a named physical change, for the end-of-run list (until the mutators draw it) */
export const LAND_KIND: Record<string, string> = { flooded: 'Flooded', burned: 'Burned', melted: 'Melted', buried: 'Buried', founded: 'Founded', captured: 'Captured', vassal: 'Your vassal', abandoned: 'Abandoned', destroyed: 'Destroyed' };
export const landLine = (kind: string, where: string): string => `${LAND_KIND[kind] ?? kind}: ${where}.`;

export const seasonLabel = (n: number): string => `Season ${n}`;
export const runLine = (n: number): string => (n === 1 ? 'This was the first run in this world.' : `This was run ${n} in this world.`);
/** an event's note from the history as a sentence */
export const sentence = (t: string): string => {
  const s = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
};

/** the fight's two sides, over their figures (a count follows) */
export const RAIDERS_TAG = 'Raiders';
export const SOLDIERS_TAG = 'Your soldiers';

/** a live event (round 6): its own words are its template's (season/realm-events.ts); these are the screen's */
export const LIVE_LEAVE = 'Back to the town';
export const LIVE_WAIT = 'They are on the road.';
export const underWay = (title: string): string => `${title} · under way`;
/** a line with an event's numbers in it: '{alive} of {raiders} raiders are left.' */
export const fill = (line: string, v: Record<string, number>): string => line.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));

export const SPELLS_TITLE = 'Your spells';
export const GROWTH_HOW = 'Tap the east fields to draw the growth rune. Farms there yield double this season. It costs 1 Magic.';
export const GROWTH_CAST = 'You drew a growth rune over the east fields. They grow fast until the season ends.';
export const GROWTH_MISS = 'Tap the east fields to draw the growth rune there.';
export const RAIN_CAST = 'Rain falls where you tapped.';

/** (round 8) packs, laws, rules, the record, endings (the card table's own words are table/words.ts) */
export const LAWS = 'Laws';
export const RULES = 'Rules';
export const REMEMBERED = 'Remembered';
export const CLOSE = 'Close';
export const SETTLE = 'Settle it now';
export const PACKS_BAD = 'A pack could not be played. The base game plays without it.';
export const NOW_TITLE = 'The world now';
export const lawCost = (now: string, printed: string): string => `${now} By law. Printed: ${printed}`;
export const bringsLaw = (line: string): string => `Brings a law: ${line}`;
export const remainsOf = (name: string): string => `remains of ${name}`;
export const builtThing = (name: string): string => `Built: ${name}.`;
export const doneHere = (title: string): string => `Done: ${title}`;
export const TAGS = 'Tags';
export const castOn = (name: string, cost: number): string => `${name} (${cost} Magic)`;
export const ABILITY_CAST = 'Cast';
export const ruleWhy = (when: string, why: string): string => `${when} ${why}`;
export const firedLine = (n: number): string => (n === 1 ? 'It paid once last season.' : `It paid ${n} times last season.`);
