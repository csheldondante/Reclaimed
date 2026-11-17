// (tilekit step 3) The grid alone as a plan diagram (Node, raster.ts): cells inset so the edges show, coloured by
// where they are (the district's grain regions by grain, roads, the plaza, the alley, the town round it), the road
// lines, and every irregular interior vertex marked (3 blue, 5 red, 6 magenta).

import { centroid, P, type GridMesh } from '../../src/tilekit/grid';
import { valenceZones, type GrainInfo } from '../../src/tilekit/grain';
import { Raster, type RGB8 } from './raster';

const GRAIN: RGB8[] = [
  [236, 206, 160],
  [176, 214, 178],
  [178, 196, 232],
];

export function gridDiagram(m: GridMesh, info: GrainInfo | null, centre: [number, number], span: number, px = 900): Uint8Array {
  const R = new Raster(px, px, [40, 44, 50]);
  const s = px / span;
  const to = (p: [number, number]): [number, number] => [(p[0] - centre[0]) * s + px / 2, px / 2 - (p[1] - centre[1]) * s];
  for (let c = 0; c < m.nc; c++) {
    const [cx, cy] = centroid(m, c);
    if (Math.abs(cx - centre[0]) > span * 0.6 || Math.abs(cy - centre[1]) > span * 0.6) continue;
    let col: RGB8 = [150, 150, 150];
    const open = m.open?.[c] ?? 0;
    if (info?.inDistrict[c] && !open) {
      const g = info.grain[info.cellTri[c]];
      col = g >= 0 ? GRAIN[g] : [225, 225, 225];
    } else if (open === 1) col = [92, 92, 100];
    else if (open === 2) col = [214, 150, 110];
    else if (open === 3) col = [250, 250, 250];
    else if (m.cls && (m.lot![c] === 0xffffffff || m.cls[c] === 3)) col = [70, 70, 78];
    else if (m.cls && (m.cls[c] === 1 || m.cls[c] === 2)) col = [175, 170, 160];
    const q = [0, 1, 2, 3].map((k) => {
      const p = P(m, m.cells[c * 4 + k]);
      return to([p[0] + (cx - p[0]) * 0.08, p[1] + (cy - p[1]) * 0.08]);
    });
    R.poly(q, col);
  }
  if (info) {
    info.chains.forEach((ch, ci) => {
      const seam = info.kinds[ci] === 'seam';
      for (let i = 0; i + 1 < ch.length; i++) if (!seam || i % 2 === 0) R.seg(to(P(m, ch[i])), to(P(m, ch[i + 1])), seam ? 3 : 2, seam ? [200, 30, 160] : [20, 20, 20]);
    });
    const z = valenceZones(m, info);
    for (let v = 0; v < m.nv; v++) {
      if (z.rim[v] || z.valence[v] === 4) continue;
      const p = P(m, v);
      if (Math.abs(p[0] - centre[0]) > span / 2 || Math.abs(p[1] - centre[1]) > span / 2) continue;
      const n = z.valence[v];
      const inside = z.where[v] !== 4;
      const col: RGB8 = n === 3 ? [40, 90, 255] : n === 5 ? [230, 40, 40] : [220, 40, 220];
      R.dot(to(p), inside ? 6 : 3.5, col);
    }
  }
  return R.png();
}
