// The road generator on the GPU (round 128p, DA-A13 step 0: src/roadgen/gpu.ts, shaders/roadgen.wgsl) against the CPU
// reference (roadgen/cpu.ts, roadgen/lattice.ts), then on the user's start town's land (data/lab/town.rclt): timed, a
// full run and an edit (a drawn road), the site it makes; ROADGEN_OUT=<dir> writes the map previews there (PNG).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { testGpu, type TestGpu } from './dawn';
import { fieldOf, latticeSize, ROADGEN_STYLE, type Road, type RoadGenInput, type RoadGenParams, type V2 } from '../../src/roadgen/roadgen';
import { RoadGenCpu } from '../../src/roadgen/cpu';
import { RoadGenGpu } from '../../src/roadgen/gpu';
import { claimsCpu, offsetsCpu } from '../../src/roadgen/lattice';
import { inputOfSite, siteOfRoads } from '../../src/roadgen/site';
import { previewRgba } from '../../src/roadgen/preview';
import { decodeTownFixture } from '../../src/lab/townfixture';
import { siteFromJson, TownSite } from '../../src/build/site';
import { cellAt, ROW_H } from '../../src/world/lattice';
import { DEEP } from '../../src/build/reach';

let gpu: TestGpu;
beforeAll(async () => {
  gpu = await testGpu();
});
afterAll(() => {
  expect(gpu.takeErrors()).toEqual([]);
});

function input(o: { ground?: (x: number, y: number) => number; params?: Partial<RoadGenParams> } = {}): RoadGenInput {
  const W = 160;
  const H = 160;
  const params: RoadGenParams = { ...ROADGEN_STYLE, W, H, centre: [80, 80], radius: 76, theta: 0, seed: 1, ...o.params };
  if (!o.params?.sigmaR) params.sigmaR = 0.01;
  const { nx, ny } = latticeSize(params);
  const ground = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) ground[j * nx + i] = o.ground?.(i * params.S, j * params.S) ?? 0;
  return { params, ground, wet: new Uint8Array(nx * ny), constraints: [] };
}

const length = (rs: Road[]) => rs.reduce((s, r) => s + r.pts.reduce((t, q, k) => (k ? t + Math.hypot(q[0] - r.pts[k - 1][0], q[1] - r.pts[k - 1][1]) : 0), 0), 0);

describe('the GPU road generator = the CPU reference', () => {
  it('the field', async () => {
    const inp = input({ ground: (x, y) => 5 * Math.sin(x / 20) + 0.3 * y, params: { sigmaR: 40, theta: 0.3 } });
    inp.constraints.push([
      [10, 30],
      [90, 70],
      [150, 60],
    ]);
    const g = new RoadGenGpu(gpu.device, inp);
    await g.run();
    // (the field buffer: a, b, wet, ground per node)
    const raw = new Float32Array(await gpu.read((g as unknown as { field: GPUBuffer }).field, latticeSize(inp.params).nx * latticeSize(inp.params).ny * 16));
    const cpu = fieldOf(inp);
    expect(gpu.takeErrors()).toEqual([]);
    let worst = 0;
    for (let i = 0; i < cpu.length / 2; i++) worst = Math.max(worst, Math.abs(raw[i * 4] - cpu[i * 2]), Math.abs(raw[i * 4 + 1] - cpu[i * 2 + 1]));
    expect(worst).toBeLessThan(1e-4);
    g.destroy();
  });

  it('flat land: the same roads', async () => {
    const inp = input();
    const cpu = new RoadGenCpu(input()).run();
    const g = new RoadGenGpu(gpu.device, inp);
    const res = await g.run();
    expect(res.roads.length).toBe(cpu.length);
    expect(length(res.roads)).toBeCloseTo(length(cpu), 0);
    g.destroy();
  });

  it('hilly land: about the same roads (f32 against f64 steps)', async () => {
    const ground = (x: number, y: number) => 6 * Math.sin(x / 30) + 4 * Math.cos(y / 23) + 0.25 * x;
    const cpu = new RoadGenCpu(input({ ground, params: { sigmaR: 50, theta: 0.4 } })).run();
    const g = new RoadGenGpu(gpu.device, input({ ground, params: { sigmaR: 50, theta: 0.4 } }));
    const res = await g.run();
    expect(Math.abs(res.roads.length - cpu.length) / cpu.length).toBeLessThan(0.2);
    expect(Math.abs(length(res.roads) - length(cpu)) / length(cpu)).toBeLessThan(0.1);
    g.destroy();
  });

  it('the lattice: claims and offsets as the CPU makes them from the same roads', async () => {
    const inp = input({ ground: (x, y) => 3 * Math.sin(x / 25) + 0.1 * y, params: { sigmaR: 40, theta: 0.5, jitter: 0.2 } });
    const g = new RoadGenGpu(gpu.device, inp);
    const res = await g.run();
    const claims = claimsCpu(inp.params, res.roads, res.latN, inp.wet);
    let differ = 0;
    for (let i = 0; i < claims.length; i++) if (claims[i] !== res.claims[i]) differ++;
    // (a cell's middle exactly half a cell from a line can fall either way in f32)
    expect(differ / claims.length).toBeLessThan(0.005);
    const off = offsetsCpu(inp.params, res.roads, res.latN, res.claims);
    // (a vertex as near two roads — where they cross — may take either's edge: f32 against f64 picks)
    let apart = 0;
    for (let v = 0; v < off.length / 2; v++) if (Math.hypot(off[v * 2] - res.offsets[v * 2], off[v * 2 + 1] - res.offsets[v * 2 + 1]) > 0.05) apart++;
    expect(apart / (off.length / 2)).toBeLessThan(0.01);
    g.destroy();
  });
});

