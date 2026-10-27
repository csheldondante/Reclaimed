// Round 96: two runs' frames side by side in one GIF (rocklabgif.mjs --pngs 1 saves every frame as name-NNN.png):
//   node scripts/sidebyside.mjs a.gif b.gif out.gif [--scale 0.5] [--delay 100]
// a.gif and b.gif name the runs (their frames a-000.png … beside them); the shorter run holds its last frame.
import { PNG } from 'pngjs';
import gifenc from 'gifenc';
import fs from 'node:fs';
const { GIFEncoder, quantize, applyPalette } = gifenc;
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const [a, b, out] = argv;
const scale = Number(opt('scale', 0.5));
const delay = Number(opt('delay', 100));
const frames = (g) => {
  const base = g.replace(/\.gif$/, '');
  const dir = base.slice(0, base.lastIndexOf('/') + 1) || './';
  const name = base.slice(base.lastIndexOf('/') + 1);
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(name + '-') && f.endsWith('.png'))
    .sort()
    .map((f) => PNG.sync.read(fs.readFileSync(dir + f)));
};
const A = frames(a);
const B = frames(b);
if (!A.length || !B.length) throw new Error('no frames (run rocklabgif with --pngs 1)');
const w = Math.round(A[0].width * scale);
const h = Math.round(A[0].height * scale);
const enc = GIFEncoder();
const n = Math.max(A.length, B.length);
for (let k = 0; k < n; k++) {
  const out = new Uint8Array(w * 2 * h * 4);
  [A[Math.min(k, A.length - 1)], B[Math.min(k, B.length - 1)]].forEach((p, side) => {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const sx = Math.min(p.width - 1, Math.floor(x / scale));
        const sy = Math.min(p.height - 1, Math.floor(y / scale));
        const si = (sy * p.width + sx) * 4;
        const di = (y * w * 2 + x + side * w) * 4;
        out.set(p.data.subarray(si, si + 4), di);
      }
  });
  // (a line between them)
  for (let y = 0; y < h; y++) out.set([255, 255, 255, 255], (y * w * 2 + w) * 4);
  const pal = quantize(out, 256);
  enc.writeFrame(applyPalette(out, pal), w * 2, h, { palette: pal, delay });
}
enc.finish();
fs.writeFileSync(out, enc.bytes());
console.log('saved', out, n, 'frames');
