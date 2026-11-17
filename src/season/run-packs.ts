// (loop round 8; docs/SYSTEMS.md 3c) Outside-authored packs (packs/load.ts, docs/design/PACK_FORMAT.md) in the 3D
// game: the same loader, helpers and Realm options the card table gives its Realm (table/game.ts), and the read-only
// views the town's screens show — laws in force, the rules and what each lacks, the world's record by place, the pack
// things standing at the town's sites, and what the world is now at a run's start. No DOM, no scene: scenes/level/
// loop.ts calls these and season/run-ui.ts draws them.
// (BACKLOG LS-84: the card table's Table still has its own copies of the view code; one should call the other.)
import type { WorldSnapshot } from '../api/contracts/world';
import { MemoryWorldState } from '../api/contracts/world-state';
import type { EntityId } from '../api/contracts/facts';
import { lawKind, type LawKind, type Mech } from '../living/laws';
import { SPELL_MECH } from '../living/live';
import type { RuleHit, RuleMissing } from '../living/rules';
import { FactWorld } from '../living/world';
import { placeStates } from '../mutate/facts';
import { checkTogether, reportText, type Pack, type PackAbility } from '../packs/check';
import { farThings, homeOf, isOpen, lawThings, leaderFits, linkPacks, loadPack, notYetFound, OPENED, packHelpers, packMech, packThings, seedFactions, tradeThings, UNLOCKED, withPackThings, type LoadedPack, type PackHost } from '../packs/load';
import type { PackLeader } from '../packs/check';
import { BETWEEN } from './realm-between';
import type { Pools } from './ledger';
import * as TW from '../table/words';
import { lawText, lawUntil } from './law-words';
import { pools, type Pool, type SeasonLedger } from './ledger';
import { CATALOG } from './catalog';
import { FIRE_TEMPLATE } from './realm-events';
import { projectTemplate, siteId, SITES, WORLD_TEMPLATES, type SiteKey } from './realm-templates';
import { CARD_DONE, CARD_LAPSED, recordOf, type Realm, type RealmOptions } from './realm';

/** the ids of the base game's cards (a pack's may not clash with them; table/game.ts baseCards) */
const baseCards = (): string[] => [...CATALOG.map(projectTemplate).filter((t) => t !== null).map((t) => t!.id), ...WORLD_TEMPLATES.map((t) => t.id), FIRE_TEMPLATE.id];

/** the packs packs/ ships, by name (`&packs=laws,glitter,arena`): part of the build (each its own small chunk), so a
 *  built page has them as the dev server does */
const SHIPPED = import.meta.glob('../../packs/*.json', { import: 'default' }) as Record<string, () => Promise<Pack>>;

/**
 * The packs a page asks for: `&packs=<name>[,<name>]` (packs/ in the repo) and `&pack=<url>[,<url>]` (fetched as
 * JSON). One that cannot be found or read is a line of `errors` and is left out.
 */