describe("the start town's land (data/lab/town.rclt)", () => {
  it('a full run and an edit, timed; the site it makes', async () => {
    const FILE = path.resolve(import.meta.dirname, '../../data/lab/town.rclt');
    const { header, map } = await decodeTownFixture(new Uint8Array(fs.readFileSync(FILE)));
    const tpl = TownSite.fromData(siteFromJson(header.site));
    const { box } = tpl;
    const [ox, oy] = header.origin;
    const W = header.dims.w;
    const wet = (x: number, y: number) => {
      const [k, r] = cellAt(x, y);
      const col = (r + box.y0 - oy) * W + (k + box.x0 - ox);
      return map.water[col] > DEEP || map.surface[col] < header.seaZ;
    };
    const centre: V2 = [header.town.at[0] - (box.x0 - ox), header.town.at[1] - (box.y0 - oy) * ROW_H];
    const radius = Math.min(centre[0], centre[1], box.w - 1 - centre[0], (box.h - 1) * ROW_H - centre[1]) - 2;
    const inp = inputOfSite(tpl, { centre, radius, wet });
    const g = new RoadGenGpu(gpu.device, inp);
    // (the first run pays the pipelines' compiling: timed after one warm run on a copy)
    const warm = new RoadGenGpu(gpu.device, inputOfSite(tpl, { centre, radius, wet }));
    await warm.run();
    warm.destroy();
    const res = await g.run();
    const made = siteOfRoads(tpl, inp, res);
    // the GPU's column -> cell (math, then the 3 x 3) against QuadGrid's on the CPU
    const cols = await g.columnCells((b, n) => gpu.read(b, n));
    let same = 0;
    let held = 0;
    made.site.grid.cellOf.forEach((q, col) => {
      if (q < 0) return;
      held++;
      if (cols[col] >= 0 && made.latticeQuad[cols[col]] === q) same++;
    });
    expect(same / held).toBeGreaterThan(0.995);
    // an edit: a road drawn across the town from one side of its middle to the other
    const a: V2 = [centre[0] - radius * 0.7, centre[1] - radius * 0.2];
    const b: V2 = [centre[0] + radius * 0.6, centre[1] + radius * 0.35];
    const drawn: V2[] = [a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + 12], b];
    const reach = 3 * inp.params.sigmaC;
    const rect: [number, number, number, number] = [Math.min(a[0], b[0]) - reach, Math.min(a[1], b[1]) - reach, Math.max(a[0], b[0]) + reach, Math.max(a[1], b[1]) + 12 + reach];
    const res2 = await g.edit([drawn], rect);
    const made2 = siteOfRoads(tpl, inp, res2);
    // (a profile: each phase waited on)
    const gt = new RoadGenGpu(gpu.device, inputOfSite(tpl, { centre, radius, wet }));
    gt.timed = true;
    const prof = gpu.device.features.has('timestamp-query');
    if (prof) gt.kernelMs = {};
    const pt = (await gt.run()).phases;
    const kt = prof ? await gt.kernelTimes() : null;
    if (prof) gt.kernelMs = {};
    const pt2 = (await gt.edit([drawn], rect)).phases;
    const kt2 = prof ? await gt.kernelTimes() : null;
    gt.destroy();
    const report = {
      box: [box.w, box.h],
      domain: [inp.params.W, inp.params.H].map((v) => +v.toFixed(1)),
      radius: +radius.toFixed(1),
      theta: +inp.params.theta.toFixed(3),
      constraints: inp.constraints.length,
      caps: g.caps,
      columns: { held, same },
      run: { gpuMs: +res.gpuMs.toFixed(1), totalMs: +res.totalMs.toFixed(1), readbackKB: +(res.bytes / 1024).toFixed(0), ...made.stats, cpuMs: +made.stats.cpuMs.toFixed(1) },
      edit: { gpuMs: +res2.gpuMs.toFixed(1), totalMs: +res2.totalMs.toFixed(1), ...made2.stats, cpuMs: +made2.stats.cpuMs.toFixed(1) },
      phases: { run: pt, edit: pt2 },
      kernels: { run: kt, edit: kt2 },
      adapter: gpu.adapterInfo,
    };
    console.log(JSON.stringify(report, null, 1));
    expect(res.roads.length).toBeGreaterThan(10);
    expect(made.stats.blocks).toBeGreaterThan(5);
    expect(made.stats.houses).toBeGreaterThan(50);
    const out = process.env.ROADGEN_OUT;
    if (out) {
      fs.mkdirSync(out, { recursive: true });
      for (const [name, r, m] of [
        ['roadgen-town', res, made],
        ['roadgen-town-edit', res2, made2],
      ] as const) {
        const img = previewRgba(inp, r, m.houseCells, 3);
        const png = new PNG({ width: img.w, height: img.h });
        png.data = Buffer.from(img.data);
        fs.writeFileSync(path.join(out, `${name}.png`), PNG.sync.write(png));
      }
      fs.writeFileSync(path.join(out, 'roadgen-town.json'), JSON.stringify(report, null, 1));
    }
    g.destroy();
  }, 120_000);
});
