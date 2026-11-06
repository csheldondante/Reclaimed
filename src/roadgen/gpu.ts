// The road generator on the GPU (round 128p, DA-A13 step 0; shaders/roadgen.wgsl, the rules roadgen.ts's and the
// rounds cpu.ts's). A run: the inputs uploaded once (the ground and wet per field node, the constraints, their points
// as fixed major roads), then two submits (the majors' rounds; the minors' rounds, the base lattice's claims and
// offsets), then one async readback of what the CPU's plan needs: the roads, the claims and the offsets (AGENT_RULES 1b:
// gpu/transfers.ts). An edit: the constraints added, the field made again in its rectangle, the lines through it dead,
// the grids rebuilt from the living, the rounds run again from the dead lines' seeds and the new constraints', the
// lattice again, the same readback. Nothing waits on the GPU in a frame.
import roadgenWgsl from '../shaders/roadgen.wgsl?raw';
import { makeBindGroup, makeCompute, type BindSpec, type ComputeKernel } from '../gpu/pipeline';
import { DEGENERATE, latticeSize, maxRounds, maxSteps, ROAD_GRADE, spacing, type Polyline, type Road, type RoadGenInput, type V2 } from './roadgen';
import { everyAlong, resample } from './cpu';

/** the base lattice's cell (m: DECISIONS round 128p, ways claim whole 4 m cells) and how far a vertex may move (of a cell) */
export const LATTICE_CELL = 4;
export const MAX_OFFSET = 0.45;

const DEAD = 256;
const FIXED = 512;

export interface RoadGenResult {
  roads: Road[];
  /** per base-lattice cell (latN × latN): 0 open, 1 a major road's, 2 a minor road's, 3 off the town, 4 water */
  claims: Uint32Array;
  /** per lattice vertex ((latN + 1)², x y): its offset (m) */
  offsets: Float32Array;
  latN: number;
  /** the GPU's time for the run (submit to done, ms) and to the CPU's hands (with the readback) */
  gpuMs: number;
  totalMs: number;
  /** the readback's bytes */
  bytes: number;
  /** (RoadGenGpu.timed) each phase's ms */
  phases: Record<string, number>;
}

type K =
  | 'rgField'
  | 'rgTrace'
  | 'rgCommit'
  | 'rgSeedLinesA'
  | 'rgSeedLinesB'
  | 'rgSeedListA'
  | 'rgSeedListB'
  | 'rgSeedOnlineA'
  | 'rgSeedOnlineB'
  | 'rgCompact'
  | 'rgBegin'
  | 'rgNextRound'
  | 'rgKill'
  | 'rgClearHeads'
  | 'rgClearRound'
  | 'rgInsert'
  | 'rgClaim'
  | 'rgOffsets'
  | 'rgColumns';

const U = 'uniform' as const;
const RW = 'rw' as const;
const RD = 'read' as const;
/** each kernel's bindings (explicit layouts; ≤ 8 storage buffers a kernel) */
const SPECS: Record<K, BindSpec> = {
  rgField: { 20: U, 21: RW, 22: RD },
  rgTrace: { 20: U, 21: RW, 23: RW, 24: RW, 25: RW, 26: RW, 27: RW, 28: RW, 35: RW },
  rgCommit: { 20: U, 23: RW, 25: RW, 26: RW, 27: RW, 28: RW, 29: RW, 34: RW, 35: RW },
  rgSeedLinesA: { 20: U, 23: RW, 26: RW, 27: RW, 28: RW, 29: RW, 30: RW, 35: RW },
  rgSeedLinesB: { 20: U, 23: RW, 26: RW, 27: RW, 28: RW, 29: RW, 30: RW, 35: RW },
  rgSeedListA: { 20: U, 23: RW, 26: RW, 27: RW, 28: RW, 30: RW, 31: RD, 35: RW },
  rgSeedListB: { 20: U, 23: RW, 26: RW, 27: RW, 28: RW, 30: RW, 31: RD, 35: RW },
  rgSeedOnlineA: { 20: U, 23: RW, 26: RW, 27: RW, 28: RW, 29: RW, 30: RW, 35: RW },
  rgSeedOnlineB: { 20: U, 23: RW, 26: RW, 27: RW, 28: RW, 29: RW, 30: RW, 35: RW },
  rgCompact: { 20: U, 23: RW, 24: RW, 30: RW, 34: RW },
  rgBegin: { 23: RW, 34: RW },
  rgNextRound: { 23: RW },
  rgKill: { 20: U, 23: RW, 26: RW, 29: RW },
  rgClearHeads: { 20: U, 28: RW },
  rgClearRound: { 20: U, 35: RW },
  rgInsert: { 20: U, 23: RW, 26: RW, 27: RW, 28: RW, 29: RW },
  rgClaim: { 20: U, 21: RW, 26: RW, 27: RW, 28: RW, 29: RW, 32: RW },
  rgOffsets: { 20: U, 26: RW, 27: RW, 28: RW, 29: RW, 32: RW, 33: RW },
  rgColumns: { 20: U, 32: RW, 33: RW, 36: RW },
};

