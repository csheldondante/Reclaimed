// (loop-skeleton round 6; docs/SYSTEMS.md recipe 6) A live event as data. The owner (2026-11-16): "I do think this may
// be a mistake to differentiate combat from other events like parades or riots or fires. I would strongly consider
// using the same system for all of them." and "Let's make these realtime for now and they can resolve automatically
// when the season ends with a different outcome based on your strategic interactions including casting spells."
//
// A template says what is played with `play.event` (living/engine.ts TemplateDef): who takes part, where, an optional
// hazard, an optional time limit, what the player may cast, when it ends by itself, and how its result is read and
// mapped to the template's tiered outcomes. One runner plays any of them in the live city
// (scenes/level/live-runner.ts); this file is the data and the rules of reading a result — pure, so the same event
// resolves in Node (a test, the bots) from the state nobody played: every group as it was sent, nothing arrived, the
// hazard unfought.
//
// The reading has four steps, in order:
//   1. `result`  numbers counted from the event as it stands (units alive by tag, lots burned, casts);
//   2. rules     the realm's tag-and-synergy rules may change a named number here (living/rules.ts: "walls with a
//                garrison stop 2 raiders") — each change with its reason, shown to the player;
//   3. `derive`  numbers worked out from those (who got in, what is lost);
//   4. `tiers`   the first row whose conditions hold names the outcome.
// The template's outcome for that tier then runs through the engine as any card's does, with the numbers as its vars.
import type { Tier } from '../api/contracts/opportunity';

/** where something of an event is: a named place of the home town's place table (resolved on the GPU where the order
 *  runs), the road an entering group came by, or a site of the town (a point the scene knows) */
export type LiveWhere =
  | { place: 'muster' | 'stores' | 'barracks' | 'market' | 'keep'; else?: LiveWhere }
  /** the town's heart: the keep, else the stores, else the market */
  | { place: 'heart' }
  /** a gate or a road's spawn point outside the town. `road`: its number, or 'entry' — the road this event's entering
   *  group came in by (the runner tries each road in turn until one's spawn point stands on ground the window holds) */
  | { place: 'gate' | 'spawn'; road: number | 'entry' }
  /** a site of the home town by its key ('graves', 'market'); 'here': the site the card stands at */
  | { site: string };

export interface LiveGroup {
  id: string;
  /** the units' kind (units/agent-units.ts: worker, soldier, guard, raider, shambler, cart) */
  kind: string;
  /** 'foe' fights the town; 'town' the town's own; 'folk' takes no part in a fight */
  side: 'town' | 'foe' | 'folk';
  /** how many: a number, or the name of one of the event's numbers (the run's: 'raid', 'soldiers') */
  n: number | string;
  /** what its members count as in `result`, `ends` and the rules ('raider', 'soldier', 'dead', 'marcher', 'crowd') */
  tags: string[];
  /** where they start. 'squads': the town's soldiers as they already stand at their posts (none are made) */
  from: LiveWhere | 'squads';
  /** a group at a site starts in clumps this far apart (cells) */
  spread?: number;
  order?: { kind: 'go' | 'guard' | 'attack'; at: LiveWhere; formation?: 'column' | 'line' | 'loose'; discipline?: number };
}

/** when an event ends by itself (the first that holds). Checked from counts the units' events already give: no read */
export type LiveEnd =
  /** nobody with the tag is left alive (of those that were made) */
  | { when: 'none'; tag: string }
  /** the group stands at its order's place */
  | { when: 'arrived'; group: string }
  /** nobody with `tag` has been alive for `seconds` while someone with `while` is, and stands at their place or has
   *  struck a blow (the runner counts the seconds only then) */
  | { when: 'absent'; tag: string; while: string; seconds: number }
  /** the hazard has nothing alight any more, `after` seconds in at the earliest (the runner's own small read) */
  | { when: 'out'; after: number };

