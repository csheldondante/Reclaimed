// (tilekit step 3) A tiny software rasteriser for plan diagrams in Node (the grid alone, its valences): filled
// polygons, dots, thick segments, written as a PNG with node:zlib. Lab and test tooling only — the stills the owner
// judges of the 3D district come from the WebGPU lab.

import { deflateSync } from 'node:zlib';

export type RGB8 = [number, number, number];

export class Raster {
  data: Uint8Array;
  constructor(public w: number, public h: number, bg: RGB8 = [255, 255, 255]) {
    this.data = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) this.data.set(bg, i * 3);
  }
  /** a filled polygon (pixel coordinates), even–odd */
  poly(pts: [number, number][], c: RGB8) {
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const p of pts) {
      y0 = Math.min(y0, p[1]);
      y1 = Math.max(y1, p[1]);
    }
    for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(this.h - 1, Math.ceil(y1)); y++) {
      const yc = y + 0.5;
      const xs: number[] = [];
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xa, ya] = pts[j];
        const [xb, yb] = pts[i];
        if (ya > yc !== yb > yc) xs.push(xa + ((yc - ya) * (xb - xa)) / (yb - ya));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x <= Math.min(this.w - 1, Math.floor(xs[k + 1] - 0.5)); x++) this.data.set(c, (y * this.w + x) * 3);
      }
    }
  }
  seg(a: [number, number], b: [number, number], width: number, c: RGB8) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    const nx = (-dy / l) * width * 0.5;
    const ny = (dx / l) * width * 0.5;
    this.poly([[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]], c);
  }
  dot(p: [number, number], r: number, c: RGB8) {
    const n = 12;
    this.poly(Array.from({ length: n }, (_, i) => [p[0] + Math.cos((i / n) * 6.283) * r, p[1] + Math.sin((i / n) * 6.283) * r] as [number, number]), c);
  }
  /** a 5 × 7 pixel font is overkill here: labels are left to the caption files */
  png(): Uint8Array {
    const raw = new Uint8Array((this.w * 3 + 1) * this.h);
    for (let y = 0; y < this.h; y++) raw.set(this.data.subarray(y * this.w * 3, (y + 1) * this.w * 3), y * (this.w * 3 + 1) + 1);
    const chunk = (type: string, body: Uint8Array) => {
      const out = new Uint8Array(12 + body.length);
      const dv = new DataView(out.buffer);
      dv.setUint32(0, body.length);
      for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
      out.set(body, 8);
      dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
      return out;
    };
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, this.w);
    dv.setUint32(4, this.h);
    ihdr.set([8, 2, 0, 0, 0], 8);
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array(0))];
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

let table: Uint32Array | null = null;
function crc32(b: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
