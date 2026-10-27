// The session story's validator (round 84, docs/GM.md): checks a SessionStory (src/api/contracts/story.ts)
// against its types and the world it was written from (a WorldSnapshot, or the world wiki holding one).
// Returns every problem found, as lines; none means the story can be played. No fixing, no defaults: a
// story with problems goes back to the GM (scripts/storycheck.mjs exits non-zero).
//
// What it checks:
//  - shapes: every field's type, no missing fields, no fields story.ts doesn't have (no prose outside them);
//  - references: regions and factions in the snapshot, settlements in their region, locations, rooms,
//    cast, dialogs, nodes, choices, objectives; locks with keys, keys for locks;
//  - names: an item is spelled one way; an item a condition or a key needs is given somewhere; a flag a
//    condition needs is set somewhere;
//  - play: by a fixed point over what can happen (an over-approximation: it doesn't know choices exclude
//    each other) every dialog node can be reached, every objective shown and done, every happening fired,
//    every room of a location reached through its locks; a run can be won and lost; something changes
//    the world (an AtlasEvent).
// (Node runs it too — scripts/storycheck.mjs — so it imports only types.)

import type { AtlasEventKind, WorldSnapshot } from '../api/contracts/world';
import type { Condition, Outcome, SessionStory } from '../api/contracts/story';

export const ATLAS_EVENT_KINDS = [
  'sink', 'raise', 'bury', 'overgrow', 'freeze', 'thaw', 'storm', 'clear-storm', 'shadow', 'light',
  'raise-dead', 'lay-dead', 'flood', 'drain', 'burn', 'ruin', 'rebuild', 'faction-presence', 'faction-attitude', 'mark',
] as const satisfies readonly AtlasEventKind[];
/** (a compile error here: world.ts has a kind the list above lacks) */
export const ATLAS_EVENT_KINDS_COMPLETE: [Exclude<AtlasEventKind, (typeof ATLAS_EVENT_KINDS)[number]>] extends [never] ? true : false = true;

const CONDITION_KINDS = ['any', 'talked', 'chose', 'has', 'reached', 'killed', 'event', 'objective', 'flag', 'time', 'saw'] as const satisfies readonly Condition['kind'][];
export const CONDITION_KINDS_COMPLETE: [Exclude<Condition['kind'], (typeof CONDITION_KINDS)[number]>] extends [never] ? true : false = true;
const SIM_EVENTS = ['collapsed', 'flooded', 'burned', 'built', 'dug'];
const STORMS = ['rain', 'dust', 'snow', 'ash', 'arcane'];
const BURY = ['ash', 'sand', 'silt'];
const ROOM_SIZES = ['small', 'medium', 'large'];
const ID = /^[a-z0-9][a-z0-9-]*$/;

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface CheckWorld {
  snapshot: WorldSnapshot;
  /** each region's ground (wiki regions[].ground): floods are checked against it when given */
  ground?: (region: number) => { min: number; max: number } | undefined;
  sea?: number;
}

/** The world a story is checked against, from a world wiki (data/wiki/*.json) or a bare WorldSnapshot. */
export function checkWorldFrom(json: unknown): CheckWorld {
  if (isObj(json) && isObj(json.snapshot)) {
    const w = json as { snapshot: WorldSnapshot; regions?: { id: number; ground?: { min: number; max: number } }[]; world?: { sea: number } };
    const g = new Map((w.regions ?? []).map((r) => [r.id, r.ground]));
    return { snapshot: w.snapshot, ground: (id) => g.get(id), sea: w.world?.sea };
  }
  if (isObj(json) && Array.isArray(json.regions) && Array.isArray(json.factions)) return { snapshot: json as unknown as WorldSnapshot };
  throw new Error('storycheck: the world is neither a world wiki ({snapshot, …}) nor a WorldSnapshot');
}

