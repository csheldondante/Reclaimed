// Nested scales: compare two stills of the same view (e.g. ?cliffDbg=13 hit-kind stills before / after a march change):
// the pixels whose colour differs (any channel by more than 24 of 255) and, per still, the pixels of each hit-kind tint
// (draw.wgsl TINTS: blue = kind 6 (notch ceiling), red = 1 / 7 (side, notch back), yellow 2 top, green 3 floor,
// magenta 4 edge wall, cyan 5 notch floor). The top-left 440 x 190 (the page's text) is skipped.
// node scripts/nested-png-diff.mjs a.png b.png
import fs from 'node:fs';
import { PNG } from 'pngjs';

const [fa, fb] = process.argv.slice(2);
const A = PNG.sync.read(fs.readFileSync(fa));
const B = PNG.sync.read(fs.readFileSync(fb));
const TINTS = { blue: [89, 140, 255], red: [255, 89, 77], yellow: [255, 230, 64], green: [89, 255, 115], magenta: [230, 102, 255], cyan: [77, 255, 255] };
const kindOf = (d, i) => {
  for (const [k, t] of Object.entries(TINTS)) if (Math.abs(d[i] - t[0]) < 30 && Math.abs(d[i + 1] - t[1]) < 30 && Math.abs(d[i + 2] - t[2]) < 30) return k;
  return 'other';
};
let diff = 0;
let n = 0;
const ca = {};
const cb = {};
for (let y = 0; y < A.height; y++)
  for (let x = 0; x < A.width; x++) {
    if (x < 440 && y < 190) continue;
    const i = (y * A.width + x) * 4;
    n++;
    if (Math.abs(A.data[i] - B.data[i]) > 24 || Math.abs(A.data[i + 1] - B.data[i + 1]) > 24 || Math.abs(A.data[i + 2] - B.data[i + 2]) > 24) diff++;
    const ka = kindOf(A.data, i);
    const kb = kindOf(B.data, i);
    ca[ka] = (ca[ka] ?? 0) + 1;
    cb[kb] = (cb[kb] ?? 0) + 1;
  }
console.log(`${fa} vs ${fb}: ${diff} of ${n} px differ (${((100 * diff) / n).toFixed(1)} %)`);
console.log(`  a: ${JSON.stringify(ca)}`);
console.log(`  b: ${JSON.stringify(cb)}`);
