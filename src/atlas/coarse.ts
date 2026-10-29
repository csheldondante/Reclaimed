// The coarse world (round 71, coarse.wgsl): the whole torus at cn × cn cells,
// what has changed from the atlas — so the world changes at its own scale
// while only the window around the camera is simulated finely: a meteor's
// crater many chunks across, an eruption burying a country's forests in ash,
// lava running for kilometres and setting. The fine columns are made from the
// atlas and this (compose.wgsl coarseAt); a region frozen before an event gets
// what changed while it was away when it comes back (`snapshot` / `changes`);
// an event inside the window is also made in the fine columns (`onEvent`,
// with `eventAt`: the same shapes the GPU makes, cell by cell).

import { makeBindGroup, makeComputeAsync, makeModule, type ComputeKernel } from '../gpu/pipeline';
import coarseW from './coarse.wgsl?raw';

/** floats a cell (coarse.wgsl CCell) */
const CELL_FLOATS = 8;
const UNI_BYTES = 208;
const MAX_VENTS = 8;
export const EV = { meteor: 1, ash: 2, cone: 3, strike: 4 } as const;

/**
 * (round 112, the user: "I want to know what an atlas sized strike looks like") How deep an atlas strike of radius R
 * digs: the great meteor's 0.18 R up to its 240, then as R^0.45 (a big crater is shallow for its width — a flat floor,
 * a central peak), so a thousand-cell strike is 81 deep, not 180 (the world's floor is z 1: BACKLOG MF7).
 */
export function strikeDepth(R: number): number {
  return R <= 240 ? R * 0.18 : 43.2 * (R / 240) ** 0.45;
}

export interface CoarseEvent {
  kind: number;
  x: number;
  y: number;
  /** size (world units) and how much (cells of rock, of ash) */
  r: number;
  a: number;
  wind?: [number, number];
}

/** what has changed at a point (coarse.wgsl Co) */
export interface CoarseAt {
  dr: number;
  loose: number;
  water: number;
  lava: number;
  lmat: number;
  cap: number;
}

/** the cells round a region as they were: to tell what changed since */
export interface CoarseSnap {
  i0: number;
  j0: number;
  ni: number;
  nj: number;
  cells: Float32Array;
}

export class Coarse {
  readonly cells: GPUBuffer;
  private next: GPUBuffer;
  private base: GPUBuffer;
  private fW: GPUBuffer;
  private fL: GPUBuffer;
  private fT: GPUBuffer;
  private uni: GPUBuffer;
  private kFlux?: ComputeKernel;
  private kDepth?: ComputeKernel;
  private kEvent?: ComputeKernel;
  private gFlux?: GPUBindGroup;
  private gDepth?: GPUBindGroup;
  private gEvent?: GPUBindGroup;
  readonly vents: { x: number; y: number; rate: number; r: number; steps: number }[] = [];
  /** rain and evaporation a step (cells of water), and how hard running water wears the ground (0: not at all) */
  rain = 0;
  evap = 0.00002;
  erode = 0;
  steps = 0;
  /** an event was made (the level makes it in the fine window too) */
  readonly onEvent: ((e: CoarseEvent) => void)[] = [];

