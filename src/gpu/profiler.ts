// Lightweight instrumentation (design doc §9 "benchmark before escalating").
// - GPU time per named pass via timestamp queries (when the adapter supports them).
// - Draw/dispatch counts, buffer/texture memory tracked at allocation time.
// Readbacks are asynchronous and ring-buffered so they never stall the frame.

const MAX_QUERIES = 128; // 64 passes per frame
const RING = 3;

export class Profiler {
  readonly enabled: boolean;
  /** (round 82) timing taken only while someone looks (the perf overlay open, or a script): a readback every frame */
  active = true;
  private querySet?: GPUQuerySet;
  private resolveBuf?: GPUBuffer;
  private staging: { buf: GPUBuffer; busy: boolean; names: string[] }[] = [];
  /** (round 100, hitchrec) the timestamp writes made once a slot pair, not an object a pass a frame */
  private writes: GPUComputePassTimestampWrites[] = [];
  private perName = new Map<string, number>();
  private names: string[] = [];
  private next = 0;

  /** Smoothed GPU ms per pass name (over the frames it ran in). */
  readonly passMs = new Map<string, number>();
  /** GPU ms per pass name summed over every frame resolved since `resetTotals`, and those frames: per-frame costs whatever a pass's period */
  readonly totalMs = new Map<string, number>();
  /** (round 81) the most one frame took of each pass since `resetTotals` (raw, not smoothed) */
  readonly maxMs = new Map<string, number>();
  framesResolved = 0;
  gpuTotalMs = 0;
  gpuFrameMs = 0;
  /** (round 81) the GPU's long frames: its ms (first pass's start to the last's end) and its three longest passes */
  readonly gpuLong: string[] = [];
  dispatches = 0;
  draws = 0;
  memory = new Map<string, number>();
  /** (round 100, hitchrec) frames begun, and who hears each frame's GPU time once it's read back (src/perf/hitch.ts) */
  frameNo = 0;
  /** (round 106, frameprobe) the last frame read back: its first pass's start and its last pass's end (GPU ns, as
   * numbers), and its passes' ms by name (valid during onFrame) — for gaps between frames and per-frame breakdowns */
  lastStartNs = 0;
  lastEndNs = 0;
  get lastPasses(): ReadonlyMap<string, number> {
    return this.perName;
  }
  onFrame?: (frame: number, ms: number, top: string) => void;

  constructor(device: GPUDevice, hasTimestamps: boolean) {
    this.enabled = hasTimestamps;
    if (!hasTimestamps) return;
    this.querySet = device.createQuerySet({ type: 'timestamp', count: MAX_QUERIES });
    this.resolveBuf = device.createBuffer({
      size: MAX_QUERIES * 8,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    for (let i = 0; i < RING; i++) {
      this.staging.push({
        buf: device.createBuffer({ size: MAX_QUERIES * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
        busy: false,
        names: [],
      });
    }
  }

  beginFrame(): void {
    this.frameNo++;
    this.names.length = 0;
    this.next = 0;
    this.dispatches = 0;
    this.draws = 0;
  }

  /** (round 108) this profiler with its passes named `prefix` + their name (a render-only tile's render prep: the
   *  window's systems on a tile's land — render/tileworld.ts — timed apart from the window's own) */
  named(prefix: string): Profiler {
    const p = Object.create(this) as Profiler;
    p.timestamps = (name: string) => this.timestamps(prefix + name);
    Object.defineProperty(p, 'dispatches', { get: () => this.dispatches, set: (v: number) => (this.dispatches = v) });
    return p;
  }

  /** Timestamp writes for a pass, or undefined when unsupported / out of slots. */
  timestamps(name: string): GPUComputePassTimestampWrites | undefined {
    if (!this.querySet || !this.active || this.next + 2 > MAX_QUERIES) return undefined;
    const i = this.next;
    this.next += 2;
    this.names.push(name);
    return (this.writes[i / 2] ??= { querySet: this.querySet, beginningOfPassWriteIndex: i, endOfPassWriteIndex: i + 1 });
  }

  /** Resolve this frame's queries into a free staging buffer (skipped if all are in flight). */
  endFrame(encoder: GPUCommandEncoder): (() => void) | undefined {
    if (!this.querySet || this.next === 0) return undefined;
    const slot = this.staging.find((s) => !s.busy);
    if (!slot) return undefined;
    const count = this.next;
    const names = slot.names;
    names.length = 0;
    for (const n of this.names) names.push(n);
    const frameNo = this.frameNo;
    encoder.resolveQuerySet(this.querySet, 0, count, this.resolveBuf!, 0);
    encoder.copyBufferToBuffer(this.resolveBuf!, 0, slot.buf, 0, count * 8);
    slot.busy = true;
    // Caller invokes this after queue.submit.
    return () => {
      slot.buf.mapAsync(GPUMapMode.READ, 0, count * 8).then(() => {
        // (round 100, hitchrec: ns as two u32 words, not BigInts — a BigInt a read was two allocations a pass)
        const w = new Uint32Array(slot.buf.getMappedRange(0, count * 8));
        const ns = (k: number) => w[k * 2] + w[k * 2 + 1] * 4294967296;
        let first = ns(0);
        let last = ns(1);
        const perName = this.perName;
        perName.clear();
        for (let p = 0; p < names.length; p++) {
          const a = ns(p * 2);
          const b = ns(p * 2 + 1);
          if (a < first) first = a;
          if (b > last) last = b;
          const ms = (b - a) / 1e6;
          perName.set(names[p], (perName.get(names[p]) ?? 0) + ms);
        }
        this.framesResolved++;
        for (const [n, ms] of perName) {
          this.totalMs.set(n, (this.totalMs.get(n) ?? 0) + ms);
          this.maxMs.set(n, Math.max(this.maxMs.get(n) ?? 0, ms));
          const prev = this.passMs.get(n);
          this.passMs.set(n, prev === undefined ? ms : prev * 0.9 + ms * 0.1);
        }
        this.lastStartNs = first;
        this.lastEndNs = last;
        const frame = (last - first) / 1e6;
        if (frame > 25) {
          const top = [...perName].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([n, ms]) => `${n} ${ms.toFixed(1)}`);
          this.gpuLong.push(`${frame.toFixed(0)}ms: ${top.join(', ')}`);
          if (this.gpuLong.length > 24) this.gpuLong.shift();
        }
        if (this.onFrame) {
          let top = '';
          let topMs = -1;
          for (const [n, ms] of perName)
            if (ms > topMs) {
              topMs = ms;
              top = n;
            }
          this.onFrame(frameNo, frame, `${top} ${topMs.toFixed(1)}`);
        }
        this.gpuTotalMs += frame;
        this.gpuFrameMs = this.gpuFrameMs * 0.9 + frame * 0.1;
        slot.buf.unmap();
        slot.busy = false;
      });
    };
  }

  resetTotals(): void {
    this.totalMs.clear();
    this.maxMs.clear();
    this.framesResolved = 0;
    this.gpuTotalMs = 0;
  }

  trackMemory(label: string, bytes: number): void {
    this.memory.set(label, bytes);
  }

  totalMemoryBytes(): number {
    let s = 0;
    for (const v of this.memory.values()) s += v;
    return s;
  }
}
