// The mutators' bridge to the fact layer (docs/design/FACTIONS_WORLD_STATE.md §7; api/contracts/facts.ts;
// living/world.ts FactWorld). Pure — no GPU, no DOM.
//
// The world's state has one home: who holds a settlement, whether it stands, who it pays, what happened to it are the
// fact layer's (the settlement's record through WorldState.apply, relations, condition tags, the event history). A
// mutator does two things: `recordMutation` changes those facts through their owners (living/mutations.ts) and records
// ONE fact event for it; the world modifier list keeps only the physical projection (land, lot conditions, the map's
// mark), each entry carrying that event's id (`Mutation.fact`). `placeState` / `placeStates` are reads of the fact
// world: there is no second list of owners and conditions.
//
// What each kind writes:
//   destroyed   settlement-condition 'ruined' (setCondition)                              event 'destroyed'
//   abandoned   settlement-condition 'abandoned'                                           event 'abandoned'
//   captured    `occupies` holder → place, tag condition.occupied, and — when the holder is a faction of the world —
//               settlement-owner (setControl)                                              event 'captured'
//   vassal      `vassal_of` place → lord, `pays_tribute_to` place → lord (meta.perSeason)  event 'vassal'
//   founded     settlement-founded (the record), the settlement's entity                   event 'founding'
//   flooded, burned, melted, buried, withered, greened
//               tag condition.<kind> on every settlement whose centre the area covers      event '<kind>'
//   dried       the same, and the region's river inflow lowered (setRiverInflow: "a river falls when its steady-flow
//               inflow is lowered")                                                        events 'river-inflow', 'dried'
// A sign (ash fall, darkness, the dead rise, crime) is a condition tag on its place while it is on, and an event when
// it starts.
import type { EntityId, FactEvent } from '../api/contracts/facts';
import { setCondition, setControl, setRiverInflow } from '../living/mutations';
import type { FactWorld } from '../living/world';
import { ROW_H } from '../world/lattice';
import type { MutatorKind, PhysicalKind, PlaceState, SignKind } from './index';

/** what `recordMutation` needs of an entry (a list entry, or a template's outcome before any list has it) */
export interface FactSpec {
  kind: MutatorKind;
  place: string | null;
  /** world cells [x, row] */
  cell: readonly [number, number];
  radius: number;
  strength: number;
  by?: string;
  tribute?: number;
  name?: string;
  size?: 'camp' | 'village' | 'town';
}

export interface FactOpts {
  /** the opportunity (or arc stage) that caused it: FactEvent.about.opp */
  cause?: string;
  /** the region of a world point (x cells, y world units): for a change that names no settlement */
  regionAt?(x: number, y: number): number;
}

const LAND = ['flooded', 'burned', 'melted', 'buried', 'dried', 'withered', 'greened'] as const;
const STATE_EVENT: Record<string, string> = { destroyed: 'destroyed', abandoned: 'abandoned', captured: 'captured', vassal: 'vassal', founded: 'founding' };
/** the event kinds the mutators record (a place with one of these in its history is a place they touched) */
export const MUTATION_EVENTS: readonly string[] = [...LAND, ...Object.values(STATE_EVENT)];

const isLandKind = (k: string): k is PhysicalKind => (LAND as readonly string[]).includes(k);

/** the settlements whose centre a land change covers (Settlement.at: world units) */
function covered(w: FactWorld, s: FactSpec): string[] {
  const out: string[] = [];
  for (const t of w.ws.settlements) if (w.facts.entity(t.id) && (t.id === s.place || Math.hypot(s.cell[0] - t.at[0], s.cell[1] * ROW_H - t.at[1]) <= s.radius)) out.push(t.id);
  return out;
}

const LAND_NOTE: Record<PhysicalKind, string> = {
  flooded: 'went under water',
  burned: 'burned',
  melted: 'was taken by lava',
  buried: 'was buried in sand',
  dried: 'lost its river',
  withered: 'withered',
  greened: 'grew over green',
};

/**
 * A mutation as facts: the owners' records changed, one event recorded. Returns the event's id (the physical entry's
 * `fact`). Safe to apply again (a replay onto a restored world): relations and tags are set, not added.
 */
