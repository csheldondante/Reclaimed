// Top-down preview of a level's map, straight from its generator on the CPU
// (no GPU, no browser): height shading, materials, water, poison, dust,
// green, and each gate outlined and labelled. Seconds per iteration while
// writing a level (docs/LEVELS.md, "The tools").
//
//   node scripts/mapview.mjs [level-id] [--out map.png] [--scale 3]
//
// Legend: green = living; blue = water; black = oil; red tint = soil poison
// (deeper red, worse); tan speckle = blown dust (deeper, lighter); grey =
// stone/concrete; the start is a white ring, caches yellow rings, each gate
// a coloured outline with its id.
import { createServer } from 'vite';
import { PNG } from 'pngjs';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const id = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--')) ?? 'trials';
const S = Number(opt('scale', 3));
const out = opt('out', `${id}-map.png`);

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const { levelById, gatesOf } = await vite.ssrLoadModule('/src/game/levels.ts');
  const { MATERIALS, MAT } = await vite.ssrLoadModule('/src/world/materials.ts');
  const lv = levelById(id);
  if (lv.id !== id || !lv.generate) throw new Error(`no built level "${id}"`);
  const dims = { w: 256, h: 256, zMax: 64 };
  const t0 = performance.now();
  const map = lv.generate(dims);
  const gen = performance.now() - t0;
  const { w, h } = dims;
  const N = w * h;
  const top = new Float32Array(N);
  const mat = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const c = map.grid.cols[i];
    const t = c[c.length - 1];
    top[i] = t.z1 + map.drift[i];
    mat[i] = t.mat;
  }
  const png = new PNG({ width: w * S, height: h * S });
  const put = (px, py, r, g, b) => {
    if (px < 0 || py < 0 || px >= w * S || py >= h * S) return;
    const o = (py * w * S + px) * 4;
    png.data[o] = r;
    png.data[o + 1] = g;
    png.data[o + 2] = b;
    png.data[o + 3] = 255;
  };
  const mix = (a, b, t) => a.map((v, k) => v + (b[k] - v) * t);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      // light from the back-left, like the game's sun
      const dzx = top[Math.min(w - 1, x + 1) + y * w] - top[Math.max(0, x - 1) + y * w];
      const dzy = top[x + Math.min(h - 1, y + 1) * w] - top[x + Math.max(0, y - 1) * w];
      const shade = Math.max(0.45, Math.min(1.25, 0.9 + (dzx + dzy) * 0.12 + (top[i] - 14) * 0.008));
      const dust = map.driftMat?.[i] === 0 ? map.drift[i] : 0;
      let c = MATERIALS[mat[i]].albedo.map((v) => v * 255);
      if (map.driftMat?.[i] === MAT.Soil && map.drift[i] > 0) c = MATERIALS[MAT.Soil].albedo.map((v) => v * 255);
      if (dust > 0.2) c = mix(c, [205, 180, 140], Math.min(1, 0.4 + dust * 0.2));
      const p = map.contam[i * 2];
      if (p > 0.2) c = mix(c, [150, 40, 40], Math.min(0.75, p * 0.4));
      const v = map.vegetation[i];
      if (v > 0.5) c = mix(c, [60, 140, 50], Math.min(1, v / 3));
      if (map.moisture[i] < 0.04 && v < 0.5) c = mix(c, [235, 220, 190], 0.35);
      c = c.map((q) => q * shade);
      if (map.water[i] > 0.05) c = mix(c, [40, 90, 160], Math.min(0.85, 0.45 + map.water[i] * 0.12));
      if (map.oil[i] > 0.02) c = mix(c, [15, 12, 10], 0.85);
      if (map.oilStored[i * 2] > 0) c = mix(c, [120, 60, 40], 0.3);
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) put(x * S + sx, y * S + sy, ...c.map((q) => Math.max(0, Math.min(255, q))));
    }

  // outlines: a cell of the set whose neighbour isn't in it
  const PAL = [[255, 80, 80], [255, 200, 40], [80, 220, 255], [255, 120, 255], [140, 255, 120], [255, 160, 60], [180, 140, 255], [255, 255, 255]];
  const outline = (cells, col) => {
    const set = new Set(cells);
    for (const i of cells) {
      const x = i % w;
      const y = (i - x) / w;
      const edge = [i - 1, i + 1, i - w, i + w].some((j) => !set.has(j));
      if (edge) for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) put(x * S + sx, y * S + sy, ...col);
    }
  };
  const circle = (c, r, col) => {
    for (let a = 0; a < 360; a++) {
      const x = c[0] + Math.cos((a * Math.PI) / 180) * r;
      const y = c[1] + Math.sin((a * Math.PI) / 180) * r;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) put(Math.round(x * S) + sx - 1, Math.round(y * S) + sy - 1, ...col);
    }
  };
  const gates = gatesOf(map);
  gates.forEach((g, k) => outline(g.cells, PAL[k % PAL.length]));
  for (const [name, at] of Object.entries(map.poi)) {
    if (name === 'healthy') circle(at, 4, [255, 255, 255]);
    else if (name.startsWith('cache')) circle(at, 2.5, [255, 230, 0]);
    else if (name === 'goal') circle(at, 5, [255, 60, 200]);
  }
  // labels: a tiny 3×5 font
  const FONT = {
    a: '010101111101101', b: '110101110101110', c: '011100100100011', d: '110101101101110', e: '111100110100111', f: '111100110100100',
    g: '011100101101011', h: '101101111101101', i: '111010010010111', j: '001001001101010', k: '101101110101101', l: '100100100100111',
    m: '101111111101101', n: '110101101101101', o: '010101101101010', p: '110101110100100', q: '010101101110011', r: '110101110101101',
    s: '011100010001110', t: '111010010010010', u: '101101101101111', v: '101101101101010', w: '101101111111101', x: '101101010101101',
    y: '101101010010010', z: '111001010100111', '-': '000000111000000', ' ': '000000000000000',
  };
  const text = (s, x0, y0, col) => {
    const K = Math.max(2, S - 1);
    [...s.toLowerCase()].forEach((ch, n) => {
      const g = FONT[ch] ?? FONT[' '];
      for (let r = 0; r < 5; r++)
        for (let q = 0; q < 3; q++) {
          const on = g[r * 3 + q] === '1';
          for (let sy = 0; sy < K; sy++)
            for (let sx = 0; sx < K; sx++) {
              const px = x0 + (n * 4 + q) * K + sx;
              const py = y0 + r * K + sy;
              // a dark halo so labels read on any ground
              if (on) put(px, py, ...col);
            }
        }
    });
  };
  gates.forEach((g, k) => {
    const K = Math.max(2, S - 1);
    const x0 = Math.round(g.at[0] * S - (g.id.length * 4 * K) / 2);
    const y0 = Math.round(g.at[1] * S - 2.5 * K);
    for (let yy = y0 - 2; yy < y0 + 5 * K + 2; yy++) for (let xx = x0 - 2; xx < x0 + g.id.length * 4 * K + 1; xx++) put(xx, yy, 20, 20, 20);
    text(g.id, x0, y0, PAL[k % PAL.length]);
  });
  fs.writeFileSync(out, PNG.sync.write(png));
  console.log(`${lv.name}: generated in ${gen.toFixed(0)} ms → ${out}`);
  gates.forEach((g, k) => console.log(`  gate ${g.id.padEnd(8)} ${g.kind.padEnd(7)} ${String(g.cells.length).padStart(5)} cells  at ${g.at.map((v) => v.toFixed(0)).join(',')}  teaches ${g.teaches.join(', ') || '-'}`));
  const caches = Object.keys(map.poi).filter((n) => n.startsWith('cache'));
  if (caches.length) console.log(`  caches: ${caches.map((n) => `${n} ${map.poi[n].join(',')}`).join('; ')}`);
} finally {
  await vite.close();
}
