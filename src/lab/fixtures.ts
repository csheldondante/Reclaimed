// (round 128m, townlab) The land fixtures (data/lab/*.rclt: lab/townfixture.ts) — the street lab's sites, captured from
// the game (scripts/labtown.mjs site <name> <cx>,<cy> [centre]: bare land, no towns or woods) — fetched and decoded.
// (Switchover: was lab/recipes.ts, with the behaviour lab's recipes and its old-town fixture, deleted.)
import type { MapData } from '../world/mapgen';
import { decodeTownFixture, type TownFixtureHeader } from './townfixture';

/** where a fixture's file is served from (the build copies data/lab/*.rclt) */
const FIXTURE_URLS: Record<string, () => Promise<string>> = {
  muru: async () => (await import('../../data/lab/site-muru.rclt?url')).default,
  river: async () => (await import('../../data/lab/site-river.rclt?url')).default,
  mountain: async () => (await import('../../data/lab/site-mountain.rclt?url')).default,
  mesa: async () => (await import('../../data/lab/site-mesa.rclt?url')).default,
  coast: async () => (await import('../../data/lab/site-coast.rclt?url')).default,
};

/** a fixture's land by name (FIXTURE_URLS: the street lab's sites), fetched and decoded */
export async function loadFixtureLand(name: string): Promise<{ map: MapData; fixture: TownFixtureHeader }> {
  const url = FIXTURE_URLS[name];
  if (!url) throw new Error(`no fixture file "${name}" (${Object.keys(FIXTURE_URLS).join(', ')})`);
  const res = await fetch(await url());
  if (!res.ok) throw new Error(`fixture ${name} didn't load (${res.status})`);
  const { header, map } = await decodeTownFixture(new Uint8Array(await res.arrayBuffer()));
  return { map, fixture: header };
}