export type LiveRead =
  /** units of a tag: made, alive now, dead, or members of groups that stand at their place */
  | { as: string; count: 'made' | 'alive' | 'dead' | 'arrived'; tag: string }
  /** the hazard's points (lots) that burned; how many it had; how many are alight now; the casts of a spell (or all) */
  | { as: string; read: 'burned' | 'points' | 'alight' | 'casts'; spell?: string }
  /** a number that starts at this (one the rules add to: 'stopped') */
  | { as: string; value: number };

/** a number worked out: a op b, rounded, kept within min and max. a and b: a number, or a number's name */
export interface LiveCalc {
  as: string;
  calc: [number | string, '+' | '-' | '*' | '/', number | string];
  round?: 'floor' | 'ceil';
  min?: number | string;
  max?: number | string;
}

export type LiveCond = [number | string, '<' | '<=' | '=' | '>=' | '>', number | string];

export interface LiveDef {
  /** what the rules know it as ('raid', 'parade', 'fire', 'rising') */
  tag: string;
  /** the sheet while the player is at it: its title, what to do, and its line (a number's name in braces) */
  title: string;
  how: string;
  line: string;
  groups: LiveGroup[];
  /** a hazard set going when the event starts: the real fire system lit at `points` spots within `spread` cells of
   *  `at` (each `radius` wide). Its result is how many of those spots burned */
  hazard?: { kind: 'fire'; at: LiveWhere; points: number; spread: number; radius: number; intensity: number };
  /** particles over a group as it goes (petals over a parade): a burst every `every` seconds */
  fx?: { burst: string; over: string; every: number; count: number };
  /** what the camera follows (a tag's living units), else where it looks; its zoom (px a cell), and closer once a
   *  blow has landed */
  camera: { follow?: string; at?: LiveWhere; zoom: number; fightZoom?: number };
  /** wall seconds it may take; absent: until it ends by itself or the season does */
  seconds?: number;
  /** spells the player may cast while at it ('known': every spell the run has) */
  spells?: string[];
  /** the player cannot leave it (the run's last fight) */
  stay?: boolean;
  /** the sim's speed while an entering group is still on the road */
  marchSpeed?: number;
  ends: LiveEnd[];
  result: LiveRead[];
  derive?: LiveCalc[];
  /** the first row whose conditions all hold; a row with none is the default */
  tiers: { tier: Tier; when?: LiveCond[] }[];
  /** numbers the result's marks show over the figures: [tag, the side's name] */
  marks?: [string, string][];
}

/** an event as it stands: what the runner counts (from the units' own events), or what nobody played */
export interface LiveState {
  /** seconds it has run */
  t: number;
  groups: Record<string, { tags: string[]; made: number; alive: number; dead: number; arrived: boolean }>;
  /** the hazard's points, and how many of them burned */
  points: number;
  burned: number;
  casts: Record<string, number>;
  /** seconds since anybody with the tag was alive (LiveEnd 'absent') */
  absent: Record<string, number>;
  /** the hazard's points alight now (as last read) */
  alight: number;
  /** a blow has landed */
  fighting: boolean;
}

export type LiveVars = Record<string, number>;

const numOf = (v: LiveVars, x: number | string): number => {
  if (typeof x === 'number') return x;
  const n = v[x];
  if (typeof n !== 'number') throw new Error(`live event: no number ${x}`);
  return n;
};

/** how many a group is made of: its number, or the run's */
export function groupSize(g: LiveGroup, run: LiveVars): number {
  return Math.max(0, Math.round(numOf(run, g.n)));
}

/** the event as nobody played it: every group as it was sent, nothing arrived, no cast, the hazard unfought (every
 *  point burned). What a season's end resolves an event from when nothing ran (a test, the bots, a reload) */
export function idleState(def: LiveDef, run: LiveVars): LiveState {
  const groups: LiveState['groups'] = {};
  for (const g of def.groups) {
    const n = groupSize(g, run);
    groups[g.id] = { tags: [...g.tags], made: n, alive: n, dead: 0, arrived: false };
  }
  return { t: 0, groups, points: def.hazard?.points ?? 0, burned: def.hazard?.points ?? 0, casts: {}, absent: {}, alight: 0, fighting: false };
}

