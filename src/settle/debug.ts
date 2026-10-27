// ?towndebug=1 (round 88): the live settlement's grids and jobs over the view — its districts' cells (the
// buildings' white, the yards faint, the fields brown), its spots (homes blue, stores yellow, jobs green,
// posts red, the camp's fire), its people (dots by what they're doing), and a panel: who they are, their
// people's profile, the districts' styles, their stores, trips, the raid.
import type { Camera } from '../render/camera';
import type { Settlements } from './settlements';
import { ROW_H } from '../world/lattice';

const SPOT: Record<string, string> = { home: '#4cf', store: '#fd0', farm: '#7f4', fell: '#3a3', mine: '#f6f', repair: '#f90', make: '#fff', trade: '#0fc', post: '#f33', camp: '#f00' };
const PHASE: Record<string, string> = { home: '#4cf', toWork: '#7f4', working: '#ff4', toStore: '#fd0', toHome: '#8af', flee: '#f8f' };

export class TownDebug {
  private svg: SVGSVGElement;
  private panel: HTMLDivElement;
  private frame = 0;

  constructor(ui: HTMLElement, private st: Settlements, private camera: Camera, private heightAt: (x: number, y: number) => number) {
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:5');
    ui.appendChild(this.svg);
    this.panel = document.createElement('div');
    this.panel.setAttribute('style', 'position:absolute;left:8px;bottom:8px;max-width:340px;font:11px/1.35 monospace;color:#fff;background:#000a;padding:6px 8px;border-radius:4px;pointer-events:none;z-index:6;white-space:pre-wrap');
    ui.appendChild(this.panel);
  }

  /** shown or not (reclaimed.townDebug.show(false) for a clean shot) */
  show(on: boolean): void {
    this.on = on;
    this.svg.style.display = on ? '' : 'none';
    this.panel.style.display = on ? '' : 'none';
  }
  private on = true;

