// The user's own tree variants (round 128, `treegen`; the user: "I would love a generator to play with the parameters
// or make new tree variants"). A variant is a species, a seed and the parameters changed from the species (params.ts
// overrides). Saved in the browser (localStorage), exported and imported as JSON, carried in a link, and loaded into the
// world: `?ftree=` holds { species: overrides } and the game's flora library builds those species with them
// (library.ts). Pure but for the storage calls (each guarded: a private window has none).

import { PARAMS, paramsFromQuery } from './params';
import { SPECIES, SPECIES_IDS, type SpeciesId } from './species';
import { rng } from './rng';

export interface Variant {
  name: string;
  species: SpeciesId;
  seed: number;
  over: Record<string, number | string>;
}

const KEY = 'reclaimed.treevariants';

export function loadVariants(): Variant[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter(isVariant) : [];
  } catch {
    return [];
  }
}

export function saveVariants(list: Variant[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // (no storage: the export is the copy)
  }
}

export function isVariant(v: unknown): v is Variant {
  const o = v as Variant;
  return !!o && typeof o.name === 'string' && SPECIES_IDS.includes(o.species) && typeof o.seed === 'number' && typeof o.over === 'object' && o.over !== null;
}

/** base64url of a JSON value (a link carries it) */
export function encodeLink(v: unknown): string {
  const b = btoa(unescape(encodeURIComponent(JSON.stringify(v))));
  return b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodeLink<T>(s: string): T {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(decodeURIComponent(escape(atob(b + '='.repeat((4 - (b.length % 4)) % 4)))));
}

/**
 * A new variant of a species: a new seed and its shape and crown parameters nudged at random (± `amount` of each
 * slider's range), the rest as given — "new variant from this species".
 */
/** the parameters that pick a kind of thing (a style, a shape, on/off): a new variant keeps them */
const SWITCHES = new Set(['cStyle', 'cLobeShape', 'sEnvelope', 'sLeader', 'cCore', 'tOrders', 'sForks', 'cLayers']);

export function newVariant(species: SpeciesId, over: Record<string, number | string>, seed: number, amount = 0.12): Record<string, number | string> {
  const r = rng(seed ^ 0x7a1e);
  const sp = SPECIES[species];
  const out = { ...over };
  for (const p of PARAMS) {
    if (p.group !== 'shape' && p.group !== 'crown' && p.group !== 'stem') continue;
    if ((p.shape && !sp.colonize) || (p.crown && !sp.crown) || (p.woody && !(sp.turtle && sp.stem)) || (p.twigs && !sp.twigs)) continue;
    // (the switches — style, shape, leader — kept: a variant is the same kind of tree)
    if (SWITCHES.has(p.key)) continue;
    const base = typeof out[p.key] === 'number' ? (out[p.key] as number) : p.get(sp);
    const v = base + (r() * 2 - 1) * amount * (p.max - p.min);
    out[p.key] = Math.min(p.max, Math.max(p.min, Math.round(v / p.step) * p.step));
  }
  return out;
}

/** `?ftree=` (the world's: { species: overrides }), or {} */
export function worldOverrides(q: URLSearchParams): Partial<Record<SpeciesId, Record<string, number | string>>> {
  const s = q.get('ftree');
  if (!s) return {};
  const v = decodeLink<Record<string, Record<string, number | string>>>(s);
  const out: Partial<Record<SpeciesId, Record<string, number | string>>> = {};
  for (const [k, o] of Object.entries(v)) {
    if (!SPECIES_IDS.includes(k as SpeciesId)) throw new Error(`?ftree: no species ${k}`);
    out[k as SpeciesId] = o;
  }
  return out;
}

export { paramsFromQuery };
