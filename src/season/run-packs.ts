// (loop round 8; docs/SYSTEMS.md 3c) Outside-authored packs (packs/load.ts, docs/design/PACK_FORMAT.md) in the 3D
// game: the same loader, helpers and Realm options the card table gives its Realm (table/game.ts), and the read-only
// views the town's screens show — laws in force, the rules and what each lacks, the world's record by place, the pack
// things standing at the town's sites, and what the world is now at a run's start. No DOM, no scene: scenes/level/
// loop.ts calls these and season/run-ui.ts draws them.
// (BACKLOG LS-84: the card table's Table still has its own copies of the view code; one should call the other.)
import type { WorldSnapshot } from '../api/contracts/world';
import { MemoryWorldState } from '../api/contracts/world-state';
import type { EntityId } from '../api/contracts/facts';
import { lawKind, type LawKind } from '../living/laws';
import { SPELL_MECH } from '../living/live';
import type { RuleHit, RuleMissing } from '../living/rules';
import { FactWorld } from '../living/world';
import { placeStates } from '../mutate/facts';
import { checkTogether, reportText, type Pack, type PackAbility } from '../packs/check';
import { lawThings, linkPacks, loadPack, packHelpers, packMech, packThings, seedFactions, tradeThings, UNLOCKED, withPackThings, type LoadedPack, type PackHost } from '../packs/load';
import * as TW from '../table/words';
import { lawText, lawUntil } from './law-words';
import { pools, type Pool, type SeasonLedger } from './ledger';
import { CATALOG } from './catalog';
import { FIRE_TEMPLATE } from './realm-events';
import { projectTemplate, WORLD_TEMPLATES, type SiteKey } from './realm-templates';
import { recordOf, type Realm, type RealmOptions } from './realm';

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
export function realmExtra(packs: readonly LoadedPack[], played: readonly Pack[], realm: () => Realm | null, o: { home: EntityId; ledger: () => SeasonLedger; leader: string }): NonNullable<RealmOptions['extra']> {
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
      return r ? lawThings(r.w, packs) : [];
    },
    recordLaws: packs.flatMap((p) => p.recordLaws),
    tradeThings: () => {
      const r = realm();
      return r ? tradeThings(r.w, packs) : [];
    },
    seed: (w) => seedFactions(w, [...played]),
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
  return packThings(r.w, packs).map((t) => {
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
export function mechOf(r: Realm, packs: readonly LoadedPack[]): Record<string, { kills?: number; douses?: number }> {
  return r.spellMech({ ...SPELL_MECH, ...packMech(packs) });
}
