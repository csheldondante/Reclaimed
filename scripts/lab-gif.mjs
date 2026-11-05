// (round 128m) Join lab shots into a GIF: node scripts/lab-gif.mjs <prefix> <out.gif> [--every ms] [--crop x,y,w,h]
// e.g. node scripts/lab-gif.mjs quarry-gif- quarry.gif --crop 0,0,412,600 (the shots in .testcache/lab-shots, by name)
import fs from 'node:fs';
import path from 'node:path';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const [prefix, out] = process.argv.slice(2);
const opt = (k) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const every = Number(opt('every') ?? 150);
const dir = path.resolve('.testcache/lab-shots');
const files = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.png')).sort();
if (!files.length) throw new Error(`no shots ${prefix}* in ${dir}`);
const gif = GIFEncoder();
for (const f of files) {
  const png = PNG.sync.read(fs.readFileSync(path.join(dir, f)));
  const [cx, cy, cw, ch] = (opt('crop') ?? `0,0,${png.width},${png.height}`).split(',').map(Number);
  const rgba = new Uint8Array(cw * ch * 4);
  for (let y = 0; y < ch; y++) rgba.set(png.data.subarray(((cy + y) * png.width + cx) * 4, ((cy + y) * png.width + cx + cw) * 4), y * cw * 4);
  const pal = quantize(rgba, 256);
  gif.writeFrame(applyPalette(rgba, pal), cw, ch, { palette: pal, delay: every });
}
gif.finish();
fs.writeFileSync(out, gif.bytes());
console.log(`${files.length} frames → ${out}`);