export function recordMutation(w: FactWorld, s: FactSpec, o: FactOpts = {}): string {
  const f = w.facts;
  const cause = o.cause ?? 'mutators';
  const about = (atlas?: string[]): FactEvent['about'] => ({ ...(o.cause ? { opp: o.cause } : {}), ...(atlas?.length ? { atlas } : {}) });
  const where = { at: [s.cell[0], s.cell[1]] as [number, number] };

  if (isLandKind(s.kind)) {
    const towns = covered(w, s);
    for (const id of towns) f.setTag(id, 'condition', s.kind, true, cause);
    // (grown over: what it grows over is no longer burned or withered ground)
    if (s.kind === 'greened') for (const id of towns) for (const k of ['burned', 'withered'] as const) f.dropTag(id, 'condition', k);
    const atlas: string[] = [];
    if (s.kind === 'dried') {
      // (the river's inflow is the region's: lowered through its owner, as a drought is)
      const anchor = s.place && f.entity(s.place) ? s.place : towns[0];
      const factor = +(1 - s.strength).toFixed(3);
      if (anchor) {
        const before = f.events({ kind: 'river-inflow' }).length;
        setRiverInflow(w, anchor, { factor }, cause, `the rivers by ${w.name(anchor)} fall`);
        const made = f.events({ kind: 'river-inflow' });
        if (made.length > before) atlas.push(...(made[made.length - 1].about?.atlas ?? []));
      } else if (o.regionAt) atlas.push(w.apply({ kind: 'river-inflow', regions: [o.regionAt(s.cell[0], s.cell[1] * ROW_H)], magnitude: factor, cause: { by: 'world', ref: cause } }));
    }
    const who = towns.length ? towns.map((id) => w.name(id)).join(', ') : `the land at ${s.cell[0]}, ${s.cell[1]}`;
    return f.record({ kind: s.kind, by: [], to: towns, where, about: about(atlas), note: `${who} ${LAND_NOTE[s.kind]}` }).id;
  }

  const place = s.place;
  if (!place) throw new Error(`mutators: ${s.kind} needs a place`);
  if (s.kind === 'founded') {
    const by = s.by && w.ws.faction(s.by) ? s.by : null;
    const region = o.regionAt ? o.regionAt(s.cell[0], s.cell[1] * ROW_H) : 0;
    const aid = w.apply({ kind: 'settlement-founded', regions: [region], magnitude: 1, detail: { settlement: place, name: s.name ?? place, at: [s.cell[0], s.cell[1] * ROW_H], radius: s.radius, size: s.size ?? 'camp', faction: by }, cause: { by: 'world', ref: cause } });
    if (!f.entity(place)) f.add({ id: place, kind: 'settlement', name: s.name ?? place, ref: { settlement: place }, at: { region }, cause });
    const founder = s.by && f.entity(s.by) ? [s.by] : [];
    return f.record({ kind: 'founding', by: founder, to: [place], where, about: about([aid]), note: `${s.name ?? place} founded${founder.length ? ` by ${w.name(founder[0])}` : ''}` }).id;
  }
  if (!f.entity(place) || !w.settlement(place)) throw new Error(`mutators: ${s.kind} — ${place} is not a settlement of the fact world`);
  const before = w.ws.history().length;
  const atlasIds = () => w.ws.history().slice(before).map((e) => e.id);
  if (s.kind === 'destroyed' || s.kind === 'abandoned') {
    setCondition(w, place, s.kind === 'destroyed' ? 'ruined' : 'abandoned', cause);
    // (nobody is left to be held or to pay)
    f.unrelate({ type: 'pays_tribute_to', from: place }, cause);
    return f.record({ kind: s.kind, by: s.by && f.entity(s.by) ? [s.by] : [], to: [place], where, about: about(atlasIds()), note: `${w.name(place)} ${s.kind === 'destroyed' ? 'destroyed' : 'abandoned by its people'}` }).id;
  }
  const holder = s.by;
  if (!holder || !f.entity(holder)) throw new Error(`mutators: ${s.kind} needs \`by\`, an entity of the fact world (a faction, a polity, 'player') — got ${String(holder)}`);
  if (s.kind === 'captured') {
    f.unrelate({ type: 'occupies', to: place }, cause);
    f.relate({ type: 'occupies', from: holder, to: place, cause });
    f.setTag(place, 'condition', 'occupied', true, cause);
    // (a vassal taken by force is no vassal)
    f.unrelate({ type: 'vassal_of', from: place }, cause);
    f.unrelate({ type: 'pays_tribute_to', from: place }, cause);
    if (w.ws.faction(holder)) setControl(w, holder, place, cause);
    return f.record({ kind: 'captured', by: [holder], to: [place], where, about: about(atlasIds()), note: `${w.name(place)} taken by ${w.name(holder)}` }).id;
  }
  // vassal: it keeps its people and its holder, swears to a lord and pays
  f.unrelate({ type: 'vassal_of', from: place }, cause);
  f.unrelate({ type: 'pays_tribute_to', from: place }, cause);
  f.relate({ type: 'vassal_of', from: place, to: holder, cause });
  f.relate({ type: 'pays_tribute_to', from: place, to: holder, meta: { perSeason: s.tribute ?? 1 }, cause });
  return f.record({ kind: 'vassal', by: [holder], to: [place], where, about: about(), note: `${w.name(place)} sworn to ${w.name(holder)}, paying ${s.tribute ?? 1} a season` }).id;
}

