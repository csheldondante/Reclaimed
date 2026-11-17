// (board, docs/design/BOARD.md) How the model's words look on the board. Pure: tags in, a look out. Every scar, sign
// and far state the model can set has a look here; a tag with none shows as a marker with its plain words, so nothing
// a card does is invisible (BACKLOG BD-4 lists the looks still to make).
import { SITE_TAGS } from '../season/realm-rules';
import type { SiteKey } from '../season/realm-templates';

/** what the land of a site has become: each has its own tiles and a short transition */
export const SCARS = ['burned', 'flooded', 'melted', 'buried', 'abandoned', 'destroyed', 'occupied', 'lost', 'greened', 'withered', 'dried'] as const;
export type Scar = (typeof SCARS)[number];
/** what hangs over the whole town (the model's signs, condition tags on the town) */
export const SIGNS = ['ashfall', 'darkness', 'deadrise', 'crime', 'rain', 'storm', 'fog', 'camp'] as const;
export type Sign = (typeof SIGNS)[number];

/** words a site's own state uses: no marker for these */
const STATE_WORDS = new Set(['standing', 'worked', 'ruined', 'crewed', 'manned', 'town', 'home', 'wall', 'garrison', 'unrest']);

export interface SiteLook {
  scars: Scar[];
  /** tags with no look of their own, in plain words */
  marks: string[];
  ruined: boolean;
}

/**
 * A site's look from its tags. `own`: the tags the things standing on it carry as what they are (a pack thing's tags
 * lent to its site) — not marks either.
 */
export function siteLook(key: SiteKey, tags: readonly string[], own: readonly string[] = []): SiteLook {
  const is = new Set([...SITE_TAGS[key].is, ...own]);
  const scars = SCARS.filter((s) => tags.includes(s));
  const marks = tags.filter((t) => !is.has(t) && !STATE_WORDS.has(t) && !(SCARS as readonly string[]).includes(t) && !t.startsWith('remains-of-') && !t.startsWith('is:')).map(words);
  return { scars, marks: [...new Set(marks)], ruined: tags.includes('ruined') };
}

/** the town's signs from the home town's condition tags */
export const signsOf = (conditions: readonly string[]): Sign[] => SIGNS.filter((s) => conditions.includes(s));

/** a tag in plain words: "growth-active" → "growth active" */
export const words = (tag: string): string => tag.replace(/[-_:]/g, ' ');

export type FarKind = 'town' | 'camp' | 'lair' | 'tower' | 'crash' | 'poi' | 'found';
export type FarStatus = 'standing' | 'burned' | 'drowned' | 'lava' | 'buried' | 'abandoned' | 'destroyed' | 'occupied' | 'vassal' | 'cleared' | 'withered' | 'greened';

export interface FarLook {
  kind: FarKind;
  status: FarStatus;
  /** held by the player (sworn, founded, a colony) */
  yours: boolean;
  founded: boolean;
  /** a faction's id that holds it (not the player): its colour */
  holder: string | null;
  /** tags with no look of their own */
  marks: string[];
}

const FAR_KNOWN = new Set(['town', 'far-town', 'standing', 'ruined', 'yours', 'founded', 'colony', 'poi', 'cleared', 'trade-partner', 'vassal', 'occupied', 'destroyed', 'abandoned', 'captured', 'found']);
const CONDITION_STATUS: Record<string, FarStatus> = { burned: 'burned', flooded: 'drowned', melted: 'lava', buried: 'buried', withered: 'withered', dried: 'withered', greened: 'greened' };

/**
 * A far place's look: its tags (packs/load.ts farThings), its land conditions (mutate/facts.ts placeState), the
 * factions known (their ids may be tags), and the resources a town may carry as a tag.
 */
export function farLook(tags: readonly string[], conditions: readonly string[], factions: readonly string[], resources: readonly string[] = []): FarLook {
  const has = (t: string) => tags.includes(t);
  const kind: FarKind = has('poi') ? (has('camp') ? 'camp' : has('lair') ? 'lair' : has('tower') ? 'tower' : has('crash') || has('wreck') ? 'crash' : 'poi') : has('found') ? 'found' : 'town';
  const holder = factions.find((f) => has(f)) ?? (has('raiders') && kind !== 'town' ? 'raiders' : null);
  const cond = [...conditions].reverse().map((c) => CONDITION_STATUS[c]).find((x) => !!x);
  const status: FarStatus = has('destroyed') ? 'destroyed' : has('abandoned') ? 'abandoned' : has('cleared') ? 'cleared' : cond === 'burned' || cond === 'drowned' || cond === 'lava' || cond === 'buried' ? cond : has('occupied') ? 'occupied' : has('vassal') ? 'vassal' : cond ?? 'standing';
  const kindWords = new Set(['camp', 'lair', 'tower', 'crash', 'wreck', 'raiders']);
  const marks = tags.filter((t) => !FAR_KNOWN.has(t) && !factions.includes(t) && !kindWords.has(t) && !resources.includes(t)).map(words);
  return { kind, status, yours: has('yours'), founded: has('founded'), holder, marks };
}

/** a far status in plain words, for its label */
export const FAR_WORD: Record<FarStatus, string> = {
  standing: 'standing',
  burned: 'burned',
  drowned: 'flooded',
  lava: 'under lava',
  buried: 'buried',
  abandoned: 'abandoned',
  destroyed: 'destroyed',
  occupied: 'occupied',
  vassal: 'sworn',
  cleared: 'cleared',
  withered: 'withered',
  greened: 'overgrown',
};
