// The fine pass's desktop benchmark (docs/design/PHYSICS_ENGINE.md "Fine collision"): SDF_BENCH=1 — 64, 256, 1,024
// and 4,096 intersecting pairs of 8³, 16³ and 32³ models (a box, a ball and an L of each size, shared by every body)
// at random poses, in each field format, in two scenes (shapes.ts benchScene): `touch`, each pair overlapping by
// 0.75 voxels (a resting or colliding pair), and `deep`, a third of each body inside the other. A desktop proxy on Dawn
// (D3D12): the phone bench (sdfbench.html) is the number that counts.
// GPU ms: timestamp queries round the fine pass (expand + args + the indirect fine dispatch), the median of 16
// passes, each its own submit. Wall ms: 8 passes submitted together, submit to onSubmittedWorkDone, over 8.
// Bake: wall ms (submit to onSubmittedWorkDone) for one model and for a batch of 64, the median of 5.
// Prints a table and writes data/perf/sdf/fine-bench.json. Skipped otherwise (the suite stays fast).
import fs from 'node:fs';
import { expect, test } from 'vitest';
import { COUNTS_BYTES, packBodies, type SdfFormat } from '../../src/engine/sdf/contract';
import { FINE_DEFAULT_CAP, FINE_DEFAULT_MARGIN, SdfFine } from '../../src/engine/sdf/fine';
import { SdfModels } from '../../src/engine/sdf/models';
import { benchScene, benchShapes } from '../../src/engine/sdf/shapes';
import { testGpu, type TestGpu } from './dawn';
import { storage } from './sdf-harness';

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

/** GPU ms of each of `n` passes: `encode` is given the pass's timestamp writes */
async function gpuMs(g: TestGpu, n: number, encode: (enc: GPUCommandEncoder, tw: GPUComputePassTimestampWrites) => void): Promise<number[]> {
  const dev = g.device;
  const qs = dev.createQuerySet({ type: 'timestamp', count: n * 2 });
  const res = dev.createBuffer({
    size: n * 16,
    usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
  });
  for (let k = 0; k < n; k++) {
    const enc = dev.createCommandEncoder();
    encode(enc, {
      querySet: qs,
      beginningOfPassWriteIndex: k * 2,
      endOfPassWriteIndex: k * 2 + 1,
    });
    dev.queue.submit([enc.finish()]);
    await dev.queue.onSubmittedWorkDone();
  }
  const enc = dev.createCommandEncoder();
  enc.resolveQuerySet(qs, 0, n * 2, res, 0);
  dev.queue.submit([enc.finish()]);
  const t = new BigUint64Array(await g.read(res, n * 16));
  qs.destroy();
  res.destroy();
  return Array.from({ length: n }, (_, k) => Number(t[k * 2 + 1] - t[k * 2]) / 1e6);
}

