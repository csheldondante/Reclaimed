// A system that sleeps on the CPU's word (phone-idle round 2, 2026-11-15; DESIGN §24: "CPU reads are small, async, and
// only after edits or events; nothing reads back per frame"; the user's rule of thumb: a system that is asleep encodes
// nothing at all). On the phone an indirect dispatch costs ~0.1 ms whether it does 1 workgroup or 0 (docs/FRAMECOST.md),
// so a GPU-gated solve that encodes its kernels every frame "sized to 0 when settled" is not asleep.
//
// The pattern: the system's solve is encoded only while `awake`. A CPU-known event wakes it (`wake()`: a lot built, a
// road changed, a season's step, a slide, an edit near it). While awake, each frame it encodes its work and then
// `encode(enc)`: a few words of its own state copied to a staging buffer and mapped — one read in flight at a time.
// When a read that was taken after the last wake says settled, it sleeps: no dispatch, no copy, no read. So reads
// happen only between an event and the solve's end, a handful per event.
//
// `hold`: frames after a wake during which a read's "settled" isn't believed — an event that reaches the GPU a tick
// later (an edit queued this frame) would otherwise be slept through.
// API: SettledGate (the logic, pure), SettledRead (the gate over a GPU buffer's words).

export class SettledGate {
  /** encode the solve this frame */
  awake = true;
  private gen = 0;
  private frame = 0;
  private trustFrom = 0;
  /** reads asked for, and wakes, so far (a test's, the census's) */
  readonly stats = { wakes: 0, reads: 0, slept: 0 };

  constructor(private hold = 2) {}

  /** a CPU-known event: there may be work */
  wake(hold = this.hold): void {
    this.gen++;
    this.awake = true;
    this.trustFrom = Math.max(this.trustFrom, this.frame + hold);
    this.stats.wakes++;
  }

  /** a frame encoded (awake): returns the token a read taken now carries, or null when its answer wouldn't be believed yet */
  tick(): number | null {
    const f = this.frame++;
    return f >= this.trustFrom ? this.gen : null;
  }

  /** a read came back: taken at `token`, the GPU's words said `settled` */
  answer(token: number, settled: boolean): void {
    this.stats.reads++;
    if (!settled || token !== this.gen) return;
    this.awake = false;
    this.stats.slept++;
  }
}

export class SettledRead {
  readonly gate: SettledGate;
  private staging: GPUBuffer;
  private inFlight = false;
  private dead = false;

  /**
   * `src`'s `bytes` at `offset` (a multiple of 4; `src` must be a COPY_SRC) are the system's state words; `settled`
   * says from them whether the solve has nothing more to do.
   */
  constructor(
    device: GPUDevice,
    label: string,
    private src: GPUBuffer,
    private offset: number,
    private bytes: number,
    private settled: (words: Uint32Array) => boolean,
    hold = 2,
  ) {
    this.gate = new SettledGate(hold);
    this.staging = device.createBuffer({ label: `${label} settled read`, size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  }

  get awake(): boolean {
    return this.gate.awake;
  }

  wake(hold?: number): void {
    this.gate.wake(hold);
  }

  /**
   * After the system's dispatches, in the frame's encoder, only while awake: the state words copied and, once the
   * encoder is submitted (later in this task: the map starts in a microtask), read. Nothing while a read is in flight.
   */
  encode(enc: GPUCommandEncoder): void {
    const token = this.gate.tick();
    if (token === null || this.inFlight || this.dead) return;
    enc.copyBufferToBuffer(this.src, this.offset, this.staging, 0, this.bytes);
    this.inFlight = true;
    queueMicrotask(() => {
      if (this.dead) return;
      this.staging.mapAsync(GPUMapMode.READ).then(
        () => {
          if (this.dead) return;
          const words = new Uint32Array(this.staging.getMappedRange().slice(0));
          this.staging.unmap();
          this.inFlight = false;
          this.gate.answer(token, this.settled(words));
        },
        () => (this.inFlight = false),
      );
    });
  }

  destroy(): void {
    this.dead = true;
    this.staging.destroy();
  }
}
