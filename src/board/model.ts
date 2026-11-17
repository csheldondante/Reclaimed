// (board, docs/design/BOARD.md) The board's reading of the run: one plain record of what to draw, taken from the card
// table's driver (table/game.ts) and its Realm. Nothing of the model is copied: every number is read. The page draws
// this record and diffs two of them (before and after a season's end) for the time-lapse.
import type { Pack } from '../packs/check';
import { farThings, packFactions, packThings } from '../packs/load';
import { placeState } from '../mutate/facts';
import { RAIDERS, SITES, type SiteKey } from '../season/realm-templates';
import { SITE_TAGS } from '../season/realm-rules';
import { CATALOG } from '../season/catalog';
import { raidersOf } from '../living/laws';
import { military } from '../season/war';
import { WORKS } from '../season/works';
import type { UseNow } from '../season/realm';
import type { EventView, OppCard, PoolView, Table } from '../table/game';
import { farLook, signsOf, siteLook, words, type FarLook, type SiteLook, type Sign } from './looks';

export interface WorkView {
  id: string;
  name: string;
  site: SiteKey;
  slots: { kind: 'crew' | 'soldier'; n: number; posted: number }[];
  uses: UseNow[];
  text: string;
}

export interface SiteView {
  key: SiteKey;
  id: string;
  name: string;
  look: SiteLook;
  /** the base game's building stands here (the catalog card that builds it was built) */
  built: string | null;
  /** the pack things standing here: buildings, and policies (no building: a flag) */
  things: { id: string; def: string; name: string; building: boolean; ruined: boolean }[];
  /** a project under way here: what it raises, and how far along (0..1 at the start of this season) */
  raising: { offer: string; title: string; builds: string | null; done: number; left: number } | null;
}

export type OfferAt = { site: SiteKey } | { far: string } | { town: true };
export interface OfferView {
  card: OppCard;
  at: OfferAt;
}
export interface LiveView {
  ev: EventView;
  at: OfferAt;
  raid: boolean;
  /** a hazard's kind: a fire, or a front of lava or water (null: none) */
  hazard: 'fire' | 'lava' | 'water' | null;
}
export interface FarView {
  id: string;
  name: string;
  /** world units from the home town's centre */
  dx: number;
  dy: number;
  look: FarLook;
  partner: boolean;
}

export interface BoardState {
  season: number;
  seasons: number;
  run: number;
  over: boolean;
  leader: string;
  pools: PoolView[];
  crews: { free: number; all: number };
  soldiers: { free: number; all: number };
  /** every crew and soldier: where it stands on the board (a site; null: away from the town, or kept off by Unrest) */
  pieces: { kind: 'crew' | 'soldier'; where: 'free' | 'strike' | 'project' | 'posted'; site: SiteKey | null; on: string | null }[];
  /** conditions on the town itself that have no look of their own, in plain words */
  homeMarks: string[];
  sites: Record<SiteKey, SiteView>;
  works: WorkView[];
  offers: OfferView[];
  live: LiveView[];
  far: FarView[];
  signs: Sign[];
  /** the raiders' standing threat in numbers, or null */
  raid: { title: string; left: number; raiders: number; meet: number; military: boolean } | null;
  /** the catalog buildings built (houses count for the crowd) */
  built: string[];
  /** walls built and standing */
  walls: boolean;
}

/** what each card puts in play (a pack or the works: `put`), by card id */
function putsOf(packs: readonly Pack[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of [WORKS, ...packs]) for (const c of p.cards ?? []) for (const e of (c.if_taken ?? []) as Record<string, unknown>[]) if (typeof e?.put === 'string') out.set(c.id, e.put);
  return out;
}

export function siteOf(home: string, place: string): SiteKey | null {
  const pre = `site:${home}:`;
  return place.startsWith(pre) ? (place.slice(pre.length) as SiteKey) : null;
}
const atOf = (home: string, place: string): OfferAt => {
  const s = siteOf(home, place);
  return s ? { site: s } : place === home ? { town: true } : { far: place };
};

