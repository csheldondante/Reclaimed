// The coarse pass's desktop benchmark, and the whole body ↔ body path: SDF_BENCH=1 — 1,024, 4,096 and 16,384 rows of
// mixed sizes (shapes.ts coarseScene: a 2³ crumb to a 32 × 32 × 8 slab), 10% and 100% awake, in a loose field and in a
// dense pile; GPU ms for the coarse pass alone and for coarse + fine + reduction, by timestamp queries (the median of
// 12 submits; the sleeper hash built before, as in a tick with no sleep event). Then the structure's own question:
// the same pile with 1, 2, 3 and 5 levels. A desktop proxy on Dawn (D3D12); the phone's numbers come from
// sdfbench.html. Prints a table and writes data/perf/sdf/coarse-bench.json. Skipped otherwise.
import fs from 'node:fs';
import { expect, test } from 'vitest';
import { COUNTS_BYTES, COUNT_BRICKS, COUNT_CONTACTS, COUNT_PAIRS_DROPPED, COUNT_SAMPLE_CONTACTS, packBodies } from '../../src/engine/sdf/contract';
import { PAIR_ASKED, SdfCoarse } from '../../src/engine/sdf/coarse';
import { SdfFine } from '../../src/engine/sdf/fine';
import { SdfModels } from '../../src/engine/sdf/models';
import { awakeList, COARSE_MAX_DIAMETER, coarseScene, coarseShapes } from '../../src/engine/sdf/shapes';
import { testGpu } from './dawn';
import { storage } from './sdf-harness';

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

test.skipIf(!process.env.SDF_BENCH)('coarse collision: GPU ms by rows, awake share and density; the whole path; one level against several', async () => {
  const g = await testGpu();
  const dev = g.device;
  const store = new SdfModels(dev, 'grad8');
  const ids = coarseShapes().map((s) => store.add(s));
  store.flush();
  const rowsOut: Record<string, unknown>[] = [];
  const measure = async (rows: number, awake: number, kind: 'loose' | 'pile', levels: number) => {
    const scene = coarseScene(rows, awake, kind, ids, 7);
    const p = packBodies(scene.bodies);
    const list = dev.createBuffer({ size: (8 + rows) * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(list, 0, awakeList(scene.awake, rows));
    const inputs = { list, pose: storage(g, 'pose', p.pose), vel: storage(g, 'vel', p.vel), info: storage(g, 'info', p.info), model: storage(g, 'model', p.model), sleepEpoch: storage(g, 'epoch', new Uint32Array([1, 0, 0, 0])) };
    const coarse = new SdfCoarse(dev, store, { rows, cellTop: COARSE_MAX_DIAMETER + 0.25, levels, pairsARow: 16 });
    const fine = new SdfFine(dev, store, { maxPairs: coarse.pairRoom, maxBricks: coarse.pairRoom * 16 });
    const fin = { ...coarse.finePairs, pose: inputs.pose, vel: inputs.vel, info: inputs.info, model: inputs.model };
    coarse.setParams(rows);
    fine.setParams(coarse.pairRoom, 0);
    const N = 12;
    const qs = dev.createQuerySet({ type: 'timestamp', count: N * 4 });
    const res = dev.createBuffer({ size: N * 32, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    for (let k = -3; k < N; k++) {
      const enc = dev.createCommandEncoder();
      const i = Math.max(k, 0) * 4;
      coarse.encode(enc, inputs, { querySet: qs, beginningOfPassWriteIndex: i, endOfPassWriteIndex: i + 1 });
      fine.encode(enc, fin, coarse.pairRoom, { querySet: qs, beginningOfPassWriteIndex: i + 2, endOfPassWriteIndex: i + 3 });
      dev.queue.submit([enc.finish()]);
      await dev.queue.onSubmittedWorkDone();
    }
    const enc = dev.createCommandEncoder();
    enc.resolveQuerySet(qs, 0, N * 4, res, 0);
    dev.queue.submit([enc.finish()]);
    const t = new BigUint64Array(await g.read(res, N * 32));
    const ms = (a: number, b: number) => +median(Array.from({ length: N }, (_, k) => Number(t[k * 4 + b] - t[k * 4 + a]) / 1e6)).toFixed(3);
    const asked = new Uint32Array(await g.read(coarse.pairBuf, 16))[PAIR_ASKED];
    const c = new Uint32Array(await g.read(fine.counts, COUNTS_BYTES));
    expect(g.takeErrors()).toEqual([]);
    const row = { rows, awake: scene.awake.length, kind, levels, coarseMs: ms(0, 1), fineMs: ms(2, 3), allMs: ms(0, 3), pairs: asked, pairsDropped: c[COUNT_PAIRS_DROPPED], threads: c[COUNT_BRICKS] * 16, sampleContacts: c[COUNT_SAMPLE_CONTACTS], contactRows: c[COUNT_CONTACTS], coarseBytes: coarse.bytes };
    coarse.destroy();
    fine.destroy();
    qs.destroy();
    res.destroy();
    for (const b of Object.values(inputs)) b.destroy();
    return row;
  };
  for (const kind of ['loose', 'pile'] as const) for (const rows of [1024, 4096, 16384]) for (const awake of [0.1, 1]) rowsOut.push(await measure(rows, awake, kind, 3));
  // (nothing awake: the pass's fixed cost)
  rowsOut.push(await measure(4096, 0, 'pile', 3));
  const levels: Record<string, unknown>[] = [];
  for (const lv of [1, 2, 3, 5]) for (const awake of [0.1, 1]) levels.push(await measure(4096, awake, 'pile', lv));
  const pad = (v: unknown, w: number) => String(v).padStart(w);
  const line = (r: Record<string, unknown>) => `${String(r.kind).padEnd(5)} ${pad(r.rows, 6)} ${pad(r.awake, 6)} ${pad(r.levels, 3)}  ${pad(r.coarseMs, 7)} ${pad(r.fineMs, 8)} ${pad(r.allMs, 8)} ${pad(r.pairs, 8)} ${pad(r.pairsDropped, 6)} ${pad(r.threads, 9)} ${pad(r.contactRows, 8)}`;
  console.log([g.adapterInfo, 'scene   rows  awake lv  coarse ms  fine ms   all ms    pairs dropped   threads     rows', ...rowsOut.map(line), '', 'levels (pile, 4,096 rows):', ...levels.map(line)].join('\n'));
  fs.mkdirSync('data/perf/sdf', { recursive: true });
  fs.writeFileSync('data/perf/sdf/coarse-bench.json', JSON.stringify({ at: new Date().toISOString(), adapter: g.adapterInfo, what: 'desktop proxy, Dawn in Node (D3D12), grad8; timestamps round the coarse pass and the fine pass (expand to reduce), median of 12 submits; allMs from the coarse pass’s start to the fine pass’s end', rows: rowsOut, levels }, null, 1));
  store.destroy();
}, 1_200_000);
