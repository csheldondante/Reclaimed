// The world's settlements' purposes and stories (round 120, `cities`; BACKLOG STR30): the cached atlas facts of seed 1
// (data/atlas/seed1.json) through the wiki the GM reads and the settlements' records. Node, no GPU.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SettlementPurpose } from '../../src/api/contracts/settlement';
import { buildWiki, wikiMarkdown } from '../../src/gm/wiki';
import { recordsFrom } from '../../src/settle/records';

describe('the world (seed 1): every settlement has a purpose and a story, on the record the GM reads', () => {
  const f = JSON.parse(fs.readFileSync('data/atlas/seed1.json', 'utf8'));
  const wiki = buildWiki(f);
  it('purposes vary with the land', () => {
    const count: Partial<Record<SettlementPurpose, number>> = {};
    for (const s of wiki.snapshot.settlements) {
      expect(s.purpose, s.id).toBeTruthy();
      expect(s.story?.founding).toMatch(/was founded/);
      count[s.purpose!.kind] = (count[s.purpose!.kind] ?? 0) + 1;
    }
    expect(Object.keys(count).length).toBeGreaterThanOrEqual(5);
    // (no purpose takes the world: the land differs)
    for (const n of Object.values(count)) expect(n!).toBeLessThan(wiki.snapshot.settlements.length * 0.5);
    // a port stands low by the sea
    for (const s of wiki.snapshot.settlements.filter((x) => x.purpose!.kind === 'port')) expect(f.sites[Number(s.id.slice(1))].ground - f.params.sea).toBeLessThan(18);
  });
  it('the records carry them, and the wiki’s page says them', () => {
    const recs = recordsFrom(wiki, 1);
    expect(recs.every((r) => r.rec.purpose && r.rec.story)).toBe(true);
    expect(recs.some((r) => r.approaches.length >= 2)).toBe(true);
    const md = wikiMarkdown(wiki, undefined as never);
    expect(md).toMatch(/Purpose: \*\*/);
  });
});