/** the State's bytes (roadgen.wgsl): rect (4 f32), family, round, seedCount, ptsEnd, linesEnd, roundLine0, roundPt0, err, listN, 3 pad */
const ST_BYTES = 64;
const ST_FAMILY = 16;
const ST_PTS_END = 28;
const ST_LISTN = 48;

export class RoadGenGpu {
  private k = {} as Record<K, ComputeKernel>;
  private bg = {} as Record<K, GPUBindGroup>;
  private bufs: GPUBuffer[] = [];
  private P: GPUBuffer;
  private field: GPUBuffer;
  private cons: GPUBuffer;
  private st: GPUBuffer;
  private seeds: GPUBuffer;
  private scratch: GPUBuffer;
  private points: GPUBuffer;
  private pinfo: GPUBuffer;
  private heads: GPUBuffer;
  private lines: GPUBuffer;
  private sb: GPUBuffer;
  private list: GPUBuffer;
  private claims: GPUBuffer;
  private offsets: GPUBuffer;
  private ind: GPUBuffer;
  private rheads: GPUBuffer;
  private colCell: GPUBuffer;
  /** the box the columns are of (rgColumns): the domain's columns and rows */
  private boxW: number;
  private boxH: number;
  readonly latN: number;
  readonly caps: { seeds: number; pts: number; lines: number; segs: number; list: number; scratchBytes: number };
  private nx: number;
  private ny: number;
  private gridCells: number;
  private sbCells: number;
  /** the roads as the CPU has them (the last readback): an edit's seeds come from them */
  private last: Road[] = [];
  private nSegs = 0;
  private ptsEnd = 0;
  private linesEnd = 0;

