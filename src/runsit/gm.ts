// ---- runsit/gm.ts -----------------------------------------------------------------------------------------------
// (round 120, `runsit`) The run's situation: the GM's, when one was written for this world (data/situations/*.json,
// its seed, version and run), else the template filled from the world as it is (fill.ts). Either way it must pass the
// validator (src/gm/situationcheck.ts): a written situation with problems is an error, never patched.
// The user (round 120): "This is what we want the gm to do possibly with templates. Look at world state and tell a
// story with meaningful decisions for the player run."

import type { Situation } from '../api/contracts/situation';
import type { RegionGraph } from '../api/contracts/run';
import type { WorldSnapshot } from '../api/contracts/world';
import { checkSituation, situationWorldFrom, worldPrint } from '../gm/situationcheck';
import { fillSituation } from './fill';
import type { V2 } from './state';

/** the GM's situations, bundled (Vite: every file under data/situations) */
const WRITTEN = import.meta.glob('../../data/situations/*.json', { eager: true, import: 'default' }) as Record<string, Situation>;

export function writtenSituations(): Situation[] {
  return Object.keys(WRITTEN)
    .sort()
    .map((k) => WRITTEN[k]);
}

/**
 * The situation for the next run: the first GM-written one for this world's seed, version and run (`gm` false: skip
 * them), else the template's. `wiki` is the world wiki built from the live atlas (its regions' neighbours and centres:
 * what the validator checks a route and the clock against).
 */
export function situationFor(o: { graph: RegionGraph; world: WorldSnapshot; wiki: unknown; seed: number; from: number; at?: V2; hero: string; gm?: boolean; written?: Situation[] }): { sit: Situation; by: 'gm' | 'template'; note?: string } {
  const sw = situationWorldFrom({ ...(o.wiki as object), snapshot: o.world });
  const print = worldPrint(o.world);
  let note: string | undefined;
  if (o.gm !== false)
    for (const s of o.written ?? writtenSituations()) {
      if (s.from.seed !== o.seed || s.from.worldVersion !== o.world.version || s.from.run !== o.world.run) continue;
      if (s.hero !== 'any' && s.hero !== o.hero) continue;
      // (written for another make of this seed — other towns: round 120's phone bug. Not this world's situation; said on
      // the card and the console, and the template fills one for the world as it came out here)
      if (s.from.print !== print) {
        note = `the GM's "${s.title}" was written for another make of seed ${o.seed} (world ${s.from.print ?? 'unprinted'}, here ${print}: this GPU made other towns)`;
        console.warn(`runsit: ${note}`);
        continue;
      }
      const p = checkSituation(s, sw);
      if (p.length) throw new Error(`runsit: the GM's situation ${s.id} has ${p.length} problems:\n${p.join('\n')}`);
      return { sit: structuredClone(s), by: 'gm' };
    }
  const sit = fillSituation({ graph: o.graph, world: o.world, seed: o.seed, from: o.from, at: o.at, hero: o.hero });
  const p = checkSituation(sit, sw);
  if (p.length) throw new Error(`runsit: the template's situation ${sit.id} has ${p.length} problems:\n${p.join('\n')}`);
  return { sit, by: 'template', note };
}
