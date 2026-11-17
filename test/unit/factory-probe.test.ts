// (card-table, docs/design/FACTORY.md) A probe: one solver run of the factory, season by season, printed (crews,
// Unrest, stock, the turn played, the news). Run alone: npx vitest run --project unit test/unit/factory-probe.test.ts
import fs from 'node:fs';
import { it } from 'vitest';
import { Table } from '../../src/table/game';
import { modelOf, playTurn, solve, actText } from '../../src/table/turn-search';
import { RAID_AIM } from '../../src/table/bots';

it('probe: one solver run of the factory', () => {
  if (!process.env.FACTORY_PROBE) return;
  const t = new Table({ seed: 7, leader: process.env.FACTORY_PROBE === '1' ? 'ysolt' : process.env.FACTORY_PROBE, seasons: 12, factory: true });
  const out: string[] = [];
  while (!t.over) {
    const m = modelOf(t, process.env.FACTORY_AIM ? RAID_AIM : {});
    const sr = solve(m);
    const ps = t.pieces();
    const where = (k: string) => ps.filter((p) => p.kind === 'crew' && p.where === k).length;
    out.push(`S${t.season}: crews free ${where('free')} strike ${where('strike')} project ${where('project')} posted ${where('posted')}; unrest ${t.poolViews().find((p) => p.pool === 'unrest')!.have}; stock ${t.stock().filter((x) => x.have).map((x) => `${x.k} ${x.have}`).join(', ')}`);
    out.push(`  cards: ${t.cards().map((c) => `${c.title} [${c.cost}]${Object.keys(c.short).length ? ' SHORT' : ''}`).join(' | ')}`);
    out.push(`  turn: ${sr.best.map((a) => actText(m, a)).join('; ')}`);
    const mis = playTurn(t, m, sr.best);
    if (mis.length) out.push(`  MISMATCH ${mis.join('; ')}`);
    const at = t.log.length;
    t.endSeason();
    out.push(`  news: ${t.log.slice(at).map((l) => l.text).join(' / ')}`);
  }
  if (process.env.FACTORY_PROBE_OUT) fs.writeFileSync(process.env.FACTORY_PROBE_OUT, out.join('\n'));
  else console.log(out.join('\n'));
}, 600_000);