test.skipIf(!process.env.SDF_BENCH)(
  'fine collision: GPU ms by pairs, model size and field format; bake ms; bytes a model',
  async () => {
    const g = await testGpu();
    const hasTs = g.device.features.has('timestamp-query');
    const rows: Record<string, unknown>[] = [];
    const bake: Record<string, unknown>[] = [];
    const formats = (process.env.SDF_FORMATS?.split(',') as SdfFormat[] | undefined) ?? (['f32', 'snorm8', 'grad8'] as SdfFormat[]);
    for (const format of formats) {
      for (const n of [8, 16, 32]) {
        // ---- the bake: one model, then 64, wall time
        const one: number[] = [];
        const many: number[] = [];
        let bytes = { field: 0, samples: 0, occupancy: 0, row: 0, total: 0 };
        let dispatches = 0;
        for (let k = 0; k < 6; k++) {
          const s = new SdfModels(g.device, format);
          await g.device.queue.onSubmittedWorkDone();
          let t0 = performance.now();
          const id = s.add(benchShapes(n)[k % 3]);
          s.flush();
          await g.device.queue.onSubmittedWorkDone();
          // (the first is the pipelines' warm-up)
          if (k) one.push(performance.now() - t0);
          if (k % 3 === 0) bytes = s.info(id).bytes;
          const before = s.dispatches;
          const specs = Array.from({ length: 64 }, (_, i) => benchShapes(n)[i % 3]);
          t0 = performance.now();
          for (const spec of specs) s.add(spec);
          s.flush();
          await g.device.queue.onSubmittedWorkDone();
          if (k) many.push(performance.now() - t0);
          dispatches = s.dispatches - before;
          s.destroy();
        }
        bake.push({
          format,
          side: n,
          bakeOneMs: +median(one).toFixed(2),
          bake64Ms: +median(many).toFixed(2),
          bake64Dispatches: dispatches,
          boxBytes: bytes,
        });

        // ---- the fine pass
        const store = new SdfModels(g.device, format);
        const ids = benchShapes(n).map((s) => store.add(s));
        store.flush();
        for (const kind of ['touch', 'deep'] as const)
          for (const pairs of [64, 256, 1024, 4096]) {
            const scene = benchScene(pairs, n, ids, 7, kind);
            const packed = packBodies(scene.bodies);
            const inputs = {
              pairs: storage(g, 'bench pairs', scene.pairs),
              pairCount: storage(g, 'bench pair count', new Uint32Array([pairs, 0, 0, 0])),
              pose: storage(g, 'bench pose', packed.pose),
              vel: storage(g, 'bench vel', packed.vel),
              info: storage(g, 'bench info', packed.info),
            model: storage(g, 'bench model', packed.model),
              missing: storage(g, 'bench missing', new Uint32Array(scene.bodies.length)),
            };
            const fine = new SdfFine(g.device, store, {
              maxPairs: pairs,
              maxBricks: pairs * 2 * 512,
            });
            const pass = (tw?: GPUComputePassTimestampWrites) => {
              const enc = g.device.createCommandEncoder();
              fine.encode(enc, inputs, pairs, tw);
              return enc;
            };
            fine.setParams(pairs, 0);
            for (let k = 0; k < 4; k++) g.device.queue.submit([pass().finish()]);
            await g.device.queue.onSubmittedWorkDone();
            const ts = hasTs ? await gpuMs(g, 16, (enc, tw) => fine.encode(enc, inputs, pairs, tw)) : [];
            const t0 = performance.now();
            for (let k = 0; k < 8; k++) g.device.queue.submit([pass().finish()]);
            await g.device.queue.onSubmittedWorkDone();
            const wall = (performance.now() - t0) / 8;
            const c = new Uint32Array(await g.read(fine.counts, COUNTS_BYTES));
            const row = {
              format,
              side: n,
              kind,
              pairs,
              gpuMs: hasTs ? +median(ts).toFixed(3) : null,
              gpuMsMin: hasTs ? +Math.min(...ts).toFixed(3) : null,
              wallMs: +wall.toFixed(3),
              threads: c[2] * 16,
              sampleContacts: c[4], rows: c[0], rowsAPair: +(c[0] / pairs).toFixed(2),
              dropped: c[3],
              chunksDropped: c[3],
              passBytes: fine.bytes,
            };
            rows.push(row);
            expect(g.takeErrors()).toEqual([]);
            expect(c[4]).toBeGreaterThan(kind === 'deep' ? pairs : pairs / 2);
            fine.destroy();
            for (const b of Object.values(inputs)) b.destroy();
          }
        store.destroy();
      }
    }
    const pad = (v: unknown, w: number) => String(v).padStart(w);
    const lines = ['format  side  scene  pairs   GPU ms (median/min)   wall ms   threads    sample contacts  rows a pair  bricks dropped'];
    for (const r of rows)
      lines.push(`${String(r.format).padEnd(6)} ${pad(r.side, 5)}  ${String(r.kind).padEnd(5)} ${pad(r.pairs, 6)}   ${pad(r.gpuMs, 8)} / ${pad(r.gpuMsMin, 7)}  ${pad(r.wallMs, 8)} ${pad(r.threads, 9)} ${pad(r.sampleContacts, 10)} ${pad(r.rowsAPair, 6)} ${pad(r.dropped, 8)}`);
    lines.push('', 'format  side  bake 1 (wall ms)  bake 64 (wall ms)  dispatches  bytes a box model (field + samples + occupancy + row)');
    for (const b of bake) {
      const by = b.boxBytes as {
        field: number;
        samples: number;
        occupancy: number;
        row: number;
        total: number;
      };
      lines.push(`${String(b.format).padEnd(6)} ${pad(b.side, 5)} ${pad(b.bakeOneMs, 12)} ${pad(b.bake64Ms, 18)} ${pad(b.bake64Dispatches, 12)}   ${by.total} (${by.field} + ${by.samples} + ${by.occupancy} + ${by.row})`);
    }
    console.log(`${g.adapterInfo}\ncap ${FINE_DEFAULT_CAP} samples a half pair, margin ${FINE_DEFAULT_MARGIN} cells, both ways\n${lines.join('\n')}`);
    fs.mkdirSync('data/perf/sdf', { recursive: true });
    fs.writeFileSync(
      'data/perf/sdf/fine-bench.json',
      JSON.stringify(
        {
          at: new Date().toISOString(),
          adapter: g.adapterInfo,
          what: 'desktop proxy, Dawn in Node (D3D12). gpuMs: timestamp queries round the fine pass, median of 16 single-pass submits; wallMs: 8 passes in a row, submit to onSubmittedWorkDone, over 8; bake: wall ms',
          cap: FINE_DEFAULT_CAP,
          margin: FINE_DEFAULT_MARGIN,
          rows,
          bake,
        },
        null,
        1,
      ),
    );
  },
  1_200_000,
);
