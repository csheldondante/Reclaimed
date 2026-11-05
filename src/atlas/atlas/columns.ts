// Columns of the atlas's land for a rectangle: on the CPU (columns) or kept on the GPU (columnsGpu), the giants in
// it, and the coarse world's changes since a snapshot. API: columns, columnsGpu, changes (Atlas's), giantsFor.
import { makeBindGroup } from '../../gpu/pipeline';
import { ROW_H } from '../../world/lattice';
import { type GpuColumns } from '../finish';
import { type CoarseSnap } from '../coarse';
import type { LandChange } from '../../scenes/streamer';
import { tileGate, traceOf } from './region-land';
import { PARAM_BYTES, COL_WORDS, COLG_BYTES, MR, INST_BYTES, MAX_INST, TILE, paceTile, GIANT_FLOATS, MAT_QUARTZ, FORM_MARGIN, FINEST, AtlasColumns } from './defs';
import type { Atlas } from '../atlas';

/** Atlas.columns (the class keeps the method, documented there) */
export async function columns(atl: Atlas, x0: number, y0: number, w: number, h: number, spread = false): Promise<AtlasColumns> {
  const dev = atl.device;
  const g = await atl.columnsGpu(x0, y0, w, h, spread);
  const { o, runs, instN } = g;
  const st = dev.createBuffer({ label: 'atlas col read', size: o.size + runs.size + 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const fin = dev.createCommandEncoder({ label: 'atlas columns read' });
  fin.copyBufferToBuffer(o, 0, st, 0, o.size);
  fin.copyBufferToBuffer(runs, 0, st, o.size, runs.size);
  fin.copyBufferToBuffer(instN, 0, st, o.size + runs.size, 16);
  dev.queue.submit([fin.finish()]);
  let buf: ArrayBuffer;
  try {
    await st.mapAsync(GPUMapMode.READ);
    const bt = spread ? atl.builds.get(`${x0},${y0}`) : undefined;
    if (bt) bt.mapped = performance.now();
    buf = st.getMappedRange().slice(0);
    st.unmap();
  } finally {
    st.destroy();
    g.done();
  }
  const forms = new Uint32Array(buf, o.size + runs.size, 1)[0];
  if (forms > MAX_INST) throw new Error(`atlas: ${forms} forms around the batch at ${x0},${y0} (room for ${MAX_INST})`);
  const f = new Float32Array(buf, 0, o.size / 4);
  const u = new Uint32Array(buf, 0, o.size / 4);
  for (let i = 0; i < w * h; i++) {
    const fl = u[i * COL_WORDS + 10];
    if (fl) throw new Error(`atlas: column ${x0 + (i % w)},${y0 + Math.floor(i / w)} has ${fl & 1 ? 'more forms near it than it considers' : `more than ${MR} runs`}`);
  }
  const runsU = new Uint32Array(buf, o.size, runs.size / 4);
  const run = (i: number, k: number) => {
    const r = (i * MR + k) * 2;
    return { z0: (runsU[r] & 0x7fffffff) / 256, z1: (runsU[r + 1] & 0xffffff) / 256, mat: runsU[r + 1] >>> 24, form: runsU[r] >>> 31 === 1 };
  };
  return { w, h, f, u, runsU, run, forms };
}

/** Atlas.columnsGpu (the class keeps the method, documented there) */
export async function columnsGpu(atl: Atlas, x0: number, y0: number, w: number, h: number, spread = false, gate: () => Promise<void> = () => tileGate(atl)): Promise<GpuColumns & { done: () => void }> {
  const dev = atl.device;
  const bt = spread ? traceOf(atl, x0, y0) : undefined;
  const tileBufs: GPUBuffer[] = [];
  const pb = dev.createBuffer({ label: 'atlas col params', size: PARAM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const g = dev.createBuffer({ label: 'atlas colG', size: (w + 2) * (h + 2) * COLG_BYTES, usage: GPUBufferUsage.STORAGE });
  const o = dev.createBuffer({ label: 'atlas colOut', size: w * h * COL_WORDS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const runs = dev.createBuffer({ label: 'atlas colRuns', size: w * h * MR * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const inst = dev.createBuffer({ label: 'atlas forms', size: MAX_INST * INST_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const instN = dev.createBuffer({ label: 'atlas forms n', size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  atl.writeParams({ x0, y0, w, h }, pb);
  // the giants reaching into it go first (the lattice forms are counted on from them)
  const gi = giantsFor(atl, x0, y0, w, h);
  if (gi.count) {
    dev.queue.writeBuffer(inst, 0, gi.data);
    dev.queue.writeBuffer(instN, 0, new Uint32Array([gi.count]));
  }
  const enc = dev.createCommandEncoder({ label: 'atlas columns' });
  // (round 80: the passes' GPU time in the game's profiler, when the level lends it — the streaming's cost)
  const ts = (name: string) => ({ timestampWrites: atl.profiler?.timestamps(name) });
  let cp = enc.beginComputePass(ts('atlas-colHeight'));
  cp.setPipeline(atl.colH.pipeline);
  cp.setBindGroup(0, makeBindGroup(dev, 'colH', atl.colH.layout, { 0: pb, 20: atl.region, 21: atl.dist, 22: atl.regs, 23: atl.pat, 25: atl.riverBuf, 26: atl.coarse.cells, 30: g }));
  cp.dispatchWorkgroups(Math.ceil((w + 2) / 8), Math.ceil((h + 2) / 8));
  cp.end();
  // the lattice forms around the batch (every lattice: the finest's cells cover the most)
  cp = enc.beginComputePass(ts('atlas-formSeed'));
  cp.setPipeline(atl.formSeed.pipeline);
  cp.setBindGroup(0, makeBindGroup(dev, 'formSeed', atl.formSeed.layout, { 0: pb, 20: atl.region, 21: atl.dist, 22: atl.regs, 23: atl.pat, 25: atl.riverBuf, 26: atl.coarse.cells, 32: inst, 33: instN }));
  const cells = (n: number) => Math.ceil((n + 2 * FORM_MARGIN) / FINEST) + 3;
  cp.dispatchWorkgroups(Math.ceil(cells(w + 1) / 8), Math.ceil(cells(h * ROW_H) / 8), 7);
  cp.end();
  // the columns: at once, or (streaming: `spread`) a TILE² tile a frame — the march is the batch's cost
  // (~13 ms of a desktop's GPU a 64² region: a phone's frame several times over)
  let fin = enc;
  const tiles: [number, number][] = [];
  // (round 108: a batch a little over whole tiles — a render-only tile's, its border round it — in as many turns as
  // the whole tiles would take, each a little bigger, not a row of slivers more)
  const T = spread ? paceTile(Math.max(w, h), TILE) : Math.max(w, h);
  for (let ty = 0; ty < h; ty += T) for (let tx = 0; tx < w; tx += T) tiles.push([tx, ty]);
  try {
    for (let k = 0; k < tiles.length; k++) {
      let tpb = pb;
      if (spread) {
        dev.queue.submit([fin.finish()]);
        await gate();
        if (bt) bt.tiles.push(performance.now());
        fin = dev.createCommandEncoder({ label: 'atlas columns tile' });
        tpb = dev.createBuffer({ label: 'atlas col params tile', size: PARAM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        atl.writeParams({ x0, y0, w, h, tile: tiles[k] }, tpb);
        tileBufs.push(tpb);
      }
      const tw = Math.min(T, w - tiles[k][0]);
      const th = Math.min(T, h - tiles[k][1]);
      cp = fin.beginComputePass(ts('atlas-colFinish'));
      cp.setPipeline(atl.colF.pipeline);
      cp.setBindGroup(0, makeBindGroup(dev, 'colF', atl.colF.layout, { 0: tpb, 22: atl.regs, 23: atl.pat, 30: g, 31: o, 32: inst, 33: instN, 34: runs }));
      cp.dispatchWorkgroups(Math.ceil(tw / 8), Math.ceil(th / 8));
      cp.end();
    }
    dev.queue.submit([fin.finish()]);
  } catch (e) {
    for (const b of [g, o, runs, inst, instN, pb, ...tileBufs]) b.destroy();
    throw e;
  }
  // (what reads them is submitted after: destroyed buffers stay alive for work already submitted)
  const done = () => {
    for (const b of [g, o, runs, inst, instN, pb, ...tileBufs]) b.destroy();
  };
  return { w, h, o, runs, instN, mr: MR, done };
}

/** the giants reaching into a batch of world cells, as forms.wgsl Insts in the batch's frame */
export function giantsFor(atl: Atlas, x0: number, y0: number, w: number, h: number): { data: ArrayBuffer; count: number } {
  const rowH = Math.sqrt(3) / 2;
  const cx = x0 + w / 2;
  const cy = (y0 + h / 2) * rowH;
  const hw = w / 2 + 2;
  const hh = (h / 2) * rowH + 2;
  const G = atl.giants;
  const recs: number[] = [];
  for (let k = 0; k < G.length; k += GIANT_FLOATS) {
    // (the copy of it round the torus nearest the batch)
    const gx = G[k] + Math.round((cx - G[k]) / atl.worldW) * atl.worldW;
    const gy = G[k + 1] + Math.round((cy - G[k + 1]) / atl.worldH) * atl.worldH;
    const H = G[k + 3];
    const r = G[k + 4];
    const lx = G[k + 5] * H;
    const ly = G[k + 6] * H;
    // its box: from its foot to its point, the polygon's corners round both
    const R = r * 1.16 + 2;
    const bx0 = Math.min(gx, gx + lx) - R;
    const bx1 = Math.max(gx, gx + lx) + R;
    const by0 = Math.min(gy, gy + ly) - R;
    const by1 = Math.max(gy, gy + ly) + R;
    if (bx1 < cx - hw || bx0 > cx + hw || by1 < cy - hh || by0 > cy + hh) continue;
    recs.push(k / GIANT_FLOATS, gx, gy, Math.max(R + Math.hypot(lx, ly), 1));
  }
  const data = new ArrayBuffer(Math.max(recs.length / 4, 1) * INST_BYTES);
  const f = new Float32Array(data);
  const u = new Uint32Array(data);
  for (let i = 0; i < recs.length / 4; i++) {
    const k = recs[i * 4] * GIANT_FLOATS;
    const o = i * 16;
    f[o] = recs[i * 4 + 1];
    f[o + 1] = recs[i * 4 + 2];
    f[o + 2] = G[k + 2];
    f[o + 3] = G[k + 3];
    f[o + 4] = G[k + 4];
    f[o + 5] = 0;
    f[o + 6] = G[k + 5];
    f[o + 7] = G[k + 6];
    u[o + 8] = 1; // FORM_SPIRE
    u[o + 9] = MAT_QUARTZ | (8 << 16) | (6 << 24); // a hexagonal prism to its point (PROF_PRISM)
    f[o + 10] = -1;
    f[o + 11] = 0;
    f[o + 12] = G[k + 7];
    f[o + 13] = recs[i * 4 + 3];
    f[o + 14] = G[k + 2] + G[k + 3];
    f[o + 15] = 0;
  }
  return { data, count: recs.length / 4 };
}

/** Atlas.changes (the class keeps the method, documented there) */
export async function changes(atl: Atlas, snap: unknown, x0: number, y0: number, w: number, h: number): Promise<((x: number, y: number) => LandChange) | null> {
  const was = snap as CoarseSnap;
  const now = await atl.coarse.snapshot(x0, y0, w, h);
  let any = false;
  for (let i = 0; i < now.cells.length; i++)
    if (Math.abs(now.cells[i] - was.cells[i]) > 1e-4) {
      any = true;
      break;
    }
  if (!any) return null;
  const rowH = Math.sqrt(3) / 2;
  return (x, y) => {
    const px = x + 0.5 + 0.5 * (((y % 2) + 2) % 2);
    const py = (y + 0.5) * rowH;
    const a = atl.coarse.sample(now, px, py);
    const b = atl.coarse.sample(was, px, py);
    return { dr: a.dr - b.dr, cap: a.cap, dl: a.loose - b.loose, lmat: a.lmat, dw: a.water - b.water };
  };
}
