// (loop round 14) Points of interest: real places on the world map that are not towns — a bandit camp, a monster's
// lair, a wizard's tower, a star ship's crash site, an old battlefield, a vault, a temple on a magic node. The owner
// (2026-11-17): "Yes make any interesting poi like this. Bandit camps, monster lairs, wizard towers, giants bound to the
// land, crash sites of star ships, ancient battlefields, bridges, dungeons, vaults, temples to channel magical nodes
// etc." Only cards make, change or remove one (never a timer); the record of resolved cards is their history.
//
// A POI is an entity of the fact world: kind 'site', attrs.poi its kind, at.at its world cell [x, row], and conditions:
// `cleared` (taken out: a lair emptied, a camp broken), `gone` (no longer on the map). Its holder (a faction that keeps
// it, 'raiders' for the raiders' camp) is attrs.holder. The rules read it as a thing (packs/load.ts farThings):
// `poi`, its kind, `standing` or `cleared`, its holder's id, the pack tags set on it.
//
// Where a new one stands is chosen here, the same way every time (the dealer binds a card's template to a fitting place):
// a ring of FAR_STEPS points round a place at the kind's distance, the one farthest from every settlement (a camp in
// the wilds, not on a town). The macro ground is not read: the card table has no atlas (BACKLOG LS-133).
import type { EntityId } from '../api/contracts/facts';
import type { FactWorld } from '../living/world';
import { ROW_H } from '../world/lattice';

import { isPoiKind, POI_KINDS, type PoiKind } from '../packs/check';
export { isPoiKind, POI_KINDS, type PoiKind };
/** the words the player reads for each kind */
export const POI_WORD: Record<PoiKind, string> = { camp: 'camp', lair: 'lair', tower: 'tower', crash: 'crash site', battlefield: 'old battlefield', vault: 'vault', temple: 'temple', bridge: 'bridge', dungeon: 'dungeon', giant: 'giant' };
/** how far from the place it is put near, by kind (cells): [least, most] — the ring is walked from the least out */
export const POI_FAR: Record<PoiKind, [number, number]> = { camp: [90, 160], lair: [100, 200], tower: [80, 160], crash: [120, 240], battlefield: [80, 180], vault: [100, 220], temple: [80, 180], bridge: [60, 120], dungeon: [100, 200], giant: [120, 240] };
/** the map's mark colour by kind */
export const POI_COLOUR: Record<PoiKind, string> = { camp: '#d4553a', lair: '#8a3ad4', tower: '#3a8ad4', crash: '#d4b13a', battlefield: '#9a8a7a', vault: '#c8c8c8', temple: '#3ad4b1', bridge: '#b07a3a', dungeon: '#6a4a8a', giant: '#7ad43a' };

export interface Poi {
  id: EntityId;
  name: string;
  kind: PoiKind;
  /** world cells [x, row] */
  cell: [number, number];
  state: 'standing' | 'cleared' | 'gone';
  holder: EntityId | null;
}

const FAR_STEPS = 16;
const RINGS = 4;


/** one POI of the world (null: no such, or not a POI) */
export function poi(w: FactWorld, id: EntityId): Poi | null {
  const e = w.facts.entity(id);
  if (!e || !isPoiKind(e.attrs.poi) || !e.at.at) return null;
  const state = w.facts.tag(id, 'condition', 'gone')?.value ? 'gone' : w.facts.tag(id, 'condition', 'cleared')?.value ? 'cleared' : 'standing';
  return { id, name: e.name, kind: e.attrs.poi, cell: [e.at.at[0], e.at.at[1]], state, holder: typeof e.attrs.holder === 'string' ? e.attrs.holder : null };
}

/** every POI of the world, gone ones too (the map leaves those out) */
export function pois(w: FactWorld): Poi[] {
  return w.facts.find({ kind: 'site' }).flatMap((e) => (isPoiKind(e.attrs.poi) ? [poi(w, e.id)!].filter(Boolean) : []));
}