export async function fetchPacks(params: URLSearchParams): Promise<{ json: Pack[]; errors: string[] }> {
  const json: Pack[] = [];
  const errors: string[] = [];
  for (const n of (params.get('packs') ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const get = SHIPPED[`../../packs/${n}.json`];
    if (!get) errors.push(`There is no pack "${n}" in packs/. There are: ${Object.keys(SHIPPED).map((k) => k.replace(/^.*\/|\.json$/g, '')).join(', ')}.`);
    else json.push(structuredClone(await get()));
  }
  const urls = (params.get('pack') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const u of urls) {
    try {
      const r = await fetch(u);
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      json.push((await r.json()) as Pack);
    } catch (e) {
      errors.push(`The pack ${u} could not be read: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { json, errors };
}

/**
 * The packs loaded and joined. A pack with errors is left out with its report (the base game plays without it); the
 * packs together are checked too — with an error there, none is played.
 */
export function loadRunPacks(json: readonly Pack[]): { packs: LoadedPack[]; played: Pack[]; report: string[] } {
  const report: string[] = [];
  const base = baseCards();
  const packs: LoadedPack[] = [];
  const played: Pack[] = [];
  for (const p of json) {
    try {
      packs.push(loadPack(p, { cards: base, boost: true }));
      played.push(p);
    } catch (e) {
      report.push(e instanceof Error ? e.message : String(e));
    }
  }
  const together = checkTogether(played);
  if (together.some((x) => x.level === 'error')) {
    report.push(reportText('The packs together', together));
    return { packs: [], played: [], report };
  }
  linkPacks(packs);
  return { packs, played, report };
}

/**
 * The Realm's options for the packs (RealmOptions.extra): the same the card table gives (table/game.ts), over this
 * game's home town. `realm` is the Realm once made (it deals once while it is made, before it can be read).
 */
export function realmExtra(packs: readonly LoadedPack[], played: readonly Pack[], realm: () => Realm | null, o: { home: EntityId; ledger: () => SeasonLedger; leader: string; deckOut?: PackLeader['deck_out'] }): NonNullable<RealmOptions['extra']> {
  const host: PackHost = {
    season: () => realm()?.season ?? 1,
    pool: (k) => pools(realm()?.ledger ?? o.ledger())[k as Pool] ?? 0,
    leader: () => o.leader,
    home: () => o.home,
    tags: (where) => {
      const r = realm();
      return r ? r.things().filter((t) => t.town === o.home && (where === 'town') === (t.id === o.home)).map((t) => [...t.tags]) : [];
    },
    began: () => {
      const r = realm();
      return r ? r.w.turn - r.season + 1 : 0;
    },
    thingTags: (id) => realm()?.things().find((t) => t.id === id)?.tags ?? null,
  };
  return {
    templates: packs.flatMap((p) => p.templates),
    helpers: packHelpers(packs, host),
    rules: packs.flatMap((p) => p.rules),
    things: (things) => {
      const r = realm();
      return r ? withPackThings(r.w, packs, things, o.home) : things;
    },
    laws: packs.flatMap((p) => p.laws),
    lawThings: () => {
      const r = realm();
      return r ? lawThings(r.w, packs, o.home) : [];
    },
    recordLaws: packs.flatMap((p) => p.recordLaws),
    tradeThings: () => {
      const r = realm();
      return r ? tradeThings(r.w, packs, o.home) : [];
    },
    // (loop round 10, card-table round 5: the packs' between-runs entries, after the base game's)
    between: packs.flatMap((p) => p.between),
    seed: (w) => seedFactions(w, [...played]),
    // (ages: a pack leader's start takes cards out of the deck)
    ...(o.deckOut ? { deckOut: o.deckOut } : {}),
  };
}

// ---- views ------------------------------------------------------------------------------------------------------

export interface LawLine {
  name: string;
  kind: LawKind;
  text: string;
  from: string;
  until: string;
  times: number;
}

/** a card's title by its id */
const cardTitle = (r: Realm, id: string): string => r.engine.templates.find((t) => t.id === id)?.title ?? id;
const lawNames = (r: Realm) => ({ rule: (id: string) => r.ruleView().rules.find((x) => x.id === id)?.name ?? r.rulesBefore().find((x) => x.id === id)?.name ?? id, card: (id: string) => cardTitle(r, id) });

/** the laws in force, in the order they came; the same law from the same maker once, with a count (Table.laws) */
export function lawLines(r: Realm): LawLine[] {
  const out: LawLine[] = [];
  const names = lawNames(r);
  for (const { def, at } of r.lawsInForce()) {
    const until = 'thing' in at.source && at.source.thing.startsWith('record:') ? TW.LAW_AFTER : lawUntil(at.source, r.w.turn, (id) => r.things().find((t) => t.id === id)?.name ?? id);
    const same = out.find((x) => x.name === def.name && x.from === at.from && x.until === until);
    if (same) same.times++;
    else out.push({ name: def.name, kind: lawKind(def.does), text: lawText(def.does, names), from: at.from, until, times: 1 });
  }
  return out;
}

/** a law by id, in one line */
export function lawLine(r: Realm, id: string): string {
  const d = r.lawDef(id);
  return d ? TW.lawLine(d.name, lawText(d.does, lawNames(r))) : id;
}

export interface RuleLine {
  name: string;
  says: string;
  when: string;
  /** what it lacks, that it is ready, or that a law turned it off */
  why: string;
  ready: boolean;
  fired: string[];
  laws: string[];
  off: boolean;
}

/** every synergy rule: fired since the last season's end, ready, or the one thing it lacks (Table.rules) */
export function ruleLines(r: Realm, recent: readonly RuleHit[]): RuleLine[] {
  const book = r.rules;
  const view = r.ruleView();
  const lawName = (id: string) => r.lawDef(id)?.name ?? id;
  const title = (id: string) => cardTitle(r, id);
  const live = book.rules.map((x): RuleLine => {
    const c = book.check(x);
    const fired = recent.filter((h) => h.rule === x.id).map((h) => `${h.text}.`);
    const spent = !c.ok && c.missing?.kind === 'spent' && fired.length > 0;
    return { name: x.name, says: TW.ruleSays(x, title, lawName), when: TW.ruleWhen(x.on), fired, ready: c.ok, why: c.ok ? TW.ruleReady(x.on, c.things ?? []) : spent ? TW.RULE_SPENT : TW.whyNot(c.missing as RuleMissing), laws: [...new Set(view.changed[x.id] ?? [])], off: false };
  });
  const off = r.rulesBefore().filter((x) => view.off[x.id]).map((x): RuleLine => ({ name: x.name, says: TW.ruleSays(x, title, lawName), when: TW.ruleWhen(x.on), fired: [], ready: false, why: TW.ruleOff(view.off[x.id]), laws: [view.off[x.id]], off: true }));
  return [...live, ...off];
}

/** a rule's firing as the table words it: the rule that had set the card going → what happened → this rule */
export function chainLine(h: RuleHit): string {
  const what = h.act || h.after ? (h.what ? h.what.charAt(0).toUpperCase() + h.what.slice(1) : undefined) : undefined;
  return TW.chainLine(h.after, what, TW.ruleLine(h.name, h.text));
}

/** the record of every card resolved or run out in this world, by place (Table.record); `home`: the town's own name */
export function recordByPlace(w: FactWorld, home: EntityId, town: string): { place: string; lines: string[] }[] {
  const by = new Map<string, string[]>();
  for (const e of recordOf(w)) {
    const place = e.place === home ? town : w.name(e.place);
    by.set(place, [...(by.get(place) ?? []), TW.recordLine(e.run, e.leader, e.title, e.result)]);
  }
  return [...by].map(([place, lines]) => ({ place, lines }));
}

/** a saved world as a fact world, to read before a run begins */
export function worldOf(s: WorldSnapshot): FactWorld {
  return new FactWorld(MemoryWorldState.restore(structuredClone(s)));
}

/**
 * What the world is now, for the run-start screen: how the last run ended and by what, the laws an earlier run left
 * in force, and how many far towns stand. Read from the saved world (no run is under way yet).
 */
export function worldNow(w: FactWorld, packs: readonly LoadedPack[], home: EntityId): string[] {
  const out: string[] = [];
  const ended = w.facts.events({ kind: 'run-ended' }).at(-1);
  if (ended) out.push(`The last run ended: ${ended.note}.`);
  const rec = recordOf(w);
  for (const x of packs.flatMap((p) => p.recordLaws)) {
    const e = rec.filter((y) => y.card === x.card).at(-1);
    if (!e) continue;
    for (const id of x.laws) {
      const def = packs.flatMap((p) => p.laws).find((l) => l.id === id);
      if (def) out.push(`A law since "${e.title}" (run ${e.run}): ${def.name}.`);
    }
  }
  const states = placeStates(w).filter((s) => s.id !== home);
  const gone = states.filter((s) => s.status === 'abandoned' || s.status === 'destroyed').length;
  if (gone) out.push(`${gone} of ${states.length} far towns are empty or ruined.`);
  return out;
}

// ---- (loop round 10) a run's start, one copy for both front ends (BACKLOG LS-84) ---------------------------------------

/** a leader the start screen shows: one the player can pick, or a locked one with its hint (`locked`), or a pack leader
 *  who plays from a far town (`home`: the town, null when they play from the town the run would start in) */
export interface LeaderChoice {
  id: string;
  name: string;
  line: string;
  pools: Partial<Pools>;
  income: Partial<Pools>;
  /** locked: the hint of how to open it (`""`: no hint written); null: open */
  locked: string | null;
  home: EntityId | null;
  pack: PackLeader | null;
}

/**
 * (ages, draft 8; Table.leaders) Who the player can be in this world: the base leaders and each pack leader whose
 * `appears_when` the world fits and, for one who plays from a far town, while one fits (`can`: a town this front end
 * can play from). A fitting pack leader that `replaces` hides the base leaders. Locked pack leaders are listed with
 * their hint and cannot be picked (the unlock model: never offered until a run of the world opened them).
 */
export function leaderChoices(w: FactWorld, played: readonly Pack[], base: readonly { id: string; name: string; line: string; pools: Partial<Pools>; income: Partial<Pools> }[], home: EntityId, can: (id: EntityId) => boolean = () => true): LeaderChoice[] {
  const all = played.flatMap((p) => p.leaders ?? []);
  const fitting = all.filter((l) => leaderFits(w, l, home));
  const open = fitting.filter((l) => isOpen(w, played, l.id) && (!l.home || homeOf(w, l, home, can) !== null));
  const asChoice = (l: PackLeader, locked: string | null): LeaderChoice => ({ id: l.id, name: l.name, line: l.line, pools: { ...l.pools } as Partial<Pools>, income: { ...(l.income ?? {}) } as Partial<Pools>, locked, home: l.home && !locked ? homeOf(w, l, home, can) : null, pack: l });
  const baseList = open.some((l) => l.replaces) ? [] : base.map((l) => ({ ...l, locked: null, home: null, pack: null }));
  const locked = all.filter((l) => !isOpen(w, played, l.id)).map((l) => asChoice(l, l.hint ?? ''));
  return [...baseList, ...open.map((l) => asChoice(l, null)), ...locked];
}

/** (draft 8; Table.opened) what this world has unlocked, oldest first: the content, the card that opened it (read from
 *  the record: the card's own record event names the offer), and the turn */
export function openedLines(r: Realm): { id: string; turn: number; line: string }[] {
  const f = r.w.facts;
  const done = f.events().filter((e) => (e.kind.startsWith(CARD_DONE) || e.kind === CARD_LAPSED) && !!e.about?.opp);
  return f.events({ kind: OPENED }).map((e) => {
    const cause = e.about?.opp ?? '';
    const by = done.find((d) => cause === d.about!.opp || cause.startsWith(`${d.about!.opp}:`))?.note ?? cause;
    return { id: e.about?.thing ?? '', turn: e.turn, line: TW.newLater(e.note, by) };
  });
}

/**
 * (ages, draft 8; Table.worldNow) The world as this run finds it, for the run's start: which run and who leads; how
 * each earlier run ended; a run played from another town; what moved while nobody played ("While you were gone"); the
 * far towns and the town; the laws earlier runs left; what earlier runs opened; what is still to find.
 */
export function startLines(r: Realm, packs: readonly LoadedPack[], played: readonly Pack[], o: { run: number; leaderLine: string; movedFrom: EntityId | null }): string[] {
  const w = r.w;
  const home = r.home;
  const out = [TW.worldRun(o.run, r.leader.name, o.leaderLine)];
  const runs = w.facts.events({ kind: 'run-began' });
  for (const e of w.facts.events({ kind: 'run-ended' })) {
    const n = runs.filter((x) => x.turn <= e.turn).length;
    if (n < o.run) out.push(TW.worldEnded(n, e.note));
  }
  if (o.movedFrom) out.push(TW.homeLine(w.name(home), w.name(o.movedFrom)));
  const t0 = w.turn - r.season;
  for (const e of w.facts.events({ kind: BETWEEN })) if (e.turn === t0) out.push(TW.whileGone(e.note));
  const far = farThings(w, packs, home).filter((t) => t.tags.includes('far-town'));
  const count = (s: string) => far.filter((t) => t.tags.includes(s)).length;
  const ruins = SITES.filter((s) => r.things().find((t) => t.id === siteId(home, s.key))?.tags.includes('ruined')).length;
  const signs = ['ashfall', 'darkness', 'deadrise', 'crime'].filter((k) => !!w.facts.tag(home, 'condition', k)?.value);
  out.push(TW.worldState({ far: far.length, destroyed: count('destroyed') + count('abandoned'), yours: far.filter((t) => t.tags.includes('yours') && t.tags.includes('standing')).length, held: far.filter((t) => !t.tags.includes('yours') && t.tags.includes('standing')).length, ruins, of: SITES.length, signs }));
  const after = lawLines(r).filter((l) => l.until === TW.LAW_AFTER).map((l) => l.name);
  if (after.length) out.push(TW.worldLaws([...new Set(after)]));
  const opened = openedLines(r).filter((x) => x.turn <= t0);
  if (opened.length) out.push(TW.worldOpened(opened.map((x) => x.line)));
  const missing = notYetFound(w, played);
  if (missing.length) out.push(TW.notFound(missing.flatMap((x) => (x.hint ? [x.hint] : [])), missing.filter((x) => !x.hint).length));
  return out;
}

export interface ThingMark {
  id: EntityId;
  /** the pack thing's own id (its art, its card) */
  def: string;
  name: string;
  site: SiteKey | null;
  ruined: boolean;
  tags: string[];
  text: string;
  image?: string;
}

/** the pack things in play and their remains, each at the site of the home town it stands at (null: the town) */
export function thingMarks(r: Realm, packs: readonly LoadedPack[]): ThingMark[] {
  const things = new Map(r.things().map((t) => [t.id, t]));
  return packThings(r.w, packs, r.home).map((t) => {
    const site = t.site ? ((r.w.facts.entity(t.site)?.attrs?.site as SiteKey | undefined) ?? null) : null;
    const now = things.get(t.id);
    const tags = (now?.tags ?? t.def.tags).filter((x) => !x.startsWith('is:'));
    return { id: t.id, def: t.def.id, name: t.def.name, site, ruined: tags.includes('ruined'), tags, text: t.def.text, ...((t.def as { image?: string }).image ? { image: (t.def as { image?: string }).image } : {}) };
  });
}

/** the pack abilities this run has unlocked (Table.unlocked: read from this run's history) */
export function unlockedAbilities(r: Realm, packs: readonly LoadedPack[]): PackAbility[] {
  const all = packs.flatMap((p) => p.abilities);
  const ids = new Set(r.history().filter((e) => e.kind.startsWith(UNLOCKED)).map((e) => e.kind.slice(UNLOCKED.length)));
  return all.filter((a) => ids.has(a.id));
}

/** what one cast of each spell and pack ability does in an event, with the laws in force */
export function mechOf(r: Realm, packs: readonly LoadedPack[]): Mech {
  return r.spellMech({ ...SPELL_MECH, ...packMech(packs) });
}
