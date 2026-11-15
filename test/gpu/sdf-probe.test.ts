// (the coarse pass's cost by part: SDF_PROBE=1; the note's isolation numbers)
import { test } from 'vitest';
import { packBodies } from '../../src/engine/sdf/contract';
import { SdfCoarse } from '../../src/engine/sdf/coarse';
import { SdfModels } from '../../src/engine/sdf/models';
import { awakeList, COARSE_MAX_DIAMETER, coarseScene, coarseShapes } from '../../src/engine/sdf/shapes';
import { testGpu } from './dawn';
import { storage } from './sdf-harness';

test.skipIf(!process.env.SDF_PROBE)('the coarse pass by part', async () => {
  const g = await testGpu();
  const dev = g.device;
  const store = new SdfModels(dev, 'grad8');
  const ids = coarseShapes().map((s) => store.add(s));
  store.flush();
  for (const [rows, awake, kind] of [[1024, 0.1, 'pile'], [4096, 0.1, 'pile'], [4096, 1, 'loose'], [16384, 0.1, 'loose'], [16384, 1, 'pile']] as const) {
    const scene = coarseScene(rows, awake, kind, ids, 7);
    const p = packBodies(scene.bodies);
    const list = dev.createBuffer({ size: (8 + rows) * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(list, 0, awakeList(scene.awake, rows));
    const inputs = { list, pose: storage(g, 'pose', p.pose), vel: storage(g, 'vel', p.vel), info: storage(g, 'info', p.info), model: storage(g, 'model', p.model), sleepEpoch: storage(g, 'epoch', new Uint32Array([1, 0, 0, 0])) };
    const coarse = new SdfCoarse(dev, store, { rows, cellTop: COARSE_MAX_DIAMETER + 0.25, pairsARow: 16 });
    coarse.setParams(rows);
    const out: number[] = [];
    for (const upTo of [0, 1, 2, 3]) {
      coarse.upTo = upTo;
      const N = 12;
      const qs = dev.createQuerySet({ type: 'timestamp', count: N * 2 });
      const res = dev.createBuffer({ size: N * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      for (let k = -3; k < N; k++) {
        const enc = dev.createCommandEncoder();
        const i = Math.max(k, 0) * 2;
        coarse.encode(enc, inputs, { querySet: qs, beginningOfPassWriteIndex: i, endOfPassWriteIndex: i + 1 });
        dev.queue.submit([enc.finish()]);
        await dev.queue.onSubmittedWorkDone();
      }
      const enc = dev.createCommandEncoder();
      enc.resolveQuerySet(qs, 0, N * 2, res, 0);
      dev.queue.submit([enc.finish()]);
      const t = new BigUint64Array(await g.read(res, N * 16));
      out.push([...Array(N).keys()].map((k) => Number(t[k * 2 + 1] - t[k * 2]) / 1e6).sort((a, b) => a - b)[N / 2]);
    }
    console.log(`PROBE ${kind} ${rows} rows, ${scene.awake.length} awake: gate ${out[0].toFixed(3)} | + awake table ${out[1].toFixed(3)} | + stage A ${out[2].toFixed(3)} | + stage B ${out[3].toFixed(3)} ms`);
    coarse.destroy();
  }
}, 300_000);