/**
 * Where a new POI of `kind` goes near `near` (a settlement, or a POI): of FAR_STEPS ways round it on RINGS rings from the
 * kind's least distance to its most, the point farthest from every settlement and every other POI; ties by the
 * way's order (a hash of the id turns the ring, so two POIs near one town differ).
 */
export function poiCell(w: FactWorld, kind: PoiKind, near: EntityId, id: string): [number, number] {
  const s = w.settlement(near);
  const p = s ? null : poi(w, near);
  if (!s && !p) throw new Error(`pois: nothing called ${near} to put a ${kind} near`);
  const c: [number, number] = s ? [s.at[0], s.at[1]] : [p!.cell[0], p!.cell[1] * ROW_H];
  const others: [number, number][] = [...w.ws.settlements.map((x) => [x.at[0], x.at[1]] as [number, number]), ...pois(w).map((x) => [x.cell[0], x.cell[1] * ROW_H] as [number, number])];
  let turn = 0;
  for (let i = 0; i < id.length; i++) turn = (turn * 31 + id.charCodeAt(i)) >>> 0;
  const a0 = ((turn % 997) / 997) * Math.PI * 2;
  const [lo, hi] = POI_FAR[kind];
  let best: [number, number] = [c[0] + lo, c[1]];
  let bestD = -1;
  for (let r = 0; r < RINGS; r++) {
    const far = lo + ((hi - lo) * r) / Math.max(1, RINGS - 1);
    for (let k = 0; k < FAR_STEPS; k++) {
      const a = a0 + (k / FAR_STEPS) * Math.PI * 2;
      const q: [number, number] = [c[0] + Math.cos(a) * far, c[1] + Math.sin(a) * far];
      const d = Math.min(...others.map((o) => Math.hypot(o[0] - q[0], o[1] - q[1])));
      if (d > bestD + 1e-6) [best, bestD] = [q, d];
    }
  }
  return [Math.round(best[0]), Math.round(best[1] / ROW_H)];
}

/** a POI put on the map (once: an id already there is left as it is) */
export function addPoi(w: FactWorld, spec: { id: EntityId; name: string; kind: PoiKind; cell: [number, number]; holder?: EntityId | null; region?: number; cause: string }): void {
  const f = w.facts;
  if (f.entity(spec.id)) return;
  f.add({ id: spec.id, kind: 'site', name: spec.name, at: { ...(spec.region !== undefined ? { region: spec.region } : {}), at: spec.cell }, attrs: { poi: spec.kind, ...(spec.holder ? { holder: spec.holder } : {}) }, cause: spec.cause });
  f.record({ kind: 'poi-made', by: spec.holder ? [spec.holder] : [], to: [spec.id], about: { opp: spec.cause }, note: `${spec.name}, a ${POI_WORD[spec.kind]}, is on the map` });
}

/** a POI's state set by a card: cleared (taken out), gone (off the map), standing (back) */
export function setPoiState(w: FactWorld, id: EntityId, state: 'standing' | 'cleared' | 'gone', cause: string): void {
  const p = poi(w, id);
  if (!p) throw new Error(`pois: ${id} is no point of interest`);
  const f = w.facts;
  if (state === 'standing') {
    f.dropTag(id, 'condition', 'cleared');
    f.dropTag(id, 'condition', 'gone');
  } else f.setTag(id, 'condition', state, true, cause);
  f.record({ kind: `poi-${state}`, by: ['player'], to: [id], about: { opp: cause }, note: `${p.name} ${state === 'cleared' ? 'is cleared' : state === 'gone' ? 'is gone from the map' : 'stands again'}` });
}

/** the tags the rules read on a POI */
export function poiTags(p: Poi): string[] {
  return ['poi', p.kind, p.state === 'standing' ? 'standing' : p.state, ...(p.holder ? [p.holder] : [])];
}
