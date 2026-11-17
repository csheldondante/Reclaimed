// (loop round 9) A before/after strip: rows of stills side by side, one PNG, for judging a step against the last.
//   node scripts/lab/strip.mjs <out.png> <row1a.png,row1b.png,...> [<row2a.png,...> ...] [--scale 0.5]
// Each argument after the output is a row (comma-separated files); a missing file leaves its cell grey.
import fs from 'node:fs';
import { PNG } from 'pngjs';

const args = process.argv.slice(2);
const si = args.indexOf('--scale');
const scale = si >= 0 ? Number(args[si + 1]) : 0.5;
const rest = si >= 0 ? args.filter((_, i) => i !== si && i !== si + 1) : args;
const [out, ...rows] = rest;
if (!out || !rows.length) throw new Error('usage: strip.mjs <out.png> <a.png,b.png> [<c.png,d.png> ...] [--scale s]');
const grid = rows.map((r) => r.split(',').map((f) => (fs.existsSync(f) ? PNG.sync.read(fs.readFileSync(f)) : null)));
const any = grid.flat().find(Boolean);
if (!any) throw new Error('no image found');
const cw = Math.round(any.width * scale);
const ch = Math.round(any.height * scale);
const gap = 4;
const cols = Math.max(...grid.map((r) => r.length));
const W = cols * cw + (cols - 1) * gap;
const H = grid.length * ch + (grid.length - 1) * gap;
const o = new PNG({ width: W, height: H });
o.data.fill(40);
for (let i = 3; i < o.data.length; i += 4) o.data[i] = 255;
grid.forEach((row, r) =>
  row.forEach((img, c) => {
    const x0 = c * (cw + gap);
    const y0 = r * (ch + gap);
    for (let y = 0; y < ch; y++)
      for (let x = 0; x < cw; x++) {
        const d = ((y0 + y) * W + x0 + x) * 4;
        if (!img) {
          o.data[d] = o.data[d + 1] = o.data[d + 2] = 90;
          continue;
        }
        const s = (Math.min(img.height - 1, Math.floor(y / scale)) * img.width + Math.min(img.width - 1, Math.floor(x / scale))) * 4;
        o.data[d] = img.data[s];
        o.data[d + 1] = img.data[s + 1];
        o.data[d + 2] = img.data[s + 2];
      }
  }),
);
fs.writeFileSync(out, PNG.sync.write(o));
console.log(`${out}: ${grid.length} rows × ${cols}, ${W}x${H}`);
