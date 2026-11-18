// Nested scales lab: the watertight checks (test only; readbacks). (i) The manifold check: every triangle the draw
// places for a level (Renderer.capture: the vertex code run in a compute pass), welded by EXACT position (x, y are whole
// columns, z the stored f32); every edge of the level's face set must be shared by an EVEN number of triangles (a box
// union can share an edge among four), with one exception: edges on the level's open world bottom plane. Each level is
// checked whole, its window edge and its child's footprint included: a level walls its own rim (the outside is air to
// it), so where two levels meet each one's surface is closed by itself and the union has no gap. (ii) The screen check:
// pixels with no surface (the info target's red channel 0) where ground must be.
import type { Renderer } from './render';

export interface EdgeReport {
  depth: number;
  tris: number;
  edges: number;
  /** edges used by an odd number of triangles (a crack) */
  open: number;
  /** edges used by four or more (box corners meeting: allowed) */
  over: number;
  /** triangles with two equal corners (none expected) */
  degenerate: number;
  /** a few open edges' midpoints (local units) */
  where: [number, number, number][];
}

/** the open world bottom of level depth (nest.wgsl botOf) */
export function botOf(depth: number, n: number): number {
  return Math.fround(depth === 0 ? -8 : -2 * n);
}

export function manifold(cap: { depth: number; n: number; tris: Float32Array }): EdgeReport {
  const t = cap.tris;
  const bot = botOf(cap.depth, cap.n);
  const vk = (o: number) => `${t[o]},${t[o + 1]},${t[o + 2]}`;
  const edges = new Map<string, number>();
  let tris = 0;
  let degenerate = 0;
  const slots = t.length / 12;
  for (let s = 0; s < slots; s++) {
    const o = s * 12;
    if (t[o + 3] === 0) continue;
    const k = [0, 1, 2].map((v) => vk(o + v * 4));
    if (k[0] === k[1] || k[1] === k[2] || k[0] === k[2]) {
      degenerate++;
      continue;
    }
    tris++;
    for (let e = 0; e < 3; e++) {
      const a = k[e];
      const b = k[(e + 1) % 3];
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  let open = 0;
  let over = 0;
  let count = 0;
  const where: [number, number, number][] = [];
  for (const [key, c] of edges) {
    const [s, e] = key.split('|').map((v) => v.split(',').map(Number));
    // (the open world bottom: edges on the bottom plane are the one boundary a level has)
    if (s[2] === bot && e[2] === bot) continue;
    count++;
    if (c % 2 === 1) {
      open++;
      if (where.length < 6) where.push([(s[0] + e[0]) / 2, (s[1] + e[1]) / 2, +((s[2] + e[2]) / 2).toFixed(3)]);
    } else if (c > 2) over++;
  }
  return { depth: cap.depth, tris, edges: count, open, over, degenerate, where };
}

/** the last holePixels call's frame at half resolution, holes magenta */
export let lastImage: { w: number; h: number; rgb: number[] } | null = null;
/** the info target's pixels with no surface (red 0), whole frame */
export async function holePixels(device: GPUDevice, render: Renderer, redraw: () => GPUTexture): Promise<{ holes: number; px: number; at: [number, number][]; rows: number[]; h: number }> {
  // a draw of our own, so the colour and the info targets read back are the same frame
  const colour = redraw();
  const tex = render.info!;
  const w = tex.width;
  const h = tex.height;
  const bpr = Math.ceil((w * 4) / 256) * 256;
  const buf = device.createBuffer({ size: bpr * h, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const cbuf = device.createBuffer({ size: bpr * h, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [w, h]);
  enc.copyTextureToBuffer({ texture: colour }, { buffer: cbuf, bytesPerRow: bpr }, [w, h]);
  device.queue.submit([enc.finish()]);
  await Promise.all([buf.mapAsync(GPUMapMode.READ), cbuf.mapAsync(GPUMapMode.READ)]);
  const px = new Uint8Array(buf.getMappedRange());
  const cp = new Uint8Array(cbuf.getMappedRange());
  // (the colour at quarter resolution, holes magenta; bgra canvases swapped to rgb)
  const bgra = colour.format.startsWith('bgra');
  const img: number[] = [];
  for (let y = 0; y < h; y += 2)
    for (let x = 0; x < w; x += 2) {
      const i = y * bpr + x * 4;
      if (px[i] === 0) img.push(255, 0, 255);
      else img.push(cp[i + (bgra ? 2 : 0)], cp[i + 1], cp[i + (bgra ? 0 : 2)]);
    }
  lastImage = { w: Math.ceil(w / 2), h: Math.ceil(h / 2), rgb: img };
  cbuf.unmap();
  cbuf.destroy();
  let holes = 0;
  const at: [number, number][] = [];
  const rows = new Array<number>(h).fill(0);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (px[y * bpr + x * 4] === 0) {
        holes++;
        rows[y]++;
        if (at.length < 8 && (at.length === 0 || Math.abs(at[at.length - 1][1] - y) > 20)) at.push([x, y]);
      }
  buf.unmap();
  buf.destroy();
  return { holes, px: w * h, at, rows, h };
}
