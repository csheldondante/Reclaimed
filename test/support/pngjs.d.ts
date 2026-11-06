// (round 128p) pngjs has no types; the gpu tier's map previews (test/gpu/roadgen.test.ts) use only this much of it.
declare module 'pngjs' {
  export class PNG {
    constructor(o: { width: number; height: number });
    data: Buffer;
    static sync: { write(png: PNG): Buffer };
  }
}
