// Nested scales lab: the watertight checks (test only; readbacks). (i) The manifold check: every triangle the draw
// places for a level (Renderer.capture: the vertex code run in a compute pass), welded by EXACT position (x, y are whole
// columns, z the stored f32); every edge of the level's face set must be shared by an EVEN number of triangles (a box
// union can share an edge among four), with no exception (round 8: no open world bottom any more). Each level is
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

// (round 8) no edge is exempt: a level's boxes end at each column's own depth with a down cap (nest.wgsl zbOf), so the
// face set is closed everywhere; before, the edges on a fixed bottom plane were the one boundary allowed.
export function manifold(cap: { depth: number; n: number; tris: Float32Array }): EdgeReport {
  const t = cap.tris;
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
    count++;
    if (c % 2 === 1) {
      open++;
      if (where.length < 6) where.push([(s[0] + e[0]) / 2, (s[1] + e[1]) / 2, +((s[2] + e[2]) / 2).toFixed(3)]);
    } else if (c > 2) over++;
  }
  return { depth: cap.depth, tris, edges: count, open, over, degenerate, where };
}

/** (round 8, test only) every column in view drawn by exactly one level: from the captured faces, each level's caps (the
 *  horizontal triangles, which lie on their own column's square) must belong to columns that level draws now (in its
 *  window, not under its child's footprint: no stale faces after a slide, demote or shrink), and every column it draws
 *  must have its top cap (no column left undrawn by both). wins: each level's window (global columns of its depth). */
export function coverage(caps: { depth: number; tris: Float32Array }[], wins: { gx: number; gy: number; n: number }[], k: number): { stale: number; missing: number; where: string[] } {
  let stale = 0;
  let missing = 0;
  const where: string[] = [];
  for (const cap of caps) {
    const L = cap.depth;
    const w = wins[L];
    const c = wins[L + 1];
    const under = (X: number, Y: number) => !!c && X * k >= c.gx && Y * k >= c.gy && X * k < c.gx + c.n && Y * k < c.gy + c.n;
    const capsAt = new Uint16Array(w.n * w.n);
    const t = cap.tris;
    for (let o = 0; o + 12 <= t.length; o += 12) {
      if (t[o + 3] === 0 || t[o + 2] !== t[o + 6] || t[o + 2] !== t[o + 10]) continue;
      const x = Math.min(t[o], t[o + 4], t[o + 8]);
      const y = Math.min(t[o + 1], t[o + 5], t[o + 9]);
      const X = w.gx + x;
      const Y = w.gy + y;
      if (x < 0 || y < 0 || x >= w.n || y >= w.n || under(X, Y)) {
        stale++;
        if (where.length < 6) where.push(`L${L} stale cap at ${X},${Y}`);
        continue;
      }
      capsAt[y * w.n + x]++;
    }
    for (let y = 0; y < w.n; y++)
      for (let x = 0; x < w.n; x++)
        if (!under(w.gx + x, w.gy + y) && capsAt[y * w.n + x] < 2) {
          missing++;
          if (where.length < 6) where.push(`L${L} column ${w.gx + x},${w.gy + y} has no cap`);
        }
  }
  return { stale, missing, where };
}

/** the last holePixels call's frame at half resolution, holes magenta */
export let lastImage: { w: number; h: number; rgb: number[] } | null = null;
/** the info target's pixels with no surface (red 0), whole frame */
export async function holePixels(device: GPUDevice, render: Renderer, redraw: () => GPUTexture): Promise<{ holes: number; px: number; at: [number, number][]; rows: number[]; h: number; w: number; mask: Uint8Array }> {
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
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (px[y * bpr + x * 4] === 0) {
        holes++;
        rows[y]++;
        mask[y * w + x] = 1;
        if (at.length < 8 && (at.length === 0 || Math.abs(at[at.length - 1][1] - y) > 20)) at.push([x, y]);
      }
  buf.unmap();
  buf.destroy();
  return { holes, px: w * h, at, rows, h, w, mask };
}
