// (debugging aid, skipped unless PLAN_SHEET=<dir>) top-down drawings of planned interiors: tiles, walls and their
// openings, stairs, props' footprints, spots, the free grid — one PNG a storey. `PLAN_SHEET=out npx vitest run plan.sheet`.
import fs from 'node:fs';
import { describe, it } from 'vitest';
import { PNG } from 'pngjs';
import { planCity } from '../../src/structures/plan';
import { planInterior } from '../../src/interiors/plan';
import { propSize } from '../../src/interiors/props';
import { sideAxes } from '../../src/interiors/frame';

const OUT = process.env.PLAN_SHEET;

describe.skipIf(!OUT)('plan sheets', () => {
  it('draws', () => {
    for (const seed of [7, 11, 23, 41]) {
      const city = planCity({ seed, system: 'irregular', style: 'hearth', at: [500, 500], radius: 40 }, (x, y) => (seed % 2 ? 10 + 0.03 * x + 0.02 * y : 10));
      const cands = city.buildings.filter((b) => !b.mega && b.quads.length >= 2 && city.quadBuilding[b.quads[0]] === b.id);
      cands.sort((a, b) => b.quads.length * b.storeys - a.quads.length * a.storeys);
      const b = cands[0];
      let res;
      try {
        res = planInterior(city, b.id, 'hall', propSize);
      } catch (e) {
        console.log(`seed ${seed}: ${(e as Error).message}`);
        continue;
      }
      const { plan, grids } = res;
      plan.storeys.forEach((st, l) => {
        const g = grids[l];
        const S = 24;
        const W = g.w * (S * g.cell), H = g.h * (S * g.cell);
        const png = new PNG({ width: Math.ceil(W), height: Math.ceil(H) });
        const put = (x: number, y: number, c: number[]) => {
          const X = Math.round((x - g.x0) * S), Y = Math.round((y - g.y0) * S);
          if (X < 0 || Y < 0 || X >= png.width || Y >= png.height) return;
          png.data.set([...c, 255], (Y * png.width + X) * 4);
        };
        for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) {
          const c = g.free[j * g.w + i] ? [70, 66, 60] : [20, 20, 24];
          for (let y = 0; y < S * g.cell; y++) for (let x = 0; x < S * g.cell; x++) put(g.x0 + i * g.cell + x / S, g.y0 + j * g.cell + y / S, c);
        }
        const line = (a: number[], bb: number[], c: number[]) => {
          const n = Math.ceil(Math.hypot(bb[0] - a[0], bb[1] - a[1]) * S * 2);
          for (let k = 0; k <= n; k++) put(a[0] + ((bb[0] - a[0]) * k) / n, a[1] + ((bb[1] - a[1]) * k) / n, c);
        };
        for (const w of st.walls) {
          line(w.a, w.b, w.outer ? [200, 200, 190] : [140, 120, 100]);
          const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
          const { dir } = sideAxes(plan.corners.get(w.tile)!, w.side);
          for (const o of w.openings) {
            const c = o.kind === 'window' ? [90, 160, 230] : o.kind === 'door' ? [240, 80, 60] : [240, 200, 60];
            line([w.a[0] + dir[0] * o.u0 * L, w.a[1] + dir[1] * o.u0 * L], [w.a[0] + dir[0] * o.u1 * L, w.a[1] + dir[1] * o.u1 * L], c);
          }
        }
        for (const s of st.stairs) line(s.foot, s.top, [80, 240, 120]);
        for (const p of st.props) {
          const [sx, sy] = propSize(p.prop).map((v) => v * (p.scale ?? 1));
          const ax = [Math.cos(p.yaw), Math.sin(p.yaw)], ny = [-ax[1], ax[0]];
          const cs = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, c]) => [p.at[0] + ax[0] * a * sx / 2 + ny[0] * c * sy / 2, p.at[1] + ax[1] * a * sx / 2 + ny[1] * c * sy / 2]);
          for (let k = 0; k < 4; k++) line(cs[k], cs[(k + 1) % 4], [200, 140, 70]);
          line([p.at[0], p.at[1]], [p.at[0] + ax[0] * sx / 2, p.at[1] + ax[1] * sx / 2], [250, 250, 120]);
        }
        for (const sp of st.spots) {
          const c = sp.kind === 'sit' ? [255, 0, 255] : sp.kind === 'stand' ? [0, 255, 255] : [255, 255, 255];
          for (let k = -3; k <= 3; k++) for (let m = -3; m <= 3; m++) put(sp.at[0] + k / S, sp.at[1] + m / S, c);
        }
        fs.mkdirSync(OUT!, { recursive: true });
        fs.writeFileSync(`${OUT}/plan-s${seed}-l${l}.png`, PNG.sync.write(png));
      });
      for (const s of plan.storeys) console.log(`  l${s.level}: ${s.props.map((p) => p.prop).join(' ')}`);
      console.log(`seed ${seed}: ${plan.storeys.length} storeys, rooms ${plan.storeys.map((s) => s.rooms.map((r) => r.purpose + r.tiles.length).join('/')).join(' | ')}, props ${plan.storeys.map((s) => s.props.length).join(',')}, doors ${plan.doors.length}`);
    }
  });
});
