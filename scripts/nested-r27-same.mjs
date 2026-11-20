// Nested scales (round 27): two sets of stills compared pixel by pixel (the ?tex=1 picture before and after part 2).
// node scripts/nested-r27-same.mjs <prefixA> <prefixB> <pose,pose,...>   e.g. local/nested/r27p1-r26 local/nested/r27p2-r26
//   bowl-sheets,cliff-sheets   (each file <prefix>-<pose>.png; the HUD's text rows, y < 170, left out: timings differ)
import fs from 'node:fs';
import { PNG } from 'pngjs';

const [a, b, poses] = process.argv.slice(2);
for (const p of poses.split(',')) {
  const A = PNG.sync.read(fs.readFileSync(`${a}-${p}.png`));
  const B = PNG.sync.read(fs.readFileSync(`${b}-${p}.png`));
  let diff = 0;
  let maxd = 0;
  for (let y = 170; y < A.height; y++)
    for (let x = 0; x < A.width; x++) {
      const i = (y * A.width + x) * 4;
      const d = Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]));
      if (d > 0) diff++;
      maxd = Math.max(maxd, d);
    }
  console.log(`${p}: ${diff} pixels differ below the HUD, largest channel difference ${maxd}`);
}