const withTag = (s: LiveState, tag: string) => Object.values(s.groups).filter((g) => g.tags.includes(tag));
const sum = (gs: LiveState['groups'][string][], k: 'made' | 'alive' | 'dead') => gs.reduce((a, g) => a + g[k], 0);

/** the event has ended by itself (its `ends`, or its seconds) */
export function liveEnded(def: LiveDef, s: LiveState): boolean {
  if (def.seconds !== undefined && s.t >= def.seconds) return true;
  return def.ends.some((e) => {
    if (e.when === 'none') return sum(withTag(s, e.tag), 'made') > 0 && sum(withTag(s, e.tag), 'alive') === 0;
    if (e.when === 'arrived') return !!s.groups[e.group]?.arrived;
    if (e.when === 'out') return s.t >= e.after && s.alight === 0;
    return sum(withTag(s, e.while), 'alive') > 0 && (s.absent[e.tag] ?? 0) >= e.seconds;
  });
}

/** step 1: the numbers counted from the event as it stands, over the run's own (`run`: the raid's size, the pools) */
export function liveRead(def: LiveDef, s: LiveState, run: LiveVars = {}): LiveVars {
  const v: LiveVars = { ...run };
  for (const r of def.result) {
    if ('count' in r) {
      const gs = withTag(s, r.tag);
      v[r.as] = r.count === 'arrived' ? sum(gs.filter((g) => g.arrived), 'alive') : sum(gs, r.count);
    } else if ('value' in r) v[r.as] = r.value;
    else if (r.read === 'burned') v[r.as] = s.burned;
    else if (r.read === 'points') v[r.as] = s.points;
    else if (r.read === 'alight') v[r.as] = s.alight;
    else v[r.as] = r.spell ? (s.casts[r.spell] ?? 0) : Object.values(s.casts).reduce((a, b) => a + b, 0);
  }
  return v;
}

/** step 3: the numbers worked out from the counted ones (after the rules have had their say) */
export function liveDerive(def: LiveDef, vars: LiveVars): LiveVars {
  const v = { ...vars };
  for (const c of def.derive ?? []) {
    const [a, op, b] = [numOf(v, c.calc[0]), c.calc[1], numOf(v, c.calc[2])];
    let x = op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : b === 0 ? 0 : a / b;
    x = c.round === 'ceil' ? Math.ceil(x) : c.round === 'floor' ? Math.floor(x) : Math.round(x);
    if (c.min !== undefined) x = Math.max(numOf(v, c.min), x);
    if (c.max !== undefined) x = Math.min(numOf(v, c.max), x);
    v[c.as] = x;
  }
  return v;
}

/** step 4: the outcome's tier */
export function liveTier(def: LiveDef, v: LiveVars): Tier {
  const ok = ([a, op, b]: LiveCond): boolean => {
    const [x, y] = [numOf(v, a), numOf(v, b)];
    return op === '<' ? x < y : op === '<=' ? x <= y : op === '=' ? x === y : op === '>=' ? x >= y : x > y;
  };
  const row = def.tiers.find((t) => (t.when ?? []).every(ok));
  if (!row) throw new Error(`live event ${def.tag}: no tier fits (its last row should have no conditions)`);
  return row.tier;
}

/** every number an event's texts and outcomes may name, at 0: what a card's words are filled from before it is played */
export function liveNames(def: LiveDef): LiveVars {
  const v: LiveVars = {};
  for (const r of def.result) v[r.as] = 0;
  for (const c of def.derive ?? []) v[c.as] = 0;
  return v;
}

