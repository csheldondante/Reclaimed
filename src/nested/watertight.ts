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
  /** (round 14) triangles sharing their three vertices with another (z-fighting pairs) */
  coincident: number;
  /** (round 11) the rim lines to this level's live child (rimJunctions) */
  rim?: { junctions: number; unflagged: number; lines: number; where: string[] };
}

// (round 8) no edge is exempt: a level's boxes end at each column's own depth with a down cap (nest.wgsl zbOf), so the
// face set is closed everywhere; before, the edges on a fixed bottom plane were the one boundary allowed.
export function manifold(cap: { depth: number; n: number; tris: Float32Array }): EdgeReport {
  const t = cap.tris;
  // (round 14: the smooth draw's rim vertices carry the w 2 flag too: z in the child's units, kept apart from the level's own)
  const vk = (o: number) => `${t[o]},${t[o + 1]},${t[o + 2]}${t[o + 3] === 2 ? 'k' : ''}`;
  const edges = new Map<string, number>();
  const faces = new Map<string, number>();
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
    const fk = [...k].sort().join('|');
    faces.set(fk, (faces.get(fk) ?? 0) + 1);
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
  // (round 14) faces on the same three vertices (a collapsed thin layer's two caps: they z-fight; none expected)
  let coincident = 0;
  for (const c of faces.values()) if (c > 1) coincident += c;
  return { depth: cap.depth, tris, edges: count, open, over, degenerate, where, coincident };
}

/** (round 16, test only) the sheet draw's closure over every level at once (a level is no longer closed by itself: a
 *  parent's edge along its child's footprint is closed by the child's zipper). Vertices welded by exact position in the
 *  finest units that hold them (a rim vertex, capture w 2, is the child's); every directed edge must cancel, except
 *  along one side of the root window (no faces outside it, open by design). */
export function unionClosure(caps: { depth: number; tris: Float32Array }[], wins: { gx: number; gy: number; n: number }[], k: number): { tris: number; open: number; openRoot: number; odd: number; degenerate: number; coincident: number; where: string[] } {
  const dir = new Map<string, number>();
  const und = new Map<string, number>();
  const faces = new Map<string, number>();
  const side = new Map<string, number>();
  const r = wins[0];
  let tris = 0;
  let degenerate = 0;
  for (const cap of caps) {
    const L = cap.depth;
    const w = wins[L];
    const t = cap.tris;
    const vk = (o: number) => {
      const kid = t[o + 3] === 2;
      const lv = kid ? L + 1 : L;
      const cx = kid ? (t[o] + w.gx) * k : t[o] + w.gx;
      const cy = kid ? (t[o + 1] + w.gy) * k : t[o + 1] + w.gy;
      const key = `${lv}:${cx}:${cy}:${Math.fround(t[o + 2])}`;
      if (!side.has(key)) {
        const s = Math.pow(k, lv);
        const x = cx / s;
        const y = cy / s;
        side.set(key, (x === r.gx ? 1 : 0) | (x === r.gx + r.n ? 2 : 0) | (y === r.gy ? 4 : 0) | (y === r.gy + r.n ? 8 : 0));
      }
      return key;
    };
    for (let o = 0; o + 12 <= t.length; o += 12) {
      if (t[o + 3] === 0) continue;
      const v = [vk(o), vk(o + 4), vk(o + 8)];
      if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) {
        degenerate++;
        continue;
      }
      tris++;
      const fk = [...v].sort().join('|');
      faces.set(fk, (faces.get(fk) ?? 0) + 1);
      for (let e = 0; e < 3; e++) {
        const a = v[e];
        const b = v[(e + 1) % 3];
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        dir.set(key, (dir.get(key) ?? 0) + (a < b ? 1 : -1));
        und.set(key, (und.get(key) ?? 0) + 1);
      }
    }
  }
  let open = 0;
  let openRoot = 0;
  let odd = 0;
  const where: string[] = [];
  for (const [key, c] of dir) {
    if (c === 0) continue;
    const [a, b] = key.split('|');
    if (side.get(a)! & side.get(b)!) openRoot++;
    else {
      open++;
      if (where.length < 6) where.push(`${a} - ${b} (${c})`);
    }
  }
  for (const c of und.values()) if (c % 2) odd++;
  let coincident = 0;
  for (const c of faces.values()) if (c > 1) coincident += c;
  return { tris, open, openRoot, odd, degenerate, coincident, where };
}

