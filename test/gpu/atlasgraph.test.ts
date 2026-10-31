// (runplay, round 119) Terrain's atlas graph for seed 1 — the run's region graph (runplan/graph.ts runGraph) — built
// on Dawn from the level's own atlas (DEFAULT_ATLAS), checked against the atlas facts the wiki was made from (the same
// regions: ids, kinds, centres) and kept as a fixture, data/atlas/seed1-graph.json, so the planner's Node tests plan on
// terrain's real graph without a GPU. The fixture is written when missing or with WRITE_FIXTURES=1; otherwise the
// built graph must equal it (terrain changing its borders shows here, and the fixture is rewritten on purpose).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { testGpu } from './dawn';
import { Atlas, DEFAULT_ATLAS } from '../../src/atlas/atlas';
import { TerrainSystem } from '../../src/terrain/terrain';
import { saveAtlasGraph } from '../../src/runplan/graph';
import type { AtlasFacts } from '../../src/gm/atlas-facts';

const file = (rel: string) => new URL(`../../${rel}`, import.meta.url);

describe('the atlas graph of seed 1', () => {
  it('matches the atlas facts and the fixture', { timeout: 240_000 }, async () => {
    const g = await testGpu();
    const a = await Atlas.build(g.device, DEFAULT_ATLAS);
    expect(g.takeErrors()).toEqual([]);
    const saved = saveAtlasGraph(new TerrainSystem(a).atlasGraph());
    const facts: AtlasFacts = JSON.parse(readFileSync(file('data/atlas/seed1.json'), 'utf8'));
    expect(saved.nodes.length).toBe(facts.regions.length);
    for (const r of facts.regions) {
      const n = saved.nodes[r.id];
      expect(n.kind, `region ${r.id}`).toBe(r.kind);
      expect(Math.hypot(n.centre[0] - r.centre[0], n.centre[1] - r.centre[1]), `region ${r.id} centre`).toBeLessThan(2);
    }
    const out = file('data/atlas/seed1-graph.json');
    const json = JSON.stringify(saved);
    if (!existsSync(out) || process.env.WRITE_FIXTURES) writeFileSync(out, json);
    else expect(JSON.parse(json)).toEqual(JSON.parse(readFileSync(out, 'utf8')));
  });
});
