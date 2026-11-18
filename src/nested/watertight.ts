// Nested scales lab: the watertight checks (test only; readbacks). (i) The manifold check: every triangle the draw
// places for a level (Renderer.capture: the vertex code run in a compute pass), welded by position; every edge inside
// the level (away from its window's rim and its child's cut) must be shared by exactly two triangles. (ii) The screen
// check: pixels with no surface (the info target's red channel 0) where ground must be.
import type { DrawLevel, Renderer } from './render';

export interface EdgeReport {
  depth: number;
  tris: number;
  edges: number;
  /** interior edges used by one triangle (a crack) */
  open: number;
  /** interior edges used by more than two (overlapping faces) */
  over: number;
  /** a few open edges' midpoints (local units) */
  where: [number, number, number][];
  /** open edges by the source of their one triangle (A the top sheet, R a region item, S a slab item), a few each */
  bySrc: Record<string, number>;
  whereBy: Record<string, [number, number, number][]>;
  trisBy: Record<string, number>;
  items: number;
}

/** weld quantum, local units */
const Q = 1024;

export function manifold(cap: { depth: number; n: number; a: Float32Array; b: Float32Array }, cut: DrawLevel['cut']): EdgeReport {
  const { n, a, b } = cap;
  const vk = (arr: Float32Array, i: number) => `${Math.round(arr[i * 4] * Q)},${Math.round(arr[i * 4 + 1] * Q)},${Math.round(arr[i * 4 + 2] * Q)}`;
  const edges = new Map<string, number>();
  const pos = new Map<string, [number, number, number]>();
  // (the source of an edge's last triangle: A the top sheet, R a region item, S a slab item)
  const srcOf = new Map<string, string>();
  let src = 'A';
  let tris = 0;
  const trisBy: Record<string, number> = {};
  const tri = (arr: Float32Array, i0: number, i1: number, i2: number) => {
    const k = [vk(arr, i0), vk(arr, i1), vk(arr, i2)];
    if (k[0] === k[1] || k[1] === k[2] || k[0] === k[2]) return;
    // (zero area: three points on a line)
    const p = [i0, i1, i2].map((i) => [arr[i * 4], arr[i * 4 + 1], arr[i * 4 + 2]]);
    const u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    const v = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    const cr = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
    if (cr < 1e-7) return;
    tris++;
    trisBy[src] = (trisBy[src] ?? 0) + 1;
    for (let e = 0; e < 3; e++) {
      const s = k[e];
      const t = k[(e + 1) % 3];
      const key = s < t ? `${s}|${t}` : `${t}|${s}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
      srcOf.set(key, src);
      pos.set(key, [(p[e][0] + p[(e + 1) % 3][0]) / 2, (p[e][1] + p[(e + 1) % 3][1]) / 2, (p[e][2] + p[(e + 1) % 3][2]) / 2]);
    }
  };
  for (let j = 0; j < n - 1; j++)
    for (let i = 0; i < n - 1; i++) {
      const v = j * n + i;
      const own = (x: number) => a[x * 4 + 3] > 0;
      if (own(v) || own(v + 1) || own(v + n) || own(v + n + 1)) continue;
      tri(a, v, v + 1, v + n + 1);
      tri(a, v, v + n + 1, v + n);
    }
  // (36 vertices an item, 12 triangles: draw.wgsl VPI; a region item uses the first 18)
  const items = b.length / 4 / 36;
  for (let it = 0; it < items; it++)
    for (let t = 0; t < 12; t++) {
      const o = it * 36 + t * 3;
      if (b[o * 4 + 3] === 0 || b[(o + 1) * 4 + 3] === 0 || b[(o + 2) * 4 + 3] === 0) continue;
      src = b[o * 4 + 3] === 2 ? 'S' : 'R';
      tri(b, o, o + 1, o + 2);
    }
  const inside = (x: number, y: number) => {
    if (x < 1.5 || y < 1.5 || x > n - 1.5 || y > n - 1.5) return false;
    if (cut && cut[0] < cut[2] && x > cut[0] - 1.5 && y > cut[1] - 1.5 && x < cut[2] + 1.5 && y < cut[3] + 1.5) return false;
    return true;
  };
  let open = 0;
  let over = 0;
  let count = 0;
  const bySrc: Record<string, number> = {};
  const whereBy: Record<string, [number, number, number][]> = {};
  const where: [number, number, number][] = [];
  for (const [key, c] of edges) {
    const [s, t] = key.split('|').map((v) => v.split(',').map((x) => Number(x) / Q));
    if (!inside(s[0], s[1]) || !inside(t[0], t[1])) continue;
    count++;
    if (c === 1) {
      open++;
      const sk = srcOf.get(key)!;
      bySrc[sk] = (bySrc[sk] ?? 0) + 1;
      const p = pos.get(key)!.map((x) => +x.toFixed(2)) as [number, number, number];
      if (where.length < 6) where.push(p);
      (whereBy[sk] ??= []).length < 4 && whereBy[sk].push(p);
    } else if (c > 2) over++;
  }
  return { depth: cap.depth, tris, edges: count, open, over, where, bySrc, whereBy, trisBy, items: b.length / 4 / 36 };
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
