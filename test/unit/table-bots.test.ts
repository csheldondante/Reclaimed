// (card-table; docs/design/CARD_TABLE.md) The bots' table: every policy plays whole runs on the Realm and the report is
// printed. `node scripts/tablebots.mjs [--seeds 3] [--seasons 16]` runs this file alone and shows the table.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CATALOG } from '../../src/season/catalog';
import { projectTemplate, WORLD_TEMPLATES } from '../../src/season/realm-templates';
import { runBots } from '../../src/table/bots';
import { WORKS } from '../../src/season/works';
import { FACTORY } from '../../src/season/factory';

const N = Number(process.env.TABLE_SEEDS ?? 1);
const SEASONS = Number(process.env.TABLE_SEASONS ?? 16);

describe('bots play the card table', () => {
  const t0 = Date.now();
  const templates = [...CATALOG.map(projectTemplate).filter((t) => t !== null).map((t) => t!.id), ...WORLD_TEMPLATES.map((t) => t.id)];
  // (TABLE_PACK: one file, or several with commas — loaded together)
  const packs = process.env.TABLE_PACK ? process.env.TABLE_PACK.split(',').map((f) => JSON.parse(fs.readFileSync(f.trim(), 'utf8'))) : undefined;
  for (const p of packs ?? []) templates.push(...(p.cards ?? []).map((c: { id: string }) => c.id));
  const raiders = process.env.TABLE_RAIDERS ? { raiders: Number(process.env.TABLE_RAIDERS) } : {};
  // (draft 10: TABLE_WORKS — the base game's works on, the solver and greedy turn players added; TABLE_MEASURE — every
  // season of every run searched as a whole turn)
  const works = process.env.TABLE_WORKS ? { works: true } : {};
  if (process.env.TABLE_WORKS) templates.push(...(WORKS.cards ?? []).map((c) => c.id));
  const measure = process.env.TABLE_MEASURE ? { measure: true } : {};
  // (draft 11: TABLE_FACTORY — the factory game in place of the works; TABLE_CPC — clicks a posted crew a season)
  const factory = process.env.TABLE_FACTORY ? { factory: process.env.TABLE_CPC ? { cpc: Number(process.env.TABLE_CPC) } : true } : {};
  if (process.env.TABLE_FACTORY) templates.push(...(FACTORY.cards ?? []).map((c) => c.id));
  const rep = runBots({ seeds: Array.from({ length: N }, (_, i) => 7 + i), seasons: SEASONS, templates, ...(packs ? { packs } : {}), ...raiders, ...works, ...measure, ...factory });
  const timed = `${rep.text}\n(${rep.runs.length} runs in ${Date.now() - t0} ms)\n`;
  if (process.env.TABLE_OUT) fs.writeFileSync(process.env.TABLE_OUT, timed);
  console.log(`\n${timed}`);

  it('doing nothing loses the town; some way of playing keeps it', () => {
    expect(rep.runs.filter((r) => r.policy === 'idle').every((r) => r.end === 'fell')).toBe(true);
    expect(rep.runs.some((r) => r.end !== 'fell')).toBe(true);
  });
  it('more than one way of playing holds the raid: soldiers with spells hold it, and the tribute buys it off', () => {
    const ends = new Set(rep.runs.map((r) => r.end));
    expect(ends.has('held'), [...ends].join(', ')).toBe(true);
    // (draft 11: in the factory the tribute's Materials are made at the yard; no bot has paid it yet — a run is held
    // or falls)
    if (!process.env.TABLE_FACTORY) expect(ends.has('paid off'), [...ends].join(', ')).toBe(true);
    else expect(ends.has('fell'), [...ends].join(', ')).toBe(true);
  });
  it('a season asks few things', () => {
    // (draft 11: the factory's board is 6 offers and 3 needs)
    for (const r of rep.runs) expect(Math.max(...r.asked), r.policy).toBeLessThanOrEqual(process.env.TABLE_FACTORY ? 9 : 6);
  });
});
