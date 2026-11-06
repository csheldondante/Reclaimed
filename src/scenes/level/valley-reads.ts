// (round 128o, DA-B5; DESIGN.md §24) The sandbox valley's timed reads of the GPU, in one place: what the valley's
// Nature, its storms and its ambience hear of the world. The level makes one for the sandbox; the fortress has none
// (scenes/level/fortress.ts startFortress drops it), so none of these reads run in fortress play:
//   - the wind field, 4 Hz (rgba32float, a texel per 2 × 2 columns): the storms feel the painted wind (weather.ts)
//   - the particle counters, 2 Hz (16 bytes): Nature paid for smoke the wind tore apart and grime washed into water,
//     and the wash's plinks (audio.wash)
//   - the plants and the water, 1 Hz (a per-column f32 each, the whole window): the ambience's birdsong, insects,
//     running water and frogs round the view (valley.ts hearing), the frogs' water for the inhabitants (attach-tools)
// API: ValleyReads.
import { ignoreTeardown } from '../../gpu/pipeline';
import type { WorldCore } from '../world-core';

/** what the reads tell: the valley's Nature and its audio */
export interface ValleyReadsIO {
  core: WorldCore;
  smokeDispersed(n: number): void;
  grimeWashed(n: number): void;
}

export class ValleyReads {
  /** the succession field and the water as last read (the window's ring order: core.ring.i), for the ambience */
  veg?: Float32Array;
  water?: Float32Array;
  private windIn = 0;
  private countersIn = 0;
  private ambienceIn = 0;
  private smokeSeen = -1;
  private washedSeen = -1;

  constructor(private io: ValleyReadsIO) {}

  /** each frame: the reads that are due */
  frame(dt: number): void {
    const { core } = this.io;
    if ((this.windIn -= dt) <= 0) {
      this.windIn = 0.25;
      void core.readWindField().then((f) => (core.weather.windField = f), ignoreTeardown);
    }
    if ((this.countersIn -= dt) <= 0) {
      this.countersIn = 0.5;
      void core.readBuffer('particleCounters').then((f) => {
        const u = new Uint32Array(f.buffer);
        if (this.smokeSeen >= 0 && u[2] > this.smokeSeen) this.io.smokeDispersed(u[2] - this.smokeSeen);
        this.smokeSeen = u[2];
        // (grime blown into water washes away: plinks and a little Nature)
        if (this.washedSeen >= 0 && u[3] > this.washedSeen) this.io.grimeWashed(u[3] - this.washedSeen);
        this.washedSeen = u[3];
      }, ignoreTeardown);
    }
    if ((this.ambienceIn -= dt) <= 0) {
      this.ambienceIn = 1;
      void core.readBuffer('veg', true).then((f) => (this.veg = f), ignoreTeardown);
      void core.readBuffer('water', true).then((f) => (this.water = f), ignoreTeardown);
    }
  }
}