/** problems in an event's data (a template is refused with them: never patched) */
export function checkLive(id: string, def: LiveDef, run: readonly string[] = []): string[] {
  const p: string[] = [];
  const groups = new Set(def.groups.map((g) => g.id));
  const tags = new Set(def.groups.flatMap((g) => g.tags));
  const names = new Set<string>(run);
  if (groups.size !== def.groups.length) p.push(`${id}: two groups share an id`);
  for (const g of def.groups) if (typeof g.n === 'string' && !names.has(g.n)) p.push(`${id}: group ${g.id}'s size ${g.n} is not one of the run's numbers`);
  for (const e of def.ends) {
    if (e.when === 'out') {
      if (!def.hazard) p.push(`${id}: an end waits for a hazard it has not`);
      continue;
    }
    if (e.when === 'arrived' ? !groups.has(e.group) : !tags.has(e.tag)) p.push(`${id}: an end names ${e.when === 'arrived' ? `group ${e.group}` : `tag ${e.tag}`}, which no group has`);
    if (e.when === 'absent' && !tags.has(e.while)) p.push(`${id}: an end names tag ${e.while}, which no group has`);
  }
  for (const r of def.result) {
    if ('count' in r && !tags.has(r.tag)) p.push(`${id}: result ${r.as} counts tag ${r.tag}, which no group has`);
    if ('read' in r && r.read !== 'casts' && !def.hazard) p.push(`${id}: result ${r.as} reads a hazard it has not`);
    names.add(r.as);
  }
  const known = (x: number | string, at: string) => {
    if (typeof x === 'string' && !names.has(x)) p.push(`${id}: ${at} names ${x} before it is counted`);
  };
  for (const c of def.derive ?? []) {
    known(c.calc[0], `derive ${c.as}`);
    known(c.calc[2], `derive ${c.as}`);
    if (c.min !== undefined) known(c.min, `derive ${c.as}`);
    if (c.max !== undefined) known(c.max, `derive ${c.as}`);
    names.add(c.as);
  }
  for (const t of def.tiers) for (const [a, , b] of t.when ?? []) (known(a, `tier ${t.tier}`), known(b, `tier ${t.tier}`));
  if (!def.tiers.length || def.tiers[def.tiers.length - 1].when?.length) p.push(`${id}: its last tier row must have no conditions`);
  if (def.camera.follow && !tags.has(def.camera.follow)) p.push(`${id}: the camera follows tag ${def.camera.follow}, which no group has`);
  if (def.fx && !groups.has(def.fx.over)) p.push(`${id}: its particles are over group ${def.fx.over}, which it has not`);
  return p;
}

/**
 * (card-table) What one cast of a spell does to a live event when nothing is played in real time: foes put down, and
 * points of a fire put out. First numbers, to tune (BACKLOG CT-16): the 3D game's casts are aimed by hand and these
 * stand in for "a cast that lands". A spell not listed does nothing to an event.
 */
export const SPELL_MECH: Record<string, { kills?: number; douses?: number }> = {
  fire: { kills: 1 },
  heatray: { kills: 2 },
  rain: { douses: 2 },
};

/**
 * (card-table) A live event as it ends when nobody plays it in real time but the player made strategic choices: every
 * group does what it was ordered to (a group told to go somewhere arrives; a fight is left as it was sent, for the
 * event's own `derive` to settle), the hazard burns every point, and each logged cast does what SPELL_MECH says —
 * foes put down in the groups' order, fire points put out. Pure: the same casts give the same state. The card table
 * and the bots resolve events from this (`Realm.tellLive` then `finishLive`); the 3D game tells its own counts.
 */
export function mechState(def: LiveDef, run: LiveVars, casts: Record<string, number> = {}): LiveState {
  const s = idleState(def, run);
  for (const g of def.groups) if (g.order?.kind === 'go') s.groups[g.id].arrived = true;
  s.casts = { ...casts };
  let kills = 0;
  let douses = 0;
  for (const [spell, n] of Object.entries(casts)) {
    kills += (SPELL_MECH[spell]?.kills ?? 0) * n;
    douses += (SPELL_MECH[spell]?.douses ?? 0) * n;
  }
  for (const g of def.groups) {
    if (g.side !== 'foe' || kills <= 0) continue;
    const st = s.groups[g.id];
    const k = Math.min(st.alive, kills);
    st.alive -= k;
    st.dead += k;
    kills -= k;
  }
  s.burned = Math.max(0, s.burned - douses);
  return s;
}