  constructor(
    private device: GPUDevice,
    readonly inp: RoadGenInput,
    /** what an edit may add: constraint segments in all */
    segCap = 1024,
  ) {
    const p = inp.params;
    const d = device;
    const { nx, ny } = latticeSize(p);
    this.nx = nx;
    this.ny = ny;
    // (the separation grids: half a spacing square, so a 3 x 3 look holds any point within half a spacing)
    const gw = (f: number) => Math.ceil(p.W / (spacing(p, f) / 2)) + 1;
    const gh = (f: number) => Math.ceil(p.H / (spacing(p, f) / 2)) + 1;
    const sbw = (f: number) => Math.ceil(p.W / (spacing(p, f) / 2)) + 1;
    const sbh = (f: number) => Math.ceil(p.H / (spacing(p, f) / 2)) + 1;
    this.gridCells = gw(0) * gh(0) + gw(1) * gh(1);
    this.sbCells = Math.max(sbw(0) * sbh(0), sbw(1) * sbh(1));
    const N = maxSteps(p);
    // (the bounds, from geometry: a seed a bucket; a family's lines keep half its spacing apart, so their length is at
    // most the area over that, twice over for an edit's dead lines; a line is at least a spacing long)
    const area = p.W * p.H;
    const conPts = inp.constraints.reduce((s, c) => s + resample(c, p.step).length, 0);
    const pts = 2 * Math.ceil((area / (p.major / 2) + area / (p.minor / 2)) / p.step) + 4 * conPts + 4096;
    const lines = Math.ceil(pts / Math.round(p.minor / p.step)) + inp.constraints.length + 64;
    this.caps = { seeds: this.sbCells, pts, lines, segs: segCap, list: this.sbCells * 4, scratchBytes: this.sbCells * (2 * N + 2) * 8 };
    this.latN = 2 * Math.ceil(p.radius / LATTICE_CELL) + 2;
    const L1 = this.latN + 1;
    const buf = (label: string, size: number, usage = 0) => {
      const b = d.createBuffer({ label: `roadgen ${label}`, size: Math.max(16, Math.ceil(size / 16) * 16), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | usage });
      this.bufs.push(b);
      return b;
    };
    this.P = d.createBuffer({ label: 'roadgen params', size: 40 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bufs.push(this.P);
    this.field = buf('field', nx * ny * 16);
    this.cons = buf('constraints', segCap * 32);
    this.st = buf('state', ST_BYTES);
    this.seeds = buf('seeds', this.caps.seeds * 8);
    this.scratch = buf('scratch', this.caps.scratchBytes);
    this.points = buf('points', pts * 8);
    this.pinfo = buf('pinfo', pts * 16);
    this.heads = buf('heads', this.gridCells * 4);
    this.lines = buf('lines', lines * 32);
    this.sb = buf('seed buckets', this.sbCells * 12);
    this.list = buf('seed list', this.caps.list * 8);
    this.claims = buf('claims', this.latN * this.latN * 4);
    this.offsets = buf('offsets', L1 * L1 * 8);
    this.ind = buf('indirect', 4 * 16, GPUBufferUsage.INDIRECT);
    this.rheads = buf('round heads', this.gridCells * 4);
    this.boxW = Math.round(p.W) + 1;
    this.boxH = Math.round(p.H / 0.8660254) + 1;
    this.colCell = buf('column cells', this.boxW * this.boxH * 4);
    d.queue.writeBuffer(this.sb, 0, new Uint32Array(this.sbCells * 3).fill(0xffffffff));
    const f = new Float32Array(40);
    const u = new Uint32Array(f.buffer);
    f.set([p.W, p.H, p.S, p.step, p.centre[0], p.centre[1], p.radius, p.theta, p.sigmaR, p.sigmaC, p.major, p.minor, LATTICE_CELL, ROAD_GRADE, DEGENERATE, MAX_OFFSET]);
    u.set([nx, ny, N, this.caps.seeds, pts, lines, 0, this.latN, gw(0), gh(0), gw(1), gh(1), sbw(0), sbh(0), sbw(1), sbh(1), 0, 0, nx - 1, ny - 1], 16);
    f[36] = p.jitter;
    u[37] = p.seed >>> 0;
    u[38] = this.boxW;
    u[39] = this.boxH;
    this.params = f;
    const res: Record<number, GPUBuffer> = {
      20: this.P,
      21: this.field,
      22: this.cons,
      23: this.st,
      24: this.seeds,
      25: this.scratch,
      26: this.points,
      27: this.pinfo,
      28: this.heads,
      29: this.lines,
      30: this.sb,
      31: this.list,
      32: this.claims,
      33: this.offsets,
      34: this.ind,
      35: this.rheads,
      36: this.colCell,
    };
    for (const name of Object.keys(SPECS) as K[]) {
      this.k[name] = makeCompute(d, `roadgen ${name}`, [roadgenWgsl], SPECS[name], name);
      this.bg[name] = makeBindGroup(d, `roadgen ${name}`, this.k[name].layout, Object.fromEntries(Object.keys(SPECS[name]).map((b) => [b, res[Number(b)]])));
    }
  }

  private params: Float32Array;

  /** the params with the field's rectangle and the segments' count */
  private writeParams(rect: [number, number, number, number]): void {
    const u = new Uint32Array(this.params.buffer);
    u[22] = this.nSegs;
    u.set(rect, 32);
    this.device.queue.writeBuffer(this.P, 0, this.params);
  }

  /** constraints' segments appended (two vec4 each: a b, its polyline) */
  private addSegments(add: Polyline[], firstPoly: number): void {
    const out: number[] = [];
    add.forEach((c, i) => {
      for (let k = 1; k < c.length; k++) out.push(c[k - 1][0], c[k - 1][1], c[k][0], c[k][1], firstPoly + i, 0, 0, 0);
    });
    const n = out.length / 8;
    if (this.nSegs + n > this.caps.segs) throw new Error(`roadgen: ${this.nSegs + n} constraint segments, room for ${this.caps.segs}`);
    if (n) this.device.queue.writeBuffer(this.cons, this.nSegs * 32, new Float32Array(out));
    this.nSegs += n;
  }

  /** constraints as fixed major roads: their points and lines appended */
  private addFixed(add: Polyline[]): Road[] {
    const p = this.inp.params;
    const made: Road[] = [];
    for (const c of add) {
      const pts = resample(c, p.step);
      if (this.ptsEnd + pts.length > this.caps.pts || this.linesEnd + 1 > this.caps.lines) throw new Error('roadgen: no room for a constraint');
      const P = new Float32Array(pts.length * 2);
      const I = new Int32Array(pts.length * 4);
      pts.forEach((q, k) => {
        P.set(q, k * 2);
        I.set([this.linesEnd, -1, -1, k], k * 4);
      });
      this.device.queue.writeBuffer(this.points, this.ptsEnd * 8, P);
      this.device.queue.writeBuffer(this.pinfo, this.ptsEnd * 16, I);
      const L = new Uint32Array(8);
      const Lf = new Float32Array(L.buffer);
      L.set([this.ptsEnd, pts.length, 0 | FIXED, 0]);
      Lf[4] = pts[0][0];
      Lf[5] = pts[0][1];
      this.device.queue.writeBuffer(this.lines, this.linesEnd * 32, L);
      this.ptsEnd += pts.length;
      this.linesEnd += 1;
      made.push({ family: 0, pts, steep: [], seed: pts[0], fixed: true });
    }
    return made;
  }

  private writeState(o: { rect?: [number, number, number, number]; family?: number; listN?: number; reset?: boolean }): void {
    const q = this.device.queue;
    if (o.reset) {
      const s = new Uint32Array(ST_BYTES / 4);
      new Float32Array(s.buffer).set([-1e9, -1e9, 1e9, 1e9]);
      s.set([0, 0, 0, this.ptsEnd, this.linesEnd, 0, 0, 0, 0], 4);
      q.writeBuffer(this.st, 0, s);
    }
    if (o.rect) q.writeBuffer(this.st, 0, new Float32Array(o.rect));
    if (o.family !== undefined) q.writeBuffer(this.st, ST_FAMILY, new Uint32Array([o.family]));
    if (o.listN !== undefined) q.writeBuffer(this.st, ST_LISTN, new Uint32Array([o.listN]));
  }

  private writeList(list: V2[]): void {
    if (list.length > this.caps.list) throw new Error(`roadgen: ${list.length} listed seeds, room for ${this.caps.list}`);
    if (list.length) this.device.queue.writeBuffer(this.list, 0, new Float32Array(list.flat()));
  }

  private pass(enc: GPUCommandEncoder, enc2: (cp: GPUComputePassEncoder | null, run: (k: K, n: number | [number, number] | { ind: number }) => void) => void): void {
    const dispatch = (cp: GPUComputePassEncoder, k: K, n: number | [number, number] | { ind: number }) => {
      cp.setPipeline(this.k[k].pipeline);
      cp.setBindGroup(0, this.bg[k]);
      if (typeof n === 'number') cp.dispatchWorkgroups(n);
      else if (Array.isArray(n)) cp.dispatchWorkgroups(n[0], n[1]);
      else cp.dispatchWorkgroupsIndirect(this.ind, n.ind * 16);
    };
    if (!this.kernelMs) {
      const cp = enc.beginComputePass({ label: 'roadgen' });
      enc2(cp, (k, n) => dispatch(cp, k, n));
      cp.end();
      return;
    }
    // (profiling: a pass a dispatch, its start and end stamped)
    const names: K[] = [];
    const qs = this.device.createQuerySet({ type: 'timestamp', count: 4096 });
    enc2(null, (k, n) => {
      const i = names.push(k) - 1;
      if (2 * i + 1 >= 4096) throw new Error('roadgen profile: more than 2048 dispatches in an encoder');
      const cp = enc.beginComputePass({ label: `roadgen ${k}`, timestampWrites: { querySet: qs, beginningOfPassWriteIndex: 2 * i, endOfPassWriteIndex: 2 * i + 1 } });
      dispatch(cp, k, n);
      cp.end();
    });
    const bytes = names.length * 16;
    const res = this.device.createBuffer({ size: Math.max(16, bytes), usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    const rd = this.device.createBuffer({ size: Math.max(16, bytes), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    if (names.length) {
      enc.resolveQuerySet(qs, 0, names.length * 2, res, 0);
      enc.copyBufferToBuffer(res, 0, rd, 0, bytes);
    }
    this.kernelReads.push(
      (async () => {
        await this.device.queue.onSubmittedWorkDone();
        await rd.mapAsync(GPUMapMode.READ);
        const t = new BigUint64Array(rd.getMappedRange().slice(0));
        rd.unmap();
        names.forEach((k, i) => (this.kernelMs![k] = (this.kernelMs![k] ?? 0) + Number(t[2 * i + 1] - t[2 * i]) / 1e6));
        (rd.destroy(), res.destroy(), qs.destroy());
      })(),
    );
  }

  /** (profiling, when the device stamps time: set to {}) each kernel's total GPU ms over the runs since */
  kernelMs: Partial<Record<K, number>> | null = null;
  private kernelReads: Promise<void>[] = [];
  /** the kernels' times read (profiling) */
  async kernelTimes(): Promise<Partial<Record<K, number>>> {
    await Promise.all(this.kernelReads.splice(0));
    return Object.fromEntries(Object.entries(this.kernelMs ?? {}).map(([k, v]) => [k, +v!.toFixed(2)]));
  }

  /** (`timed`) each phase waited on and timed (ms): a profile, not the game's way — it costs the overlap */
  timed = false;
  private phases: Record<string, number> = {};
  private mark0 = 0;
  private async mark(name: string): Promise<void> {
    if (!this.timed) return;
    await this.device.queue.onSubmittedWorkDone();
    const now = performance.now();
    this.phases[name] = +(now - this.mark0).toFixed(2);
    this.mark0 = now;
  }

  private submit(label: string, body: (run: (k: K, n: number | [number, number] | { ind: number }) => void) => void): void {
    const enc = this.device.createCommandEncoder({ label });
    this.pass(enc, (_, run) => body(run));
    this.device.queue.submit([enc.finish()]);
  }

  /** a family's rounds (after its first seeds are in the buckets: compact makes them the first round's) */
  private rounds(run: (k: K, n: number | [number, number] | { ind: number }) => void, f: number): void {
    run('rgCompact', 1);
    for (let r = 0; r < maxRounds(this.inp.params, f); r++) {
      run('rgTrace', { ind: 0 });
      run('rgClearRound', Math.ceil(this.gridCells / 64));
      run('rgCommit', 1);
      run('rgSeedLinesA', { ind: 1 });
      run('rgSeedLinesB', { ind: 1 });
      run('rgCompact', 1);
      run('rgNextRound', 1);
    }
  }

  private lattice(run: (k: K, n: number | [number, number] | { ind: number }) => void): void {
    const g = Math.ceil(this.latN / 8);
    run('rgClaim', [g, g]);
    const g1 = Math.ceil((this.latN + 1) / 8);
    run('rgOffsets', [g1, g1]);
    run('rgColumns', [Math.ceil(this.boxW / 8), Math.ceil(this.boxH / 8)]);
  }

  /** the whole town */
  async run(): Promise<RoadGenResult> {
    const t0 = performance.now();
    const p = this.inp.params;
    const q = this.device.queue;
    // (a run starts afresh: the constraints, points and lines from nothing)
    this.nSegs = 0;
    this.ptsEnd = 0;
    this.linesEnd = 0;
    // the inputs: ground and wet per node
    const F = new Float32Array(this.nx * this.ny * 4);
    for (let i = 0; i < this.nx * this.ny; i++) ((F[i * 4 + 2] = this.inp.wet[i] ? 1 : 0), (F[i * 4 + 3] = this.inp.ground[i]));
    q.writeBuffer(this.field, 0, F);
    this.addSegments(this.inp.constraints, 0);
    this.addFixed(this.inp.constraints);
    const list: V2[] = [[p.centre[0], p.centre[1]]];
    for (const c of this.inp.constraints) list.push(...everyAlong(resample(c, p.step), Math.round(p.major / p.step)).map((e) => e.at));
    this.writeList(list);
    this.writeParams([0, 0, this.nx - 1, this.ny - 1]);
    this.writeState({ reset: true, family: 0, listN: list.length });
    const fieldG: [number, number] = [Math.ceil(this.nx / 8), Math.ceil(this.ny / 8)];
    this.phases = {};
    this.mark0 = t0;
    this.submit('roadgen field', (run) => {
      run('rgField', fieldG);
      run('rgClearHeads', Math.ceil(this.gridCells / 64));
      run('rgInsert', Math.ceil(this.caps.pts / 64));
    });
    await this.mark('field');
    this.submit('roadgen majors', (run) => {
      run('rgBegin', 1);
      run('rgSeedListA', Math.ceil(list.length / 64));
      run('rgSeedListB', Math.ceil(list.length / 64));
      this.rounds(run, 0);
    });
    await this.mark('majors');
    this.writeState({ family: 1, listN: 0 });
    return this.minorsAndRead(t0, (run) => {
      run('rgBegin', 1);
      run('rgSeedOnlineA', { ind: 2 });
      run('rgSeedOnlineB', { ind: 2 });
    });
  }

  /**
   * An edit: `add` drawn roads (constraints, fixed major roads), `rect` [x0, y0, x1, y1] the area it changes (the
   * constraints' reach): the field made again there, the lines through it traced again. After a run's readback.
   */
  async edit(add: Polyline[], rect: [number, number, number, number]): Promise<RoadGenResult> {
    const t0 = performance.now();
    const p = this.inp.params;
    this.inp.constraints.push(...add);
    this.addSegments(add, this.inp.constraints.length - add.length);
    const inRect = (q: V2) => q[0] >= rect[0] && q[0] <= rect[2] && q[1] >= rect[1] && q[1] <= rect[3];
    // (the same rule rgKill applies on the GPU: the CPU has the roads from the last readback, so it knows the seeds)
    const dropped = this.last.filter((r) => !r.fixed && r.pts.some(inRect));
    this.addFixed(add);
    const list: V2[] = [];
    for (const c of add) list.push(...everyAlong(resample(c, p.step), Math.round(p.major / p.step)).map((e) => e.at));
    list.push(...dropped.filter((r) => r.family === 0).map((r) => r.seed));
    const minors = dropped.filter((r) => r.family === 1).map((r) => r.seed);
    const nx0 = Math.max(0, Math.floor(rect[0] / p.S));
    const ny0 = Math.max(0, Math.floor(rect[1] / p.S));
    const nx1 = Math.min(this.nx - 1, Math.ceil(rect[2] / p.S));
    const ny1 = Math.min(this.ny - 1, Math.ceil(rect[3] / p.S));
    this.writeParams([nx0, ny0, nx1, ny1]);
    this.writeList(list);
    this.writeState({ reset: true, rect, family: 0, listN: list.length });
    this.phases = {};
    this.mark0 = t0;
    this.submit('roadgen edit field', (run) => {
      run('rgField', [Math.ceil((nx1 - nx0 + 1) / 8), Math.ceil((ny1 - ny0 + 1) / 8)]);
      run('rgKill', Math.ceil(this.caps.lines / 64));
      run('rgClearHeads', Math.ceil(this.gridCells / 64));
      run('rgInsert', Math.ceil(this.caps.pts / 64));
    });
    await this.mark('field');
    this.submit('roadgen edit majors', (run) => {
      run('rgBegin', 1);
      run('rgSeedListA', Math.max(1, Math.ceil(list.length / 64)));
      run('rgSeedListB', Math.max(1, Math.ceil(list.length / 64)));
      this.rounds(run, 0);
    });
    await this.mark('majors');
    this.writeList(minors);
    this.writeState({ family: 1, listN: minors.length });
    return this.minorsAndRead(t0, (run) => {
      run('rgBegin', 1);
      run('rgSeedListA', Math.max(1, Math.ceil(minors.length / 64)));
      run('rgSeedListB', Math.max(1, Math.ceil(minors.length / 64)));
      run('rgSeedOnlineA', { ind: 2 });
      run('rgSeedOnlineB', { ind: 2 });
    });
  }

  private async minorsAndRead(t0: number, first: (run: (k: K, n: number | [number, number] | { ind: number }) => void) => void): Promise<RoadGenResult> {
    const d = this.device;
    this.submit('roadgen minors', (run) => {
      first(run);
      this.rounds(run, 1);
    });
    await this.mark('minors');
    const enc = d.createCommandEncoder({ label: 'roadgen lattice' });
    this.pass(enc, (_, run) => this.lattice(run));
    // the readback: the state, the lines and points (to their caps: the counts are in the state), the lattice
    const L1 = this.latN + 1;
    const parts: [GPUBuffer, number][] = [
      [this.st, ST_BYTES],
      [this.lines, this.caps.lines * 32],
      [this.points, this.caps.pts * 8],
      [this.claims, this.latN * this.latN * 4],
      [this.offsets, L1 * L1 * 8],
    ];
    const total = parts.reduce((s, [, n]) => s + n, 0);
    const rd = d.createBuffer({ label: 'roadgen readback', size: total, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    let o = 0;
    for (const [b, n] of parts) (enc.copyBufferToBuffer(b, 0, rd, o, n), (o += n));
    d.queue.submit([enc.finish()]);
    await d.queue.onSubmittedWorkDone();
    await this.mark('lattice');
    const gpuMs = performance.now() - t0;
    await rd.mapAsync(GPUMapMode.READ);
    const bytes = rd.getMappedRange().slice(0);
    rd.unmap();
    rd.destroy();
    const st = new Uint32Array(bytes, 0, ST_BYTES / 4);
    const err = st[11];
    if (err) throw new Error(`roadgen: the GPU ran out of room (${err === 1 ? 'points or lines' : 'seeds'}) — a bound in RoadGenGpu's caps is wrong`);
    this.ptsEnd = st[ST_PTS_END / 4];
    this.linesEnd = st[8];
    let off = ST_BYTES;
    const lines = new Uint32Array(bytes, off, this.caps.lines * 8);
    const linesF = new Float32Array(bytes, off, this.caps.lines * 8);
    off += this.caps.lines * 32;
    const pts = new Float32Array(bytes, off, this.caps.pts * 2);
    off += this.caps.pts * 8;
    const claims = new Uint32Array(bytes.slice(off, off + this.latN * this.latN * 4));
    off += this.latN * this.latN * 4;
    const offsets = new Float32Array(bytes.slice(off, off + L1 * L1 * 8));
    const roads: Road[] = [];
    for (let l = 0; l < this.linesEnd; l++) {
      const [start, count, flags] = [lines[l * 8], lines[l * 8 + 1], lines[l * 8 + 2]];
      if (flags & DEAD) continue;
      const ps: V2[] = [];
      for (let k = 0; k < count; k++) ps.push([pts[(start + k) * 2], pts[(start + k) * 2 + 1]]);
      roads.push({ family: (flags & 255) as 0 | 1, pts: ps, steep: [], seed: [linesF[l * 8 + 4], linesF[l * 8 + 5]], fixed: (flags & FIXED) !== 0 });
    }
    this.last = roads;
    return { roads, claims, offsets, latN: this.latN, gpuMs, totalMs: performance.now() - t0, bytes: total, phases: { ...this.phases } };
  }

  /** (the tests') every box column's lattice cell, as the GPU found it (j × latN + i; -1 none) */
  async columnCells(read: (b: GPUBuffer, n: number) => Promise<ArrayBuffer>): Promise<Int32Array> {
    return new Int32Array(await read(this.colCell, this.boxW * this.boxH * 4));
  }

  destroy(): void {
    for (const b of this.bufs) b.destroy();
  }
}
