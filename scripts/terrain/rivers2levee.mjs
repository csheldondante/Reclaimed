// Terrain rivers, step 1: the columns the levee raises — compare a rivers2.mjs --levee run with the levee (rivers=table)
// against one with ?levee=0, the same world. Prints raised columns, per river column, and the raise's size.
//   node scripts/terrain/rivers2levee.mjs local/terrain1/off-levee-stats.json local/terrain1/off-nolevee-stats.json
import fs from 'node:fs';

const [fa, fb] = process.argv.slice(2);
const a = JSON.parse(fs.readFileSync(fa, 'utf8')).levee;
const b = JSON.parse(fs.readFileSync(fb, 'utf8')).levee;
if (!a || !b || a.length !== b.length) throw new Error('the two runs must have the same sampled batches (--levee, same world)');
let cols = 0, raised = 0, rcols = 0, over1 = 0, over3 = 0, max = 0, batches = 0;
for (let i = 0; i < a.length; i++) {
  if (a[i].k !== b[i].k) throw new Error(`batch ${i}: node ${a[i].k} vs ${b[i].k}`);
  let any = false;
  rcols += a[i].rcols;
  for (let j = 0; j < a[i].g.length; j++) {
    cols++;
    const d = a[i].g[j] - b[i].g[j];
    if (d > 0.25) {
      raised++;
      any = true;
      if (d > 1) over1++;
      if (d > 3) over3++;
      max = Math.max(max, d);
    }
  }
  if (any) batches++;
}
console.log(JSON.stringify({ batches: a.length, batchesWithLevee: batches, columns: cols, riverColumns: rcols, raised, raisedPerRiverColumn: +(raised / Math.max(1, rcols)).toFixed(3), raisedOver1: over1, raisedOver3: over3, maxRaise: +max.toFixed(1) }));
