// (the coarse pass's cost by part: SDF_PROBE=1; the note's isolation numbers)
import { test } from 'vitest';
import { COUNT_SLOT_EPOCH, packBodies } from '../../src/engine/sdf/contract';
import { SdfCoarse } from '../../src/engine/sdf/coarse';
import { SdfFine } from '../../src/engine/sdf/fine';
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

// (the pair slots' cost: SDF_PROBE=1. The fine pass when every pair finds its own slot (a settled scene), and when
// every pair claims one (the probe jumps the table's epoch before each pass, so every slot has gone stale); and
// pairArgs + slots alone, both ways)
test.skipIf(!process.env.SDF_PROBE)('the pair slots by part', async () => {
  const g = await testGpu();
  const dev = g.device;
  const store = new SdfModels(dev, 'grad8');
  const ids = coarseShapes().map((s) => store.add(s));
  store.flush();
  const lines: string[] = [];
  // (the first scene is run twice: its first run pays the pipelines)
  for (const [rows, awake, kind] of [[4096, 1, 'pile'], [4096, 1, 'pile'], [16384, 0.1, 'pile'], [16384, 1, 'pile']] as const) {
    const scene = coarseScene(rows, awake, kind, ids, 7);
    const p = packBodies(scene.bodies);
    const list = dev.createBuffer({ size: (8 + rows) * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(list, 0, awakeList(scene.awake, rows));
    const inputs = { list, pose: storage(g, 'pose', p.pose), vel: storage(g, 'vel', p.vel), info: storage(g, 'info', p.info), model: storage(g, 'model', p.model), sleepEpoch: storage(g, 'epoch', new Uint32Array([1, 0, 0, 0])) };
    const coarse = new SdfCoarse(dev, store, { rows, cellTop: COARSE_MAX_DIAMETER + 0.25, pairsARow: 16 });
    const fine = new SdfFine(dev, store, { maxPairs: coarse.pairRoom, maxBricks: coarse.pairRoom * 16, slots: 65536 });
    const fin = { ...coarse.finePairs, pose: inputs.pose, vel: inputs.vel, info: inputs.info, model: inputs.model };
    coarse.setParams(rows);
    fine.setParams(coarse.pairRoom, 0);
    const N = 13;
    let jump = 1000;
    const run = async (claim: boolean) => {
      const qs = dev.createQuerySet({ type: 'timestamp', count: N * 2 });
      const res = dev.createBuffer({ size: N * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      for (let k = 0; k < N; k++) {
        const enc = dev.createCommandEncoder();
        if (claim) dev.queue.writeBuffer(fine.counts, COUNT_SLOT_EPOCH * 4, new Uint32Array([(jump += 10)]));
        coarse.encode(enc, inputs);
        fine.encode(enc, fin, coarse.pairRoom, { querySet: qs, beginningOfPassWriteIndex: k * 2, endOfPassWriteIndex: k * 2 + 1 });
        dev.queue.submit([enc.finish()]);
        await dev.queue.onSubmittedWorkDone();
      }
      const enc = dev.createCommandEncoder();
      enc.resolveQuerySet(qs, 0, N * 2, res, 0);
      dev.queue.submit([enc.finish()]);
      const t = new BigUint64Array(await g.read(res, N * 16));
      const ms = [...Array(N).keys()].map((k) => Number(t[k * 2 + 1] - t[k * 2]) / 1e6);
      qs.destroy();
      res.destroy();
      return ms.slice(1).sort((a, b) => a - b)[6];
    };
    const found = await run(false);
    const claimed = await run(true);
    fine.upTo = 0;
    const aloneFound = await run(false);
    const aloneClaimed = await run(true);
    const c = new Uint32Array(await g.read(coarse.pairBuf, 16));
    lines.push(`SLOTS ${kind} ${rows} rows, ${scene.awake.length} awake, ${c[0]} pairs: fine pass, every pair found ${found.toFixed(3)} | every pair claiming ${claimed.toFixed(3)} | pairArgs + slots alone: found ${aloneFound.toFixed(3)}, claiming ${aloneClaimed.toFixed(3)} ms`);
    coarse.destroy();
    fine.destroy();
    for (const b of Object.values(inputs)) b.destroy();
  }
  console.log(lines.join('\n'));
  if (process.env.SDF_PROBE_OUT) (await import('node:fs')).writeFileSync(process.env.SDF_PROBE_OUT, lines.join('\n'));
}, 300_000);
