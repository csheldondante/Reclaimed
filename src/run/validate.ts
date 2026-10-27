// ---- run/validate.ts -----------------------------------------------------------
// A SessionStory checked before it's played (round 83, docs/SYSTEMS.md systems 9–11): every reference resolves
// (a cast member's location, a tree's speaker, a choice's next node, a condition's character, dialog, node,
// location or objective, an unlock), the ids are unique, the numbers are in range. A bad story throws one
// error listing every problem, so the GM (or whoever wrote it) can fix them in one go: nothing is guessed.
//
//   validateStory(JSON.parse(text))   // throws StoryError, or returns the story typed

import type { Condition, DialogTree, Outcome, SessionStory } from '../api/contracts';

export class StoryError extends Error {
  constructor(
    readonly story: string,
    readonly problems: string[],
  ) {
    super(`story "${story}": ${problems.length} problem${problems.length === 1 ? '' : 's'}\n- ${problems.join('\n- ')}`);
    this.name = 'StoryError';
  }
}

const CONDITIONS = new Set(['any', 'talked', 'chose', 'has', 'reached', 'killed', 'event', 'objective', 'flag', 'time', 'saw']);
const EVENTS = new Set(['collapsed', 'flooded', 'burned', 'built', 'dug']);

/** Check a story (parsed JSON or a literal): every reference resolves. Throws StoryError listing what's wrong. */
export function validateStory(data: unknown): SessionStory {
  const s = data as SessionStory;
  const bad: string[] = [];
  const need = (ok: unknown, what: string) => {
    if (!ok) bad.push(what);
  };
  if (!s || typeof s !== 'object') throw new StoryError('?', ['not an object']);
  need(typeof s.id === 'string' && s.id, 'id: a string');
  need(typeof s.title === 'string', 'title: a string');
  for (const k of ['locations', 'cast', 'dialogs', 'objectives', 'happenings'] as const) need(Array.isArray(s[k]), `${k}: an array`);
  if (bad.length) throw new StoryError(String(s.id ?? '?'), bad);

  const ids = (what: string, list: { id: string }[]) => {
    const seen = new Set<string>();
    for (const x of list) {
      if (typeof x.id !== 'string' || !x.id) bad.push(`${what}: an entry without an id`);
      else if (seen.has(x.id)) bad.push(`${what} "${x.id}": the id is used twice`);
      seen.add(x.id);
    }
    return seen;
  };
  const locations = ids('location', s.locations);
  const cast = ids('character', s.cast);
  ids('dialog', s.dialogs);
  const objectives = ids('objective', s.objectives);
  const trees = new Map<string, DialogTree>(s.dialogs.map((d) => [d.id, d]));

  for (const l of s.locations) {
    const rooms = new Set((l.brief?.rooms ?? []).map((r) => r.id));
    for (const c of l.brief?.connections ?? []) {
      need(rooms.has(c.from), `location "${l.id}": connection from unknown room "${c.from}"`);
      need(rooms.has(c.to), `location "${l.id}": connection to unknown room "${c.to}"`);
    }
    for (const k of l.brief?.keys ?? []) {
      need((l.brief.connections ?? []).some((c) => c.lock === k.lock), `location "${l.id}": key for unknown lock "${k.lock}"`);
      if (k.key.character) need(cast.has(k.key.character), `location "${l.id}": key "${k.lock}" names unknown character "${k.key.character}"`);
      if (k.key.objective) need(objectives.has(k.key.objective), `location "${l.id}": key "${k.lock}" names unknown objective "${k.key.objective}"`);
    }
  }
  for (const c of s.cast) {
    need(locations.has(c.location), `character "${c.id}": unknown location "${c.location}"`);
    if (c.room !== undefined)
      need(s.locations.find((l) => l.id === c.location)?.brief?.rooms?.some((r) => r.id === c.room), `character "${c.id}": location "${c.location}" has no room "${c.room}"`);
    need(typeof c.disposition === 'number' && c.disposition >= -1 && c.disposition <= 1, `character "${c.id}": disposition in −1..1`);
  }
  for (const d of s.dialogs) {
    const at = `dialog "${d.id}"`;
    need(cast.has(d.speaker), `${at}: unknown speaker "${d.speaker}"`);
    if (!d.nodes || typeof d.nodes !== 'object') {
      bad.push(`${at}: no nodes`);
      continue;
    }
    need(d.start in d.nodes, `${at}: start node "${d.start}" isn't one of its nodes`);
    for (const [nid, n] of Object.entries(d.nodes)) {
      need(typeof n.text === 'string' && n.text, `${at} node "${nid}": no text`);
      need(Array.isArray(n.choices), `${at} node "${nid}": choices must be an array (empty: the talk ends)`);
      if (n.effects) outcome(n.effects, `${at} node "${nid}"`);
      (n.choices ?? []).forEach((c, i) => {
        const ca = `${at} node "${nid}" choice ${i}`;
        need(typeof c.text === 'string' && c.text, `${ca}: no text`);
        if (c.to !== undefined) need(c.to in d.nodes, `${ca}: goes to unknown node "${c.to}"`);
        for (const q of c.requires ?? []) condition(q, `${ca} requires`);
        if (c.effects) outcome(c.effects, ca);
      });
    }
  }
  for (const o of s.objectives) {
    const at = `objective "${o.id}"`;
    need(typeof o.text === 'string' && o.text, `${at}: no text`);
    if (o.location !== undefined) need(locations.has(o.location), `${at}: unknown location "${o.location}"`);
    need(Array.isArray(o.when) && Array.isArray(o.done), `${at}: when and done must be arrays`);
    need((o.done ?? []).length > 0, `${at}: done is empty (it would be done as soon as it's shown)`);
    for (const q of o.when ?? []) condition(q, `${at} when`);
    for (const q of o.done ?? []) condition(q, `${at} done`);
    outcome(o.outcome, at);
    if (o.failed) {
      for (const q of o.failed.when) condition(q, `${at} failed.when`);
      outcome(o.failed.outcome, `${at} failed`);
    }
  }
  s.happenings.forEach((h, i) => {
    need((h.when ?? []).length > 0, `happening ${i}: when is empty`);
    for (const q of h.when ?? []) condition(q, `happening ${i} when`);
    outcome(h.effects, `happening ${i}`);
  });
  if (bad.length) throw new StoryError(s.id, bad);
  return s;

  function condition(c: Condition, at: string): void {
    if (!c || !CONDITIONS.has(c.kind)) return void bad.push(`${at}: unknown condition kind "${(c as { kind?: string })?.kind}"`);
    switch (c.kind) {
      case 'any':
        need(Array.isArray(c.of) && c.of.length > 0, `${at}: any needs a list of conditions`);
        (c.of ?? []).forEach((x, i) => condition(x, `${at} any[${i}]`));
        break;
      case 'talked':
        need(cast.has(c.character), `${at}: talked to unknown character "${c.character}"`);
        if (c.node !== undefined)
          need(s.dialogs.some((d) => d.speaker === c.character && c.node! in d.nodes), `${at}: no dialog of "${c.character}" has node "${c.node}"`);
        break;
      case 'chose': {
        const t = trees.get(c.dialog);
        if (!t) return void bad.push(`${at}: chose in unknown dialog "${c.dialog}"`);
        const n = t.nodes[c.node];
        if (!n) return void bad.push(`${at}: chose at unknown node "${c.dialog}/${c.node}"`);
        need(Number.isInteger(c.choice) && c.choice >= 0 && c.choice < n.choices.length, `${at}: "${c.dialog}/${c.node}" has no choice ${c.choice}`);
        break;
      }
      case 'has':
        need(typeof c.item === 'string' && c.item, `${at}: has needs an item`);
        break;
      case 'reached':
        need(locations.has(c.location), `${at}: reached unknown location "${c.location}"`);
        if (c.room !== undefined) {
          const l = s.locations.find((x) => x.id === c.location);
          need(l?.brief?.rooms?.some((r) => r.id === c.room), `${at}: location "${c.location}" has no room "${c.room}"`);
        }
        break;
      case 'killed':
        if (c.character !== undefined) need(cast.has(c.character), `${at}: killed unknown character "${c.character}"`);
        break;
      case 'event':
        need(EVENTS.has(c.event), `${at}: unknown event "${c.event}"`);
        if (c.location !== undefined) need(locations.has(c.location), `${at}: event at unknown location "${c.location}"`);
        break;
      case 'objective':
        need(objectives.has(c.id), `${at}: unknown objective "${c.id}"`);
        need(c.state === 'done' || c.state === 'failed', `${at}: objective state is done or failed`);
        break;
      case 'flag':
        need(typeof c.flag === 'string' && c.flag, `${at}: flag needs a name`);
        break;
      case 'time':
        need(typeof c.after === 'number' && c.after >= 0, `${at}: time.after in seconds`);
        break;
      case 'saw':
        need((c.character === undefined) !== (c.location === undefined), `${at}: saw names a character or a location`);
        if (c.character !== undefined) need(cast.has(c.character), `${at}: saw unknown character "${c.character}"`);
        if (c.location !== undefined) need(locations.has(c.location), `${at}: saw unknown location "${c.location}"`);
        break;
    }
  }

  function outcome(o: Outcome, at: string): void {
    if (!o || typeof o !== 'object') return void bad.push(`${at}: no outcome (use {} for none)`);
    for (const e of o.atlas ?? []) {
      need(Array.isArray(e.regions) && e.regions.length > 0, `${at}: an atlas event (${e.kind}) without regions`);
      need(typeof e.magnitude === 'number', `${at}: an atlas event (${e.kind}) without a magnitude`);
      const [lo, hi] = e.kind === 'faction-presence' || e.kind === 'faction-attitude' ? [-1, 1] : e.kind === 'bury' ? [0, Infinity] : [0, 1];
      need(!(e.magnitude < lo || e.magnitude > hi), `${at}: an atlas event (${e.kind})'s magnitude ${e.magnitude} is out of ${lo}..${hi}`);
      if (e.kind === 'flood') need(typeof e.level === 'number', `${at}: a flood needs its level (world z)`);
      if (e.kind === 'faction-presence' || e.kind === 'faction-attitude') need(typeof e.detail?.faction === 'string', `${at}: ${e.kind} needs detail.faction`);
      need(e.cause && ['story', 'player', 'world'].includes(e.cause.by), `${at}: an atlas event (${e.kind}) without a cause`);
      // (where in the region it's seen: a story location — story/play.ts realises it there)
      if (e.location !== undefined) need(locations.has(e.location), `${at}: an atlas event (${e.kind}) at unknown location "${e.location}"`);
    }
    for (const a of o.attitude ?? []) {
      need(a.character !== undefined || a.faction !== undefined, `${at}: an attitude change names neither a character nor a faction`);
      if (a.character !== undefined) need(cast.has(a.character), `${at}: attitude of unknown character "${a.character}"`);
    }
    for (const sp of o.spawn ?? []) {
      need(locations.has(sp.location), `${at}: spawn at unknown location "${sp.location}"`);
      if (sp.toward !== undefined) need(locations.has(sp.toward), `${at}: spawn toward unknown location "${sp.toward}"`);
    }
    for (const b of o.say ?? []) {
      need(typeof b.line === 'string' && b.line.length > 0, `${at}: a bark without a line`);
      if (b.by !== undefined) need(cast.has(b.by), `${at}: a bark by unknown character "${b.by}"`);
    }
    if (o.talk) {
      need(s.dialogs.some((d) => d.speaker === o.talk!.character), `${at}: talk opens "${o.talk.character}", who has no dialog`);
      if (o.talk.node !== undefined) need(s.dialogs.some((d) => d.speaker === o.talk!.character && o.talk!.node! in d.nodes), `${at}: talk at unknown node "${o.talk.node}"`);
    }
    for (const c of o.hostile ?? []) need(cast.has(c), `${at}: unknown character "${c}" turns hostile`);
    for (const u of o.unlock ?? []) {
      const t = trees.get(u.dialog);
      need(t && u.node in t.nodes, `${at}: unlocks unknown node "${u.dialog}/${u.node}"`);
    }
    if (o.endRun !== undefined) need(o.endRun === 'won' || o.endRun === 'lost', `${at}: endRun is won or lost`);
  }
}

