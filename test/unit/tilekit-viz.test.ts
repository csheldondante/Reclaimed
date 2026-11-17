// (tilekit step 3) Plan diagrams of the grid (lab tooling, skipped unless TILEKIT_VIZ=1): writes PNGs to
// local/tilekit3/ (or $TILEKIT_VIZ_OUT) and prints the numbers. `TILEKIT_VIZ=1 npx vitest run test/unit/tilekit-viz.test.ts`
import fs from 'node:fs';
import { describe, it } from 'vitest';
import lotsMuru from '../../data/lab/lots-muru.json';
import { cornerAngle } from '../../src/tilekit/grid';
import { grainGrid, lotsOf, squareness, valenceZones, type V2 } from '../../src/tilekit/grain';
import { labPlan, windowAt } from '../../src/tilekit/grainplan';
import { gridDiagram } from '../support/tilediagram';

const on = !!process.env.TILEKIT_VIZ;
const OUT = process.env.TILEKIT_VIZ_OUT ?? 'local/tilekit3';

describe.skipIf(!on)('grid diagrams', () => {
  it('writes the grid before and after the grain', () => {
    fs.mkdirSync(OUT, { recursive: true });
    const words = new Uint32Array((lotsMuru as { lots: number[] }).lots);
    const L = lotsOf(words);
    const f = new Float32Array(words.buffer);
    let x = 0;
    let y = 0;
    let n = 0;
    for (let i = 0; i < words.length / 24; i++) {
      if (words[i * 24 + 17] === 1) {
        x += f[i * 24 + 8];
        y += f[i * 24 + 9];
        n++;
      }
    }
    const anchor: V2 = [x / n, y / n];
    const radius = Number(process.env.TILEKIT_R ?? 30);
    const relax = Number(process.env.TILEKIT_RELAX ?? 1000);
    const fair = Number(process.env.TILEKIT_FAIR ?? 0.5);
    const base = { ...windowAt(anchor), anchor, radius, relax, fair };
    const runs: [string, boolean, number][] = [
      ['grid_before', false, 1],
      ['grid_grain', true, 1],
      ['grid_after', true, 0],
      ['grid_noseam', true, 2],
    ];
    for (const [name, grain, variant] of runs) {
      const t0 = performance.now();
      const g = grainGrid(L, { ...base, grain, plan: labPlan(anchor, variant) });
      const ms = performance.now() - t0;
      fs.writeFileSync(`${OUT}/${name}.png`, gridDiagram(g.mesh, g.info, anchor, radius * 2 + 16));
      const z = valenceZones(g.mesh, g.info);
      console.log(name, `${ms.toFixed(0)} ms`, JSON.stringify(z.zones), 'square', JSON.stringify(squareness(g.mesh, g.info, cornerAngle)), 'blocks', JSON.stringify(g.info.blocks));
    }
  });
});
