// (round 117, runplan) Test and script fixture: seed 1's cached atlas facts and wiki (data/atlas, data/wiki) as a
// region graph and a fresh world — Node only (reads files).

import { readFileSync } from 'node:fs';
import type { AtlasFacts } from '../gm/atlas-facts';
import type { WorldWiki } from '../gm/wiki';
import { MemoryWorldState } from '../api/contracts/world-state';
import { factsGraph } from './graph';

const file = (rel: string) => new URL(`../../${rel}`, import.meta.url);

let cache: { facts: AtlasFacts; wiki: WorldWiki } | null = null;

export function seed1(): { facts: AtlasFacts; wiki: WorldWiki } {
  cache ??= {
    facts: JSON.parse(readFileSync(file('data/atlas/seed1.json'), 'utf8')),
    wiki: JSON.parse(readFileSync(file('data/wiki/seed1.json'), 'utf8')),
  };
  return cache;
}

export function seed1Graph() {
  const { facts, wiki } = seed1();
  return factsGraph(facts, { regions: wiki.regions, settlements: wiki.snapshot.settlements });
}

/** the wiki's world (its regions' states, factions, settlements) as a live world state */
export function seed1World(): MemoryWorldState {
  return MemoryWorldState.restore(structuredClone(seed1().wiki.snapshot));
}
