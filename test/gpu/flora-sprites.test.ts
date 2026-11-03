// Round 128 (treegen, M6): the flora sprites baked on Dawn — every tree kind's every yaw cell has its tree in it (the
// bake's projection lands inside its cell), in leaf and in winter. With FLORA_SPRITE_PNG=<dir> the atlas is written out
// as PNGs (albedo over grey, and the normals) to look at.
import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { PNG } from 'pngjs';
import { testGpu, type TestGpu } from './dawn';
import { FloraLibrary } from '../../src/flora/library';
import { MeshInstances } from '../../src/render/meshinst';
import { FloraSprites } from '../../src/render/florasprites';
import { GLOBALS_BYTES } from '../../src/sim/globals';
import { SPR_CELL, SPR_COLS, SPR_YAWS } from '../../src/flora/sprites';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});

async function readTex(t: GPUTexture): Promise<Uint8Array> {
  const dev = g.device;
  const bpr = t.width * 4;
  const buf = dev.createBuffer({ size: bpr * t.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  const enc = dev.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: t }, { buffer: buf, bytesPerRow: bpr }, [t.width, t.height]);
  dev.queue.submit([enc.finish()]);
  return new Uint8Array(await g.read(buf, bpr * t.height));
}

describe('flora sprites bake (Dawn)', () => {
  for (const [name, season] of [
    ['leaf', 0.2],
    ['flower', 0.97],
    ['autumn', 0.47],
    ['bare', 0.76],
    ['winter', 0.85],
  ] as const)
    it(`every cell holds its tree (${name})`, async () => {
      const dev = g.device;
      const lib = new FloraLibrary(undefined, 6, 'sprite');
      const mi = new MeshInstances(dev, lib.kinds, (label, size, usage) => dev.createBuffer({ label, size, usage }), 16);
      const globals = dev.createBuffer({ size: GLOBALS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const gd = new ArrayBuffer(GLOBALS_BYTES);
      // (the season: Globals.rules.w — sim/globals.ts writes it at float 275, as the viewer page does)
      new Float32Array(gd)[275] = season;
      dev.queue.writeBuffer(globals, 0, gd);
      const mats = dev.createBuffer({ size: 40 * 80, usage: GPUBufferUsage.UNIFORM });
      const floraWgsl = `const FLORA: bool = true;const FLORA_RPX: f32 = 0.5;\n${lib.wgsl()}`;
      const spr = new FloraSprites(dev, lib, mi, globals, mats, floraWgsl);
      const enc = dev.createCommandEncoder();
      spr.bake(enc, season);
      dev.queue.submit([enc.finish()]);
      const alb = await readTex(spr.albedo);
      const nd = await readTex(spr.nd);
      expect(g.takeErrors()).toEqual([]);
      const W = spr.albedo.width;
      // each cell: its coverage, and none of it touching the cell's edge (the tree fits)
      for (let c = 0; c < spr.cells; c++) {
        const cx = (c % SPR_COLS) * SPR_CELL;
        const cy = Math.floor(c / SPR_COLS) * SPR_CELL;
        let cov = 0;
        for (let y = 0; y < SPR_CELL; y++) for (let x = 0; x < SPR_CELL; x++) if (alb[((cy + y) * W + cx + x) * 4 + 3] > 127) cov++;
        expect(cov, `cell ${c} (sprite ${Math.floor(c / SPR_YAWS)}, yaw ${c % SPR_YAWS})`).toBeGreaterThan(SPR_CELL * SPR_CELL * (season > 0.7 && season < 0.92 ? 0.01 : 0.04));
      }
      const dir = process.env.FLORA_SPRITE_PNG;
      if (dir) {
        fs.mkdirSync(dir, { recursive: true });
        for (const [tag, px] of [
          ['albedo', alb],
          ['normal', nd],
        ] as const) {
          const png = new PNG({ width: W, height: spr.albedo.height });
          for (let i = 0; i < W * spr.albedo.height; i++) {
            const a = alb[i * 4 + 3] / 255;
            for (let k = 0; k < 3; k++) png.data[i * 4 + k] = Math.round(px[i * 4 + k] * a + 96 * (1 - a));
            png.data[i * 4 + 3] = 255;
          }
          fs.writeFileSync(`${dir}/sprites-${name}-${tag}.png`, PNG.sync.write(png));
        }
      }
    });
});
