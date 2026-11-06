// (round 128p, DA-A13 step 1) A map preview of a town's edge paths, for the human pass: the ground shaded, the cells
// (buildings brown, as inset; yards green; the wall grey), the drawn paths (main red, lanes orange; stairs purple),
// the cut edges (a wall black, water blue, a cliff magenta), what reach leaves out ringed red. RGBA, `scale` px a metre.
import type { TownSite } from '../../src/build/site';
import type { EdgeNet } from '../../src/build/edgenet';
import { CUT_CLIFF, CUT_WALL, CUT_WATER, PATH_MAIN } from '../../src/build/edgenet';
import { insetTiles } from '../../src/build/edgeview';
import { ROW_H } from '../../src/world/lattice';

type V2 = [number, number];

export function edgePreview(site: TownSite, net: EdgeNet, wet: (x: number, y: number) => boolean, crop: [number, number, number, number], scale = 3): { w: number; h: number; data: Uint8Array } {
  const [x0, y0, x1, y1] = crop;
  const w = Math.ceil((x1 - x0) * scale);
  const h = Math.ceil((y1 - y0) * scale);
  const data = new Uint8Array(w * h * 4);
  const put = (px: number, py: number, c: number[]) => {
    if (px < 0 || py < 0 || px >= w || py >= h) return;
    const o = ((h - 1 - py) * w + px) * 4;
    data.set([c[0], c[1], c[2], 255], o);
  };
  const toPx = (x: number, y: number): V2 => [Math.floor((x - x0) * scale), Math.floor((y - y0) * scale)];
  // the ground
  for (let py = 0; py < h; py++)
    for (let px = 0; px < w; px++) {
      const x = x0 + (px + 0.5) / scale;
      const y = y0 + (py + 0.5) / scale;
      const z = site.groundAt(x, y);
      const sh = Math.max(0.4, Math.min(1.2, 0.85 + (site.groundAt(x, y + 1) - z - (site.groundAt(x + 1, y) - z)) * 0.3));
      put(px, py, wet(x, y) ? [70, 110, 170] : [168 * sh, 172 * sh, 140 * sh]);
    }
  const { plan, grid } = site;
  const out = new Set(net.reach.out.map((o) => o.id));
  const t = insetTiles(grid, plan, net);
  const fillQuad = (q: V2[], c: number[]) => {
    let lx = Infinity, ly = Infinity, hx = -Infinity, hy = -Infinity;
    for (const p of q) ((lx = Math.min(lx, p[0])), (ly = Math.min(ly, p[1])), (hx = Math.max(hx, p[0])), (hy = Math.max(hy, p[1])));
    const [a0, b0] = toPx(lx, ly);
    const [a1, b1] = toPx(hx, hy);
    for (let py = b0; py <= b1; py++)
      for (let px = a0; px <= a1; px++) {
        const x = x0 + (px + 0.5) / scale;
        const y = y0 + (py + 0.5) / scale;
        let inside = true;
        for (let e = 0; e < 4 && inside; e++) {
          const p = q[e];
          const r = q[(e + 1) & 3];
          if ((r[0] - p[0]) * (y - p[1]) - (r[1] - p[1]) * (x - p[0]) < 0) inside = false;
        }
        if (inside) put(px, py, c);
      }
  };
  for (let c = 0; c < grid.count; c++) {
    const st = plan.structureAt(c);
    if (!st) continue;
    const form = plan.defs[st.type].form;
    const q = [0, 1, 2, 3].map((k) => {
      const v = t.quads[c * 4 + k];
      return [t.verts[v * 2], t.verts[v * 2 + 1]] as V2;
    });
    const col = out.has(st.id) ? [220, 40, 40] : form === 'block' || form === 'keep' ? [125, 82, 60] : form === 'wall' ? (plan.gate[c] ? [200, 190, 120] : [110, 110, 110]) : [120, 160, 80];
    fillQuad(q, col);
  }
  const line = (a: V2, b: V2, c: number[], th: number) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(L * scale * 2));
    for (let s = 0; s <= n; s++) {
      const [px, py] = toPx(a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n);
      for (let dy = -th; dy <= th; dy++) for (let dx = -th; dx <= th; dx++) put(px + dx, py + dy, c);
    }
  };
  const P = (v: number): V2 => [grid.verts[v * 2], grid.verts[v * 2 + 1]];
  for (let e = 0; e < net.kind.length; e++) {
    const a = P(net.ends[e * 2]);
    const b = P(net.ends[e * 2 + 1]);
    if (net.cut[e] & CUT_WALL) line(a, b, [20, 20, 20], 1);
    else if (net.cut[e] & CUT_CLIFF) line(a, b, [220, 40, 200], 0);
    else if (net.cut[e] & CUT_WATER) continue;
    else if (net.kind[e]) line(a, b, net.steep[e] ? [140, 50, 180] : net.kind[e] === PATH_MAIN ? [210, 40, 30] : [240, 150, 40], net.kind[e] === PATH_MAIN ? 2 : 1);
    else if (!net.inner[e]) line(a, b, [150, 150, 130], 0);
  }
  for (const v of [net.storesV, net.centreV]) {
    const [px, py] = toPx(...P(v));
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) put(px + dx, py + dy, v === net.storesV ? [30, 30, 220] : [250, 250, 250]);
  }
  void ROW_H;
  return { w, h, data };
}
