// (round 128s, trackA-legible) The variants side by side: for each shot (core, edge, street, people, overview) one sheet
// of A | B | C | D at half size, from scripts/legible.mjs's shots.
//   node scripts/legiblesheet.mjs <dir>
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const dir = process.argv[2];
const VS = ['A', 'B', 'C', 'D'];
for (const name of ['core', 'edge', 'street', 'people', 'crowd', 'overview']) {
  const imgs = VS.map((v) => {
    const f = path.join(dir, `${v}-${name}.png`);
    return fs.existsSync(f) ? PNG.sync.read(fs.readFileSync(f)) : null;
  });
  const first = imgs.find(Boolean);
  if (!first) continue;
  const w = Math.floor(first.width / 2);
  const h = Math.floor(first.height / 2);
  const gap = 6;
  const out = new PNG({ width: VS.length * w + (VS.length - 1) * gap, height: h });
  out.data.fill(255);
  imgs.forEach((im, k) => {
    if (!im) return;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const o = ((y * out.width) + k * (w + gap) + x) * 4;
        // (a 2 x 2 box average)
        for (let c = 0; c < 4; c++) {
          let s = 0;
          for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) s += im.data[((2 * y + dy) * im.width + 2 * x + dx) * 4 + c];
          out.data[o + c] = s / 4;
        }
      }
  });
  const f = path.join(dir, `sheet-${name}.png`);
  fs.writeFileSync(f, PNG.sync.write(out));
  console.log(f);
}
