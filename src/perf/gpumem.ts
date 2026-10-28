// Round 100 (hitchrec): the GPU memory the page holds, buffer and texture bytes alive — every createBuffer /
// createTexture counted in, every destroy() (or the object collected without one) out. Installed on the device
// with `?hitch=1` before anything is made, so a leak (bytes growing over a soak) shows whoever made it, by label.

const BYTES: Record<string, number> = {
  r8unorm: 1, r8uint: 1, r16float: 2, r16uint: 2, rg8unorm: 2, r32float: 4, r32uint: 4, r32sint: 4, rgba8unorm: 4,
  'rgba8unorm-srgb': 4, bgra8unorm: 4, 'bgra8unorm-srgb': 4, rg16float: 4, rgb10a2unorm: 4, rg11b10ufloat: 4,
  rg32float: 8, rg32uint: 8, rgba16float: 8, rgba16uint: 8, rgba32float: 16, rgba32uint: 16, depth16unorm: 2,
  depth24plus: 4, 'depth24plus-stencil8': 4, depth32float: 4,
};

export class GpuMemTrack {
  private live = new WeakMap<object, { label: string; bytes: number; kind: 'buffer' | 'texture' }>();
  private gone = new FinalizationRegistry<{ label: string; bytes: number }>((r) => {
    this.collected++;
    this.drop(r.label, r.bytes);
  });
  private byLabel = new Map<string, number>();
  private total = 0;
  created = 0;
  destroyed = 0;
  collected = 0;
  /**
   * (the GPU's traffic, for what a hitch's GPU was doing — summed since the page began; the recorder takes the
   * differences over a frame) submits, bytes written by the queue, bytes copied buffer to buffer, bytes mapped for
   * reading, bytes made; and the slowest readback (mapAsync asked → resolved) that finished, its label and size
   */
  io = { submits: 0, writeBytes: 0, copyBytes: 0, mapBytes: 0, madeBytes: 0, maps: 0, pendingMaps: 0 };
  slowMap = { ms: 0, label: '', bytes: 0, at: 0 };

  constructor(device: GPUDevice) {
    const cb = device.createBuffer.bind(device);
    const ct = device.createTexture.bind(device);
    device.createBuffer = (d: GPUBufferDescriptor) => {
      const b = cb(d);
      this.add(b, d.label ?? '', d.size, 'buffer');
      return b;
    };
    device.createTexture = (d: GPUTextureDescriptor) => {
      const t = ct(d);
      const s = d.size as number[] | GPUExtent3DDict;
      const [w, h, z] = Array.isArray(s) ? [s[0], s[1] ?? 1, s[2] ?? 1] : [(s as GPUExtent3DDict).width, (s as GPUExtent3DDict).height ?? 1, (s as GPUExtent3DDict).depthOrArrayLayers ?? 1];
      const mips = d.mipLevelCount ?? 1;
      this.add(t, d.label ?? '', Math.round(w * h * z * (BYTES[d.format] ?? 4) * (mips > 1 ? 1.34 : 1) * (d.sampleCount ?? 1)), 'texture');
      return t;
    };
    const self = this;
    const q = device.queue;
    const submit = q.submit.bind(q);
    q.submit = (b: Iterable<GPUCommandBuffer>) => {
      self.io.submits++;
      return submit(b);
    };
    const write = q.writeBuffer.bind(q) as (...a: unknown[]) => void;
    (q as unknown as { writeBuffer: (...a: unknown[]) => void }).writeBuffer = (...a: unknown[]) => {
      const data = a[2] as ArrayBufferView | ArrayBuffer;
      const el = ArrayBuffer.isView(data) ? (data as unknown as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1 : 1;
      const size = a[4] !== undefined ? (a[4] as number) * el : (data as ArrayBuffer).byteLength - ((a[3] as number | undefined) ?? 0) * el;
      self.io.writeBytes += size;
      return write(...a);
    };
    const copy = GPUCommandEncoder.prototype.copyBufferToBuffer as (...a: unknown[]) => void;
    GPUCommandEncoder.prototype.copyBufferToBuffer = function (this: GPUCommandEncoder, ...a: unknown[]) {
      // (src, srcOffset, dst, dstOffset, size) or (src, dst, size?)
      const size = a.length >= 5 ? (a[4] as number) : ((a[2] as number | undefined) ?? (a[1] as GPUBuffer).size);
      self.io.copyBytes += size || 0;
      return copy.apply(this, a);
    } as typeof GPUCommandEncoder.prototype.copyBufferToBuffer;
    const map = GPUBuffer.prototype.mapAsync;
    GPUBuffer.prototype.mapAsync = function (this: GPUBuffer, mode: GPUMapModeFlags, offset?: number, size?: number) {
      const bytes = size ?? this.size - (offset ?? 0);
      self.io.mapBytes += bytes;
      self.io.maps++;
      self.io.pendingMaps++;
      const t0 = performance.now();
      const label = this.label || '?';
      const done = () => {
        self.io.pendingMaps--;
        const ms = performance.now() - t0;
        if (ms > self.slowMap.ms || performance.now() - self.slowMap.at > 1000) self.slowMap = { ms, label, bytes, at: performance.now() };
      };
      const p = map.call(this, mode, offset, size);
      p.then(done, done);
      return p;
    };
    for (const proto of [GPUBuffer.prototype, GPUTexture.prototype]) {
      const d = proto.destroy;
      proto.destroy = function (this: GPUBuffer | GPUTexture) {
        const r = self.live.get(this);
        if (r) {
          self.live.delete(this);
          self.gone.unregister(this);
          self.destroyed++;
          self.drop(r.label, r.bytes);
        }
        return d.call(this);
      };
    }
  }

  private add(o: object, label: string, bytes: number, kind: 'buffer' | 'texture'): void {
    const key = `${kind[0]}:${label || '?'}`;
    this.live.set(o, { label: key, bytes, kind });
    this.gone.register(o, { label: key, bytes }, o);
    this.created++;
    this.io.madeBytes += bytes;
    this.total += bytes;
    this.byLabel.set(key, (this.byLabel.get(key) ?? 0) + bytes);
  }

  private drop(label: string, bytes: number): void {
    this.total -= bytes;
    this.byLabel.set(label, (this.byLabel.get(label) ?? 0) - bytes);
  }

  liveBytes(): number {
    return this.total;
  }

  /** the largest labels, MB */
  top(k = 12): Record<string, number> {
    return Object.fromEntries(
      [...this.byLabel]
        .filter(([, b]) => b > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, k)
        .map(([l, b]) => [l, +(b / 1048576).toFixed(2)]),
    );
  }
}
