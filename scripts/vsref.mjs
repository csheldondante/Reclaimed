// Round 125 (forest): a shot and the reference side by side, as one PNG (the reference scaled to the shot's height,
// nearest neighbour). node scripts/vsref.mjs <shot.png> [--ref docs/design/ref/forest-floor.png] [--out x.png]
import fs from 'node:fs';
import { PNG } from 'pngjs';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const shot = PNG.sync.read(fs.readFileSync(argv[0]));
const ref = PNG.sync.read(fs.readFileSync(opt('ref', 'docs/design/ref/forest-floor.png')));
const out = opt('out', argv[0].replace(/\.png$/, '-vs-ref.png'));
const H = shot.height;
const rw = Math.round((ref.width * H) / ref.height);
const W = shot.width + 8 + rw;
const o = new PNG({ width: W, height: H });
o.data.fill(20);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < shot.width; x++) {
    const s = (y * shot.width + x) * 4;
    const d = (y * W + x) * 4;
    for (let k = 0; k < 4; k++) o.data[d + k] = shot.data[s + k];
  }
  for (let x = 0; x < rw; x++) {
    const sx = Math.min(ref.width - 1, Math.floor((x * ref.width) / rw));
    const sy = Math.min(ref.height - 1, Math.floor((y * ref.height) / H));
    const s = (sy * ref.width + sx) * 4;
    const d = (y * W + shot.width + 8 + x) * 4;
    for (let k = 0; k < 3; k++) o.data[d + k] = ref.data[s + k];
    o.data[d + 3] = 255;
  }
}
fs.writeFileSync(out, PNG.sync.write(o));
console.log(`saved ${out}`);
