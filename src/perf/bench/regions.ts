// Region generation and the store timed: fresh spots, generation stage by stage (CPU and GPU), the store's reads
// and writes. API: freshAt, regionStages, regionStagesGpu, makeRegion, storeIO.
import { landFrom } from '../../atlas/atlas';
import { stampWays } from '../../atlas/ways';
import { GPUGEN } from '../../atlas/finish';
import { settleLand } from '../../sim/sleep';
import { cpuStats } from '../../gpu/cpustat';
import { RegionStore } from '../../world/region-store';
import { ROW_H, r3, stat } from './defs';
import { frame } from '../bench';
import type { Bench } from '../bench';

/** a region's corner (world cells) in fresh ground: away from the window and from anything made so far */
export function freshAt(bn: Bench, k: number): [number, number] {
  const S = bn.R.stream;
  const a = bn.R.atlas;
  const R = S.R;
  // (on land — over the sea a region has nothing to march and costs nothing: round 101's first run measured 0.2 ms
  // regions 2 km out to sea — and a spiral 12+ regions out from the window, away from what the scenarios ride)
  for (let j = k; ; j += 7) {
    const ang = j * 2.399963;
    const d = (12 + (j % 23)) * R;
    const x = (((S.origin[0] + S.W / 2 + Math.cos(ang) * d) % a.p.cols) + a.p.cols) % a.p.cols;
    const y = (((S.origin[1] + S.H / 2 + Math.sin(ang) * d) % a.p.rows) + a.p.rows) % a.p.rows;
    const c: [number, number] = [Math.floor(x / R) * R, Math.floor(y / R) * R];
    const key = `${c[0]},${c[1]}`;
    if (bn.used.has(key)) continue;
    // (land under most of it: the macro height at its middle and corners over the sea)
    let land = 0;
    for (const [fx, fy] of [[0.5, 0.5], [0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]]) if (a.macroAt(c[0] + fx * R, (c[1] + fy * R) * ROW_H) > a.p.sea + 2) land++;
    if (land < 4 && j < k + 7 * 400) continue;
    bn.used.add(key);
    return c;
  }
}

/** Region generation stage by stage, as Atlas.regionLand and Streamer.generate do it (not the geysers' sinter) */
export async function regionStages(bn: Bench, n: number): Promise<Record<string, unknown>> {
  const a = bn.R.atlas;
  const S = bn.R.stream;
  const R = S.R;
  const was = a.profiler;
  a.profiler = bn.timer;
  const t: Record<string, number[]> = { columnsWall: [], readbackWait: [], land: [], ways: [], hooks: [], cutPack: [], toBody: [], uploadCall: [], uploadDone: [], total: [] };
  const gpu: Record<string, number[]> = { colHeight: [], formSeed: [], colFinish: [] };
  const scratch = bn.dev.createBuffer({ size: S.layout.bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  try {
    for (let k = 0; k < n; k++) {
      const [x0, y0] = freshAt(bn, bn.freshK++);
      await bn.dev.queue.onSubmittedWorkDone();
      const tA = performance.now();
      const c = await a.columns(x0, y0, R, R, false);
      const tB = performance.now();
      const g = await bn.timer.read();
      const gs = (nm: string) => (g.get(`atlas-${nm}`) ?? []).reduce((s, v) => s + v, 0);
      for (const nm of Object.keys(gpu)) if (g.has(`atlas-${nm}`)) gpu[nm].push(gs(nm));
      t.columnsWall.push(tB - tA);
      // (only where the timestamps can be trusted: the Pixel 9a's made it -495 ms)
      if (bn.timer.on && bn.tsChecks[0]?.reliable) t.readbackWait.push(tB - tA - gs('colHeight') - gs('formSeed') - gs('colFinish'));
      let t0 = performance.now();
      const land = landFrom(c, x0, y0, Infinity);
      t.land.push(performance.now() - t0);
      t0 = performance.now();
      stampWays(a.ways, land, x0, y0, R, R, (cx: number, cy: number) => [cx + 0.5 + 0.5 * (cy & 1), (cy + 0.5) * ROW_H], a.worldW, a.worldH);
      t.ways.push(performance.now() - t0);
      t0 = performance.now();
      for (const f of a.landHooks) await f(land, x0, y0, R, R, false);
      t.hooks.push(performance.now() - t0);
      t0 = performance.now();
      const fz = S.cutRegion(land, undefined);
      t.cutPack.push(performance.now() - t0);
      t0 = performance.now();
      const body: Uint8Array = S.toBody(fz);
      t.toBody.push(performance.now() - t0);
      t0 = performance.now();
      bn.dev.queue.writeBuffer(scratch, 0, body);
      t.uploadCall.push(performance.now() - t0);
      await bn.dev.queue.onSubmittedWorkDone();
      t.uploadDone.push(performance.now() - t0);
      t.total.push(performance.now() - tA);
      await frame();
    }
  } finally {
    a.profiler = was;
    scratch.destroy();
  }
  const o: Record<string, unknown> = {
    regions: n,
    regionCells: `${R}x${R}`,
    note: 'whole region in one dispatch (the first window\'s way); the streamer splits colFinish into 32x32 tiles over frames (see tiles)',
    gpu: bn.timer.on ? Object.fromEntries(Object.entries(gpu).map(([k, v]) => [k, stat(v, 'GPU ms a region')])) : 'n/a (no timestamp-query: columnsWall is the GPU work and the readback together)',
    cpu: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, stat(v, k === 'columnsWall' || k === 'readbackWait' || k === 'uploadDone' || k === 'total' ? 'ms wall a region' : 'ms CPU a region')])),
    bytes: S.layout.bytes,
  };
  const tot = stat(t.total, 'ms');
  if (tot) o.regionsPerSecondSerial = +(1000 / tot.p50).toFixed(2);
  return o;
}