/** A sign on a place as facts: a condition tag while it is on (dropped when off), an event when it starts. Returns the
 *  event's id (null: switched off, or the place is not an entity of this world). */
export function recordSign(w: FactWorld, kind: SignKind, place: string | null, on: boolean, cause?: string): string | null {
  const f = w.facts;
  if (!place || !f.entity(place)) return null;
  const had = !!f.tag(place, 'condition', kind);
  if (!on) {
    if (had) f.dropTag(place, 'condition', kind);
    return null;
  }
  f.setTag(place, 'condition', kind, true, cause ?? 'mutators');
  if (had) return null;
  const note: Record<SignKind, string> = { ashfall: 'ash falls on', darkness: 'the sky darkens over', deadrise: 'the dead rise in', crime: 'thieves are at work in' };
  return f.record({ kind, by: [], to: [place], about: cause ? { opp: cause } : {}, note: `${note[kind]} ${w.name(place)}` }).id;
}

/** has this fact world the event `id`? (a restored list checks its entries' facts against the world it is bound to) */
export function hasEvent(w: FactWorld, id: string, kind: string): boolean {
  return w.facts.events({ kind }).some((e) => e.id === id);
}

/** One place read from the fact world (null: no such settlement). `home` settlements' own holder is the record's. */
export function placeState(w: FactWorld, id: string): PlaceState | null {
  const s = w.settlement(id);
  if (!s || !w.facts.entity(id)) return null;
  const f = w.facts;
  const evs = f.events({ involving: id }).filter((e) => MUTATION_EVENTS.includes(e.kind) && e.to.includes(id));
  const occupier = f.relations({ type: 'occupies', to: id })[0]?.from;
  const lord = f.relations({ type: 'vassal_of', from: id, historic: false })[0]?.to;
  const tribute = f.relations({ type: 'pays_tribute_to', from: id })[0];
  const gone = s.condition === 'ruined' || s.condition === 'abandoned';
  const status: PlaceState['status'] = s.condition === 'ruined' ? 'destroyed' : s.condition === 'abandoned' ? 'abandoned' : occupier ? 'occupied' : lord ? 'vassal' : evs.some((e) => e.kind === 'founding') ? 'founded' : 'standing';
  const conditions = evs.filter((e) => isLandKind(e.kind)).map((e) => e.kind as PhysicalKind);
  // (BACKLOG MU-13: a rule of thumb until the living town's people are the measure — each land change halves it)
  const population = gone ? 0 : Math.max(0.1, 0.5 ** conditions.filter((k) => k !== 'greened').length);
  return {
    id,
    name: s.name,
    at: [Math.round(s.at[0]), Math.round(s.at[1] / ROW_H)],
    size: s.size,
    owner: (occupier ?? lord ?? w.controllerOf(id) ?? '') as EntityId,
    status,
    tribute: !gone && tribute ? Number(tribute.meta?.perSeason ?? 1) : 0,
    population,
    conditions,
    restless: !gone && (status === 'vassal' || status === 'occupied'),
    history: evs.map((e) => e.id),
  };
}

/** every place the mutators' events have touched, in the order they first did */
export function placeStates(w: FactWorld): PlaceState[] {
  const ids: string[] = [];
  for (const e of w.facts.events()) if (MUTATION_EVENTS.includes(e.kind)) for (const id of e.to) if (!ids.includes(id) && w.settlement(id)) ids.push(id);
  return ids.map((id) => placeState(w, id)).filter((p): p is PlaceState => p !== null);
}
