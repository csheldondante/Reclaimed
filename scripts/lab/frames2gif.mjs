// (round 128l, m4) Lab shots into a GIF: the PNGs a scenario saved with lab.shot('<prefix>_000') … in order.
//   node scripts/lab/frames2gif.mjs <dir> <prefix> <out.gif> [--delay 120] [--scale 0.5]
import fs from 'node:fs';
import path from 'node:path';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';

const [dir, prefix, out] = process.argv.slice(2);
const opt = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? Number(process.argv[i + 1]) : d;
};
if (!dir || !prefix || !out) throw new Error('usage: frames2gif.mjs <dir> <prefix> <out.gif> [--delay ms] [--scale s]');
const delay = opt('delay', 120);
const scale = opt('scale', 0.5);
const files = fs
  .readdirSync(dir)
  .filter((f) => f.startsWith(prefix) && f.endsWith('.png'))
  .sort();
if (!files.length) throw new Error(`no ${prefix}*.png in ${dir}`);
const { GIFEncoder, quantize, applyPalette } = gifenc;
const enc = GIFEncoder();
for (const f of files) {
  const png = PNG.sync.read(fs.readFileSync(path.join(dir, f)));
  const w = Math.round(png.width * scale);
  const h = Math.round(png.height * scale);
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = Math.min(png.width - 1, Math.floor(x / scale));
      const sy = Math.min(png.height - 1, Math.floor(y / scale));
      const i = (sy * png.width + sx) * 4;
      px.set(png.data.subarray(i, i + 4), (y * w + x) * 4);
    }
  const pal = quantize(px, 256);
  enc.writeFrame(applyPalette(px, pal), w, h, { palette: pal, delay });
}
enc.finish();
fs.writeFileSync(out, enc.bytes());
console.log(`${out}: ${files.length} frames`);