export function checkStory(input: unknown, world: CheckWorld): string[] {
  const P: string[] = [];
  const bad = (at: string, msg: string) => P.push(`${at}: ${msg}`);
  const snap = world.snapshot;
  const regionIds = new Set(snap.regions.map((r) => r.id));
  const factionIds = new Set(snap.factions.map((f) => f.id));
  const settlementRegion = new Map<string, number>();
  for (const r of snap.regions) for (const s of r.settlements) settlementRegion.set(s, r.id);

  // ---- shapes ----------------------------------------------------------------------------------------
  const keys = (at: string, o: J, req: string[], opt: string[] = []) => {
    for (const k of req) if (!(k in o)) bad(at, `missing "${k}"`);
    for (const k of Object.keys(o)) if (!req.includes(k) && !opt.includes(k)) bad(at, `"${k}" isn't a field of this type (no prose outside the fields)`);
  };
  const str = (at: string, v: unknown, nonEmpty = true) => {
    if (typeof v !== 'string') return bad(at, `expected a string, got ${JSON.stringify(v)}`), false;
    if (nonEmpty && !v.trim()) return bad(at, 'is empty'), false;
    return true;
  };
  const num = (at: string, v: unknown, lo = -Infinity, hi = Infinity) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return bad(at, `expected a number, got ${JSON.stringify(v)}`), false;
    if (v < lo || v > hi) return bad(at, `${v} is outside ${lo}..${hi}`), false;
    return true;
  };
  const int = (at: string, v: unknown, lo = 1) => num(at, v, lo) && (Number.isInteger(v) || (bad(at, `${v} isn't a whole number`), false));
  const arr = (at: string, v: unknown): unknown[] => {
    if (!Array.isArray(v)) return bad(at, `expected an array, got ${JSON.stringify(v)}`), [];
    return v;
  };
  const id = (at: string, v: unknown) => str(at, v) && (ID.test(v as string) || (bad(at, `id "${v}" should be lowercase letters, digits and dashes`), false));

  if (!isObj(input)) return [`story: expected an object`];
  const s = input as J;
  keys('story', s, ['id', 'title', 'premise', 'from', 'locations', 'cast', 'dialogs', 'objectives', 'happenings']);
  id('story.id', s.id);
  str('story.title', s.title);
  str('story.premise', s.premise);
  if (isObj(s.from)) {
    keys('story.from', s.from, ['worldVersion', 'run', 'seed']);
    if (s.from.worldVersion !== snap.version) bad('story.from.worldVersion', `${s.from.worldVersion}, but the snapshot is version ${snap.version}`);
    if (s.from.run !== snap.run) bad('story.from.run', `${s.from.run}, but the snapshot's run to come is ${snap.run}`);
    if (int('story.from.seed', s.from.seed, 0) && s.from.seed !== snap.seed) bad('story.from.seed', `${s.from.seed}, but the world's seed is ${snap.seed}`);
  } else bad('story.from', 'expected an object');

  const locations = arr('story.locations', s.locations).filter(isObj);
  const cast = arr('story.cast', s.cast).filter(isObj);
  const dialogs = arr('story.dialogs', s.dialogs).filter(isObj);
  const objectives = arr('story.objectives', s.objectives).filter(isObj);
  const happenings = arr('story.happenings', s.happenings).filter(isObj);

  const allIds = new Map<string, string>();
  const unique = (at: string, v: unknown, what: string) => {
    if (typeof v !== 'string') return;
    if (allIds.has(v)) bad(at, `id "${v}" is used twice (also ${allIds.get(v)}); ids are unique across the story`);
    else allIds.set(v, what);
  };
  const locById = new Map<string, J>();
  const roomsOf = new Map<string, Set<string>>();
  locations.forEach((l, i) => {
    const at = `locations[${i}](${l.id})`;
    keys(at, l, ['id', 'name', 'region', 'kind', 'brief'], ['settlement']);
    id(`${at}.id`, l.id);
    unique(at, l.id, 'a location');
    str(`${at}.name`, l.name);
    str(`${at}.kind`, l.kind);
    if (!regionIds.has(l.region as number)) bad(`${at}.region`, `region ${JSON.stringify(l.region)} isn't in the snapshot`);
    if (l.settlement !== undefined) {
      if (!settlementRegion.has(l.settlement as string)) bad(`${at}.settlement`, `settlement ${JSON.stringify(l.settlement)} isn't in the snapshot`);
      else if (settlementRegion.get(l.settlement as string) !== l.region) bad(`${at}.settlement`, `${l.settlement} stands in region ${settlementRegion.get(l.settlement as string)}, not ${l.region}`);
    }
    locById.set(l.id as string, l);
    const rooms = new Set<string>();
    roomsOf.set(l.id as string, rooms);
    if (!isObj(l.brief)) return bad(`${at}.brief`, 'expected an object');
    const b = l.brief;
    keys(`${at}.brief`, b, [], ['rooms', 'connections', 'keys', 'landmarks', 'hazards']);
    arr(`${at}.brief.rooms`, b.rooms ?? []).forEach((r, j) => {
      const ra = `${at}.brief.rooms[${j}]`;
      if (!isObj(r)) return bad(ra, 'expected an object');
      keys(ra, r, ['id', 'kind'], ['size']);
      if (id(`${ra}.id`, r.id)) {
        if (rooms.has(r.id as string)) bad(ra, `room "${r.id}" twice`);
        rooms.add(r.id as string);
      }
      str(`${ra}.kind`, r.kind);
      if (r.size !== undefined && !ROOM_SIZES.includes(r.size as string)) bad(`${ra}.size`, `${JSON.stringify(r.size)} isn't one of ${ROOM_SIZES.join(', ')}`);
    });
    for (const k of ['landmarks', 'hazards']) arr(`${at}.brief.${k}`, b[k] ?? []).forEach((x, j) => str(`${at}.brief.${k}[${j}]`, x));
  });
  const castById = new Map<string, J>();
  cast.forEach((c, i) => {
    const at = `cast[${i}](${c.id})`;
    keys(at, c, ['id', 'name', 'role', 'faction', 'location', 'disposition', 'voice', 'wants', 'knows'], ['room']);
    id(`${at}.id`, c.id);
    unique(at, c.id, 'a cast member');
    for (const k of ['name', 'role', 'voice', 'wants']) str(`${at}.${k}`, c[k]);
    if (c.faction !== null && !factionIds.has(c.faction as string)) bad(`${at}.faction`, `faction ${JSON.stringify(c.faction)} isn't in the snapshot (null: none)`);
    if (!locById.has(c.location as string)) bad(`${at}.location`, `location ${JSON.stringify(c.location)} isn't one of the story's`);
    else if (c.room !== undefined && !roomsOf.get(c.location as string)!.has(c.room as string)) bad(`${at}.room`, `${c.location} has no room ${JSON.stringify(c.room)}`);
    num(`${at}.disposition`, c.disposition, -1, 1);
    arr(`${at}.knows`, c.knows).forEach((k, j) => str(`${at}.knows[${j}]`, k));
    castById.set(c.id as string, c);
  });
  const dlgById = new Map<string, J>();
  dialogs.forEach((d, i) => {
    const at = `dialogs[${i}](${d.id})`;
    keys(at, d, ['id', 'speaker', 'start', 'nodes']);
    id(`${at}.id`, d.id);
    unique(at, d.id, 'a dialog');
    if (!castById.has(d.speaker as string)) bad(`${at}.speaker`, `${JSON.stringify(d.speaker)} isn't in the cast`);
    if (!isObj(d.nodes)) return bad(`${at}.nodes`, 'expected an object of nodes');
    if (!(typeof d.start === 'string' && d.start in d.nodes)) bad(`${at}.start`, `${JSON.stringify(d.start)} isn't one of its nodes`);
    dlgById.set(d.id as string, d);
  });
  const objById = new Map<string, J>();
  objectives.forEach((o, i) => {
    const at = `objectives[${i}](${o.id})`;
    keys(at, o, ['id', 'text', 'when', 'done', 'outcome'], ['location', 'failed', 'short']);
    id(`${at}.id`, o.id);
    unique(at, o.id, 'an objective');
    str(`${at}.text`, o.text);
    if (o.location !== undefined && !locById.has(o.location as string)) bad(`${at}.location`, `${JSON.stringify(o.location)} isn't one of the story's locations`);
    if (!arr(`${at}.done`, o.done).length) bad(`${at}.done`, 'is empty: it would be done the moment it shows');
    objById.set(o.id as string, o);
  });

  // ---- conditions and outcomes: their shapes and references ----------------------------------------
  const nodeOf = (dlg: string, node: string) => {
    const d = dlgById.get(dlg);
    return d && isObj(d.nodes) && isObj(d.nodes[node]) ? (d.nodes[node] as J) : undefined;
  };
  const itemsGiven = new Map<string, string>();
  const itemsNeeded: { at: string; item: string }[] = [];
  const flagsSet = new Set<string>();
  const flagsNeeded: { at: string; flag: string; value: boolean }[] = [];
  const checkCond = (at: string, c: unknown) => {
    if (!isObj(c)) return bad(at, 'expected a condition object');
    const k = c.kind as string;
    if (!CONDITION_KINDS.includes(k as Condition['kind'])) return bad(`${at}.kind`, `${JSON.stringify(k)} isn't a condition kind (${CONDITION_KINDS.join(', ')})`);
    switch (k) {
      case 'any':
        keys(at, c, ['kind', 'of']);
        if (arr(`${at}.of`, c.of).length < 2) bad(`${at}.of`, 'an "any" needs two or more conditions (one is just that condition)');
        conds(`${at}.of`, c.of ?? []);
        break;
      case 'talked':
        keys(at, c, ['kind', 'character'], ['node']);
        if (!castById.has(c.character as string)) bad(`${at}.character`, `${JSON.stringify(c.character)} isn't in the cast`);
        if (c.node !== undefined && !dialogs.some((d) => d.speaker === c.character && nodeOf(d.id as string, c.node as string))) bad(`${at}.node`, `no dialog of ${c.character} has a node ${JSON.stringify(c.node)}`);
        break;
      case 'chose': {
        keys(at, c, ['kind', 'dialog', 'node', 'choice']);
        const n = nodeOf(c.dialog as string, c.node as string);
        if (!dlgById.has(c.dialog as string)) bad(`${at}.dialog`, `${JSON.stringify(c.dialog)} isn't a dialog`);
        else if (!n) bad(`${at}.node`, `${c.dialog} has no node ${JSON.stringify(c.node)}`);
        else if (!Array.isArray(n.choices) || !Number.isInteger(c.choice) || (c.choice as number) < 0 || (c.choice as number) >= n.choices.length) bad(`${at}.choice`, `${c.dialog}.${c.node} has no choice ${JSON.stringify(c.choice)} (choices count from 0)`);
        break;
      }
      case 'has':
        keys(at, c, ['kind', 'item'], ['count']);
        if (str(`${at}.item`, c.item)) itemsNeeded.push({ at, item: c.item as string });
        if (c.count !== undefined) int(`${at}.count`, c.count);
        break;
      case 'reached':
        keys(at, c, ['kind', 'location'], ['room']);
        if (!locById.has(c.location as string)) bad(`${at}.location`, `${JSON.stringify(c.location)} isn't one of the story's locations`);
        else if (c.room !== undefined && !roomsOf.get(c.location as string)!.has(c.room as string)) bad(`${at}.room`, `${c.location} has no room ${JSON.stringify(c.room)}`);
        break;
      case 'killed':
        keys(at, c, ['kind'], ['character', 'unitKind', 'count']);
        if (c.character === undefined && c.unitKind === undefined) bad(at, 'a kill needs a character or a unitKind');
        if (c.character !== undefined && !castById.has(c.character as string)) bad(`${at}.character`, `${JSON.stringify(c.character)} isn't in the cast`);
        if (c.unitKind !== undefined) str(`${at}.unitKind`, c.unitKind);
        if (c.count !== undefined) int(`${at}.count`, c.count);
        break;
      case 'event':
        keys(at, c, ['kind', 'event'], ['location']);
        if (!SIM_EVENTS.includes(c.event as string)) bad(`${at}.event`, `${JSON.stringify(c.event)} isn't one of ${SIM_EVENTS.join(', ')}`);
        if (c.location !== undefined && !locById.has(c.location as string)) bad(`${at}.location`, `${JSON.stringify(c.location)} isn't one of the story's locations`);
        break;
      case 'objective':
        keys(at, c, ['kind', 'id', 'state']);
        if (!objById.has(c.id as string)) bad(`${at}.id`, `${JSON.stringify(c.id)} isn't an objective`);
        if (c.state !== 'done' && c.state !== 'failed') bad(`${at}.state`, `${JSON.stringify(c.state)}: done or failed`);
        else if (c.state === 'failed' && objById.has(c.id as string) && !objById.get(c.id as string)!.failed) bad(`${at}.state`, `${c.id} can't fail (it has no "failed")`);
        break;
      case 'flag':
        keys(at, c, ['kind', 'flag'], ['value']);
        if (str(`${at}.flag`, c.flag)) flagsNeeded.push({ at, flag: c.flag as string, value: c.value === undefined ? true : !!c.value });
        if (c.value !== undefined && typeof c.value !== 'boolean') bad(`${at}.value`, 'expected true or false');
        break;
      case 'time':
        keys(at, c, ['kind', 'after']);
        num(`${at}.after`, c.after, 0);
        break;
      // (round 97, heroapi) a sighting: a cast member or a place
      case 'saw':
        keys(at, c, ['kind'], ['character', 'location']);
        if ((c.character === undefined) === (c.location === undefined)) bad(at, 'saw names a character or a location');
        if (c.character !== undefined && !castById.has(c.character as string)) bad(`${at}.character`, `${JSON.stringify(c.character)} isn't in the cast`);
        if (c.location !== undefined && !locById.has(c.location as string)) bad(`${at}.location`, `${JSON.stringify(c.location)} isn't one of the story's locations`);
        break;
    }
  };
  const conds = (at: string, v: unknown) => arr(at, v).forEach((c, i) => checkCond(`${at}[${i}]`, c));
  const checkOutcome = (at: string, o: unknown) => {
    if (o === undefined) return;
    if (!isObj(o)) return bad(at, 'expected an outcome object');
    keys(at, o, [], ['atlas', 'attitude', 'flags', 'give', 'spawn', 'hostile', 'unlock', 'endRun', 'say', 'talk']);
    // (round 97, heroapi) barks and a talk as an outcome
    arr(`${at}.say`, o.say ?? []).forEach((b, i) => {
      const ba = `${at}.say[${i}]`;
      if (!isObj(b)) return bad(ba, 'expected an object');
      keys(ba, b, ['line'], ['by', 'seconds']);
      str(`${ba}.line`, b.line);
      if (b.by !== undefined && !castById.has(b.by as string)) bad(`${ba}.by`, `${JSON.stringify(b.by)} isn't in the cast`);
    });
    if (o.talk !== undefined) {
      if (!isObj(o.talk)) bad(`${at}.talk`, 'expected an object');
      else {
        keys(`${at}.talk`, o.talk, ['character'], ['node']);
        if (!dialogs.some((d) => isObj(d) && d.speaker === (o.talk as { character: string }).character)) bad(`${at}.talk.character`, 'has no dialog');
      }
    }
    arr(`${at}.hostile`, o.hostile ?? []).forEach((c, i) => {
      if (!castById.has(c as string)) bad(`${at}.hostile[${i}]`, `${JSON.stringify(c)} isn't in the cast`);
    });
    arr(`${at}.atlas`, o.atlas ?? []).forEach((e, i) => {
      const ea = `${at}.atlas[${i}]`;
      if (!isObj(e)) return bad(ea, 'expected an AtlasEvent (without id and run)');
      keys(ea, e, ['kind', 'regions', 'magnitude', 'cause'], ['area', 'detail', 'level', 'location']);
      if ('id' in e || 'run' in e) bad(ea, 'a story leaves "id" and "run" to the run');
      const k = e.kind as string;
      if (!ATLAS_EVENT_KINDS.includes(k as AtlasEventKind)) bad(`${ea}.kind`, `${JSON.stringify(k)} isn't an AtlasEvent kind (${ATLAS_EVENT_KINDS.join(', ')})`);
      const regs = arr(`${ea}.regions`, e.regions);
      if (!regs.length) bad(`${ea}.regions`, 'is empty');
      for (const r of regs) if (!regionIds.has(r as number)) bad(`${ea}.regions`, `region ${JSON.stringify(r)} isn't in the snapshot`);
      if (k === 'bury') num(`${ea}.magnitude`, e.magnitude, 0.5, 40);
      else if (k === 'faction-presence' || k === 'faction-attitude') num(`${ea}.magnitude`, e.magnitude, -1, 1);
      else num(`${ea}.magnitude`, e.magnitude, 0, 1);
      if (k === 'flood') {
        if (e.level === undefined) bad(`${ea}.level`, 'a flood needs its level (world z); its magnitude is a 0..1 strength');
        else if (num(`${ea}.level`, e.level, 0, 1000) && world.ground)
          for (const r of regs) {
            const g = world.ground(r as number);
            if (g && (e.level as number) <= g.min) bad(`${ea}.level`, `a flood at z ${e.level} stands under all of region ${r}'s ground (${g.min}..${g.max}): it floods nothing`);
            if (g && (e.level as number) > g.max + 30) bad(`${ea}.level`, `a flood at z ${e.level} is far over region ${r}'s ground (${g.min}..${g.max})`);
          }
      } else if (e.level !== undefined) bad(`${ea}.level`, `only a flood has a level (this is a ${k})`);
      if (e.location !== undefined) {
        const l = locById.get(e.location as string);
        if (!l) bad(`${ea}.location`, `${JSON.stringify(e.location)} isn't one of the story's locations`);
        else if (!regs.includes(l.region)) bad(`${ea}.location`, `${e.location} is in region ${l.region}, which the event doesn't touch (${regs.join(', ')})`);
      }
      if (e.area !== undefined) {
        if (!isObj(e.area) || !Array.isArray(e.area.at) || e.area.at.length !== 2) bad(`${ea}.area`, 'expected { at: [x, y], radius }');
        else num(`${ea}.area.radius`, e.area.radius, 1);
      }
      const d = (e.detail ?? {}) as J;
      if (e.detail !== undefined && !isObj(e.detail)) bad(`${ea}.detail`, 'expected an object');
      if (k === 'storm' && !STORMS.includes(d.storm as string)) bad(`${ea}.detail.storm`, `a storm needs detail.storm: ${STORMS.join(', ')}`);
      if (k === 'bury' && !BURY.includes(d.material as string)) bad(`${ea}.detail.material`, `a bury needs detail.material: ${BURY.join(', ')}`);
      if ((k === 'faction-presence' || k === 'faction-attitude') && !factionIds.has(d.faction as string)) bad(`${ea}.detail.faction`, `${k} needs a snapshot faction, got ${JSON.stringify(d.faction)}`);
      if ('location' in d) bad(`${ea}.detail.location`, 'a story location goes on the event itself (AtlasEvent.location)');
      if (k === 'mark') {
        str(`${ea}.detail.name`, d.name);
        str(`${ea}.detail.kind`, d.kind);
      }
      if (!isObj(e.cause)) bad(`${ea}.cause`, 'expected { by: "story", ref? }');
      else {
        keys(`${ea}.cause`, e.cause, ['by'], ['ref']);
        if (e.cause.by !== 'story') bad(`${ea}.cause.by`, `a story's events are by "story", got ${JSON.stringify(e.cause.by)}`);
        if (e.cause.ref !== undefined) str(`${ea}.cause.ref`, e.cause.ref);
      }
    });
    arr(`${at}.attitude`, o.attitude ?? []).forEach((a, i) => {
      const aa = `${at}.attitude[${i}]`;
      if (!isObj(a)) return bad(aa, 'expected an object');
      keys(aa, a, ['delta'], ['faction', 'character']);
      if ((a.faction === undefined) === (a.character === undefined)) bad(aa, 'names a faction or a character (one)');
      if (a.faction !== undefined && !factionIds.has(a.faction as string)) bad(`${aa}.faction`, `${JSON.stringify(a.faction)} isn't in the snapshot`);
      if (a.character !== undefined && !castById.has(a.character as string)) bad(`${aa}.character`, `${JSON.stringify(a.character)} isn't in the cast`);
      num(`${aa}.delta`, a.delta, -2, 2);
    });
    if (o.flags !== undefined) {
      if (!isObj(o.flags)) bad(`${at}.flags`, 'expected { name: true|false }');
      else for (const [f, v] of Object.entries(o.flags)) if (typeof v !== 'boolean') bad(`${at}.flags.${f}`, 'expected true or false');
    }
    arr(`${at}.give`, o.give ?? []).forEach((g, i) => {
      const ga = `${at}.give[${i}]`;
      if (!isObj(g)) return bad(ga, 'expected an object');
      keys(ga, g, ['item'], ['count']);
      if (str(`${ga}.item`, g.item)) itemsGiven.set(g.item as string, ga);
      if (g.count !== undefined) int(`${ga}.count`, g.count);
    });
    arr(`${at}.spawn`, o.spawn ?? []).forEach((g, i) => {
      const ga = `${at}.spawn[${i}]`;
      if (!isObj(g)) return bad(ga, 'expected an object');
      keys(ga, g, ['role', 'faction', 'location'], ['count', 'hostile', 'toward']);
      if (g.toward !== undefined && !locById.has(g.toward as string)) bad(`${ga}.toward`, `${JSON.stringify(g.toward)} isn't one of the story's locations`);
      if (g.hostile !== undefined && typeof g.hostile !== 'boolean') bad(`${ga}.hostile`, 'expected true or false');
      str(`${ga}.role`, g.role);
      if (g.faction !== null && !factionIds.has(g.faction as string)) bad(`${ga}.faction`, `${JSON.stringify(g.faction)} isn't in the snapshot (null: none)`);
      if (!locById.has(g.location as string)) bad(`${ga}.location`, `${JSON.stringify(g.location)} isn't one of the story's locations`);
      if (g.count !== undefined) int(`${ga}.count`, g.count);
    });
    arr(`${at}.unlock`, o.unlock ?? []).forEach((u, i) => {
      const ua = `${at}.unlock[${i}]`;
      if (!isObj(u)) return bad(ua, 'expected an object');
      keys(ua, u, ['dialog', 'node']);
      if (!nodeOf(u.dialog as string, u.node as string)) bad(ua, `${u.dialog}.${u.node} isn't a dialog node`);
    });
    if (o.endRun !== undefined && o.endRun !== 'won' && o.endRun !== 'lost') bad(`${at}.endRun`, `${JSON.stringify(o.endRun)}: won or lost`);
  };

  // the conditions and outcomes everywhere, and the dialogs' nodes
  dialogs.forEach((d, i) => {
    if (!isObj(d.nodes)) return;
    for (const [nid, n] of Object.entries(d.nodes)) {
      const at = `dialogs[${i}](${d.id}).nodes.${nid}`;
      if (!isObj(n)) {
        bad(at, 'expected a node object');
        continue;
      }
      keys(at, n, ['text', 'choices'], ['effects']);
      str(`${at}.text`, n.text);
      checkOutcome(`${at}.effects`, n.effects);
      arr(`${at}.choices`, n.choices).forEach((c, j) => {
        const ca = `${at}.choices[${j}]`;
        if (!isObj(c)) return bad(ca, 'expected a choice object');
        keys(ca, c, ['text'], ['to', 'requires', 'effects']);
        str(`${ca}.text`, c.text);
        if (c.to !== undefined && !(typeof c.to === 'string' && c.to in (d.nodes as J))) bad(`${ca}.to`, `${JSON.stringify(c.to)} isn't a node of ${d.id}`);
        if (c.requires !== undefined) conds(`${ca}.requires`, c.requires);
        checkOutcome(`${ca}.effects`, c.effects);
      });
    }
  });
  objectives.forEach((o, i) => {
    const at = `objectives[${i}](${o.id})`;
    conds(`${at}.when`, o.when);
    conds(`${at}.done`, o.done);
    checkOutcome(`${at}.outcome`, o.outcome);
    if (o.failed !== undefined) {
      if (!isObj(o.failed)) bad(`${at}.failed`, 'expected { when, outcome }');
      else {
        keys(`${at}.failed`, o.failed, ['when', 'outcome']);
        if (!arr(`${at}.failed.when`, o.failed.when).length) bad(`${at}.failed.when`, 'is empty: it would fail at once');
        conds(`${at}.failed.when`, o.failed.when);
        checkOutcome(`${at}.failed.outcome`, o.failed.outcome);
      }
    }
  });
  happenings.forEach((h, i) => {
    const at = `happenings[${i}]`;
    keys(at, h, ['when', 'effects']);
    if (!arr(`${at}.when`, h.when).length) bad(`${at}.when`, 'is empty');
    conds(`${at}.when`, h.when);
    checkOutcome(`${at}.effects`, h.effects);
  });
  // the locks and keys
  locations.forEach((l, i) => {
    const at = `locations[${i}](${l.id}).brief`;
    if (!isObj(l.brief)) return;
    const rooms = roomsOf.get(l.id as string)!;
    const locks = new Set<string>();
    arr(`${at}.connections`, l.brief.connections ?? []).forEach((c, j) => {
      const ca = `${at}.connections[${j}]`;
      if (!isObj(c)) return bad(ca, 'expected an object');
      keys(ca, c, ['from', 'to'], ['lock']);
      for (const k of ['from', 'to']) if (!rooms.has(c[k] as string)) bad(`${ca}.${k}`, `${JSON.stringify(c[k])} isn't a room of ${l.id}`);
      if (c.lock !== undefined && id(`${ca}.lock`, c.lock)) locks.add(c.lock as string);
    });
    const keyed = new Set<string>();
    arr(`${at}.keys`, l.brief.keys ?? []).forEach((k, j) => {
      const ka = `${at}.keys[${j}]`;
      if (!isObj(k)) return bad(ka, 'expected an object');
      keys(ka, k, ['lock', 'key']);
      if (!locks.has(k.lock as string)) bad(`${ka}.lock`, `${JSON.stringify(k.lock)} locks no connection of ${l.id}`);
      if (keyed.has(k.lock as string)) bad(`${ka}.lock`, `${k.lock} has two keys`);
      keyed.add(k.lock as string);
      if (!isObj(k.key)) return bad(`${ka}.key`, 'expected { item | character | objective }');
      keys(`${ka}.key`, k.key, [], ['item', 'character', 'objective']);
      const n = ['item', 'character', 'objective'].filter((x) => (k.key as J)[x] !== undefined).length;
      if (n !== 1) bad(`${ka}.key`, `a key is one of an item, a character or an objective (has ${n})`);
      if (k.key.item !== undefined && str(`${ka}.key.item`, k.key.item)) itemsNeeded.push({ at: `${ka}.key.item`, item: k.key.item as string });
      if (k.key.character !== undefined && !castById.has(k.key.character as string)) bad(`${ka}.key.character`, `${JSON.stringify(k.key.character)} isn't in the cast`);
      if (k.key.objective !== undefined && !objById.has(k.key.objective as string)) bad(`${ka}.key.objective`, `${JSON.stringify(k.key.objective)} isn't an objective`);
    });
    for (const lk of locks) if (!keyed.has(lk)) bad(`${at}.keys`, `lock "${lk}" has no key`);
  });
  // names: items one spelling, needed items given, needed flags set
  const spellings = new Map<string, Set<string>>();
  for (const n of [...itemsGiven.keys(), ...itemsNeeded.map((x) => x.item)]) {
    const k = n.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!spellings.has(k)) spellings.set(k, new Set());
    spellings.get(k)!.add(n);
  }
  for (const v of spellings.values()) if (v.size > 1) bad('items', `one item spelled ${v.size} ways: ${[...v].map((x) => JSON.stringify(x)).join(', ')}`);
  for (const x of itemsNeeded) if (!itemsGiven.has(x.item)) bad(x.at, `item "${x.item}" is never given (no Outcome.give has it)`);
  const flagWrites = new Map<string, Set<boolean>>();
  const noteFlags = (o: unknown) => {
    if (isObj(o) && isObj(o.flags)) for (const [f, v] of Object.entries(o.flags)) (flagWrites.get(f) ?? flagWrites.set(f, new Set()).get(f)!).add(!!v);
  };
  forEachOutcome(s, noteFlags);
  for (const x of flagsNeeded) if (x.value && !flagWrites.get(x.flag)?.has(true)) bad(x.at, `flag "${x.flag}" is never set true`);
  for (const f of flagWrites.keys()) flagsSet.add(f);
  if (P.length) return P;

  // ---- play: a fixed point over what can happen --------------------------------------------------------
  const st = s as unknown as SessionStory;
  const can = {
    items: new Set<string>(),
    flags: new Set<string>(),
    done: new Set<string>(),
    failed: new Set<string>(),
    nodes: new Set<string>(),
    chosen: new Set<string>(),
    unlocked: new Set<string>(),
    rooms: new Set<string>(),
    shown: new Set<string>(),
    fired: new Set<number>(),
    outcomes: [] as Outcome[],
  };
  const holds = (c: Condition): boolean => {
    switch (c.kind) {
      case 'talked': return st.dialogs.some((d) => d.speaker === c.character && (c.node === undefined ? can.nodes.has(`${d.id}.${d.start}`) : can.nodes.has(`${d.id}.${c.node}`)));
      case 'chose': return can.chosen.has(`${c.dialog}.${c.node}.${c.choice}`);
      case 'has': return can.items.has(c.item);
      case 'reached': return can.rooms.has(c.room === undefined ? `${c.location}.` : `${c.location}.${c.room}`);
      case 'killed': return c.character === undefined || reachedChar(c.character);
      case 'event': return c.location === undefined || can.rooms.has(`${c.location}.`);
      case 'objective': return (c.state === 'done' ? can.done : can.failed).has(c.id);
      case 'flag': return c.value === false ? true : can.flags.has(c.flag);
      case 'time': return true;
      case 'saw': return c.character !== undefined ? reachedChar(c.character) : can.rooms.has(`${c.location}.`);
      case 'any': return c.of.some(holds);
    }
  };
  const reachedChar = (ch: string) => {
    const c = st.cast.find((x) => x.id === ch);
    return !!c && can.rooms.has(c.room === undefined ? `${c.location}.` : `${c.location}.${c.room}`);
  };
  const all = (cs: Condition[] | undefined) => (cs ?? []).every(holds);
  let fireCount = 0;
  const fire = (o: Outcome | undefined) => {
    if (!o) return;
    can.outcomes.push(o);
    for (const g of o.give ?? []) can.items.add(g.item);
    for (const [f, v] of Object.entries(o.flags ?? {})) if (v) can.flags.add(f);
    for (const u of o.unlock ?? []) can.unlocked.add(`${u.dialog}.${u.node}`);
    fireCount++;
  };
  const once = new Set<string>();
  const fireOnce = (key: string, o: Outcome | undefined) => {
    if (once.has(key)) return false;
    once.add(key);
    fire(o);
    return true;
  };
  for (let changed = true, guard = 0; changed && guard < 1000; guard++) {
    changed = false;
    const before = fireCount + can.nodes.size + can.rooms.size + can.shown.size + can.chosen.size;
    // rooms: a location is reached when its first room is (its way in); a room through a connection
    // whose lock's key is had
    for (const l of st.locations) {
      const rooms = l.brief.rooms ?? [];
      if (!can.rooms.has(`${l.id}.`)) can.rooms.add(`${l.id}.`);
      if (rooms.length && !can.rooms.has(`${l.id}.${rooms[0].id}`)) can.rooms.add(`${l.id}.${rooms[0].id}`);
      for (const c of l.brief.connections ?? []) {
        const k = c.lock ? l.brief.keys?.find((x) => x.lock === c.lock)?.key : undefined;
        const open = !c.lock || (k && ((k.item && can.items.has(k.item)) || (k.character && reachedChar(k.character)) || (k.objective && can.done.has(k.objective))));
        if (!open) continue;
        if (can.rooms.has(`${l.id}.${c.from}`)) can.rooms.add(`${l.id}.${c.to}`);
        if (can.rooms.has(`${l.id}.${c.to}`)) can.rooms.add(`${l.id}.${c.from}`);
      }
    }
    // dialogs: a talk opens at its start (its speaker reached) or at an unlocked node
    for (const d of st.dialogs) {
      if (!reachedChar(d.speaker)) continue;
      const open = [d.start, ...Object.keys(d.nodes).filter((n) => can.unlocked.has(`${d.id}.${n}`))];
      const queue = open.filter((n) => !can.nodes.has(`${d.id}.${n}`));
      for (const n of open) can.nodes.add(`${d.id}.${n}`);
      for (const n of Object.keys(d.nodes)) if (can.nodes.has(`${d.id}.${n}`)) queue.push(n);
      while (queue.length) {
        const n = queue.pop()!;
        const node = d.nodes[n];
        fireOnce(`node ${d.id}.${n}`, node.effects);
        node.choices.forEach((c, j) => {
          if (!all(c.requires)) return;
          can.chosen.add(`${d.id}.${n}.${j}`);
          fireOnce(`choice ${d.id}.${n}.${j}`, c.effects);
          if (c.to && !can.nodes.has(`${d.id}.${c.to}`)) {
            can.nodes.add(`${d.id}.${c.to}`);
            queue.push(c.to);
          }
        });
      }
    }
    for (const o of st.objectives) {
      if (!all(o.when)) continue;
      can.shown.add(o.id);
      if (all(o.done) && !can.done.has(o.id)) (can.done.add(o.id), fire(o.outcome));
      if (o.failed && all(o.failed.when) && !can.failed.has(o.id)) (can.failed.add(o.id), fire(o.failed.outcome));
    }
    st.happenings.forEach((h, i) => {
      if (!can.fired.has(i) && all(h.when)) (can.fired.add(i), fire(h.effects));
    });
    changed = fireCount + can.nodes.size + can.rooms.size + can.shown.size + can.chosen.size !== before;
  }
  for (const d of st.dialogs) for (const n of Object.keys(d.nodes)) if (!can.nodes.has(`${d.id}.${n}`)) bad(`dialogs(${d.id}).nodes.${n}`, 'can never be reached (no choice leads to it, no outcome unlocks it, or what leads to it can never happen)');
  for (const o of st.objectives) {
    if (!can.shown.has(o.id)) bad(`objectives(${o.id})`, 'can never be shown (its "when" never holds)');
    else if (!can.done.has(o.id)) bad(`objectives(${o.id})`, 'can be shown but never done (its "done" never holds)');
  }
  st.happenings.forEach((_, i) => {
    if (!can.fired.has(i)) bad(`happenings[${i}]`, 'can never happen (its "when" never holds)');
  });
  for (const l of st.locations) for (const r of l.brief.rooms ?? []) if (!can.rooms.has(`${l.id}.${r.id}`)) bad(`locations(${l.id}).brief.rooms(${r.id})`, 'can never be reached (no connection to it, or its lock\'s key is never had)');
  if (!can.outcomes.some((o) => o.endRun === 'won')) bad('story', 'the run can never be won (no reachable outcome has endRun "won")');
  if (!can.outcomes.some((o) => o.endRun === 'lost')) bad('story', 'the run can never be lost by the story (no reachable outcome has endRun "lost"): death and failure must be possible');
  if (!can.outcomes.some((o) => o.atlas?.length)) bad('story', 'nothing the player can do changes the world (no reachable outcome has an AtlasEvent)');
  return P;
}

/** every Outcome in a story (dialog nodes and choices, objectives, failures, happenings) */
function forEachOutcome(s: J, f: (o: unknown) => void): void {
  for (const d of (Array.isArray(s.dialogs) ? s.dialogs : []) as J[])
    if (isObj(d) && isObj(d.nodes))
      for (const n of Object.values(d.nodes) as J[]) {
        if (!isObj(n)) continue;
        f(n.effects);
        for (const c of (Array.isArray(n.choices) ? n.choices : []) as J[]) if (isObj(c)) f(c.effects);
      }
  for (const o of (Array.isArray(s.objectives) ? s.objectives : []) as J[]) {
    if (!isObj(o)) continue;
    f(o.outcome);
    if (isObj(o.failed)) f(o.failed.outcome);
  }
  for (const h of (Array.isArray(s.happenings) ? s.happenings : []) as J[]) if (isObj(h)) f(h.effects);
}
