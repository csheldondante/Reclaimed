// A contact sheet of the voxelised prop set (data/props/props.json), drawn isometric on the CPU, each voxel's three
// visible faces shaded: a quick check of the prepass without the browser.
//   node scripts/props/preview.mjs data/props/props.json out.png
import fs from 'node:fs';
import { PNG } from 'pngjs';
import { PROP_PALETTE } from './palette.mjs';

const [, , inPath, outPath] = process.argv;
const set = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const CELL = 150;
const COLS = 6;
const rows = Math.ceil(set.props.length / COLS);
const W = CELL * COLS, H = CELL * rows + 0;
const png = new PNG({ width: W, height: H });
for (let i = 0; i < W * H; i++) png.data.set([28, 26, 24, 255], i * 4);
const depth = new Float32Array(W * H).fill(-1e9);
const S = 2.2; // px per voxel step

set.props.forEach((p, k) => {
  const ox = (k % COLS) * CELL + CELL / 2, oy = Math.floor(k / COLS) * CELL + CELL * 0.72;
  const [nx, ny] = p.dims;
  const occ = new Set();
  for (let i = 0; i < p.vox.length; i += 4) occ.add(`${p.vox[i]},${p.vox[i + 1]},${p.vox[i + 2]}`);
  const sc = Math.min(1, 70 / Math.max(...p.dims) / S * 1.6);
  for (let i = 0; i < p.vox.length; i += 4) {
    const x = p.vox[i] - nx / 2, y = p.vox[i + 1] - ny / 2, z = p.vox[i + 2], c = PROP_PALETTE[p.vox[i + 3]].rgb;
    // iso: screen x = (x - y), screen y = (x + y)/2 - z
    const sx = ox + (x - y) * S * sc, sy = oy + ((x + y) / 2 - z) * S * sc;
    const d = x + y + z;
    const top = !occ.has(`${p.vox[i]},${p.vox[i + 1]},${p.vox[i + 2] + 1}`);
    const r = Math.max(1, Math.ceil(S * sc));
    for (let py = -r; py <= r; py++) for (let px = -r; px <= r; px++) {
      const X = Math.round(sx + px), Y = Math.round(sy + py);
      if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
      if (depth[Y * W + X] > d) continue;
      depth[Y * W + X] = d;
      const sh = py < 0 && top ? 1.0 : px < 0 ? 0.75 : 0.55;
      png.data.set([Math.min(255, c[0] * 255 * sh * 1.3), Math.min(255, c[1] * 255 * sh * 1.3), Math.min(255, c[2] * 255 * sh * 1.3), 255], (Y * W + X) * 4);
    }
  }
});
fs.writeFileSync(outPath, PNG.sync.write(png));
console.log(`wrote ${outPath}`);