/**
 * (round 102, `gpugen`) Region generation stage by stage the GPU's way (Atlas.regionInto, as Streamer.generateGpu does
 * it): the columns, the ways' and the stamps' CPU part, finish.wgsl straight into a slot, the small readback of what
 * the CPU keeps — wall, the GPU passes and the main thread's ms.
 */
export async function regionStagesGpu(bn: Bench, n: number): Promise<Record<string, unknown>> {
  const a = bn.R.atlas;
  const S = bn.R.stream;
  const R = S.R;
  const was = a.profiler;
  a.profiler = bn.timer;
  const t: Record<string, number[]> = { total: [], columnsCall: [], finishWall: [], readbackWait: [], encode: [], parse: [], cut: [], mainThread: [] };
  const gpu: Record<string, number[]> = { colHeight: [], formSeed: [], colFinish: [], regionFinish: [] };
  const slot = S.pool.temp();
  let back = 0;
  try {
    for (let k = 0; k < n; k++) {
      const [x0, y0] = freshAt(bn, bn.freshK++);
      await bn.dev.queue.onSubmittedWorkDone();
      const c0 = cpuStats.get('ways')?.sum ?? 0;
      const s0 = cpuStats.get('stamp')?.sum ?? 0;
      const tA = performance.now();
      const m = await a.regionInto(x0, y0, R, R, { buf: slot.buf, off: slot.off, layout: S.layout, oz: S.oz, zMax: bn.R.core.dims.zMax, K: S.K, colK: S.colK, settle: !settleLand() }, { pace: 'none', stamps: 'plan' });
      const tB = performance.now();
      // (the streamer's own CPU part: the relief bits, the structural box)
      const t0 = performance.now();
      const rel = new Uint8Array(R * R);
      for (let i = 0; i < R * R; i++) rel[i] = Math.abs(m.surface[i] - m.ground[i]) > 0.75 ? 1 : 0;
      t.cut.push(performance.now() - t0);
      const L = a.finisher.last;
      back = L.backBytes;
      const g = await bn.timer.read();
      const gs = (nm: string) => (g.get(`atlas-${nm}`) ?? []).reduce((s, v) => s + v, 0);
      for (const nm of Object.keys(gpu)) if (g.has(`atlas-${nm}`)) gpu[nm].push(gs(nm));
      t.total.push(tB - tA);
      t.finishWall.push(L.waitMs + L.encodeMs + L.parseMs);
      t.readbackWait.push(L.waitMs);
      t.encode.push(L.encodeMs);
      t.parse.push(L.parseMs);
      const ways = (cpuStats.get('ways')?.sum ?? 0) - c0;
      const stamps = (cpuStats.get('stamp')?.sum ?? 0) - s0;
      t.columnsCall.push(ways + stamps);
      t.mainThread.push(ways + stamps + L.encodeMs + L.parseMs + t.cut[t.cut.length - 1]);
      await frame();
    }
  } finally {
    a.profiler = was;
    S.pool.release(slot);
  }
  const o: Record<string, unknown> = {
    path: 'gpu (atlas/finish.wgsl straight into a pool slot)',
    regions: n,
    regionCells: `${R}x${R}`,
    gpu: bn.timer.on ? Object.fromEntries(Object.entries(gpu).map(([k, v]) => [k, stat(v, 'GPU ms a region')])) : 'n/a (no timestamp-query)',
    cpu: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, stat(v, k === 'total' || k === 'finishWall' || k === 'readbackWait' ? 'ms wall a region' : 'ms main thread a region')])),
    note: 'columnsCall: the ways\' and the stamps\' CPU part (cpustat ways + stamp); mainThread: all of the main thread\'s ms a region',
    readbackBytes: back,
    uploadBytes: 0,
  };
  const tot = stat(t.total, 'ms');
  if (tot) o.regionsPerSecondSerial = +(1000 / tot.p50).toFixed(2);
  return o;
}

