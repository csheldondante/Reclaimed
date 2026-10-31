// The collapse judges (game/judge.ts) on a RockWorld (test/support/rockworld.ts): RockWorld.judge's passes — what was
// cut judged, what gives cut out and falls as rigid bodies (with its hinge), what crumbles goes — with either judge
// behind the one interface. Judge B reads the columns on the GPU: the CPU's columns are written to the GPU before each
// pass (the test's cost, not the judge's: in the game the GPU's columns are the world's own). External cells aren't
// mirrored here (RockWorld.judge has them; the shapes have none).
import type { Fracture } from '../../src/game/fracture';
import type { RockJudge } from '../../src/game/judge';
import { subtract } from '../../src/game/colbodies';
import type { RockWorld } from './rockworld';

export interface GpuCols {
  device: GPUDevice;
  slots: GPUBuffer;
  chunks: GPUBuffer;
}

/** the GPU's copy of a RockWorld's columns (made once; its slots written before each judging) */
export function gpuCols(device: GPUDevice, w: RockWorld): GpuCols {
  const slots = device.createBuffer({ label: 'test slots', size: w.packed.slots.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  const chunks = device.createBuffer({ label: 'test chunks', size: w.packed.chunkTable.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(chunks, 0, w.packed.chunkTable);
  return { device, slots, chunks };
}

export interface Judged {
  /** each pass's verdict */
  passes: Fracture[];
  /** each pass's judge stats (ms, gpuMs …) */
  stats: RockJudge['stats'][];
  /** cells freed as pieces over every pass (from the verdicts: the rigid rock retires its oldest past TUNE.rigid.maxBodies) */
  freed: number;
}

/** RockWorld.judge's passes, by `judge` (till nothing more gives, 12 at most) */
export async function judgeWorld(w: RockWorld, judge: RockJudge, gpu?: GpuCols): Promise<Judged> {
  const out: Judged = { passes: [], stats: [], freed: 0 };
  for (let pass = 0; pass < 12 && w.cut.size; pass++) {
    const seeds: [number, number][] = [...w.cut].map((k) => [k % 65536, Math.floor(k / 65536)]);
    const weighed = new Set(w.cut);
    w.cut.clear();
    if (gpu) gpu.device.queue.writeBuffer(gpu.slots, 0, w.packed.slots);
    const fr = await judge.judge({ cols: { packed: w.packed, vox: w.vox, gpu }, seeds, weigh: (x, y) => weighed.has(y * 65536 + x), rotate: true });
    out.passes.push(fr);
    out.stats.push({ ...judge.stats });
    w.log.push(`judge pass ${pass}: pieces ${(fr.pieces ?? []).length}, tips ${(fr.tips ?? []).length}, why ${JSON.stringify(fr.why)}`);
    for (const c of fr.crumbleRuns ?? []) {
      if (!c.ivs.length) continue;
      w.write(c.x, c.y, subtract(w.read(c.x, c.y), c.ivs));
      w.cut.add(c.y * 65536 + c.x);
    }
    const tips = new Map((fr.tips ?? []).map((t) => [t.piece, t]));
    (fr.pieces ?? []).forEach((piece, i) => {
      const cells: { x: number; y: number; z: number; mat: number }[] = [];
      for (const c of piece) {
        if (!c.ivs.length) continue;
        w.write(c.x, c.y, subtract(w.read(c.x, c.y), c.ivs));
        w.cut.add(c.y * 65536 + c.x);
        for (const iv of c.ivs) for (let z = Math.round(iv.z0); z < Math.round(iv.z1); z++) cells.push({ x: c.x, y: c.y, z, mat: iv.mat });
      }
      out.freed += cells.length;
      if (cells.length) w.rigid.spawn(cells, tips.get(i));
    });
  }
  return out;
}