  constructor(
    private device: GPUDevice,
    readonly cn: number,
    readonly worldW: number,
    readonly worldH: number,
  ) {
    if (cn & (cn - 1)) throw new Error('the coarse grid must be a power of two');
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const N = cn * cn;
    const mk = (label: string, bytes: number) => device.createBuffer({ label: `coarse ${label}`, size: bytes, usage: S });
    this.cells = mk('cells', N * CELL_FLOATS * 4);
    this.next = mk('next', N * CELL_FLOATS * 4);
    this.base = mk('base', N * 8);
    this.fW = mk('flux water', N * 16);
    this.fL = mk('flux lava', N * 16);
    this.fT = mk('flux loose', N * 16);
    this.uni = device.createBuffer({ label: 'coarse params', size: UNI_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /** world units a cell, across and down */
  get csx(): number {
    return this.worldW / this.cn;
  }
  get csy(): number {
    return this.worldH / this.cn;
  }

  /** The atlas's ground under it (its macro grid, n × n, averaged down) and where the water is; the kernels. */
  async init(hmac: Float32Array, n: number, isWater: (texel: number) => boolean): Promise<void> {
    const { cn } = this;
    const k = n / cn;
    if (!Number.isInteger(k)) throw new Error(`the coarse grid (${cn}) must divide the atlas's (${n})`);
    const base = new Float32Array(cn * cn * 2);
    for (let j = 0; j < cn; j++)
      for (let i = 0; i < cn; i++) {
        let h = 0;
        let wet = 0;
        for (let y = 0; y < k; y++)
          for (let x = 0; x < k; x++) {
            const t = (j * k + y) * n + i * k + x;
            h += hmac[t];
            if (isWater(t)) wet++;
          }
        base[(j * cn + i) * 2] = h / (k * k);
        base[(j * cn + i) * 2 + 1] = wet * 2 > k * k ? 1 : 0;
      }
    this.device.queue.writeBuffer(this.base, 0, base);
    const dev = this.device;
    const m = makeModule(dev, 'coarse', [coarseW]);
    [this.kFlux, this.kDepth, this.kEvent] = await Promise.all([
      makeComputeAsync(dev, 'coarse flux', m, { 0: 'uniform', 1: 'read', 2: 'read', 4: 'rw', 5: 'rw', 6: 'rw' }, 'cFlux'),
      makeComputeAsync(dev, 'coarse depth', m, { 0: 'uniform', 1: 'read', 2: 'read', 3: 'rw', 4: 'rw', 5: 'rw', 6: 'rw' }, 'cDepth'),
      makeComputeAsync(dev, 'coarse event', m, { 0: 'uniform', 3: 'rw' }, 'cEvent'),
    ]);
    this.gFlux = makeBindGroup(dev, 'coarse flux', this.kFlux.layout, { 0: this.uni, 1: this.base, 2: this.cells, 4: this.fW, 5: this.fL, 6: this.fT });
    this.gDepth = makeBindGroup(dev, 'coarse depth', this.kDepth.layout, { 0: this.uni, 1: this.base, 2: this.cells, 3: this.next, 4: this.fW, 5: this.fL, 6: this.fT });
    this.gEvent = makeBindGroup(dev, 'coarse event', this.kEvent.layout, { 0: this.uni, 3: this.cells });
  }

  private writeUni(e?: CoarseEvent): void {
    const ab = new ArrayBuffer(UNI_BYTES);
    const u = new Uint32Array(ab);
    const f = new Float32Array(ab);
    u[0] = this.cn;
    u[1] = this.steps;
    u[2] = this.vents.length;
    u[3] = e?.kind ?? 0;
    f[4] = this.csx;
    f[5] = this.worldW;
    f[6] = this.worldH;
    f[7] = 1;
    f[8] = this.rain;
    f[9] = this.evap;
    f[10] = this.erode;
    f[11] = e?.x ?? 0;
    f[12] = e?.y ?? 0;
    f[13] = e?.r ?? 0;
    f[14] = e?.a ?? 0;
    f[15] = e?.wind?.[0] ?? 1;
    f[16] = e?.wind?.[1] ?? 0;
    this.vents.forEach((v, i) => f.set([v.x, v.y, v.rate, v.r], 20 + i * 4));
    this.device.queue.writeBuffer(this.uni, 0, ab);
  }

  /** n steps of the coarse world (each: what flows, then what it leaves) */
  step(n = 1): void {
    // (round 106: the snapshots asked before this step see the world before it)
    this.flushSnaps();
    if (!this.kFlux) return;
    const g = Math.ceil(this.cn / 8);
    for (let s = 0; s < n; s++) {
      this.writeUni();
      const enc = this.device.createCommandEncoder({ label: 'coarse step' });
      let cp = enc.beginComputePass();
      cp.setPipeline(this.kFlux.pipeline);
      cp.setBindGroup(0, this.gFlux!);
      cp.dispatchWorkgroups(g, g);
      cp.end();
      cp = enc.beginComputePass();
      cp.setPipeline(this.kDepth!.pipeline);
      cp.setBindGroup(0, this.gDepth!);
      cp.dispatchWorkgroups(g, g);
      cp.end();
      // (the cells everything reads stay one buffer: what was made is copied back)
      enc.copyBufferToBuffer(this.next, 0, this.cells, 0, this.cells.size);
      this.device.queue.submit([enc.finish()]);
      this.steps++;
      for (let k = this.vents.length - 1; k >= 0; k--) if (--this.vents[k].steps <= 0) this.vents.splice(k, 1);
    }
  }

  /** an event over the grid now (and in the fine window: onEvent) */
  event(e: CoarseEvent): void {
    if (!this.kEvent) throw new Error('the coarse world is not made yet');
    this.flushSnaps();
    this.writeUni(e);
    const enc = this.device.createCommandEncoder({ label: 'coarse event' });
    const cp = enc.beginComputePass();
    cp.setPipeline(this.kEvent.pipeline);
    cp.setBindGroup(0, this.gEvent!);
    const g = Math.ceil(this.cn / 8);
    cp.dispatchWorkgroups(g, g);
    cp.end();
    this.device.queue.submit([enc.finish()]);
    for (const f of this.onEvent) f(e);
  }

  /** A meteor at world (x, y): a crater r across (radius), d deep at its middle. */
  meteor(x: number, y: number, r = 240, d?: number): void {
    this.event({ kind: EV.meteor, x, y, r, a: d ?? r * 0.18 });
  }

  /**
   * (round 112) An atlas-sized strike at world (x, y), radius R (hundreds to thousands of cells): a flat-floored bowl
   * with a central peak, a raised rim, a rubble blanket thinning out to 4 R and ash past it to 8 R, a magma sea on the
   * bowl's floor (the coarse lava: it cools and sets to basalt at the coarse world's pace). It goes into the coarse
   * grid, so the regions there are made with it as they come (compose.wgsl coarseAt) — part of the world.
   */
  strike(x: number, y: number, R: number): void {
    this.event({ kind: EV.strike, x, y, r: R, a: strikeDepth(R) });
  }

  /** An eruption at world (x, y): a cone rising, ash carried downwind, lava pouring out for a while. */
  erupt(x: number, y: number, o: { cone?: number; ash?: number; ashR?: number; lava?: number; steps?: number; wind?: [number, number] } = {}): void {
    this.event({ kind: EV.cone, x, y, r: 260, a: o.cone ?? 40 });
    this.event({ kind: EV.ash, x, y, r: o.ashR ?? 900, a: o.ash ?? 2.5, wind: o.wind ?? [1, 0.3] });
    if (this.vents.length >= MAX_VENTS) this.vents.shift();
    this.vents.push({ x, y, rate: o.lava ?? 0.15, r: this.csx * 0.8, steps: o.steps ?? 1200 });
  }

  /** the cells (indices, wrapped when read) under the world cells x0..x0+w, y0..y0+h, a cell round */
  private span(x0: number, y0: number, w: number, h: number): { i0: number; j0: number; ni: number; nj: number } {
    const rowH = Math.sqrt(3) / 2;
    const i0 = Math.floor(x0 / this.csx - 0.5) - 1;
    const j0 = Math.floor((y0 * rowH) / this.csy - 0.5) - 1;
    const i1 = Math.floor((x0 + w + 1) / this.csx - 0.5) + 2;
    const j1 = Math.floor(((y0 + h) * rowH) / this.csy - 0.5) + 2;
    return { i0, j0, ni: i1 - i0 + 1, nj: j1 - j0 + 1 };
  }

  /**
   * The cells round a region of world cells as they are now. (Round 106, frameprobe: the snapshots asked in one task —
   * a slide's strip, eight at window 512 — are copied together, one staging buffer, one submit and one map, at the end
   * of the task (a microtask), or before the next step if that comes first: what each sees is the world as it was asked.)
   */
  snapshot(x0: number, y0: number, w: number, h: number): Promise<CoarseSnap> {
    const sp = this.span(x0, y0, w, h);
    return new Promise<CoarseSnap>((res, rej) => {
      this.snapQ.push({ sp, res, rej });
      if (this.snapQ.length === 1) queueMicrotask(() => this.flushSnaps());
    });
  }

  private snapQ: { sp: { i0: number; j0: number; ni: number; nj: number }; res: (s: CoarseSnap) => void; rej: (e: unknown) => void }[] = [];

  /** the snapshots asked so far, copied in one submit */
  private flushSnaps(): void {
    const q = this.snapQ;
    if (!q.length) return;
    this.snapQ = [];
    const { cn } = this;
    const dev = this.device;
    const offs: number[] = [];
    let size = 0;
    for (const { sp } of q) {
      offs.push(size);
      size += sp.ni * CELL_FLOATS * 4 * sp.nj;
    }
    const st = dev.createBuffer({ label: 'coarse snapshot', size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = dev.createCommandEncoder({ label: 'coarse snapshot' });
    q.forEach(({ sp }, k) => {
      const rowBytes = sp.ni * CELL_FLOATS * 4;
      for (let j = 0; j < sp.nj; j++) {
        const jj = (((sp.j0 + j) % cn) + cn) % cn;
        // (a row may wrap round the torus: copy it in runs)
        let i = 0;
        while (i < sp.ni) {
          const ii = (((sp.i0 + i) % cn) + cn) % cn;
          const run = Math.min(sp.ni - i, cn - ii);
          enc.copyBufferToBuffer(this.cells, (jj * cn + ii) * CELL_FLOATS * 4, st, offs[k] + j * rowBytes + i * CELL_FLOATS * 4, run * CELL_FLOATS * 4);
          i += run;
        }
      }
    });
    dev.queue.submit([enc.finish()]);
    st.mapAsync(GPUMapMode.READ).then(
      () => {
        const all = st.getMappedRange();
        q.forEach(({ sp, res }, k) => res({ ...sp, cells: new Float32Array(all.slice(offs[k], offs[k] + sp.ni * CELL_FLOATS * 4 * sp.nj)) }));
        st.unmap();
        st.destroy();
      },
      (e) => {
        st.destroy();
        for (const { rej } of q) rej(e);
      },
    );
  }

  /** the coarse world at world point (px, py) from a snapshot (compose.wgsl coarseAt, on the CPU) */
  sample(s: CoarseSnap, px: number, py: number): CoarseAt {
    const tx = px / this.csx - 0.5;
    const ty = py / this.csy - 0.5;
    let fx0 = Math.floor(tx);
    let fy0 = Math.floor(ty);
    const fx = tx - fx0;
    const fy = ty - fy0;
    // (into the snapshot's frame: it may sit across the torus's seam from the point)
    const wrap = (v: number, o: number) => o + ((((v - o) % this.cn) + this.cn) % this.cn);
    fx0 = wrap(fx0, s.i0);
    fy0 = wrap(fy0, s.j0);
    const o: CoarseAt = { dr: 0, loose: 0, water: 0, lava: 0, lmat: 0, cap: 0 };
    let best = -1;
    for (let k = 0; k < 4; k++) {
      const i = fx0 + (k & 1) - s.i0;
      const j = fy0 + (k >> 1) - s.j0;
      if (i < 0 || j < 0 || i >= s.ni || j >= s.nj) throw new Error('a coarse sample outside its snapshot');
      const c = (j * s.ni + i) * CELL_FLOATS;
      const wt = (k & 1 ? fx : 1 - fx) * (k >> 1 ? fy : 1 - fy);
      o.dr += s.cells[c] * wt;
      o.loose += s.cells[c + 1] * wt;
      o.water += s.cells[c + 2] * wt;
      o.lava += s.cells[c + 4] * wt;
      if (wt > best && s.cells[c + 1] > 0.01) {
        best = wt;
        o.lmat = s.cells[c + 6];
      }
      if (s.cells[c + 7] > 0.5 && wt > 0.25) o.cap = s.cells[c + 7];
    }
    return o;
  }

  dispose(): void {
    for (const b of [this.cells, this.next, this.base, this.fW, this.fL, this.fT, this.uni]) b.destroy();
  }
}

/**
 * What an event leaves at world point (px, py) — coarse.wgsl cEvent's shapes, for the fine window
 * (keep the two the same): rock taken (−) or added, loose ground added and its material.
 */
const smoothstep = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function eventAt(e: CoarseEvent, px: number, py: number, worldW: number, worldH: number): { dr: number; dl: number; lmat: number } {
  let dx = px - e.x;
  let dy = py - e.y;
  dx -= Math.round(dx / worldW) * worldW;
  dy -= Math.round(dy / worldH) * worldH;
  const r = Math.hypot(dx, dy);
  const R = e.r;
  const D = e.a;
  if (e.kind === EV.meteor) {
    let dr = D * 0.22 * Math.exp(-(((r - R) / (0.25 * R)) ** 2));
    if (r < R) dr -= D * (1 - (r / R) ** 2);
    const dl = r > 0.85 * R && r < 3 * R ? D * 0.12 * (R / Math.max(r, R)) ** 3 : 0;
    return { dr, dl, lmat: 4 };
  }
  if (e.kind === EV.strike) {
    // (coarse.wgsl cEvent kind 4: keep the two the same)
    const q = r / R;
    let dr = -D * (1 - smoothstep(0.5, 1, q)) + D * 0.2 * Math.exp(-(((q - 1) / 0.15) ** 2));
    if (R >= 400) dr += D * 0.5 * Math.exp(-((q / 0.1) ** 2));
    let dl = 0;
    let lmat = 4;
    if (q > 0.9 && q < 4) dl = D * 0.1 * (1 / Math.max(q, 1)) ** 3;
    if (q >= 2.5 && q < 8) {
      dl = Math.max(dl, 1.2 * (2.5 / q) ** 2);
      lmat = 17;
    }
    return { dr, dl, lmat };
  }
  if (e.kind === EV.ash) {
    const [wx, wy] = e.wind ?? [1, 0];
    const wl = Math.hypot(wx, wy) || 1;
    const along = (dx * wx + dy * wy) / wl - R * 0.6;
    const across = (-dx * wy + dy * wx) / wl;
    const a = D * Math.exp(-(along * along) / (R * R * 1.6) - (across * across) / (R * R * 0.35));
    return { dr: 0, dl: a > 0.01 ? a : 0, lmat: 17 };
  }
  const k = Math.max(1 - r / R, 0);
  return { dr: D * k * k, dl: 0, lmat: 0 };
}
