// (card-table; docs/design/CARD_TABLE.md) The bots' table: every policy plays whole runs on the Realm and the report is
// printed. `node scripts/tablebots.mjs [--seeds 3] [--seasons 16]` runs this file alone and shows the table.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CATALOG } from '../../src/season/catalog';
import { projectTemplate, WORLD_TEMPLATES } from '../../src/season/realm-templates';
import { runBots } from '../../src/table/bots';

const N = Number(process.env.TABLE_SEEDS ?? 1);
const SEASONS = Number(process.env.TABLE_SEASONS ?? 16);

describe('bots play the card table', () => {
  const t0 = Date.now();
  const templates = [...CATALOG.map(projectTemplate).filter((t) => t !== null).map((t) => t!.id), ...WORLD_TEMPLATES.map((t) => t.id)];
  const rep = runBots({ seeds: Array.from({ length: N }, (_, i) => 7 + i), seasons: SEASONS, templates });
  const timed = `${rep.text}\n(${rep.runs.length} runs in ${Date.now() - t0} ms)\n`;
  if (process.env.TABLE_OUT) fs.writeFileSync(process.env.TABLE_OUT, timed);
  console.log(`\n${timed}`);

  it('doing nothing loses the town; some way of playing keeps it', () => {
    expect(rep.runs.filter((r) => r.policy === 'idle').every((r) => r.end === 'fell')).toBe(true);
    expect(rep.runs.some((r) => r.end !== 'fell')).toBe(true);
  });
  it('a season asks few things', () => {
    for (const r of rep.runs) expect(Math.max(...r.asked), r.policy).toBeLessThanOrEqual(6);
  });
});