export function readBoard(t: Table, packs: readonly Pack[]): BoardState {
  const r = t.realm;
  const w = r.w;
  const home = t.home;
  const things = r.things();
  const led = r.ledger;
  const puts = putsOf(packs);
  const catalogIds = new Set(CATALOG.map((c) => c.id));
  const mine = packThings(w, t.packs, home);
  const thingDefs = new Map(t.packs.flatMap((p) => p.things).map((d) => [d.id, d]));
  const sites = {} as Record<SiteKey, SiteView>;
  for (const s of SITES) {
    const id = `site:${home}:${s.key}`;
    const th = things.find((x) => x.id === id);
    const here = mine.filter((m) => m.site === id);
    const own = here.flatMap((m) => m.def.tags ?? []);
    const meta = SITE_TAGS[s.key];
    sites[s.key] = {
      key: s.key,
      id,
      name: s.name,
      look: siteLook(s.key, th?.tags ?? [], own),
      built: meta.built && led.built.includes(meta.built) ? meta.built : null,
      things: here.map((m) => {
        const tv = things.find((x) => x.id === m.id);
        return { id: m.id, def: m.def.id, name: m.def.name, building: (m.def.kind ?? 'building') === 'building', ruined: !!tv?.tags.includes('ruined') };
      }),
      raising: null,
    };
  }
  // (projects under way: a card being built at its site — the catalog's, or one that puts a thing in play)
  for (const o of r.engine.running()) {
    if (r.liveOf(o)) continue;
    const key = siteOf(home, o.place);
    if (!key) continue;
    const total = 'turns' in o.opp.duration ? o.opp.duration.turns : 1;
    const left = Math.max(1, (o.resolvesTurn ?? w.turn + 1) - w.turn);
    const builds = catalogIds.has(o.template) ? o.template : (puts.get(o.template) ?? null);
    const cur = sites[key].raising;
    if (!cur || (builds && !cur.builds)) sites[key].raising = { offer: o.id, title: o.opp.title, builds, done: Math.max(0, Math.min(1, (total - left) / Math.max(1, total))), left };
  }
  const works: WorkView[] = t.works().map((x) => {
    const m = mine.find((q) => q.id === x.id);
    return { id: x.id, name: x.name, site: (m?.site ? siteOf(home, m.site) : null) ?? 'keep', slots: x.slots, uses: x.uses, text: thingDefs.get(m?.def.id ?? '')?.text ?? '' };
  });
  const placeOf = new Map(r.offers().map((o) => [o.id, o.place]));
  const offers: OfferView[] = t.cards().map((c) => ({ card: c, at: atOf(home, placeOf.get(c.id) ?? home) }));
  const liveOffers = new Map(r.liveRunning().map((o) => [o.id, o]));
  const live: LiveView[] = t.liveEvents().map((ev) => {
    const o = liveOffers.get(ev.id);
    const hz = o ? r.liveOf(o)?.hazard : undefined;
    return { ev, at: atOf(home, o?.place ?? home), raid: ev.template === 'raid', hazard: !hz ? null : hz.kind === 'front' ? hz.liquid : 'fire' };
  });
  const facs = packFactions(w);
  const partners = new Set(r.partners().map((p) => p.id));
  const centre = w.settlement(home)!.at;
  const far: FarView[] = farThings(w, t.packs, home)
    .filter((x) => x.at)
    .map((x) => {
      const ps = w.settlement(x.id) ? placeState(w, x.id) : null;
      return { id: x.id, name: x.name, dx: x.at![0] - centre[0], dy: x.at![1] - centre[1], look: farLook(x.tags, ps?.conditions ?? [], facs), partner: partners.has(x.id) };
    });
  const ps = t.pieces();
  const count = (k: 'crew' | 'soldier') => ({ free: ps.filter((p) => p.kind === k && p.where === 'free').length, all: ps.filter((p) => p.kind === k).length });
  const homeConds = (w.facts.entity(home)?.tags ?? []).filter((x) => x.scope === 'condition' && !!x.value).map((x) => x.key);
  const signs = signsOf(homeConds);
  const homeThing = things.find((x) => x.id === home);
  // (`built:<card>`: what a run built, written on the town for later runs — drawn as the buildings, not as words)
  const homeMarks = [...homeConds.filter((k) => !(signs as string[]).includes(k)), ...(homeThing?.tags ?? []).filter((k) => !['town', 'home', 'wall', 'garrison', 'unrest', 'crewed', 'manned'].includes(k))].filter((k) => !k.startsWith('built')).map(words);
  const workSite = new Map(works.map((x) => [x.id, x.site]));
  const offerSite = new Map(r.engine.running().map((o) => [o.id, siteOf(home, o.place)]));
  // (a crew on a project works at the project's site, whether it raises a building or not: "see workers working")
  const pieces = ps.map((p) => ({ kind: p.kind, where: p.where, on: p.on, site: p.where === 'posted' ? (workSite.get(p.on ?? '') ?? null) : p.where === 'project' ? (offerSite.get(p.on ?? '') ?? null) : null }));
  const st = r.standingThreat();
  const nums = r.runNumbers();
  const raidCard = st && st.template === 'pay-raiders' ? st : null;
  const meetNow = military(led) ? (ps.filter((p) => p.kind === 'soldier' && (p.where === 'free' || p.where === 'posted')).length) * 3 : 0;
  return {
    season: Math.min(r.season, r.seasons),
    seasons: r.seasons,
    run: t.run,
    over: t.over,
    leader: r.leader.name,
    pools: t.poolViews(),
    crews: count('crew'),
    soldiers: count('soldier'),
    sites,
    works,
    offers,
    live,
    far,
    signs,
    pieces,
    homeMarks,
    raid: raidCard ? { title: raidCard.title, left: raidCard.left, raiders: raidersOf(RAIDERS, r.laws()), meet: nums.raid ? nums.soldiers : meetNow, military: military(led) } : null,
    built: [...led.built],
    walls: led.built.includes('walls') && !sites.gate.look.ruined,
  };
}