/** (round 11, NS-97, test only) the rim lines between each level and its live child (parent corner lines on the child's
 *  window boundary): on such a line both levels' vertices must be the same set, in the child's units (the parent's
 *  flagged, capture w 2), so no vertex of one level lies inside a vertical edge of the other (a T-junction across the
 *  rim) and none of the parent's is left in its own units. Returns per parent level: junctions, unflagged parent vertices
 *  on rim lines, rim lines seen. */
export function rimJunctions(caps: { depth: number; tris: Float32Array }[], wins: { gx: number; gy: number; n: number }[], k: number): { depth: number; junctions: number; unflagged: number; lines: number; where: string[] }[] {
  const out = [];
  for (const P of caps) {
    const C = caps.find((c) => c.depth === P.depth + 1);
    if (!C) continue;
    const wp = wins[P.depth];
    const wc = wins[C.depth];
    const onRim = (x: number, y: number) => x % k === 0 && y % k === 0 && x >= wc.gx && y >= wc.gy && x <= wc.gx + wc.n && y <= wc.gy + wc.n && (x === wc.gx || y === wc.gy || x === wc.gx + wc.n || y === wc.gy + wc.n);
    // per line, per level: vertex heights and vertical edges
    const lines = new Map<string, { v: [Set<number>, Set<number>]; e: [[number, number][], [number, number][]] }>();
    let unflagged = 0;
    const add = (side: 0 | 1, t: Float32Array, toG: (x: number, y: number) => [number, number]) => {
      for (let o = 0; o + 12 <= t.length; o += 12) {
        if (t[o + 3] === 0) continue;
        const g = [0, 1, 2].map((v) => toG(t[o + v * 4], t[o + v * 4 + 1]));
        for (let v = 0; v < 3; v++) {
          if (!onRim(g[v][0], g[v][1])) continue;
          if (side === 0 && t[o + v * 4 + 3] !== 2) unflagged++;
          const key = `${g[v][0]},${g[v][1]}`;
          let l = lines.get(key);
          if (!l) lines.set(key, (l = { v: [new Set(), new Set()], e: [[], []] }));
          const z = t[o + v * 4 + 2];
          l.v[side].add(z);
          const u = (v + 1) % 3;
          if (g[u][0] === g[v][0] && g[u][1] === g[v][1]) {
            const z2 = t[o + u * 4 + 2];
            l.e[side].push([Math.min(z, z2), Math.max(z, z2)]);
          }
        }
      }
    };
    add(0, P.tris, (x, y) => [(x + wp.gx) * k, (y + wp.gy) * k]);
    add(1, C.tris, (x, y) => [x + wc.gx, y + wc.gy]);
    let junctions = 0;
    const where: string[] = [];
    for (const [key, l] of lines)
      for (const s of [0, 1] as const)
        for (const [a, b] of l.e[s])
          for (const z of l.v[1 - s])
            if (z > a && z < b) {
              junctions++;
              if (where.length < 4) where.push(`L${P.depth + s} edge ${a}..${b} at line ${key} holds L${P.depth + 1 - s}'s vertex ${z}`);
            }
    out.push({ depth: P.depth, junctions, unflagged, lines: lines.size, where });
  }
  return out;
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
      // (a cap: its corners not all on one x nor all on one y; round 11: a rim vertex's z is in the child's units, so the
      // three z of a cap touching a rim line differ)
      if (t[o + 3] === 0 || (t[o] === t[o + 4] && t[o] === t[o + 8]) || (t[o + 1] === t[o + 5] && t[o + 1] === t[o + 9])) continue;
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

/** (round 11, NS-97, test only) what the draw places round one pixel: every captured triangle of every level projected
 *  with that level's view-projection (cam words 32 + m * 24, as draw.wgsl vpOf) in float64, those whose screen triangle
 *  comes within `tol` px of the pixel's centre, with the signed distance of the centre to each edge (px, positive
 *  inside), the depth and the vertices (local units). A pinhole between faces that share an edge shows as two triangles
 *  whose edges pass the centre on the same side within a fraction of a pixel. */
export function rayDiag(caps: { depth: number; tris: Float32Array }[], cam: Float32Array, px: number, py: number, w: number, h: number, tol = 1.5, kidZ: (L: number, z: number) => number = (_L, z) => z): string[] {
  // the pixel's ray, as suite.ts groundHoles builds it (50 degree vertical field of view), cast in float64 in each
  // level's local units from that level's eye (cam words 32 + m * 24 + 16..18); the axes are the same on every level
  const tn = Math.tan((50 * Math.PI) / 360);
  const nx = ((px + 0.5) / w) * 2 - 1;
  const ny = 1 - ((py + 0.5) / h) * 2;
  const R = [cam[4], cam[5], cam[6]];
  const U = [cam[8], cam[9], cam[10]];
  const F = [cam[12], cam[13], cam[14]];
  const d0 = [0, 1, 2].map((i) => F[i] + R[i] * nx * tn * (w / h) + U[i] * ny * tn);
  const dl = Math.hypot(d0[0], d0[1], d0[2]);
  const D = d0.map((v) => v / dl);
  const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const hits: { t: number; s: string }[] = [];
  for (const cap of caps) {
    const b = 32 + cap.depth * 24;
    const E = [cam[b + 16], cam[b + 17], cam[b + 18]];
    const near = cam[b + 19];
    const t = cap.tris;
    for (let o = 0; o + 12 <= t.length; o += 12) {
      if (t[o + 3] === 0) continue;
      // (a rim vertex, w 2: z in the child's units, brought back to this level's)
      const P = [0, 1, 2].map((v) => [t[o + v * 4], t[o + v * 4 + 1], t[o + v * 4 + 3] === 2 ? kidZ(cap.depth, t[o + v * 4 + 2]) : t[o + v * 4 + 2]]);
      const n = cross(sub(P[1], P[0]), sub(P[2], P[0]));
      const nl = Math.hypot(n[0], n[1], n[2]);
      if (nl === 0) continue;
      const dn = dot(n, D);
      if (Math.abs(dn) < 1e-12 * nl) continue;
      const tt = dot(n, sub(P[0], E)) / dn;
      if (tt <= 0) continue;
      const X = [E[0] + D[0] * tt, E[1] + D[1] * tt, E[2] + D[2] * tt];
      // signed distance of the hit to each edge inside the triangle's plane, in pixels at that distance
      const pxSize = (tt * 2 * tn) / h;
      const ed: number[] = [];
      for (let e = 0; e < 3; e++) {
        const a = P[e];
        const c = P[(e + 1) % 3];
        const el = sub(c, a);
        const inward = cross(n, el);
        ed.push(dot(inward, sub(X, a)) / Math.hypot(inward[0], inward[1], inward[2]) / pxSize);
      }
      if (Math.min(...ed) < -tol) continue;
      const kind = n[2] !== 0 && n[0] === 0 && n[1] === 0 ? 'cap' : 'wall';
      hits.push({ t: tt / Math.pow(8, cap.depth), s: `L${cap.depth} slot ${o / 12} ${kind} t ${(tt / Math.pow(8, cap.depth)).toFixed(5)} world (near ${near.toExponential(3)} local, t ${tt.toFixed(4)} local) edges px ${ed.map((v) => v.toFixed(4)).join(' ')} lp ${JSON.stringify(P)}` });
    }
  }
  hits.sort((a, b) => a.t - b.t);
  return hits.map((x) => x.s);
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
