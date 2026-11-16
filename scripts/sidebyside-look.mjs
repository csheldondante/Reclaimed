// Two stills side by side (the old physics left, the engine right), cropped to the middle of the screen:
//   node scripts/sidebyside-look.mjs <dir> <name> [suffix=end] [y0=180] [y1=660]
// reads <dir>/look-old-<name>-<suffix>.png and <dir>/look-engine-<name>-<suffix>.png, writes <dir>/look-pair-<name>-<suffix>.png
import fs from 'node:fs';
import { PNG } from 'pngjs';

const [dir, name, suffix = 'end', y0s = '180', y1s = '660'] = process.argv.slice(2);
const y0 = Number(y0s);
const y1 = Number(y1s);
const a = PNG.sync.read(fs.readFileSync(`${dir}/look-old-${name}-${suffix}.png`));
const b = PNG.sync.read(fs.readFileSync(`${dir}/look-engine-${name}-${suffix}.png`));
const h = y1 - y0;
const out = new PNG({ width: a.width + b.width + 4, height: h });
out.data.fill(255);
for (const [src, ox] of [[a, 0], [b, a.width + 4]]) {
  for (let y = 0; y < h; y++) src.data.copy(out.data, (y * out.width + ox) * 4, ((y + y0) * src.width) * 4, ((y + y0) * src.width + src.width) * 4);
}
fs.writeFileSync(`${dir}/look-pair-${name}-${suffix}.png`, PNG.sync.write(out));