  draw(): void {
    // (a few times a second is plenty)
    if (!this.on || this.frame++ % 3) return;
    const life = this.st.life;
    const rec = life?.rec;
    const plan = rec ? this.st.plan(rec.id) : null;
    if (!rec || !plan) {
      this.svg.innerHTML = '';
      this.panel.textContent = `settlements: ${this.st.stats.planned} planned (${this.st.stats.planMs.toFixed(0)} ms), none live here`;
      return;
    }
    const seed = this.st.seeds.find((s) => s.rec.id === rec.id)!;
    const ox = seed.box.x0;
    const oy = seed.box.y0 * ROW_H;
    /** a local point on screen, at the ground there (or at `z`, a window height: a lot's outline flat at its yard's) */
    const P = (lx: number, ly: number, dz = 0.3, z?: number) => {
      const [x, y] = this.st.toWindow([lx + ox, ly + oy]);
      const [sx, sy] = this.camera.project(x, y, (z ?? this.heightAt(x, y)) + dz);
      return `${sx.toFixed(1)},${sy.toFixed(1)}`;
    };
    const out: string[] = [];
    // the settlement's growth field: warm dots, bigger where it's strong
    const f = plan.field;
    for (let j = 0; j < f.h; j += 2)
      for (let i = 0; i < f.w; i += 2) {
        const v = f.v[j * f.w + i];
        if (v < 0.05) continue;
        const [x, y] = P((i + 0.5) * 3, (j + 0.5) * 3, 0.2).split(',');
        out.push(`<circle cx="${x}" cy="${y}" r="${(1 + v * 3).toFixed(1)}" fill="#f80" fill-opacity="${(0.25 + 0.5 * v).toFixed(2)}"/>`);
      }
    for (const [gid, lg] of plan.grids) {
      const fields = gid.endsWith('fields');
      for (const lot of lg.lots) {
        const use = plan.lotUse.get(`${gid}:${lot.id}`);
        if (fields && use !== 'field') continue;
        const stroke = fields ? '#a84' : use ? '#fff' : '#fff6';
        const [yx, yy] = this.st.toWindow([lg.centre(lot.yard[0])[0] + ox, lg.centre(lot.yard[0])[1] + oy]);
        const zl = this.heightAt(yx, yy);
        for (const c of lot.inner) {
          const pts = [0, 1, 2, 3].map((k) => P(...lg.corner(c, k), 0.3, zl)).join(' ');
          out.push(`<polygon points="${pts}" fill="none" stroke="${stroke}" stroke-width="${use ? 1.2 : 0.6}"/>`);
        }
        if (use && !fields) {
          const [x, y] = P(...lot.centre, 6).split(',');
          out.push(`<text x="${x}" y="${y}" fill="#fff" font-size="10" text-anchor="middle" style="paint-order:stroke;stroke:#000;stroke-width:2">${use}</text>`);
        }
      }
    }
    for (const s of plan.spots) {
      const [x, y] = P(...s.at).split(',');
      out.push(`<circle cx="${x}" cy="${y}" r="4" fill="${SPOT[s.kind] ?? '#ccc'}" stroke="#000"/>`);
    }
    for (const j of life!.jobs.fell) {
      const [sx, sy] = this.camera.project(j[0], j[1], this.heightAt(j[0], j[1]) + 0.3);
      out.push(`<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="3" fill="${SPOT.fell}" stroke="#000"/>`);
    }
    const units = this.st.life ? [...life!.ids, ...life!.raiders] : [];
    const phases: Record<string, number> = {};
    for (const id of units) {
      const u = this.st.units?.recs.get(id);
      if (!u || !u.v.alive) continue;
      const ph = u.v.hostile ? (u.target !== null ? 'hunt' : 'camp') : u.v.role === 'guard' ? (u.target !== null ? 'fight' : 'guard') : (u.work?.phase ?? '?');
      phases[ph] = (phases[ph] ?? 0) + 1;
      const [sx, sy] = this.camera.project(u.v.at[0], u.v.at[1], u.v.at[2] + 2.2);
      out.push(`<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="2.5" fill="${u.v.hostile ? '#f22' : u.v.role === 'guard' ? '#ccc' : (PHASE[ph] ?? '#999')}"/>`);
    }
    this.svg.innerHTML = out.join('');
    const stores = Object.entries(rec.stores).map(([k, v]) => `${k} ${v.stock.toFixed(0)}${v.rate ? ` (${v.rate > 0 ? '+' : ''}${v.rate.toFixed(1)}/d)` : ''}`).join(', ');
    const us = this.st.units?.stats;
    this.panel.textContent = [
      `${rec.name} (${rec.id}) — ${rec.size}, ${seed.civ.profile.name}${rec.faction ? `, ${rec.faction}` : ''}`,
      `districts: ${rec.grids.map((g) => `${g.style} (${g.purpose})`).join(', ')}`,
      `buildings ${rec.buildings.length}${rec.founded?.over ? ', over a ruin' : ''}; planned in ${plan.ms} ms`,
      `people: ${rec.people.map((p) => `${p.role} ${p.count}`).join(', ')}`,
      `out now: ${Object.entries(phases).map(([k, n]) => `${k} ${n}`).join(', ')}`,
      `stores: ${stores}`,
      `quarried ${life!.moved.quarried.toFixed(1)}, felled ${life!.moved.felled.toFixed(1)}, heaped ${life!.moved.heaped.toFixed(1)}, built ${life!.moved.built.toFixed(1)} cells³; blocks ${life!.blocks}, houses ${life!.houses}`,
      `trips ${life!.trips}${life!.denied ? `, quarry without rights: ${life!.denied}` : ''}${life!.raid ? `, RAID ${life!.raid.t.toFixed(0)} s` : plan.camp ? `, camp: ${plan.camp.people[0].count} raiders` : ''}`,
      us ? `units ${us.units}, hunting ${us.hunting}, sync ${us.syncMs} ms` : '',
    ].join('\n');
  }

  dispose(): void {
    this.svg.remove();
    this.panel.remove();
  }
}
