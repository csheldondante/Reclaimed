// (round 120, PL30) The bike's handling variants measured in Node: a sloppy rider (re-aims every 0.25 s, 16 directions,
// full stick) round the canyon and the city with each variant. Off by default:
//   HEROLAB_HANDLING=1 [HEROLAB_SECS=90] [HEROLAB_OUT=rows.json] npx vitest run --project unit test/unit/herolab-handling.test.ts
import { writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { parseHandling } from '../../src/play/lab/handling';
import { rideHandling, type HandlingResult } from '../../src/play/lab/ride';

describe.runIf(process.env.HEROLAB_HANDLING === '1')('the bike handling variants (Node)', () => {
  it('rides each', () => {
    const variants = (process.env.HEROLAB_VARIANTS ?? 'stock|grip|corridor|avoid|grip+corridor+avoid').split('|');
    const rows: HandlingResult[] = [];
    for (const t of ['canyon', 'city'])
      for (const v of variants) rows.push(rideHandling(t, parseHandling(v), { secs: Number(process.env.HEROLAB_SECS ?? 90) }));
    const f = (r: HandlingResult) =>
      `${r.terrain.padEnd(7)} ${r.variant.padEnd(22)} hits ${r.hits.toFixed(1).padStart(5)}/min  crashes ${r.crashes.toFixed(1).padStart(4)}/min  speed ${r.speed.toFixed(1).padStart(5)} c/s  lap ${r.lap.toFixed(1).padStart(5)} s  fights ${(r.fight * 100).toFixed(1).padStart(4)} %  bent ${(r.bent * 100).toFixed(0).padStart(3)} %`;
    process.stderr.write(rows.map(f).join('\n') + '\n');
    if (process.env.HEROLAB_OUT) writeFileSync(process.env.HEROLAB_OUT, JSON.stringify(rows, null, 1));
  }, 1_200_000);
});