/** (round 102) a region made as the streamer makes it — on the GPU into a slot (let go after), or the CPU's way */
export async function makeRegion(bn: Bench, x0: number, y0: number, spread: boolean): Promise<void> {
  const a = bn.R.atlas;
  const S = bn.R.stream;
  if (!GPUGEN) {
    await a.regionLand(x0, y0, S.R, S.R, Infinity, spread);
    return;
  }
  const slot = S.pool.temp();
  try {
    await a.regionInto(x0, y0, S.R, S.R, { buf: slot.buf, off: slot.off, layout: S.layout, oz: S.oz, zMax: bn.R.core.dims.zMax, K: S.K, colK: S.colK, settle: !settleLand() }, { pace: spread ? 'stream' : 'none', stamps: 'plan' });
  } finally {
    S.pool.release(slot);
  }
}

/** the disk store: a real region's record (made here) written and read back, in a world of its own then cleared */
export async function storeIO(bn: Bench, n: number): Promise<Record<string, unknown>> {
  const a = bn.R.atlas;
  const S = bn.R.stream;
  const R = S.R;
  const [x0, y0] = freshAt(bn, bn.freshK++);
  const land = await a.regionLand(x0, y0, R, R, Infinity, false);
  const fz = S.cutRegion(land, undefined);
  const body: Uint8Array = S.toBody(fz).slice();
  const st = await RegionStore.open(`bench-io-${Date.now().toString(36)}`);
  const put: number[] = [];
  const get: number[] = [];
  try {
    for (let k = 0; k < n; k++) {
      const t0 = performance.now();
      await st.put(`b${k}`, body.slice(), { session: 'bench', hash: k });
      put.push(performance.now() - t0);
    }
    for (let k = 0; k < n; k++) {
      const t0 = performance.now();
      await st.get(`b${k}`);
      get.push(performance.now() - t0);
    }
    const s = st.stats;
    return {
      bytes: body.byteLength,
      packedBytes: Math.round(s.packedBytes / Math.max(1, s.puts)),
      put: stat(put, 'ms wall a region (compress in the worker + IndexedDB write)'),
      get: stat(get, 'ms wall a region (IndexedDB read + decompress)'),
      workerPutMs: r3(s.putMs / Math.max(1, s.puts)),
      workerGetMs: r3(s.getMs / Math.max(1, s.gets)),
      note: 'the record body only (no header/outside sections); pool freeze/thaw are in each scenario\'s cpuSteps (rs.freeze, rs.thaw, write.pool, slide.freeze) and gpuCopy in io',
    };
  } finally {
    await st.clear();
  }
}
