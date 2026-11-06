// The grid of mesh chunks drawn: culling chunks to the view and the sun, drawing the visible, and what moved or was
// drawn when the window slides. API: windowMoved, windowDrawn (Renderer's), gridCull, drawGrid, gridLive.
import { GRID_N, SKIP } from './defs';
import type { Renderer } from '../renderer';

/** Renderer.windowMoved (the class keeps the method, documented there) */
export function windowMoved(rd: Renderer, dcx: number, dcy: number, t: [number, number, number]): void {
  rd.fieldMesh.shift(dcx, dcy, t);
  rd.tiles?.moved(dcx, t);
  rd.band?.mesh.shift(dcx, dcy, t);
  rd.shore.dirty();
}

/** Renderer.windowDrawn (the class keeps the method, documented there) */
export function windowDrawn(rd: Renderer): Uint8Array {
  const fm = rd.fieldMesh;
  const [nx, ny] = fm.chunkGrid;
  const n = nx * ny;
  if (rd.drawnNow.length !== n) rd.drawnNow = new Uint8Array(n);
  const d = rd.drawnNow;
  d.fill(0);
  const mirror = fm.built.length === n && fm.builtSlides === fm.slides;
  const iv = fm.inViewMask;
  const g = gridLive(rd) ? rd.gridOn!.on : null;
  const gv = rd.gridView;
  for (let c = 0; c < n; c++) {
    if (g && g[c] && gv[c]) d[c] = 1;
    else if (iv && iv[c]) d[c] = mirror && fm.built[c] ? 2 : 3;
  }
  return d;
}

/** which grid chunks are in the box of clip space `m` (the view's, or the sun's) within e of the screen */
export function gridCull(rd: Renderer, m: Float32Array, out: Uint8Array, e: number, perspective: boolean): void {
  out.fill(0);
  const G = rd.gridOn;
  if (!G) return;
  const [nx, , side] = rd.fieldMesh.chunkGrid;
  const ROW = Math.sqrt(3) / 2;
  for (let c = 0; c < G.on.length; c++) {
    if (!G.on[c]) continue;
    const cx = c % nx;
    const cy = Math.floor(c / nx);
    let lx = Infinity;
    let ly = Infinity;
    let hx = -Infinity;
    let hy = -Infinity;
    let behind = false;
    for (let k = 0; k < 8; k++) {
      const x = (cx + (k & 1)) * side + (k & 1 ? 1 : -1);
      const y = (cy + ((k >> 1) & 1)) * side * ROW + (k & 2 ? 1 : -1);
      const z = k & 4 ? G.hi[c] + 1 : G.lo[c] - 1;
      const w = perspective ? m[3] * x + m[7] * y + m[11] * z + m[15] : 1;
      if (w <= 1e-3) behind = true;
      const px = (m[0] * x + m[4] * y + m[8] * z + m[12]) / Math.max(w, 1e-3);
      const py = (m[1] * x + m[5] * y + m[9] * z + m[13]) / Math.max(w, 1e-3);
      lx = Math.min(lx, px);
      ly = Math.min(ly, py);
      hx = Math.max(hx, px);
      hy = Math.max(hy, py);
    }
    out[c] = behind || (hx >= -e && lx <= e && hy >= -e && ly <= e) ? 1 : 0;
  }
}

/** draw the grid's chunks marked in `which` (the pipeline and group set) */
export function drawGrid(rd: Renderer, pass: GPURenderPassEncoder, which: Uint8Array): number {
  const P = rd.gridPipes!;
  pass.setIndexBuffer(P.index, 'uint32');
  let n = 0;
  for (let c = 0; c < which.length; c++) {
    if (!which[c]) continue;
    pass.drawIndexed(P.count, 1, 0, c * GRID_N * GRID_N);
    n++;
  }
  rd.profiler.draws += n;
  return n;
}

/** the grid has something to draw this frame (its pipelines in, chunks of it) */
export function gridLive(rd: Renderer): boolean {
  return !!rd.gridPipes && !!rd.gridOn && !SKIP.has('grid');
}
